"""Tier 6 ZIP serialisation — translate a working.json payload into the
`character.json` shape the `flistcharexporter` userscript reads, and
package it with the referenced character images into a userscript-
compatible ZIP.

Two entry points:

    to_zip_character_json(working_payload, *, image_extensions=None) -> dict
        Pure shape transform. Tested by `test_zip_serialise.py`.

    build_zip(character_id, working_payload, *, images_dir, avatar_path) -> bytes
        Bundles the JSON + each gallery image at
        `images/<image_id>.<ext>` + `avatar.png` at the root.

Shape contract: see the Vanessa sample at
`/sideprojects/flistcharexporter/flist_Vanessa_Arlington_*.json` and
the userscript's `importCharacterData` reader.
"""
from __future__ import annotations

import io
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# Working.json settings -> userscript-export settings rename map.
# Workbench stores the F-list profile-form field names (snake_case);
# the export shape collapses to the URL-friendly lowercase keys the
# userscript posts back at restore time.
_SETTINGS_RENAME = {
    "customs_first": "customsfirst",
    "show_friends": "showfriends",
    "prevent_bookmarks": "unbookmarkable",
}

# Working.json keys that don't survive into the ZIP. `guestbook` is a
# per-viewer preference on F-list, not a profile field — the userscript
# never sets it on restore.
_SETTINGS_DROP = {"guestbook"}

# Owner-only settings (visible to the account, not the public profile)
# default to these when missing from the working copy. Pinned by
# `test_owner_only_settings_filled_from_defaults` — change with caution.
_SETTINGS_OWNER_DEFAULTS: dict[str, bool] = {
    "showtimezone": True,
    "showbadges": False,
    "showcharlist": True,
}

_VALID_CHOICES = {"fave", "yes", "maybe", "no", "undecided"}

_EXPORT_FORMAT_VERSION = "0.0.0"

_IMAGE_FILE_RE = re.compile(r"^([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)$")


