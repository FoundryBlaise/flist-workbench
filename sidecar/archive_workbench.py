"""The Workbench: a character's one editable copy of its profile.

`workbench/payload.json` and `meta.json` beside it, the etag a write must
send back, and the payload shapes a Workbench is made from (Live, a
Backup, F-list's edit form). Replacing the whole Workbench keeps it as a
Backup first, so that lives in `archive_backups`.
"""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import archive_live
import archive_registry
from services import events

# The payload's `_schema_version`, stamped on every Workbench write.
# v1 → v2 added local: ids, _custom_kinks_order and tombstones; v3 held
# sha256-keyed gallery refs, which v4 turned back into image ids; v5 and
# v6 changed where the payload is stored, not its shape.
WORKING_SCHEMA_VERSION = 6


class EtagMismatch(ValueError):
    """Raised by a Workbench write when expected_etag != current on-disk etag.

    The Workbench endpoint translates this into a 409 with the current
    etag so the window can show the refresh-or-overwrite modal.
    """

    def __init__(self, current_etag: str | None) -> None:
        super().__init__("etag_mismatch")
        self.current_etag = current_etag


# ---- the one Workbench --------------------------------------------------
#
# A character has one editable copy of its profile beside Live (ADR
# 0001): `<character>/workbench/payload.json`, with `meta.json` beside it
# holding when it was made and last saved. Every reader and writer goes
# through the functions below; nothing else knows where it lives.
# Archives from versions that kept several drafts are moved to this
# shape once, at startup (`workbench_migration`).

WORKBENCH_DIRNAME = "workbench"
WORKBENCH_PAYLOAD_FILENAME = "payload.json"
WORKBENCH_META_FILENAME = "meta.json"

#: How the Workbench is named wherever a name is shown.
WORKBENCH_NAME = "Workbench"


def _file_sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    import hashlib

    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def _migrate_working_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """In-memory schema stamp for a payload about to be written. v1 → v2
    fills _custom_kinks_order from the dict; v3 stored images as
    [{sha256, description}], which cannot be turned back into image ids,
    so that array is dropped and the gallery comes from Live again."""
    version = payload.get("_schema_version")
    if version is None:
        version = 1
        payload["_schema_version"] = 1
    if version == 1:
        ck = payload.get("custom_kinks")
        if isinstance(ck, dict) and "_custom_kinks_order" not in payload:
            payload["_custom_kinks_order"] = list(ck.keys())
    if isinstance(version, int) and version <= 3:
        payload.pop("images", None)
    if isinstance(version, int) and version < WORKING_SCHEMA_VERSION:
        payload["_schema_version"] = WORKING_SCHEMA_VERSION
    return payload


_WORKING_TOP_LEVEL_KEYS = {
    "character",
    "settings",
    "infotags",
    "kinks",
    "custom_kinks",
    "images",
    "inlines",
}


def workbench_dir(character_id: int | str) -> Path:
    """The character's `workbench/` folder. Never creates it."""
    return archive_registry.character_dir(character_id) / WORKBENCH_DIRNAME


def _workbench_payload_path(character_id: int | str) -> Path:
    return workbench_dir(character_id) / WORKBENCH_PAYLOAD_FILENAME


def _workbench_meta_path(character_id: int | str) -> Path:
    return workbench_dir(character_id) / WORKBENCH_META_FILENAME


@dataclass(frozen=True)
class WorkbenchInfo:
    """When the Workbench was made and last saved (unix seconds)."""

    created_at: int
    updated_at: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": WORKBENCH_NAME,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass(frozen=True)
class WorkbenchRead:
    """A Workbench payload and the etag a write must send back.

    `created` is true when this very read made the Workbench from Live:
    nobody can have edited it yet, so a caller holding its own copy of
    Live may write over it.
    """

    payload: dict[str, Any]
    etag: str
    created: bool = False


class EtagRequired(EtagMismatch):
    """A Workbench write that sent no etag: it has not seen what it
    would replace, so it is refused like a stale one."""

    def __init__(self, current_etag: str | None) -> None:
        super().__init__(current_etag)
        self.args = ("etag_required",)


def _read_workbench_file(
    character_id: int | str,
) -> tuple[dict[str, Any] | None, str | None]:
    """The Workbench payload and its etag, from one read of the file:
    (None, None) when there is no file, (None, etag) when it holds no
    payload."""
    import hashlib

    try:
        data = _workbench_payload_path(character_id).read_bytes()
    except OSError:
        return None, None
    etag = hashlib.sha256(data).hexdigest()
    try:
        payload = json.loads(data.decode("utf-8"))
    except ValueError:
        return None, etag
    return (payload if isinstance(payload, dict) else None), etag


