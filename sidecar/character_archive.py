"""On-disk archive store for F-list character backups.

Layout under `<userdata>/characters/<character folder>/` (ADR 0001):

    live.json                        last fetched character-data + fetch ts
    workbench/payload.json           the Workbench: the one editable copy
    workbench/meta.json              when it was made and last saved
    backups/<name>.zip               Backups
    images/<image_id>.<ext>          all on-disk image bytes (Pool view in
                                     the UI is whatever isn't currently in
                                     the Workbench's gallery)
    inlines/<sha1>.<ext>             inline images referenced in BBCode
    trash/                           what waits for a human to empty it
    layout.json                      written once the folder has this
                                     shape (`workbench_migration`)

`<image_id>` is digits for F-list-pulled images, `local-<sha8>` for user
uploads that haven't been restored to F-list yet. There's no separate
sha-keyed pool — bytes live in `images/` once, and the renderer treats
files not referenced by the Workbench's gallery as "in the pool" for the
UI. The only path that ever deletes bytes is an explicit user delete
from the pool view (DELETE /images/<image_id>); pulls overwrite the
same id in place, profile→pool moves are pure Workbench edits.

Avatars sit one level up at `<userdata>/avatars/<lowercase_name>.png`
because they survive a character being deleted from the account.

`list_archived_characters()` walks `<userdata>/characters/` so a user
who signs out (or whose character was deleted from F-list) still sees
their archived data in the picker. Each entry carries `has_logs` and
`on_account` flags so the renderer can render status badges.
"""
from __future__ import annotations

import json
import re
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import backup_origin
import paths
from archive_errors import (
    CharacterNotFound,
    InvalidCharacterId,
    NoLive,
    WorkbenchConflict,
    WorkbenchNotKept,
)
from refusals import InvalidFileName

CHARACTERS_DIRNAME = "characters"
AVATARS_DIRNAME = "avatars"
CACHE_DIRNAME = "cache"
LIVE_FILENAME = "live.json"
PULL_STATE_FILENAME = "pull_state.json"
REGISTRY_FILENAME = "_registry.json"

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


def root() -> Path:
    p = paths.user_data_dir() / CHARACTERS_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def avatars_root() -> Path:
    p = paths.user_data_dir() / AVATARS_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def cache_root() -> Path:
    p = paths.user_data_dir() / CACHE_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


# ---- name-keyed folder registry --------------------------------------
#
# Storage was originally keyed by F-list character_id (numeric). That's
# stable across renames but opaque if the user opens the folder in a
# file browser. We now key folders by character name:
#   <userdata>/characters/Spielwiesending/...
# with a sidecar `_registry.json` at characters/ root mapping
# character_id → {name, folder}. character_id stays the API key
# because IDs are stable; folder is just the on-disk slug.
#
# Slug rules (mirror avatar_path_for): if the name matches a
# whitelist of filesystem-safe characters AND isn't a Windows
# reserved name AND has no leading/trailing space-or-dot, use it
# verbatim. Otherwise sha1-hash the lowercased name.

_FOLDER_SAFE_RE = re.compile(r"^[A-Za-z0-9 ._-]+$")
_WIN_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def _is_folder_safe(name: str) -> bool:
    if not isinstance(name, str) or not name:
        return False
    if not _FOLDER_SAFE_RE.fullmatch(name):
        return False
    # Leading/trailing space or dot trips Windows.
    if name[0] in " ." or name[-1] in " .":
        return False
    if name.split(".")[0].upper() in _WIN_RESERVED:
        return False
    # Length cap — most FSes top out at 255 bytes; leave headroom for
    # downstream filenames added inside the folder.
    if len(name.encode("utf-8")) > 120:
        return False
    return True


def _slug_for(name: str) -> str:
    """Return the on-disk folder slug for `name`. Either the name
    itself (if filesystem-safe) or a sha1 prefix fallback. The
    fallback prefix is `c_` so a directory listing makes clear these
    are character archives even when the name itself is unprintable.
    """
    n = (name or "").strip()
    if _is_folder_safe(n):
        return n
    import hashlib
    digest = hashlib.sha1(n.lower().encode("utf-8")).hexdigest()[:16]
    return f"c_{digest}"


def _registry_path() -> Path:
    return root() / REGISTRY_FILENAME


_REGISTRY_CACHE: dict[str, dict[str, str]] | None = None
_REGISTRY_MIGRATED = False
_REGISTRY_LOCK = threading.Lock()


def load_registry() -> dict[str, dict[str, str]]:
    """Return the {character_id: {name, folder}} map. Cached on
    first read; mutators call _invalidate_registry_cache to force
    reload. Triggers the one-shot id→name folder migration on the
    very first call after startup.
    """
    global _REGISTRY_CACHE
    with _REGISTRY_LOCK:
        if _REGISTRY_CACHE is not None:
            return _REGISTRY_CACHE
        _maybe_migrate_id_folders()
        p = _registry_path()
        reg: dict[str, dict[str, str]] = {}
        if p.exists():
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    for k, v in data.items():
                        if (
                            isinstance(k, str)
                            and isinstance(v, dict)
                            and isinstance(v.get("folder"), str)
                        ):
                            reg[k] = {
                                "name": str(v.get("name") or ""),
                                "folder": v["folder"],
                            }
            except (OSError, ValueError):
                pass
        _REGISTRY_CACHE = reg
        return reg


def save_registry(reg: dict[str, dict[str, str]]) -> None:
    global _REGISTRY_CACHE
    with _REGISTRY_LOCK:
        _atomic_write_json(_registry_path(), reg)
        _REGISTRY_CACHE = dict(reg)


def _invalidate_registry_cache() -> None:
    global _REGISTRY_CACHE
    with _REGISTRY_LOCK:
        _REGISTRY_CACHE = None


def register_character(character_id: int | str, name: str) -> str:
    """Upsert character_id → name in the registry. If the on-disk
    folder name doesn't match the current slug, rename it. Returns
    the resolved folder slug.

    Three cases:
      1. Already registered, name unchanged → no-op rename.
      2. Already registered, name changed → rename old_slug → new_slug.
      3. Not registered: check for a legacy id-named folder (created by
         earlier character_dir(id) fallbacks) and rename it into place.

    Rename failures (e.g. file lock on Windows) leave the registry
    pointing at the prior slug — the next pull will retry.
    """
    cid = str(character_id)
    new_slug = _slug_for(name)
    reg = dict(load_registry())
    entry = reg.get(cid) or {}
    # Source folder for a rename: either the registered slug (cases
    # 1+2) or the legacy id-folder if it exists on disk (case 3).
    old_slug = entry.get("folder")
    if not old_slug:
        legacy = root() / cid
        if legacy.exists() and legacy.is_dir():
            old_slug = cid
    if old_slug and old_slug != new_slug:
        old_path = root() / old_slug
        new_path = root() / new_slug
        if old_path.exists() and old_path != new_path:
            if new_path.exists():
                # Collision: leave both alone. Keep the old slug so
                # reads of existing content still work.
                entry = {"name": name, "folder": old_slug}
            else:
                try:
                    old_path.rename(new_path)
                    entry = {"name": name, "folder": new_slug}
                except OSError:
                    entry = {"name": name, "folder": old_slug}
        else:
            entry = {"name": name, "folder": new_slug}
    elif old_slug:
        entry = {"name": name, "folder": old_slug}
    else:
        # Brand-new character with no legacy folder. `write_live`
        # creates it right after registering.
        entry = {"name": name, "folder": new_slug}
    reg[cid] = entry
    save_registry(reg)
    return entry["folder"]