def to_zip_character_json(
    working_payload: dict[str, Any],
    *,
    image_extensions: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Translate `working_payload` into the userscript's character.json.

    `image_extensions` maps gallery `image_id` → file extension (e.g.
    `{"17924625": "jpg"}`). Built from `<char>/images/` by `build_zip`.
    Optional; when omitted, entries that don't carry an `extension`
    field fall through to `"png"` so the pinned contract tests can
    drive the serialiser without a real archive.
    """
    return {
        "meta": _build_meta(),
        "character": _reshape_character(working_payload.get("character")),
        "settings": _reshape_settings(working_payload.get("settings")),
        "infotags": _reshape_infotags(working_payload.get("infotags")),
        "kinks": _reshape_kinks(working_payload.get("kinks")),
        "customKinks": _reshape_custom_kinks(working_payload),
        "images": _reshape_images(
            working_payload.get("images"),
            image_extensions=image_extensions,
        ),
        "inlines": _reshape_inlines(working_payload.get("inlines")),
    }


def build_zip(
    character_id: str | int,
    working_payload: dict[str, Any],
    *,
    images_dir: Path,
    avatar_path: Path | None = None,
    backup_kind: str | None = None,
    backup_note: str | None = None,
) -> bytes:
    """Pack `character.json` + the gallery images + the avatar into a
    ZIP, returning the bytes. Skips entries whose `<image_id>.<ext>`
    file is missing rather than failing the whole export — the user-
    script will still upload the JSON + any images that resolved.

    `character_id` is currently ignored; reserved for future per-set
    routing so the signature doesn't churn then.

    `backup_kind` (one of `manual_single`, `manual_bulk`, `scheduled`,
    `import`, or `None`) is embedded in a `backup-meta.json` file
    alongside `character.json` so the Browse-backup viewer can show
    *why* this backup was created. `None` skips the file entirely —
    useful for round-trip tests that compare ZIP bytes against a
    known fixture and don't want a clock-dependent timestamp in there.
    """
    del character_id  # not yet used; signature reserved for later

    # Walk images/ once so the serialiser knows each image_id's
    # extension. This mirrors `list_character_images` without going
    # through character_archive — keeps the serialiser pure / testable.
    image_extensions: dict[str, str] = {}
    if images_dir.exists():
        for entry in images_dir.iterdir():
            if not entry.is_file():
                continue
            m = _IMAGE_FILE_RE.match(entry.name)
            if not m:
                continue
            image_extensions[m.group(1)] = m.group(2).lower()

    character_json = to_zip_character_json(
        working_payload, image_extensions=image_extensions
    )

    # Drop gallery entries whose bytes aren't on disk so the userscript
    # never sees a JSON row referencing a missing file. Happens when
    # F-list deleted an image (pull pruned images/) but the user hadn't
    # yet removed the row from the working gallery. Positions are
    # renumbered so the rendered order matches what the userscript will
    # actually upload.
    present: list[dict[str, Any]] = []
    for entry in character_json["images"]["list"]:
        filename = entry.get("filename")
        if not isinstance(filename, str):
            continue
        src = images_dir / Path(filename).name
        if not src.exists():
            continue
        present.append(entry)
    for position, entry in enumerate(present):
        entry["position"] = position
    character_json["images"]["list"] = present

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "character.json",
            json.dumps(character_json, indent=2, ensure_ascii=False),
        )
        # ALSO write the source `working.json` so a read-only Browse
        # Backup mode can render the rich internal payload without
        # inverting all the export-side reshape passes. The userscript
        # ignores extra files, so this is forward-compatible with every
        # existing flistcharexporter install. Costs a few KB per ZIP
        # (description BBCode + kink choices + custom-kink overlay) —
        # trivial next to the image bytes. Backups created before this
        # write was added gracefully degrade: the Browse Backup reader
        # surfaces a "this backup predates browse support" message.
        zf.writestr(
            "working.json",
            json.dumps(working_payload, indent=2, ensure_ascii=False),
        )
        # Record creation provenance — `kind` lets the Browse-backup
        # viewer + the sidebar list show why this backup exists
        # (manual right-click, bulk Tools→Back up all, import-driven,
        # scheduled). `created_at` is the same UTC ISO basic form the
        # filename uses (with seconds + Z) so a user reading the file
        # without opening it sees a consistent time. `note` is reserved
        # for future free-text annotations from the UI.
        if backup_kind is not None:
            meta = {
                "kind": backup_kind,
                "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            }
            if backup_note:
                meta["note"] = backup_note
            zf.writestr(
                "backup-meta.json",
                json.dumps(meta, indent=2, ensure_ascii=False),
            )
        written: set[str] = set()
        for entry in present:
            filename = entry["filename"]
            if filename in written:
                continue
            src = images_dir / Path(filename).name
            zf.write(src, filename)
            written.add(filename)
        if avatar_path is not None and avatar_path.exists():
            zf.write(avatar_path, "avatar.png")
    return buf.getvalue()


# ---- internals --------------------------------------------------------


def _build_meta() -> dict[str, str]:
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    if now.endswith("+00:00"):
        now = now[:-6] + "Z"
    return {"exportedAt": now, "version": _EXPORT_FORMAT_VERSION}


def _reshape_character(character: Any) -> dict[str, str]:
    """Lowercase-+-camelCase mapping for the four export fields. F-list's
    public character payload uses `custom_title`; the userscript export
    renames it to `customTitle`."""
    if not isinstance(character, dict):
        character = {}
    cid = character.get("id")
    return {
        "id": "" if cid is None else str(cid),
        "name": _as_str(character.get("name")),
        "description": _as_str(character.get("description")),
        "customTitle": _as_str(
            character.get("custom_title") or character.get("customTitle")
        ),
    }


def _reshape_settings(settings: Any) -> dict[str, Any]:
    if not isinstance(settings, dict):
        settings = {}
    out: dict[str, Any] = {}
    for key, value in settings.items():
        if key in _SETTINGS_DROP:
            continue
        out[_SETTINGS_RENAME.get(key, key)] = value
    for key, default in _SETTINGS_OWNER_DEFAULTS.items():
        out.setdefault(key, default)
    return out


def _reshape_infotags(infotags: Any) -> dict[str, Any]:
    if not isinstance(infotags, dict):
        return {}
    return {str(k): v for k, v in infotags.items()}


def _reshape_kinks(kinks: Any) -> dict[str, str]:
    if not isinstance(kinks, dict):
        return {}
    return {str(k): str(v) for k, v in kinks.items()}


def _reshape_custom_kinks(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Custom kinks come out of working.json as a dict keyed by id (or
    `local:<uuid>` for not-yet-uploaded entries), plus a sibling
    `_custom_kinks_order` array that fixes display order. The ZIP
    flattens to an ordered array, drops tombstones, normalises invalid
    choices to "undecided", and clears the local: prefix to a null id
    so F-list knows to mint a real one at restore."""
    custom_kinks = payload.get("custom_kinks")
    if not isinstance(custom_kinks, dict):
        return []
    order = payload.get("_custom_kinks_order")
    if not isinstance(order, list):
        order = list(custom_kinks.keys())
    out: list[dict[str, Any]] = []
    for key in order:
        if not isinstance(key, str):
            continue
        entry = custom_kinks.get(key)
        if not isinstance(entry, dict):
            continue
        if entry.get("_deleted"):
            continue
        choice = entry.get("choice")
        if not isinstance(choice, str) or choice not in _VALID_CHOICES:
            choice = "undecided"
        out.append(
            {
                "id": None if key.startswith("local:") else key,
                "name": _as_str(entry.get("name")),
                "description": _as_str(entry.get("description")),
                "choice": choice,
            }
        )
    return out


def _reshape_images(
    images: Any,
    *,
    image_extensions: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Working `images` is `[{image_id, description, sort_order}]`. The
    ZIP entry name is `images/<image_id>.<ext>` where ext comes from
    `image_extensions` (built by walking `<char>/images/`). Entries are
    emitted in sort_order; positions are renumbered 0..n-1 in that
    order so the userscript's display matches the user's curation.
    """
    out_list: list[dict[str, Any]] = []
    if isinstance(images, list):
        ordered: list[dict[str, Any]] = []
        for index, entry in enumerate(images):
            if not isinstance(entry, dict):
                continue
            image_id = entry.get("image_id") or entry.get("id")
            if image_id is None:
                continue
            sort_raw = entry.get("sort_order")
            if isinstance(sort_raw, (int, float)):
                sort_val = int(sort_raw)
            elif isinstance(sort_raw, str) and sort_raw:
                try:
                    sort_val = int(sort_raw)
                except ValueError:
                    sort_val = index
            else:
                sort_val = index
            ext = entry.get("extension")
            if not isinstance(ext, str) or not ext:
                ext = (
                    image_extensions.get(str(image_id))
                    if image_extensions
                    else None
                ) or "png"
            ordered.append(
                {
                    "_sort": sort_val,
                    "image_id": str(image_id),
                    "ext": ext,
                    "description": _as_str(entry.get("description")),
                }
            )
        ordered.sort(key=lambda r: r["_sort"])
        for position, row in enumerate(ordered):
            out_list.append(
                {
                    "position": position,
                    "filename": f"images/{row['image_id']}.{row['ext']}",
                    "description": row["description"],
                }
            )
    return {
        "list": out_list,
        "avatar": {"filename": "avatar.png"},
    }


def _reshape_inlines(inlines: Any) -> list[str]:
    """The userscript's restore path doesn't yet upload inlines, but the
    export still carries the id list so a future round-trip can be
    verified against existing exports. dict-form working.json (`{id:
    {hash, extension, nsfw}}`) collapses to the id array."""
    if isinstance(inlines, dict):
        return [str(k) for k in inlines.keys()]
    if isinstance(inlines, list):
        return [str(x) for x in inlines if x is not None]
    return []


def _as_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value)