def workbench_info(character_id: int | str) -> WorkbenchInfo | None:
    """The Workbench's dates, or None when the character has none yet."""
    if not _workbench_payload_path(character_id).is_file():
        return None
    try:
        raw = json.loads(_workbench_meta_path(character_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = None
    created = raw.get("created_at") if isinstance(raw, dict) else None
    updated = raw.get("updated_at") if isinstance(raw, dict) else None
    if not isinstance(created, int) or not isinstance(updated, int):
        # A Workbench whose meta is missing still is one; its file's
        # time stands in.
        try:
            mtime = int(_workbench_payload_path(character_id).stat().st_mtime)
        except OSError:
            return None
        created = created if isinstance(created, int) else mtime
        updated = updated if isinstance(updated, int) else mtime
    return WorkbenchInfo(created_at=created, updated_at=updated)


@archive_registry.under_character_lock
def _store_workbench(
    character_id: int | str, payload: dict[str, Any], *, created_at: int | None = None
) -> str:
    """Write the payload and its dates atomically, announce the change,
    and return the new etag. No etag check: callers do that."""
    path = _workbench_payload_path(character_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    archive_registry.write_json(path, payload)
    now = int(time.time())
    if created_at is None:
        info = workbench_info(character_id)
        created_at = info.created_at if info is not None else now
    archive_registry.write_json(
        _workbench_meta_path(character_id),
        {"created_at": created_at, "updated_at": now},
    )
    etag = _file_sha256(path)
    assert etag is not None
    archive_registry.publish(events.SETS_CHANGED, character_id)
    archive_registry.publish(events.SET_PAYLOAD_CHANGED, character_id, etag=etag)
    return etag


@archive_registry.under_character_lock
def read_workbench(
    character_id: int | str, *, create: bool = False
) -> WorkbenchRead | None:
    """The character's Workbench, or None when it has none.

    The payload and its etag come from one read of the file, under the
    character's lock. `create=True` makes it from Live first if needed,
    under the same lock, so no save can land between "there is none"
    and making it; None then means there is no Live to make it from.
    """
    created = False
    payload, etag = _read_workbench_file(character_id)
    if etag is None and create and not _workbench_payload_path(character_id).exists():
        live = archive_live.read_live(character_id)
        if live is None:
            return None
        _store_workbench(
            character_id, _seed_payload_from_live(live), created_at=int(time.time())
        )
        payload, etag = _read_workbench_file(character_id)
        created = True
    if payload is None or etag is None:
        return None
    return WorkbenchRead(payload=payload, etag=etag, created=created)


@archive_registry.under_character_lock
def workbench_etag(character_id: int | str) -> str | None:
    """The etag of the character's Workbench; None when it has none."""
    return _file_sha256(_workbench_payload_path(character_id))


@archive_registry.under_character_lock
def write_workbench(
    character_id: int | str,
    payload: dict[str, Any],
    *,
    expected_etag: str | None,
) -> str:
    """Replace the character's Workbench; return the new etag.

    The save contract: `expected_etag` must be the etag of what is on
    disk now; the check and the replace run under the character's lock,
    so of two writes that read the same Workbench one is refused. Without one this raises `EtagRequired`, with a stale one
    (or when there is no Workbench to replace) `EtagMismatch`; neither
    touches the file. The write is atomic and announces the change.
    Raises ValueError for a payload that is not a Workbench: `_overlay`
    must be a list of strings and at least one content key present; the
    schema version is stamped.
    """
    current = workbench_etag(character_id)
    if expected_etag is None:
        raise EtagRequired(current)
    if not isinstance(payload, dict):
        raise ValueError("the Workbench payload must be an object")
    payload = _migrate_working_payload(dict(payload))
    overlay = payload.get("_overlay")
    if not isinstance(overlay, list) or not all(isinstance(s, str) for s in overlay):
        raise ValueError("_overlay must be a list of strings")
    if not any(k in payload for k in _WORKING_TOP_LEVEL_KEYS):
        raise ValueError(
            "the Workbench payload must carry at least one of "
            f"{sorted(_WORKING_TOP_LEVEL_KEYS)}"
        )
    if current is None or current != expected_etag:
        raise EtagMismatch(current)
    return _store_workbench(character_id, payload)


def export_payload(
    character_id: int | str, *, from_live: bool = False
) -> dict[str, Any] | None:
    """What an export of the character packs: its Workbench, else (or
    with `from_live`) a fresh copy of Live. Never makes a Workbench.
    None when the character has neither."""
    bench = None if from_live else read_workbench(character_id)
    if bench is not None:
        return bench.payload
    live = archive_live.read_live(character_id)
    return _seed_payload_from_live(live) if live is not None else None


def _seed_payload_from_live(live: dict[str, Any]) -> dict[str, Any]:
    """Build a fresh Workbench payload from Live.

    The one implementation on the Python side: making the Workbench on
    its first read, reset to Live and `export_payload` all go through
    it. It mirrors the renderer's
    `seedWorkingFromLive`; the two have to stay in step, because a
    Workbench the sidecar makes and one the window seeds must be the
    same shape."""
    out: dict[str, Any] = {
        "_schema_version": WORKING_SCHEMA_VERSION,
        "_overlay": [],
    }
    if isinstance(live.get("character"), dict):
        out["character"] = dict(live["character"])
    else:
        out["character"] = {
            "id": live.get("id"),
            "name": live.get("name"),
            "description": live.get("description", ""),
            "custom_title": live.get("custom_title"),
        }
    for key in ("settings", "infotags", "custom_kinks", "inlines"):
        if key in live:
            out[key] = live[key]
    kinks = live.get("kinks")
    out["kinks"] = {} if isinstance(kinks, list) else (kinks or {})
    gallery: list[dict[str, Any]] = []
    raw_images = live.get("images")
    if isinstance(raw_images, list):
        for index, entry in enumerate(raw_images):
            if not isinstance(entry, dict):
                continue
            iid = entry.get("image_id") or entry.get("id")
            if iid is None:
                continue
            sort_raw = entry.get("sort_order")
            if isinstance(sort_raw, (int, float)):
                sort = int(sort_raw)
            elif isinstance(sort_raw, str) and sort_raw:
                try:
                    sort = int(sort_raw)
                except ValueError:
                    sort = index
            else:
                sort = index
            gallery.append(
                {
                    "image_id": str(iid),
                    "description": entry.get("description", "") or "",
                    "sort_order": sort,
                }
            )
    gallery.sort(key=lambda e: e["sort_order"])
    out["images"] = gallery
    return out


#: F-list's edit-form setting names -> the Workbench's.
_FORM_SETTING_NAMES = {
    "customsfirst": "customs_first",
    "showfriends": "show_friends",
    "unbookmarkable": "prevent_bookmarks",
}


def _strip_form_prefix(fields: Any, prefix: str) -> dict[str, Any]:
    if not isinstance(fields, dict):
        return {}
    return {
        (str(k)[len(prefix):] if str(k).startswith(prefix) else str(k)): v
        for k, v in fields.items()
    }


def payload_from_form_state(
    form: dict[str, Any], live: dict[str, Any] | None = None
) -> dict[str, Any]:
    """A Workbench payload from what the extension read off F-list's edit
    form just before an Upload.

    The form speaks in its own field names: infotags as `info_<id>`,
    kinks as `fetish_<id>`, settings as `customsfirst`, custom kinks as
    a list, the title as `customTitle`. A Backup's `working.json` has to
    be in the Workbench's terms, or Restore cannot load it and the
    extension cannot put it back on the form. The form carries no
    gallery; the images are the ones on the profile, i.e. Live's,
    unless `form` brings its own.
    """
    character = form.get("character")
    if not isinstance(character, dict):
        character = {}
    raw_settings = form.get("settings")
    settings = (
        {_FORM_SETTING_NAMES.get(str(k), str(k)): v for k, v in raw_settings.items()}
        if isinstance(raw_settings, dict)
        else {}
    )

    custom_rows = form.get("customKinks")
    if custom_rows is None:
        custom_rows = form.get("custom_kinks")
    custom_kinks: dict[str, Any] = {}
    order: list[str] = []
    if isinstance(custom_rows, list):
        for row in custom_rows:
            if not isinstance(row, dict) or not row.get("name"):
                continue
            key = str(row["id"]) if row.get("id") else f"local:{uuid.uuid4()}"
            custom_kinks[key] = {
                "name": row.get("name") or "",
                "description": row.get("description") or "",
                "choice": row.get("choice") or "undecided",
                "children": [],
            }
            order.append(key)
    elif isinstance(custom_rows, dict):
        custom_kinks = dict(custom_rows)
        order = [str(k) for k in custom_rows]

    source = live if isinstance(live, dict) else {}
    images = form.get("images") if isinstance(form.get("images"), list) else source.get("images")
    inlines = form.get("inlines") if "inlines" in form else source.get("inlines", {})
    return {
        "_schema_version": WORKING_SCHEMA_VERSION,
        "_overlay": [],
        "character": {
            "id": character.get("id"),
            "name": character.get("name"),
            "description": character.get("description") or "",
            "custom_title": character.get("customTitle")
            or character.get("custom_title")
            or "",
        },
        "settings": settings,
        "infotags": _strip_form_prefix(form.get("infotags"), "info_"),
        "kinks": _strip_form_prefix(form.get("kinks"), "fetish_"),
        "custom_kinks": custom_kinks,
        "_custom_kinks_order": order,
        "images": _seed_payload_from_live({"images": images})["images"],
        "inlines": inlines if inlines is not None else {},
    }


def is_form_state(payload: dict[str, Any]) -> bool:
    """Whether a Backup's `working.json` is the raw edit form an earlier
    version packed before an Upload, rather than a Workbench payload.
    Every Workbench payload carries `_schema_version` and `_overlay`."""
    return "_schema_version" not in payload and "_overlay" not in payload


def backup_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """A Backup's `working.json` as a Workbench payload. Backups taken
    before an Upload by an earlier version hold the edit form as the
    extension sent it; those are translated, the rest pass through."""
    return payload_from_form_state(payload) if is_form_state(payload) else payload