def _maybe_migrate_id_folders() -> None:
    """Scan characters/ for purely-numeric folder names; for each, read
    its live.json, compute the name slug, rename the folder, populate
    the registry. Runs once per process. Idempotent: a second run
    no-ops because there are no numeric folders left.
    """
    global _REGISTRY_MIGRATED
    if _REGISTRY_MIGRATED:
        return
    _REGISTRY_MIGRATED = True

    chars_root = root()
    if not chars_root.exists():
        return

    p = _registry_path()
    reg: dict[str, dict[str, str]] = {}
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                reg = {k: dict(v) for k, v in data.items() if isinstance(v, dict)}
        except (OSError, ValueError):
            pass

    changed = False
    for entry in sorted(chars_root.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name.startswith("_"):
            # Reserved (registry file lives here, future-proofing).
            continue
        live_path = entry / LIVE_FILENAME
        if not live_path.exists():
            continue
        try:
            live = json.loads(live_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        cid_raw = live.get("id")
        cname = live.get("name")
        if not isinstance(cname, str) or not cname.strip():
            continue
        cid = str(cid_raw) if cid_raw is not None else None
        slug = _slug_for(cname)
        # Skip folders that are already the correct slug.
        if entry.name == slug:
            if cid and cid not in reg:
                reg[cid] = {"name": cname, "folder": slug}
                changed = True
            continue
        # Only auto-migrate numeric-named folders (the legacy id-keyed
        # ones). Anything else is user-named or already-migrated; don't
        # touch it.
        if not entry.name.isdigit():
            if cid and cid not in reg:
                reg[cid] = {"name": cname, "folder": entry.name}
                changed = True
            continue
        if cid is None:
            cid = entry.name  # numeric folder name == the id
        new_path = chars_root / slug
        if new_path.exists():
            # Slug collision (two characters with the same name?).
            # Leave the legacy folder in place and just record the
            # mapping under its current numeric name.
            reg[cid] = {"name": cname, "folder": entry.name}
            changed = True
            continue
        try:
            entry.rename(new_path)
        except OSError:
            reg[cid] = {"name": cname, "folder": entry.name}
            changed = True
            continue
        reg[cid] = {"name": cname, "folder": slug}
        changed = True

    if changed:
        try:
            _atomic_write_json(p, reg)
        except OSError:
            pass


def _folder_for(character_id: int | str) -> tuple[Path, bool]:
    """Where a character's folder is, and whether the registry names it."""
    cid = str(character_id)
    reg = load_registry()
    entry = reg.get(cid)
    if entry and entry.get("folder"):
        return root() / entry["folder"], True
    if _is_folder_safe(cid) and not cid.startswith("_"):
        # Unregistered id (no pull yet, or registry corruption) — fall
        # back to the legacy id-named folder so existing data keeps
        # working. Only a name that cannot leave `characters/` or hit
        # its reserved `_` entries gets here: on Windows a backslash
        # is a separator, so `..\..\x` would otherwise escape.
        return root() / cid, False
    raise InvalidCharacterId(cid)


def require_character_id(character_id: int | str) -> None:
    """Refuse an id no character folder could have (`InvalidCharacterId`),
    whether or not the archive holds the character."""
    _folder_for(character_id)


def character_dir(character_id: int | str) -> Path:
    """Find a character's folder. Never creates it.

    A character the archive holds is one the registry names (a Pull
    registered it) or one with a legacy id-named folder on disk. Any
    other safe id raises `CharacterNotFound`; an unsafe one raises
    `InvalidCharacterId`. Only `create_character_dir` makes a folder.
    """
    p, registered = _folder_for(character_id)
    if not registered and not p.is_dir():
        raise CharacterNotFound(str(character_id))
    return p


def create_character_dir(character_id: int | str) -> Path:
    """Create a character's folder: the moment a character comes into
    the archive. A Pull (`write_live`) and a set-bundle import call
    this; every other path finds the character with `character_dir`."""
    p, _registered = _folder_for(character_id)
    p.mkdir(parents=True, exist_ok=True)
    return p


def images_dir(character_id: int | str) -> Path:
    p = character_dir(character_id) / "images"
    p.mkdir(parents=True, exist_ok=True)
    return p


def inlines_dir(character_id: int | str) -> Path:
    p = character_dir(character_id) / "inlines"
    p.mkdir(parents=True, exist_ok=True)
    return p


def backups_dir(character_id: int | str) -> Path:
    """Per-character `backups/` dir — full ZIP backups, restorable via
    the userscript. Created lazily by `save_zip_backup`."""
    p = character_dir(character_id) / "backups"
    p.mkdir(parents=True, exist_ok=True)
    return p


_BACKUP_NAMES_FILENAME = "_names.json"


def _names_file(character_id: int | str) -> Path:
    return backups_dir(character_id) / _BACKUP_NAMES_FILENAME


def _read_backup_names(character_id: int | str) -> dict[str, str]:
    """Map of backup-filename → user-set name, persisted alongside
    the ZIPs. Keeping names in a sidecar JSON file (instead of inside
    each ZIP's `backup-meta.json`) means renames don't have to
    re-pack the ZIP. Missing file or corrupt JSON returns an empty
    dict — the UI just shows the timestamp-derived default name."""
    p = _names_file(character_id)
    if not p.exists():
        return {}
    try:
        raw = p.read_text(encoding="utf-8")
        parsed = json.loads(raw)
    except (OSError, ValueError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in parsed.items():
        if isinstance(k, str) and isinstance(v, str):
            out[k] = v
    return out


def _write_backup_names(
    character_id: int | str, names: dict[str, str]
) -> None:
    p = _names_file(character_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(
        json.dumps(names, indent=2, ensure_ascii=False, sort_keys=True),
        encoding="utf-8",
    )
    tmp.replace(p)


def rename_zip_backup(
    character_id: int | str, filename: str, name: str
) -> None:
    """Persist a user-set name for one backup. The ZIP file itself is
    untouched (renames don't need to rewrite the archive bytes); the
    name only lives in the sidecar `_names.json` map. Empty string
    clears the entry so the UI falls back to the timestamp default."""
    require_backup_filename(filename)
    target = backups_dir(character_id) / filename
    if not target.exists():
        raise FileNotFoundError(str(target))
    names = _read_backup_names(character_id)
    if name.strip():
        names[filename] = name.strip()
    else:
        names.pop(filename, None)
    _write_backup_names(character_id, names)


def backup_name(character_id: int | str, filename: str) -> str | None:
    """The user-set name of one Backup, or None when it has none."""
    return _read_backup_names(character_id).get(filename) or None


def forget_backup_name(character_id: int | str, filename: str) -> None:
    """Drop the user-set name for a backup that's about to be deleted.
    Called by the DELETE endpoint so `_names.json` doesn't carry
    references to bytes that no longer exist."""
    names = _read_backup_names(character_id)
    if filename in names:
        names.pop(filename, None)
        _write_backup_names(character_id, names)


# ---- live read/write ---------------------------------------------------


def _publish(event: str, **data: Any) -> None:
    """Announce a change on the event bus, if one is running.

    Publishing lives here rather than in the callers so *every* writer
    is covered — the REST routes the window calls and the MCP tools a
    model calls alike. Imported lazily and failure-swallowing: a
    notification is never worth failing a write for, and the archive
    must stay importable in tests that don't run a loop.
    """
    try:
        from services import events

        events.publish(event, **data)
    except Exception:  # noqa: BLE001
        pass


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """Atomic JSON write. Retries `Path.replace` once on OSError with a
    short jittered backoff — OneDrive / Dropbox-synced directories can
    return EBUSY for milliseconds when their sync agent has the target
    file open. The retry costs nothing on healthy filesystems and is
    the documented fix for the open question in PHASE7_TIER2_PLAN §1.3
    (QA P3-6).

    If the retry also fails, the leftover `.tmp` is unlinked so the
    archive directory doesn't accumulate orphan temp files
    (Round 1 verifier follow-up).
    """
    import random
    import time as _time

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    try:
        tmp.replace(path)
    except OSError:
        _time.sleep(0.05 + random.random() * 0.05)
        try:
            tmp.replace(path)
        except OSError:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise


def write_live(character_id: int | str, payload: dict[str, Any]) -> None:
    """Overwrite the Live snapshot. Caller is responsible for stamping
    `fetched_at` into the payload before calling.

    Also registers the character_id ↔ name in the folder registry and
    renames the on-disk folder if the name changed since the last
    write (e.g. F-list renames are detected the next time we pull
    that character). The registry write happens BEFORE the live.json
    write so the live.json lands in the new folder, not the stale one.
    """
    name = payload.get("name")
    if isinstance(name, str) and name.strip():
        register_character(character_id, name)
    _atomic_write_json(create_character_dir(character_id) / LIVE_FILENAME, payload)
    _publish("live-changed", character_id=str(character_id))


def read_live(character_id: int | str) -> dict[str, Any] | None:
    p = character_dir(character_id) / LIVE_FILENAME
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


# Fields that are not F-list-side state: the Pull stamps `fetched_at`
# every time, so a hash that counted it would never match.
_LIVE_HASH_EXCLUDE = {"fetched_at"}


def live_content_hash(live: dict[str, Any]) -> str:
    """Canonical-JSON sha256 of `live`, ignoring fields that aren't
    really part of the F-list profile state (currently just
    `fetched_at`). A Pull compares it to tell whether F-list changed,
    and the ZIP backup dedup uses the same shape."""
    import hashlib

    filtered = {k: v for k, v in live.items() if k not in _LIVE_HASH_EXCLUDE}
    canonical = json.dumps(filtered, sort_keys=True, ensure_ascii=False).encode(
        "utf-8"
    )
    return hashlib.sha256(canonical).hexdigest()


_ZIP_BACKUP_FILE_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-(\d+))?\.zip$"
)


def require_backup_filename(filename: str) -> None:
    """Refuse a name that is not a Backup file name, before any path is
    built from it, so a crafted `../` name reads or deletes nothing.
    A caller hears 400 `invalid_file_name`."""
    if not isinstance(filename, str) or not _ZIP_BACKUP_FILE_RE.fullmatch(filename):
        raise InvalidFileName("invalid backup filename")


def _zip_backup_filename(now: float | None = None) -> str:
    """`YYYY-MM-DDTHHMMSSZ.zip` — filesystem-safe ISO basic form. The
    explicit `Z` makes it clear the timestamp is UTC so a user copying
    the file off-machine isn't confused by their local-time mtime."""
    import datetime as _dt

    ts = _dt.datetime.fromtimestamp(
        time.time() if now is None else now, tz=_dt.timezone.utc
    )
    return ts.strftime("%Y-%m-%dT%H%M%SZ") + ".zip"


def _free_backup_path(folder: Path, stem: str) -> Path:
    """`<folder>/<stem>.zip`, or `<stem>-N.zip` with the first N not on
    disk yet, so a same-second second Backup never overwrites the first."""
    target = folder / f"{stem}.zip"
    i = 1
    while target.exists():
        target = folder / f"{stem}-{i}.zip"
        i += 1
    return target


def free_backup_filename(character_id: int | str, filename: str) -> str:
    """A Backup file name like `filename` that nothing in the Backup list
    holds yet: `filename` itself, or the next free `-N` one beside it."""
    require_backup_filename(filename)
    stem = re.sub(r"-\d+$", "", filename[: -len(".zip")])
    target = backups_dir(character_id) / filename
    if not target.exists():
        return filename
    return _free_backup_path(backups_dir(character_id), stem).name


def free_backup_path(folder: Path) -> Path:
    """Where a Backup taken now goes in `folder`: named for this second,
    with the first free `-N` suffix when that name is taken."""
    return _free_backup_path(folder, _zip_backup_filename().removesuffix(".zip"))


def write_backup_zip(character_id: int | str, data: bytes) -> Path:
    """Store `data` as a new Backup of the character, under the Backup
    file name the list recognises, and return where it went. Written
    through a temp file, so a crash leaves no half-written Backup."""
    target = free_backup_path(backups_dir(character_id))
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(target)
    return target


#: The name earlier versions gave the Backup before an Upload, which the
#: Backup list never recognised: `pre-restore-YYYY-MM-DDTHH-MM-SS.zip`, UTC.
_OLD_PRE_UPLOAD_FILE_RE = re.compile(
    r"^pre-restore-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.zip$"
)


def adopt_old_pre_upload_backups() -> int:
    """Give every Backup an earlier version took before an Upload the
    Backup file name, so the list shows it. Run at startup.

    A rename and nothing else: the file keeps every byte, and a name
    already taken gets the same-second suffix rather than overwriting.
    Returns how many were adopted.
    """
    adopted = 0
    for folder in root().iterdir():
        backups = folder / "backups"
        if not backups.is_dir():
            continue
        for entry in list(backups.iterdir()):
            m = _OLD_PRE_UPLOAD_FILE_RE.fullmatch(entry.name)
            if not m or not entry.is_file():
                continue
            day, hh, mm, ss = m.groups()
            target = _free_backup_path(backups, f"{day}T{hh}{mm}{ss}Z")
            try:
                entry.rename(target)
            except OSError as exc:
                print(f"could not adopt {entry}: {exc}", file=sys.stderr)
                continue
            adopted += 1
    return adopted


def _live_to_zip_payload(live: dict[str, Any]) -> dict[str, Any]:
    """Reshape Live JSON into the working-copy payload `zip_serialise.
    build_zip` expects. Mirrors the renderer's `seedWorkingFromLive` —
    we keep the helper here (instead of pulling from server.py) so the
    character-archive module can build a ZIP without an HTTP round-trip
    from `/backup-all`."""
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
            row = dict(entry)
            row.setdefault("image_id", str(iid))
            row.setdefault("position", index)
            gallery.append(row)
    out["images"] = gallery
    return out


def list_zip_backups(character_id: int | str) -> list[dict[str, Any]]:
    """List ZIP backups newest first. Each entry:
    `{filename, created_at, size, kind, source, occasion, name}`.
    `source` and `occasion` come from `backup-meta.json` too; a Backup
    that does not record them is listed with source "unknown" and
    occasion null (see `backup_origin.read`). Filenames are the
    ISO-basic form written by `save_zip_backup`. `kind` comes from
    the embedded `backup-meta.json` (added 2026-06-17); older backups
    without that file get `"unknown"` so the UI can still bucket
    them. `name` is the user-set rename from `_names.json` or `null`
    when the user hasn't renamed it yet (UI then falls back to a
    timestamp-derived label).

    Tiebreaker: same-second writes are disambiguated by the `-N`
    suffix counter on the filename; higher N = more recent. The sort
    key must reflect that so the dedup check always compares against
    the *truly* latest ZIP — relying on lex order alone would put the
    no-suffix (oldest) file at the top because `.` > `-` in ASCII.
    """
    import datetime as _dt
    import zipfile

    names = _read_backup_names(character_id)
    out: list[dict[str, Any]] = []
    p = character_dir(character_id) / "backups"
    if not p.exists():
        return out
    for entry in p.iterdir():
        if not entry.is_file():
            continue
        # Skip the names sidecar file — it lives in this dir but
        # isn't a backup of its own.
        if entry.name == _BACKUP_NAMES_FILENAME:
            continue
        m = _ZIP_BACKUP_FILE_RE.fullmatch(entry.name)
        if not m:
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        ts = _dt.datetime(
            int(m.group(1)),
            int(m.group(2)),
            int(m.group(3)),
            int(m.group(4)),
            int(m.group(5)),
            int(m.group(6)),
            tzinfo=_dt.timezone.utc,
        )
        suffix = int(m.group(7)) if m.group(7) else 0
        # Cheap peek: open the ZIP just to read backup-meta.json.
        # Falls through to "unknown" on legacy files, corrupt ZIPs, or
        # missing meta — listing every backup must be fast even when
        # there are hundreds, so we don't load other ZIP entries here.
        kind = "unknown"
        meta: Any = None
        try:
            with zipfile.ZipFile(entry, "r") as zf:
                raw = zf.read("backup-meta.json").decode("utf-8")
            meta = json.loads(raw)
            if isinstance(meta, dict) and isinstance(meta.get("kind"), str):
                kind = meta["kind"]
        except (KeyError, OSError, ValueError, zipfile.BadZipFile):
            pass
        out.append(
            {
                "filename": entry.name,
                "created_at": int(ts.timestamp()),
                "_suffix": suffix,
                "size": stat.st_size,
                "kind": kind,
                **backup_origin.read(meta),
                "name": names.get(entry.name),
            }
        )
    out.sort(key=lambda r: (r["created_at"], r["_suffix"]), reverse=True)
    for row in out:
        row.pop("_suffix", None)
    return out


def zip_backup_meta(character_id: int | str, filename: str) -> dict[str, Any]:
    """A Backup's `backup-meta.json`; empty for one without it (older
    Backups), and for a file that is not a readable Backup."""
    import zipfile

    require_backup_filename(filename)
    try:
        with zipfile.ZipFile(backups_dir(character_id) / filename, "r") as zf:
            meta = json.loads(zf.read("backup-meta.json").decode("utf-8"))
    except (KeyError, OSError, ValueError, zipfile.BadZipFile):
        return {}
    return meta if isinstance(meta, dict) else {}


def latest_zip_backup_content_hash(
    character_id: int | str, source: str | None = None
) -> str | None:
    """Hash of the most recent ZIP backup's `character.json`, in the same
    canonical-JSON shape used by `live_content_hash`. Used by
    `save_zip_backup` to dedup against an unchanged Live so two
    Back-up-all clicks in a row don't write two identical ZIPs.

    With `source`, only Backups holding that source count: a Backup of
    Live is compared with the newest Backup of Live, not with a manual
    Backup of the Workbench taken in between."""
    import hashlib
    import zipfile

    rows = list_zip_backups(character_id)
    if source is not None:
        rows = [r for r in rows if r.get("source") == source]
    if not rows:
        return None
    target = backups_dir(character_id) / rows[0]["filename"]
    try:
        with zipfile.ZipFile(target, "r") as zf:
            raw = zf.read("character.json").decode("utf-8")
        manifest = json.loads(raw)
    except (OSError, KeyError, ValueError, zipfile.BadZipFile):
        return None
    # `meta.exportedAt` is the only field that changes when nothing
    # else did — strip it before hashing so dedup works the way the
    # snapshot path does.
    if isinstance(manifest, dict):
        meta = manifest.get("meta")
        if isinstance(meta, dict):
            meta = dict(meta)
            meta.pop("exportedAt", None)
            manifest = {**manifest, "meta": meta}
    canonical = json.dumps(manifest, sort_keys=True, ensure_ascii=False).encode(
        "utf-8"
    )
    return hashlib.sha256(canonical).hexdigest()


def _zip_payload_content_hash(payload: dict[str, Any]) -> str:
    """Hash of the post-`to_zip_character_json` shape with `meta.
    exportedAt` zeroed — so a fresh Live that round-trips to the same
    ZIP shape hashes to the same value as the latest existing ZIP."""
    import hashlib

    meta = payload.get("meta")
    if isinstance(meta, dict):
        meta = dict(meta)
        meta.pop("exportedAt", None)
        payload = {**payload, "meta": meta}
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode(
        "utf-8"
    )
    return hashlib.sha256(canonical).hexdigest()


def save_zip_backup(
    character_id: int | str,
    *,
    source: str,
    occasion: str,
    force: bool = False,
    kind: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """Pack the character's Live or Workbench into
    `<character>/backups/<ISO>.zip` — userscript-restoreable, includes
    every gallery image still on disk plus the avatar.

    `source` is what the Backup holds: `live` (what F-list showed at the
    last Pull) or `workbench` (the user's edits; a Workbench not created
    yet holds what Live seeds it with). `occasion` is why it was made:
    `manual`, `before-upload`, `before-restore`, `migration` or
    `backup-all` (see `backup_origin`). Both go into the ZIP's
    `backup-meta.json`, together with the older `kind` the extension
    sorts by — the occasion's own unless `kind` is given.

    Dedup: unless `force`, nothing is written when the newest Backup of
    the same source already holds this content; that returns
    `{saved: False, reason: 'unchanged'}`. `note` is reserved for a
    future free-text annotation surface.

    Returns one of:
      `{saved: True, path, filename, created_at, size, kind, source, occasion}`
      `{saved: False, reason: 'unchanged'}`
      `{saved: False, reason: 'no_live'}`
    """
    import zip_serialise

    origin = backup_origin.meta(source, occasion, kind=kind)

    # Heal before packing. `build_zip` drops gallery rows whose file is
    # missing, so a backup taken over a broken gallery silently lacks
    # the images — and the extension then deletes them from the profile
    # for not being in the backup. That chain cost a user their gallery
    # once; a backup must never be the weak link in it.
    live = read_live(character_id)
    if live is not None:
        try:
            repair_gallery(character_id)
        except Exception as exc:  # noqa: BLE001 - never block a backup
            print(f"gallery repair before backup failed: {exc}", file=sys.stderr)

    working = None
    if source == backup_origin.WORKBENCH:
        bench = read_workbench(character_id)
        if bench is not None:
            working = bench.payload
    if working is None:
        if live is None:
            return {"saved": False, "reason": "no_live"}
        working = _live_to_zip_payload(live)
    image_extensions: dict[str, str] = {}
    img_dir = images_dir(character_id)
    if img_dir.exists():
        for entry in img_dir.iterdir():
            if not entry.is_file():
                continue
            stem = entry.stem
            ext = entry.suffix.lstrip(".").lower()
            if stem and ext:
                image_extensions[stem] = ext
    candidate_payload = zip_serialise.to_zip_character_json(
        working, image_extensions=image_extensions
    )

    if not force:
        candidate_hash = _zip_payload_content_hash(candidate_payload)
        prior_hash = latest_zip_backup_content_hash(character_id, source)
        if prior_hash == candidate_hash:
            return {"saved": False, "reason": "unchanged"}

    # Resolve avatar path from the character name carried in the Live
    # payload. F-list allows Unicode names; `avatar_path_for` already
    # handles that.
    avatar_path: Path | None = None
    char = working.get("character")
    if isinstance(char, dict):
        nm = char.get("name")
        if isinstance(nm, str) and nm:
            candidate_avatar = avatar_path_for(nm)
            if candidate_avatar.exists():
                avatar_path = candidate_avatar

    data = zip_serialise.build_zip(
        character_id,
        working,
        images_dir=img_dir,
        avatar_path=avatar_path,
        backup_kind=origin.get("kind"),
        backup_note=note,
        backup_source=source,
        backup_occasion=occasion,
    )

    target = write_backup_zip(character_id, data)
    return {
        "saved": True,
        "path": str(target),
        "filename": target.name,
        "created_at": int(time.time()),
        "size": len(data),
        "kind": origin.get("kind", "unknown"),
        "source": source,
        "occasion": occasion,
    }


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
    return character_dir(character_id) / WORKBENCH_DIRNAME


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


def _read_workbench_payload(character_id: int | str) -> dict[str, Any] | None:
    try:
        payload = json.loads(_workbench_payload_path(character_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


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


def _store_workbench(
    character_id: int | str, payload: dict[str, Any], *, created_at: int | None = None
) -> str:
    """Write the payload and its dates atomically, announce the change,
    and return the new etag. No etag check: callers do that."""
    path = _workbench_payload_path(character_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write_json(path, payload)
    now = int(time.time())
    if created_at is None:
        info = workbench_info(character_id)
        created_at = info.created_at if info is not None else now
    _atomic_write_json(
        _workbench_meta_path(character_id),
        {"created_at": created_at, "updated_at": now},
    )
    etag = _file_sha256(path)
    assert etag is not None
    _publish("sets-changed", character_id=str(character_id))
    _publish(
        "set-payload-changed",
        character_id=str(character_id),
        set_id=WORKBENCH_DIRNAME,
        etag=etag,
    )
    return etag


def read_workbench(
    character_id: int | str, *, create: bool = False
) -> WorkbenchRead | None:
    """The character's Workbench, or None when it has none.

    `create=True` makes it from Live first if needed; None then means
    there is no Live to make it from.
    """
    created = False
    payload = _read_workbench_payload(character_id)
    if payload is None and create and not _workbench_payload_path(character_id).exists():
        live = read_live(character_id)
        if live is None:
            return None
        _store_workbench(
            character_id, _seed_payload_from_live(live), created_at=int(time.time())
        )
        payload = _read_workbench_payload(character_id)
        created = True
    etag = _file_sha256(_workbench_payload_path(character_id))
    if payload is None or etag is None:
        return None
    return WorkbenchRead(payload=payload, etag=etag, created=created)


def workbench_etag(character_id: int | str) -> str | None:
    """The etag of the character's Workbench; None when it has none."""
    return _file_sha256(_workbench_payload_path(character_id))


def write_workbench(
    character_id: int | str,
    payload: dict[str, Any],
    *,
    expected_etag: str | None,
) -> str:
    """Replace the character's Workbench; return the new etag.

    The save contract: `expected_etag` must be the etag of what is on
    disk now. Without one this raises `EtagRequired`, with a stale one
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


@dataclass(frozen=True)
class WorkbenchReplaced:
    """What a whole-Workbench replacement did: the new payload and its
    etag, and `kept`, the `before-restore` Backup holding the Workbench
    that was replaced, as `{filename, created_at}`. `kept` is None when
    the character had no Workbench yet, so there was nothing to keep.
    """

    payload: dict[str, Any]
    etag: str
    kept: dict[str, Any] | None


def _keep_workbench_before_replacing(character_id: int | str) -> dict[str, Any]:
    """Save the Workbench as a Backup (source `workbench`, occasion
    `before-restore`) before something replaces all of it (ADR 0003).

    Always taken, never deduplicated: the Backup is the undo of the
    replacement. Raises `WorkbenchNotKept` when the Backup cannot be
    written; the caller must then leave the Workbench alone.
    """
    try:
        result = save_zip_backup(
            character_id,
            source=backup_origin.WORKBENCH,
            occasion=backup_origin.BEFORE_RESTORE,
            force=True,
        )
    except Exception as exc:  # noqa: BLE001 - any failure means "not kept"
        raise WorkbenchNotKept(
            "The Workbench could not be saved as a Backup first, so it"
            f" was not replaced: {exc}"
        ) from exc
    if not result.get("saved"):
        raise WorkbenchNotKept(
            "The Workbench could not be saved as a Backup first, so it"
            f" was not replaced: {result.get('reason')}"
        )
    return {"filename": result["filename"], "created_at": result["created_at"]}


def _replace_workbench(
    character_id: int | str, payload: dict[str, Any]
) -> WorkbenchReplaced:
    """Keep the Workbench as a Backup, then overwrite it with `payload`.

    A Workbench this call had to make from Live holds no edits, so it
    is not kept. The write goes against the etag read before the Backup:
    a save that lands in between is refused as `WorkbenchConflict`
    rather than lost, since the Backup would not hold it.
    """
    current = read_workbench(character_id, create=True)
    if current is None:
        raise NoLive("no Live to make a Workbench from")
    kept = None if current.created else _keep_workbench_before_replacing(character_id)
    try:
        etag = write_workbench(character_id, payload, expected_etag=current.etag)
    except EtagMismatch as exc:
        raise WorkbenchConflict(
            "etag_mismatch",
            "The Workbench changed while it was being replaced, so it was"
            " not replaced. Try again.",
            exc.current_etag,
        ) from exc
    return WorkbenchReplaced(payload=payload, etag=etag, kept=kept)


def reset_workbench_to_live(character_id: int | str) -> WorkbenchReplaced:
    """Throw away every edit: the Workbench becomes a fresh copy of Live.

    The Workbench it replaces is kept as a `before-restore` Backup
    first; see `_keep_workbench_before_replacing`. Raises `NoLive` when
    the character has no Live to reset to.
    """
    live = read_live(character_id)
    if live is None:
        raise NoLive("no Live to reset the Workbench to")
    return _replace_workbench(character_id, _seed_payload_from_live(live))


def load_zip_backup_into_workbench(
    character_id: int | str, backup_filename: str
) -> WorkbenchReplaced:
    """Restore: replace the Workbench's payload with a Backup's contents.

    The Backup is read and checked first; only then is the Workbench it
    replaces kept as a `before-restore` Backup, and only once that is
    written is the Workbench overwritten. Raises KeyError for a Backup
    that holds no profile to load.
    """
    import zipfile

    require_backup_filename(backup_filename)
    target = backups_dir(character_id) / backup_filename
    if not target.exists() or not target.is_file():
        raise FileNotFoundError(str(target))
    try:
        with zipfile.ZipFile(target, "r") as zf:
            raw = zf.read("working.json").decode("utf-8")
    except zipfile.BadZipFile as exc:
        raise ValueError(f"corrupt backup file: {exc}") from exc
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("backup working.json is not an object")
    return _replace_workbench(character_id, backup_payload(payload))


def _seed_payload_from_live(live: dict[str, Any]) -> dict[str, Any]:
    """Build a fresh working payload from a Live snapshot.

    The one implementation on the Python side — `services.payload_ops`
    re-exports it as `seed_from_live`, and both the set-create path and
    the export fallback go through that. It mirrors the renderer's
    `seedWorkingFromLive`; the two have to stay in step, because a set
    created in the sidecar and one created in the UI must be the same
    shape."""
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


# ---- image storage ----------------------------------------------------


# Whitelist for safe filename segments. The pre-dot section must have
# at least one non-`.` character, which is what excludes `.` and `..`
# (both would otherwise satisfy `[A-Za-z0-9_.-]+`). Without this, the
# inline_path("..") case resolved to the parent directory — caught by
# the test_inline_path_rejects_unsafe_basename test added 2026-05-30.
_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$")

# `<image_id>.<ext>` filename in `images/`. image_id is digits for F-list
# images, `local-<8 hex>` for pool-only user uploads not yet on F-list.
# Always used with fullmatch.
_IMAGE_ID_RE = re.compile(r"[A-Za-z0-9_-]+")
_IMAGE_FILE_RE = re.compile(r"([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)")


def require_image_filename(filename: str) -> None:
    """Refuse a name that is not `<image_id>.<ext>` (an image, a trashed
    file, an inline), before any path is built from it. A caller hears
    400 `invalid_file_name`."""
    if not isinstance(filename, str) or not _IMAGE_FILE_RE.fullmatch(filename):
        raise InvalidFileName("invalid image filename")


def require_image_id(image_id: str) -> None:
    """Refuse an image id that could not be the stem of an image file
    name. A caller hears 400 `invalid_file_name`."""
    if not isinstance(image_id, str) or not _IMAGE_ID_RE.fullmatch(image_id):
        raise InvalidFileName("invalid image_id")


# ---- pull integrity manifest -----------------------------------------


def pull_state_path(character_id: int | str) -> Path:
    return character_dir(character_id) / PULL_STATE_FILENAME


def write_pull_state(
    character_id: int | str,
    expected_image_ids: Iterable[dict[str, Any]],
    started_at: int,
    finished_at: int | None,
) -> None:
    """Record the manifest of what a pull attempted. Written twice per
    pull — once at the start of the image loop with `finished_at=None`,
    once at the end with `finished_at=<unix>`. A `None` finished_at on
    next launch means the pull was killed mid-flight (sleep, crash,
    network drop) — `compute_pull_status` surfaces that to the renderer.

    expected_image_ids: list of {"image_id": str, "extension": str}
    """
    normalized: list[dict[str, str]] = []
    for entry in expected_image_ids:
        if not isinstance(entry, dict):
            continue
        iid = entry.get("image_id")
        ext = entry.get("extension")
        if iid and ext:
            normalized.append({"image_id": str(iid), "extension": str(ext)})
    _atomic_write_json(
        pull_state_path(character_id),
        {
            "started_at": started_at,
            "finished_at": finished_at,
            "expected_image_ids": normalized,
        },
    )


def read_pull_state(character_id: int | str) -> dict[str, Any] | None:
    p = pull_state_path(character_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _images_present_ids(character_id: int | str) -> set[str]:
    """F-list image_ids currently present in `images/`. Synthetic
    `local-*` ids are excluded — they're user uploads the userscript
    hasn't restored to F-list yet, not part of the F-list mirror that
    compute_pull_status reconciles against."""
    out: set[str] = set()
    d = images_dir(character_id)
    if not d.exists():
        return out
    for p in d.iterdir():
        if not p.is_file():
            continue
        m = _IMAGE_FILE_RE.fullmatch(p.name)
        if not m:
            continue
        iid = m.group(1)
        if iid.startswith("local-"):
            continue
        out.add(iid)
    return out


def compute_pull_status(character_id: int | str) -> dict[str, Any]:
    """Reconcile manifest with disk and return a renderer-ready status.

    status:
      'never_pulled' — no live.json yet
      'unknown'      — live.json exists but no manifest (pre-fix archive)
      'interrupted'  — manifest's finished_at is null (killed mid-pull)
      'partial'      — finished_at set but some expected images aren't on disk
      'complete'     — finished_at set and every expected image is present
    """
    live = read_live(character_id)
    if live is None:
        return {
            "status": "never_pulled",
            "missing_image_ids": [],
            "expected": 0,
            "present": 0,
            "last_attempt_ts": None,
        }
    state = read_pull_state(character_id)
    present_ids = _images_present_ids(character_id)
    if state is None:
        # Legacy archive — no manifest. Best-guess from live.json's image
        # list; treat as complete if disk matches, partial otherwise. Means
        # users with archives from before this commit still get the warning
        # surfaced if their previous pull was actually incomplete.
        expected = _expected_from_live(live)
        missing = [e for e in expected if e["image_id"] not in present_ids]
        return {
            "status": "complete" if not missing else "partial",
            "missing_image_ids": missing,
            "expected": len(expected),
            "present": len(expected) - len(missing),
            "last_attempt_ts": live.get("fetched_at"),
        }
    expected = state.get("expected_image_ids") or []
    expected = [e for e in expected if isinstance(e, dict) and e.get("image_id") and e.get("extension")]
    missing = [e for e in expected if str(e["image_id"]) not in present_ids]
    finished_at = state.get("finished_at")
    started_at = state.get("started_at")
    last_attempt_ts = finished_at or started_at or live.get("fetched_at")
    if finished_at is None:
        status = "interrupted"
    elif missing:
        status = "partial"
    else:
        status = "complete"
    return {
        "status": status,
        "missing_image_ids": missing,
        "expected": len(expected),
        "present": len(expected) - len(missing),
        "last_attempt_ts": last_attempt_ts,
    }


def _expected_from_live(live: dict[str, Any]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for img in (live.get("images") or []):
        if not isinstance(img, dict):
            continue
        iid = img.get("image_id") or img.get("id")
        ext = img.get("extension")
        if iid and ext:
            out.append({"image_id": str(iid), "extension": str(ext)})
    return out


def image_path(character_id: int | str, image_id: str, ext: str) -> Path:
    """`images/<image_id>.<ext>`. Both parts are validated against a
    conservative whitelist so a hostile filename in a payload can't
    escape the character's archive directory."""
    if not _SAFE_NAME_RE.fullmatch(image_id):
        raise ValueError(f"unsafe image_id: {image_id!r}")
    if not _SAFE_NAME_RE.fullmatch(ext):
        raise ValueError(f"unsafe extension: {ext!r}")
    return images_dir(character_id) / f"{image_id}.{ext}"


def inline_path(character_id: int | str, basename: str) -> Path:
    """`inlines/<basename>`. The basename is the CDN URL's last segment
    (typically `<sha1>.<ext>`); validated against the safe-name regex."""
    if not _SAFE_NAME_RE.fullmatch(basename):
        raise ValueError(f"unsafe inline name: {basename!r}")
    return inlines_dir(character_id) / basename


# ---- per-character images/ (unified store, image_id-keyed) -----------

# F-list only accepts these on upload, so the image store mirrors that
# whitelist — the userscript would reject anything else on restore.
_IMAGE_EXTS = frozenset({"png", "jpg", "jpeg", "gif"})


def normalise_image_ext(ext: str) -> str:
    """Lowercase + jpeg→jpg + whitelist check. Raises ValueError on
    anything outside `{png, jpg, gif}`. Public so the server's pull loop
    can normalise raw extensions from F-list without reaching into a
    private."""
    e = ext.lower().lstrip(".")
    if e == "jpeg":
        e = "jpg"
    if e not in {"png", "jpg", "gif"}:
        raise ValueError(f"unsupported image extension: {ext!r}")
    return e


def _hash_bytes(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


def detect_image_ext(data: bytes) -> str | None:
    """Sniff PNG/JPEG/GIF magic bytes and return the canonical extension
    ('png'/'jpg'/'gif'). Returns None when the bytes don't match any
    supported format — callers should reject the upload."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        return "gif"
    return None


def list_character_images(character_id: int | str) -> list[dict[str, Any]]:
    """Walk `images/` and return one row per file: `{image_id, extension,
    size, added_at}`. `added_at` is the file mtime (unix seconds) so the
    renderer can sort the Pool pane newest-first. The renderer pairs
    these rows with `description`/`sort_order` from the Workbench to
    decide which are on the profile vs. in the pool view.

    Side-effect: triggers the v4 → v5 pool migration if a legacy pool/
    directory is present, then collapses any `local-<sha8>` files whose
    bytes match an existing real-id file. Both are idempotent — no-ops
    once the disk is clean."""
    migrate_v4_pool_to_images(character_id)
    collapse_local_duplicates(character_id)
    out: list[dict[str, Any]] = []
    d = images_dir(character_id)
    if not d.exists():
        return out
    for entry in d.iterdir():
        if not entry.is_file():
            continue
        m = _IMAGE_FILE_RE.fullmatch(entry.name)
        if not m:
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        out.append(
            {
                "image_id": m.group(1),
                "extension": m.group(2).lower(),
                "size": stat.st_size,
                "added_at": int(stat.st_mtime),
            }
        )
    out.sort(key=lambda r: r["image_id"])
    return out


def write_character_image(
    character_id: int | str,
    image_id: str,
    ext: str,
    data: bytes,
) -> None:
    """Atomically write `data` to `images/<image_id>.<ext>`. Idempotent
    — re-calling with the same id+ext overwrites in place (pull loop
    relies on this for re-pulls). `image_id` and `ext` are validated
    against the safe-name regex; `ext` is normalised (jpeg → jpg)."""
    if not _SAFE_NAME_RE.fullmatch(image_id):
        raise ValueError(f"unsafe image_id: {image_id!r}")
    ext_n = normalise_image_ext(ext)
    target = images_dir(character_id) / f"{image_id}.{ext_n}"
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(target)


def find_image_with_sha(
    character_id: int | str, sha: str
) -> Path | None:
    """Return the first file in `images/` whose bytes hash to `sha`, or
    None. Cheap pre-filter on the sha-prefix in the filename (real
    F-list ids won't match by accident, but `local-<sha8>` files will);
    falls back to a full directory scan with byte-comparison for real-id
    files since their basenames don't carry the sha. Best-effort — any
    OSError on a single entry is skipped, not raised."""
    d = images_dir(character_id)
    if not d.exists():
        return None
    for entry in d.iterdir():
        if not entry.is_file():
            continue
        if not _IMAGE_FILE_RE.fullmatch(entry.name):
            continue
        try:
            if entry.stat().st_size == 0:
                continue
            if file_sha256(entry) == sha:
                return entry
        except OSError:
            continue
    return None


#: (path, size, mtime_ns) -> sha256. A batch import checks every new
#: file against the whole folder; without this each check re-reads and
#: re-hashes every image on disk. Keyed on size and mtime so a file
#: rewritten in place is hashed again.
_sha_cache: dict[tuple[str, int, int], str] = {}


def file_sha256(path: Path) -> str:
    """sha256 of a file's bytes, cached per (path, size, mtime). Raises
    OSError like `read_bytes` would."""
    stat = path.stat()
    key = (str(path), stat.st_size, stat.st_mtime_ns)
    cached = _sha_cache.get(key)
    if cached is not None:
        return cached
    digest = _hash_bytes(path.read_bytes())
    _sha_cache[key] = digest
    return digest


def collapse_local_duplicates(character_id: int | str) -> int:
    """Fold every `local-<sha8>` image whose bytes match a real-id file
    into that real id, in the character's Workbench.

    The cure for an archive where the same picture sits in the pool
    twice — once as the file that came from F-list, once as the local
    upload it was made from. Returns how many locals were folded in.

    Idempotent, and best-effort: a single unreadable file is skipped
    rather than failing the sweep.
    """
    d = images_dir(character_id)
    if not d.exists():
        return 0

    by_sha: dict[str, str] = {}
    locals_: list[tuple[str, str]] = []
    for entry in sorted(d.iterdir()):
        if not entry.is_file():
            continue
        m = _IMAGE_FILE_RE.fullmatch(entry.name)
        if not m:
            continue
        image_id = m.group(1)
        try:
            sha = _hash_bytes(entry.read_bytes())
        except OSError:
            continue
        if image_id.startswith("local-"):
            locals_.append((image_id, sha))
        else:
            by_sha.setdefault(sha, image_id)

    mapping = {
        local_id: by_sha[sha] for local_id, sha in locals_ if sha in by_sha
    }
    if not mapping:
        return 0
    # Maintenance triggered by a read (the Images tab listing), which is
    # still not the window writing: attribute it like the repair, or the
    # listing itself silently invalidates open windows' etags.
    from services import events  # lazy, same reason as _publish

    with events.origin("internal:image-dedupe"):
        result = adopt_flist_image_ids(character_id, mapping)
    return len(result["renamed"]) + len(result["dropped_duplicate"])


def dedupe_local_after_pull(
    character_id: int | str,
    pulled_image_id: str,
    pulled_bytes: bytes,
) -> str | None:
    """A freshly-pulled image turns out to be bytes the user uploaded
    here first. Hand the gallery over to the real F-list id and drop the
    local copy, so the picture stops appearing in the pool and on the
    profile at once.

    This used to patch a file the gallery no longer lived in and then
    unlink the local file regardless of whether the patch had landed,
    so the patch never landed and the unlink always ran. Every pull after an upload therefore cut a gallery
    entry loose from its bytes, and the image turned into a black
    placeholder on the profile. The file removal was called a cure for
    "image shows in both panes"; it was, and it caused something worse.

    Returns the local id that was folded in, or None.
    """
    if pulled_image_id.startswith("local-"):
        return None
    full = _hash_bytes(pulled_bytes)
    sha8 = full[:8]
    d = images_dir(character_id)
    matched: Path | None = None
    for c in sorted(d.glob(f"local-{sha8}.*")):
        if not c.is_file():
            continue
        try:
            if _hash_bytes(c.read_bytes()) == full:
                matched = c
                break
        except OSError:
            continue
    if matched is None:
        return None

    local_id = f"local-{sha8}"
    from services import events  # lazy, same reason as _publish

    with events.origin("internal:dedupe-after-pull"):
        result = adopt_flist_image_ids(character_id, {local_id: pulled_image_id})
    if result["renamed"] or result["dropped_duplicate"]:
        return local_id
    return None


def add_uploaded_image(
    character_id: int | str,
    data: bytes,
) -> dict[str, Any] | None:
    """Save user-uploaded bytes under `images/local-<sha8>.<ext>`.
    Extension is sniffed from magic bytes — Content-Type is never
    trusted. Returns the metadata row (`{image_id, extension, size,
    added_at, deduplicated}`) or None when the bytes don't match a
    supported format. `deduplicated` says no new file was written.
    Idempotent — identical bytes always produce the same `local-<sha8>`
    and the file is written only when missing.

    If a byte-identical file already exists in `images/` (regardless of
    whether it's keyed by a real F-list id or a prior `local-<sha8>`),
    return that file's row instead of minting a parallel copy. Prevents
    the "same image shows twice in pool" symptom when a user re-uploads
    bytes that came from an earlier F-list pull."""
    ext = detect_image_ext(data)
    if ext is None:
        return None
    sha = _hash_bytes(data)
    existing = find_image_with_sha(character_id, sha)
    if existing is not None:
        try:
            stat = existing.stat()
            m = _IMAGE_FILE_RE.fullmatch(existing.name)
            return {
                "image_id": m.group(1) if m else existing.stem,
                "extension": (m.group(2).lower() if m else ext),
                "size": stat.st_size,
                "added_at": int(stat.st_mtime),
                "deduplicated": True,
            }
        except OSError:
            pass
    image_id = f"local-{sha[:8]}"
    target = images_dir(character_id) / f"{image_id}.{ext}"
    if not target.exists():
        tmp = target.with_suffix(target.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(target)
    try:
        stat = target.stat()
        added_at = int(stat.st_mtime)
        size = stat.st_size
    except OSError:
        added_at = int(time.time())
        size = len(data)
    return {
        "image_id": image_id,
        "extension": ext,
        "size": size,
        "added_at": added_at,
        "deduplicated": False,
    }


def repair_gallery(character_id: int | str) -> dict[str, Any]:
    """Public entry: run the repair with its writes attributed.

    A repair runs after pulls and before backups — nobody clicked
    anything in a window, so a repair's set-rewrite is a second party's
    write as far as every open window is concerned. Unattributed it
    carried the default `ui` origin and was dropped by exactly the
    filter meant for echoes of the window's own writes; each window
    kept a dead etag and the next save looked like a conflict with
    "someone else". The name here is what tells those apart.
    """
    from services import events  # lazy, same reason as _publish

    with events.origin("internal:gallery-repair"):
        return _repair_gallery(character_id)


def _repair_gallery(character_id: int | str) -> dict[str, Any]:
    """Put a character's gallery back together when its entries have
    lost their bytes.

    Three things go wrong, and all three show the same way — a black
    placeholder where a picture should be:

    1. An entry points at `local-<sha8>` whose file is gone. That id is
       not arbitrary: it is the first eight hex of the sha256 of the
       bytes. So the same picture, sitting on disk under the id F-list
       gave it, can be found by hashing what is there — no guessing and
       no download.
    2. The same image id appears in several slots. One picture cannot
       be in three places on a profile; the extras are dropped and the
       first keeps its position.
    3. An entry points at an id with no file and no hash to match. It
       cannot be resolved here and is reported, not deleted — throwing
       away the user's slot order on a hunch is worse than a gap they
       can see.

    Idempotent and cheap enough to run whenever the Images tab opens:
    it hashes the character's own image files, nothing else.
    """
    images = images_dir(character_id)
    sha8_to_id: dict[str, str] = {}
    present: set[str] = set()
    full_hash: dict[str, str] = {}
    if images.exists():
        for entry in sorted(images.iterdir()):
            if not entry.is_file():
                continue
            m = _IMAGE_FILE_RE.fullmatch(entry.name)
            if not m:
                continue
            image_id = m.group(1)
            present.add(image_id)
            if image_id.startswith("local-"):
                continue
            try:
                digest = _hash_bytes(entry.read_bytes())
            except OSError:
                continue
            full_hash[image_id] = digest
            sha8_to_id.setdefault(digest[:8], image_id)

    # What F-list actually has. An upload gives a picture a new id, so
    # after the extension deletes and re-uploads a gallery, the ids the
    # Workbench holds are dead: the same bytes now live under a new
    # id, which shows up in the pool while the profile pane still lists
    # the old one. The same image, on both sides at once.
    live = read_live(character_id)
    live_ids: set[str] = set()
    if isinstance(live, dict):
        for row in live.get("images") or []:
            if isinstance(row, dict):
                rid = row.get("image_id") or row.get("id")
                if rid:
                    live_ids.add(str(rid))
    # Only usable as evidence when we have actually pulled: an empty
    # Live means "we don't know", not "nothing is on the profile".
    superseded: dict[str, str] = {}
    if live_ids:
        by_digest_live = {
            digest: image_id
            for image_id, digest in full_hash.items()
            if image_id in live_ids
        }
        for image_id, digest in full_hash.items():
            if image_id in live_ids:
                continue
            replacement = by_digest_live.get(digest)
            if replacement is not None:
                superseded[image_id] = replacement

    relinked: list[dict[str, str]] = []
    duplicates_removed: list[str] = []
    unresolved: list[str] = []
    workbench_rewritten = False

    bench = read_workbench(character_id)
    gallery = bench.payload.get("images") if bench is not None else None
    if bench is not None and isinstance(gallery, list):
        payload = bench.payload

        kept: list[Any] = []
        seen: set[str] = set()
        touched = False
        for row in gallery:
            if not isinstance(row, dict):
                kept.append(row)
                continue
            image_id = str(row.get("image_id") or "")

            if image_id not in present and image_id.startswith("local-"):
                match = sha8_to_id.get(image_id[len("local-"):])
                if match is not None:
                    relinked.append({"from": image_id, "to": match})
                    row["image_id"] = match
                    image_id = match
                    touched = True
            elif image_id in superseded:
                # The bytes are still on the profile, under the id the
                # re-upload gave them. Follow them.
                match = superseded[image_id]
                relinked.append({"from": image_id, "to": match})
                row["image_id"] = match
                image_id = match
                touched = True

            if image_id in seen:
                duplicates_removed.append(image_id)
                touched = True
                continue
            seen.add(image_id)

            if image_id not in present:
                unresolved.append(image_id)
            kept.append(row)

        if touched:
            payload["images"] = kept
            try:
                write_workbench(character_id, payload, expected_etag=bench.etag)
                workbench_rewritten = True
            except EtagMismatch:
                # Saved meanwhile; the next repair looks again.
                pass

    # The files left behind by the re-upload: byte-identical to one
    # F-list has, under an id it no longer knows. Keeping them would
    # leave the picture sitting in the pool for good, so they go to
    # the Trash, where repair can never destroy them.
    from services import image_trash  # lazy: image_trash imports this module

    stale_removed: list[str] = []
    for old_id in superseded:
        try:
            for entry in images.glob(f"{old_id}.*"):
                if entry.is_file() and image_trash.trash_pool_file(character_id, entry):
                    stale_removed.append(old_id)
        except OSError:
            continue

    return {
        "relinked": relinked,
        "duplicates_removed": duplicates_removed,
        "stale_removed": stale_removed,
        "unresolved": sorted(set(unresolved)),
        "workbench_rewritten": workbench_rewritten,
        "repaired": bool(relinked or duplicates_removed or stale_removed),
    }


def adopt_flist_image_ids(
    character_id: int | str,
    mapping: dict[str, str],
) -> dict[str, Any]:
    """Rename `local-<sha8>` images to the ids F-list gave them.

    An image the user uploads here is keyed by a hash of its bytes,
    because it has no F-list id yet — it exists nowhere but this
    machine. After the extension uploads it, F-list mints a real id,
    and until the archive learns it the two sides cannot recognise the
    same picture: every restore deletes the whole gallery and uploads
    it again, and every pull leaves a byte-identical twin on disk under
    the other name.

    The extension knows the pairing the moment it uploads, so it tells
    us, and this is where the archive takes it on:

    - the Workbench's gallery row moves to the new id;
    - `images/local-<sha8>.<ext>` becomes `images/<new id>.<ext>`, or
      is simply dropped when a pull already fetched the same bytes
      under that name. When that name holds other bytes, the local
      file goes to the Trash (`trashed`) instead: only a byte-identical
      twin is deleted.

    Backups are untouched: they are self-contained ZIPs carrying their
    own copy of the bytes, and rewriting history inside them would make
    a backup no longer a record of what was.

    Idempotent. Ids that aren't `local-`, aren't on disk, or don't
    appear in any gallery are reported back rather than silently
    skipped, so a caller can tell the difference between "nothing to do"
    and "that didn't work".
    """
    renamed: list[dict[str, str]] = []
    dropped_duplicate: list[str] = []
    trashed: list[str] = []
    unknown: list[str] = []

    images = images_dir(character_id)
    on_disk: dict[str, str] = {}
    if images.exists():
        for entry in images.iterdir():
            if not entry.is_file():
                continue
            m = _IMAGE_FILE_RE.fullmatch(entry.name)
            if m:
                on_disk[m.group(1)] = m.group(2).lower()

    resolved: dict[str, str] = {}
    for old_id, new_id in mapping.items():
        old_id, new_id = str(old_id).strip(), str(new_id).strip()
        if not old_id.startswith("local-") or not new_id:
            unknown.append(old_id)
            continue
        if not _SAFE_NAME_RE.fullmatch(new_id) or not _SAFE_NAME_RE.fullmatch(old_id):
            unknown.append(old_id)
            continue
        ext = on_disk.get(old_id)
        if ext is None:
            # Already adopted on an earlier run, or never here.
            unknown.append(old_id)
            continue
        resolved[old_id] = new_id

        src = image_path(character_id, old_id, ext)
        dst = image_path(character_id, new_id, on_disk.get(new_id, ext))
        if dst.exists() and file_sha256(dst) == file_sha256(src):
            # A pull fetched the same picture under its F-list name.
            # One copy is enough.
            src.unlink(missing_ok=True)
            dropped_duplicate.append(old_id)
        elif dst.exists():
            # Other bytes under the F-list id (F-list re-encoded the
            # upload, or the pairing is wrong): ours is no duplicate,
            # so it goes to the Trash rather than away for good.
            from services import image_trash

            image_trash.trash_pool_file(character_id, src)
            trashed.append(old_id)
        else:
            src.replace(dst)
            renamed.append({"from": old_id, "to": new_id})

    workbench_rewritten = False
    bench = read_workbench(character_id) if resolved else None
    gallery = bench.payload.get("images") if bench is not None else None
    if bench is not None and isinstance(gallery, list):
        touched = False
        for row in gallery:
            if not isinstance(row, dict):
                continue
            current = str(row.get("image_id") or "")
            if current in resolved:
                row["image_id"] = resolved[current]
                touched = True
        if touched:
            try:
                write_workbench(character_id, bench.payload, expected_etag=bench.etag)
                workbench_rewritten = True
            except EtagMismatch:
                pass

    return {
        "renamed": renamed,
        "dropped_duplicate": dropped_duplicate,
        "trashed": trashed,
        "unknown": unknown,
        "workbench_rewritten": workbench_rewritten,
    }


# ---- v4 → v5 pool migration ------------------------------------------

# v4 stored bytes twice: once under `images/<image_id>.<ext>` and once
# under `pool/<sha>.<ext>` with a sha→{image_ids[]} manifest. v5 keeps
# only the `images/` store; migration moves any pool-only bytes into
# `images/` under their first-known F-list id (or a `local-<sha8>`
# synthetic) and deletes the pool/ directory.

_LEGACY_POOL_DIRNAME = "pool"
_LEGACY_POOL_MANIFEST = "manifest.json"


def migrate_v4_pool_to_images(character_id: int | str) -> int:
    """One-shot disk migration from v4's `pool/<sha>` store to v5's
    unified `images/<image_id>` store. Returns the number of pool files
    promoted (informational; legacy archive with no pool/ returns 0).
    Idempotent — re-runs are no-ops once pool/ is gone.
    """
    cdir = character_dir(character_id)
    pool_d = cdir / _LEGACY_POOL_DIRNAME
    if not pool_d.exists():
        return 0
    manifest_path = pool_d / _LEGACY_POOL_MANIFEST
    manifest: dict[str, dict[str, Any]] = {}
    if manifest_path.exists():
        try:
            raw = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                manifest = {
                    k: v for k, v in raw.items()
                    if isinstance(k, str) and isinstance(v, dict)
                }
        except (OSError, ValueError):
            manifest = {}
    images_d = images_dir(character_id)
    promoted = 0
    seen_pool_files: set[str] = set()
    for sha, meta in manifest.items():
        ext_raw = meta.get("extension")
        if not isinstance(ext_raw, str):
            continue
        try:
            ext = normalise_image_ext(ext_raw)
        except ValueError:
            continue
        sha_file = pool_d / f"{sha}.{ext}"
        seen_pool_files.add(sha_file.name)
        if not sha_file.exists():
            continue
        image_ids_raw = meta.get("image_ids")
        image_ids: list[str] = (
            [str(x) for x in image_ids_raw if isinstance(x, (str, int))]
            if isinstance(image_ids_raw, list)
            else []
        )
        # If any of this sha's historical image_ids is already a file in
        # images/<id>.<ext>, the bytes are already preserved under that
        # id — skip rather than mint a redundant `local-<sha8>` copy.
        already_preserved = any(
            _SAFE_NAME_RE.fullmatch(iid) and (images_d / f"{iid}.{ext}").exists()
            for iid in image_ids
        )
        if already_preserved:
            continue
        chosen: str | None = None
        for iid in image_ids:
            if not _SAFE_NAME_RE.fullmatch(iid):
                continue
            chosen = iid
            break
        if chosen is None:
            chosen = f"local-{sha[:8]}"
        if not _SAFE_NAME_RE.fullmatch(chosen):
            continue
        target = images_d / f"{chosen}.{ext}"
        if not target.exists():
            try:
                target.write_bytes(sha_file.read_bytes())
                promoted += 1
            except OSError:
                continue
    # Also catch orphan files in pool/ that weren't in the manifest —
    # they only carry sha+ext, so they always land as `local-<sha8>`.
    for entry in list(pool_d.iterdir()):
        if not entry.is_file():
            continue
        if entry.name == _LEGACY_POOL_MANIFEST:
            continue
        if entry.name in seen_pool_files:
            continue
        stem = entry.stem
        ext_part = entry.suffix.lstrip(".")
        try:
            ext = normalise_image_ext(ext_part)
        except ValueError:
            continue
        if len(stem) < 8 or not _SAFE_NAME_RE.fullmatch(stem):
            continue
        chosen = f"local-{stem[:8]}"
        target = images_d / f"{chosen}.{ext}"
        if not target.exists():
            try:
                target.write_bytes(entry.read_bytes())
                promoted += 1
            except OSError:
                continue
    # Tear down pool/ — best-effort, leaves directory intact on errors.
    for entry in list(pool_d.iterdir()):
        try:
            entry.unlink()
        except OSError:
            pass
    try:
        pool_d.rmdir()
    except OSError:
        pass
    return promoted


def avatar_path_for(name: str) -> Path:
    """`<userdata>/avatars/<lowercase_name>.png` for ASCII-only names;
    `<userdata>/avatars/<sha1>.png` for names containing Unicode or
    other characters outside `[A-Za-z0-9_.-]`.

    F-list allows Unicode in character names (e.g. "Café Noir"), but
    we want a filesystem-safe filename — never trust the name to be
    Windows-NTFS-clean. The sha1 fallback covers the long tail without
    ever raising ValueError, which previously made /flist/avatar/{name}
    return HTTP 400 for any non-ASCII character.
    """
    import hashlib

    slug = name.strip().lower().replace(" ", "_")
    if _SAFE_NAME_RE.fullmatch(slug):
        return avatars_root() / f"{slug}.png"
    # Hash the original (case-preserving + space-preserving) name so
    # two characters that only differ in casing land on distinct paths
    # — matches the merge_roster behaviour of keying by lowercase only
    # for collision rather than identity.
    digest = hashlib.sha1(name.strip().lower().encode("utf-8")).hexdigest()
    return avatars_root() / f"{digest}.png"


# ---- roster ----------------------------------------------------------


def same_character_name(a: str | None, b: str | None) -> bool:
    """Whether two spellings name the same character: F-list and the
    Logs treat names case-insensitively, and stray spaces never count."""
    return bool(a and b) and a.strip().lower() == b.strip().lower()


def character_name(character_id: int | str) -> str | None:
    """The name of a character the archive holds, which is also the name
    its Logs are kept under. The registry's when a Pull recorded one,
    else the one in its Live."""
    entry = load_registry().get(str(character_id)) or {}
    if entry.get("name"):
        return str(entry["name"])
    for row in list_archived_characters():
        if str(row.get("id")) == str(character_id):
            return str(row.get("name") or "") or None
    return None


def list_archived_characters() -> list[dict[str, Any]]:
    """Walk `<userdata>/characters/` and surface every directory that
    looks like a character archive. Each entry: `{id, name, last_pulled_at,
    backup_count}`. Name comes from the Live — we never had a name without a Live, so
    missing-name is impossible in normal use.

    Since the rename to name-keyed folders, the directory name is no
    longer the character_id. We pull `id` out of live.json, and fall
    back to the folder name (which would be the legacy id-folder case
    for archives that haven't been migrated yet).
    """
    out: list[dict[str, Any]] = []
    root_p = root()
    # Reverse-map folder → id from the registry so we can resolve a
    # folder name back to its canonical id without re-reading live.json
    # twice. Folder→id is unambiguous; an unmapped folder is the
    # legacy id-named case where folder name == id.
    folder_to_id: dict[str, str] = {}
    for cid, entry in load_registry().items():
        folder = entry.get("folder")
        if isinstance(folder, str):
            folder_to_id[folder] = cid

    for entry in root_p.iterdir():
        if not entry.is_dir():
            continue
        if entry.name.startswith("_"):
            continue
        # Identify the character_id for this folder. Prefer the
        # registry (authoritative); fall back to live.json's id; final
        # fallback is the folder name itself (legacy unmigrated case).
        live_path = entry / LIVE_FILENAME
        if not live_path.exists():
            continue
        try:
            live = json.loads(live_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        cid = folder_to_id.get(entry.name)
        if cid is None:
            live_id = live.get("id") if isinstance(live, dict) else None
            if live_id is not None:
                cid = str(live_id)
            else:
                cid = entry.name
        char = live.get("character") if isinstance(live, dict) else None
        if not isinstance(char, dict):
            char = live
        name = (
            char.get("name") if isinstance(char, dict) else None
        ) or live.get("name")
        zip_dir = character_dir(cid) / "backups"
        if zip_dir.exists():
            backup_count = sum(
                1
                for child in zip_dir.iterdir()
                if child.is_file() and child.suffix.lower() == ".zip"
            )
        else:
            backup_count = 0
        out.append(
            {
                "id": cid,
                "name": name,
                "last_pulled_at": live.get("fetched_at"),
                "backup_count": backup_count,
            }
        )
    out.sort(key=lambda r: (r["name"] or "").lower())
    return out


def merge_roster(
    account_characters: Iterable[dict[str, Any]] | None,
    log_characters: Iterable[str] | None,
) -> list[dict[str, Any]]:
    """Union of (F-list account roster) + (locally archived) + (log
    directories). Each entry carries status flags so the renderer can
    render badges:

        - `on_account`  — present in the live account roster
        - `has_archive` — has a Live snapshot on disk
        - `has_logs`    — has F-Chat log directories under FCHAT_DATA_DIR

    `id` is the F-list character_id when we know it (account or archive
    lookup); `null` for log-only characters whose F-list id is unknown.
    """
    # Identity for rows whose F-list id we know comes from the id, not the
    # name — F-list permits two characters whose names differ only in case
    # ("Foo" and "foo"), and case-collapsing them would silently fuse two
    # real characters into one row with the wrong id auto-pulled. Rows
    # with no known id (log-only directories, defensive cases) still fall
    # back to lowercased name so on-disk casing drift still collapses.
    by_id: dict[Any, dict[str, Any]] = {}
    by_name: dict[str, dict[str, Any]] = {}

    def _new(name: str) -> dict[str, Any]:
        return {
            "name": name,
            "id": None,
            "on_account": False,
            "has_archive": False,
            "has_logs": False,
            "last_pulled_at": None,
            "backup_count": 0,
        }

    def _upsert_by_id(name: str, cid: Any) -> dict[str, Any]:
        # Key by str(cid): F-list's /flist/characters returns id as int,
        # archive's load_registry returns id as str. Without coercion
        # `by_id[42]` and `by_id["42"]` are separate buckets and the same
        # character ends up as two rows (one on_account, one logs-only).
        key = str(cid)
        row = by_id.get(key)
        if row is None:
            row = _new(name)
            row["id"] = cid
            by_id[key] = row
        return row

    def _upsert_by_name(name: str) -> dict[str, Any]:
        key = name.strip().lower()
        row = by_name.get(key)
        if row is None:
            row = _new(name)
            by_name[key] = row
        return row

    if account_characters:
        for ch in account_characters:
            name = ch.get("name")
            if not isinstance(name, str) or not name:
                continue
            cid = ch.get("id")
            row = _upsert_by_id(name, cid) if cid is not None else _upsert_by_name(name)
            row["on_account"] = True

    archived = list_archived_characters()
    for a in archived:
        name = a["name"]
        if not isinstance(name, str) or not name:
            continue
        cid = a.get("id")
        row = _upsert_by_id(name, cid) if cid is not None else _upsert_by_name(name)
        row["has_archive"] = True
        row["last_pulled_at"] = a["last_pulled_at"]
        row["backup_count"] = a["backup_count"]

    if log_characters:
        # Log directories have no id — fall back to name match. Prefer
        # an existing id-keyed row with the same lowercased name so we
        # don't create a phantom log-only row alongside the canonical
        # one. With case-collision ids this is ambiguous; pick the
        # first id-keyed row deterministically.
        id_name_index: dict[str, dict[str, Any]] = {}
        for row in by_id.values():
            key = (row["name"] or "").strip().lower()
            id_name_index.setdefault(key, row)
        for name in log_characters:
            if not isinstance(name, str) or not name:
                continue
            key = name.strip().lower()
            row = id_name_index.get(key) or by_name.get(key)
            if row is None:
                row = _new(name)
                by_name[key] = row
            row["has_logs"] = True

    rows = list(by_id.values()) + list(by_name.values())
    rows.sort(key=lambda r: (r["name"] or "").lower())
    return rows
