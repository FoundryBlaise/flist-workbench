"""On-disk archive store for F-list character backups.

Layout under `<userdata>/characters/<character_id>/`:

    live.json                        last fetched character-data + fetch ts
    backups/<unix>.json              snapshot of a previous Live
    images/<image_id>.<ext>          all on-disk image bytes (Pool view in
                                     the UI is whatever isn't currently in
                                     working.json's gallery)
    inlines/<sha1>.<ext>             inline images referenced in BBCode

`<image_id>` is digits for F-list-pulled images, `local-<sha8>` for user
uploads that haven't been restored to F-list yet. There's no separate
sha-keyed pool — bytes live in `images/` once, and the renderer treats
files not referenced by working.json's gallery as "in the pool" for the
UI. The only path that ever deletes bytes is an explicit user delete
from the pool view (DELETE /images/<image_id>); pulls overwrite the
same id in place, profile→pool moves are pure working.json edits.

Avatars sit one level up at `<userdata>/avatars/<lowercase_name>.png`
because they survive a character being deleted from the account.

`list_archived_characters()` walks `<userdata>/characters/` so a user
who signs out (or whose character was deleted from F-list) still sees
their archived data in the picker. Each entry carries `has_logs` and
`on_account` flags so the renderer can render status badges.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import documents

CHARACTERS_DIRNAME = "characters"
AVATARS_DIRNAME = "avatars"
CACHE_DIRNAME = "cache"
LIVE_FILENAME = "live.json"
PULL_STATE_FILENAME = "pull_state.json"
WORKING_FILENAME = "working.json"

# v1 → v2 (Tier 3): added local: ids, _custom_kinks_order, tombstones.
# v2 → v3 (Tier 6 attempt 1): sha256-keyed gallery refs. Reverted in v4.
# v3 → v4 (Tier 6 attempt 2): gallery refs back to image_id, with `local-
#   <sha8>` synthetic ids for non-F-list uploads. Bytes still doubly-
#   stored in a sha-keyed pool/ dir.
# v4 → v5 (refinement): drop the sha-keyed pool/ directory entirely.
#   Bytes live once under `images/<image_id>.<ext>`; the renderer's "Pool"
#   pane is a view over files not referenced by working.json's gallery.
#   Migration: pool/<sha>.<ext> entries are moved into `images/` under
#   their first-known F-list id (if not already on disk) or under
#   `local-<sha8>`; pool/ + manifest.json are then removed.
# v5 → v6 (Tier 7): introduce per-character working sets. The single
#   working.json is replaced by sets/<set_id>/payload.json + meta.json,
#   plus active_set.json one level up; snapshots live in
#   sets/<set_id>/snapshots/<snap_id>.json. The payload shape itself is
#   unchanged from v5; only the on-disk layout moves. Writers stamp v6;
#   readers continue to migrate v1..v5 forward in memory.
WORKING_SCHEMA_VERSION = 6


class EtagMismatch(ValueError):
    """Raised by write_working when expected_etag != current on-disk etag.

    The PUT /working endpoint translates this into a 409 with the
    current etag so the renderer can show the refresh-or-overwrite modal
    (Tier 2 §8.1).
    """

    def __init__(self, current_etag: str | None) -> None:
        super().__init__("etag_mismatch")
        self.current_etag = current_etag


def root() -> Path:
    p = documents.user_data_dir() / CHARACTERS_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def avatars_root() -> Path:
    p = documents.user_data_dir() / AVATARS_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def cache_root() -> Path:
    p = documents.user_data_dir() / CACHE_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def character_dir(character_id: int | str) -> Path:
    p = root() / str(character_id)
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
    p = character_dir(character_id) / "backups"
    p.mkdir(parents=True, exist_ok=True)
    return p


# ---- live + backup read/write -----------------------------------------


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
    `fetched_at` into the payload before calling."""
    _atomic_write_json(character_dir(character_id) / LIVE_FILENAME, payload)


def read_live(character_id: int | str) -> dict[str, Any] | None:
    p = character_dir(character_id) / LIVE_FILENAME
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save_backup(character_id: int | str) -> dict[str, Any]:
    """Snapshot the current Live into `backups/<unix>.json`.

    Returns `{path, created_at}` so the renderer can show the new entry
    without re-listing. Raises FileNotFoundError if there's no Live to
    snapshot.
    """
    live = read_live(character_id)
    if live is None:
        raise FileNotFoundError("no Live snapshot to back up")
    now = int(time.time())
    target = backups_dir(character_id) / f"{now}.json"
    # On the very-unlikely same-second collision, suffix with a counter.
    i = 1
    while target.exists():
        target = backups_dir(character_id) / f"{now}-{i}.json"
        i += 1
    _atomic_write_json(target, live)
    return {"path": str(target), "created_at": now, "filename": target.name}


_BACKUP_FILE_RE = re.compile(r"^(\d+)(?:-\d+)?\.json$")

# Tier 7 backup filename: <iso_ts>__<source>[__<sanitised_name>]__<hash>.zip
# (source-name segment omitted for `auto-pull`). ISO timestamp uses `-`
# in place of `:` for NTFS safety.
BACKUP_FILENAME_RE = re.compile(r"^[0-9T\-_a-zA-Z\.]+\.zip$")
_BACKUP_ZIP_PARTS_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})"
    r"__(?P<source>auto-pull|manual-set|manual-snapshot)"
    r"(?:__(?P<name>[A-Za-z0-9._-]{1,32}))?"
    r"__(?P<hash>[0-9a-f]{8})"
    r"(?:\((?P<dedupe>\d+)\))?"
    r"\.zip$"
)
_BACKUP_SOURCES = ("auto-pull", "manual-set", "manual-snapshot")


def sanitise_backup_source_name(name: str) -> str:
    """Collapse a set/snapshot name into the filename-safe segment
    documented in the Tier 7 plan: ASCII alnum + dot/dash/underscore,
    everything else collapsed to `_`, then trimmed to 32 chars."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_")
    return (cleaned or "untitled")[:32]


def list_backups(character_id: int | str) -> list[dict[str, Any]]:
    """List backups newest first. Each entry: `{filename, created_at, size}`."""
    out: list[dict[str, Any]] = []
    p = backups_dir(character_id)
    for entry in p.iterdir():
        if not entry.is_file():
            continue
        m = _BACKUP_FILE_RE.match(entry.name)
        if not m:
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        out.append(
            {
                "filename": entry.name,
                "created_at": int(m.group(1)),
                "size": stat.st_size,
            }
        )
    out.sort(key=lambda r: r["created_at"], reverse=True)
    return out


def read_backup(character_id: int | str, filename: str) -> dict[str, Any] | None:
    if not _BACKUP_FILE_RE.match(filename):
        # Reject anything that doesn't match the on-disk filename shape
        # so a caller can't path-traverse out of backups/.
        return None
    p = backups_dir(character_id) / filename
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


# ---- working-copy (offline edits, persisted to working.json) ---------


def working_path(character_id: int | str) -> Path:
    return character_dir(character_id) / WORKING_FILENAME


def _file_sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    import hashlib

    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def working_etag(character_id: int | str) -> str | None:
    """SHA-256 of working.json bytes on disk. None when absent.

    Renderer holds this between GET and the next PUT and sends it as
    `If-Match`; PUT returns the new etag on success. Used to detect a
    second window racing the same file (Tier 2 §8.1).
    """
    return _file_sha256(working_path(character_id))


def _migrate_working_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """In-memory schema migration. v1 → v2 fills _custom_kinks_order
    from the dict; v2 → v4 drops any sha256-keyed images array (the
    short-lived v3 shape) since we can't infer image_ids from shas
    without re-querying F-list. v4 → v5 is a no-op on the payload (gallery
    refs are unchanged); the actual disk side-effect (pool/ → images/) is
    driven by `migrate_v4_pool_to_images` in `read_working`.
    """
    version = payload.get("_schema_version")
    if version is None:
        version = 1
        payload["_schema_version"] = 1
    if version == 1:
        ck = payload.get("custom_kinks")
        if isinstance(ck, dict) and "_custom_kinks_order" not in payload:
            payload["_custom_kinks_order"] = list(ck.keys())
    if isinstance(version, int) and version <= 3:
        # v3 stored images as [{sha256, description}]. We can't translate
        # back to image_ids without the API. Drop the array — caller
        # re-seeds from live.json on next open.
        payload.pop("images", None)
    if isinstance(version, int) and version < WORKING_SCHEMA_VERSION:
        payload["_schema_version"] = WORKING_SCHEMA_VERSION
    return payload


def read_working(character_id: int | str) -> dict[str, Any] | None:
    """Return the working-copy payload or None if absent.

    On a JSONDecodeError, the corrupt file is renamed with a unix-
    timestamp suffix (`working.json.corrupt-<unix>`) so the user keeps
    the bytes for forensics — mirrors `read_live`'s broader silent-None
    behaviour but recovers more information for a file the user is
    actively editing.
    """
    p = working_path(character_id)
    if not p.exists():
        return None
    try:
        raw = p.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        payload = json.loads(raw)
    except ValueError:
        # Quarantine the broken file; renderer falls back to a fresh
        # seed-from-Live on the next load.
        try:
            p.rename(p.with_name(f"{p.name}.corrupt-{int(time.time())}"))
        except OSError:
            pass
        return None
    if not isinstance(payload, dict):
        return None
    version = payload.get("_schema_version")
    if isinstance(version, int) and version > WORKING_SCHEMA_VERSION:
        # File was written by a newer build. Refuse rather than silently
        # mis-interpret a future shape (QA feedback BLOCK #4). The
        # renderer's working-load handler treats None as "no working
        # copy" and seeds from Live — the file on disk stays intact.
        print(
            f"[flist] refusing to load working.json v{version} "
            f"(this build understands up to v{WORKING_SCHEMA_VERSION}); "
            f"upgrade the app or open the file with a matching version",
            flush=True,
        )
        return None
    migrated = _migrate_working_payload(payload)
    # Write the migrated shape back to disk so the next read (and any
    # external tooling inspecting working.json) sees the canonical
    # current-version layout — otherwise a renderer that never edits
    # would carry the in-memory migration forever and the on-disk file
    # would stay behind. v4 → v5 also drives the pool/→images/ disk
    # migration: payload's shape doesn't change but the byte store
    # collapses to a single directory.
    if (
        isinstance(version, int)
        and version < WORKING_SCHEMA_VERSION
    ):
        try:
            _atomic_write_json(p, migrated)
        except OSError:
            pass
        if version <= 4:
            migrate_v4_pool_to_images(character_id)
    return migrated


_WORKING_TOP_LEVEL_KEYS = {
    "character",
    "settings",
    "infotags",
    "kinks",
    "custom_kinks",
    "images",
    "inlines",
}


def write_working(
    character_id: int | str,
    payload: dict[str, Any],
    *,
    expected_etag: str | None = None,
) -> str:
    """Persist `payload` atomically; return the new sha256 etag.

    When `expected_etag` is provided, the on-disk etag must match (or
    both must be None on a first write) or `EtagMismatch` is raised
    carrying the current etag. Schema-version + `_overlay` are required;
    at least one of the recognised top-level content keys must be
    present (defensive — catches a renderer regression silently writing
    an empty payload).
    """
    if not isinstance(payload, dict):
        raise ValueError("working payload must be a dict")
    payload = _migrate_working_payload(dict(payload))
    overlay = payload.get("_overlay")
    if not isinstance(overlay, list) or not all(isinstance(s, str) for s in overlay):
        raise ValueError("_overlay must be a list of strings")
    if not any(k in payload for k in _WORKING_TOP_LEVEL_KEYS):
        raise ValueError(
            "working payload must carry at least one of "
            f"{sorted(_WORKING_TOP_LEVEL_KEYS)}"
        )
    p = working_path(character_id)
    current = _file_sha256(p)
    if expected_etag is not None and current != expected_etag:
        raise EtagMismatch(current)
    _atomic_write_json(p, payload)
    new_etag = _file_sha256(p)
    assert new_etag is not None
    return new_etag


def delete_working(character_id: int | str) -> bool:
    """Remove working.json. Idempotent — returns whether it existed."""
    p = working_path(character_id)
    if not p.exists():
        return False
    try:
        p.unlink()
        return True
    except OSError:
        return False


# ---- v6 working sets + snapshots -------------------------------------


SETS_DIRNAME = "sets"
ACTIVE_SET_FILENAME = "active_set.json"
SET_PAYLOAD_FILENAME = "payload.json"
SET_META_FILENAME = "meta.json"
SNAPSHOTS_DIRNAME = "snapshots"

_SET_NAME_MIN = 1
_SET_NAME_MAX = 80


@dataclass(frozen=True)
class SetMeta:
    id: str
    name: str
    created_at: int
    updated_at: int
    snapshot_count: int


@dataclass(frozen=True)
class SnapshotMeta:
    id: str
    name: str
    created_at: int


@dataclass(frozen=True)
class BackupListing:
    filename: str
    created_at: int
    size: int
    source: str
    source_name: str | None
    payload_hash: str


class SetNotFound(KeyError):
    """Raised when a set_id doesn't resolve under the character archive."""


class SnapshotNotFound(KeyError):
    """Raised when a snapshot_id doesn't resolve under the set."""


def sets_dir(character_id: int | str) -> Path:
    p = character_dir(character_id) / SETS_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def set_dir(character_id: int | str, set_id: str) -> Path:
    _require_safe_id(set_id, "set_id")
    return sets_dir(character_id) / set_id


def set_payload_path(character_id: int | str, set_id: str) -> Path:
    return set_dir(character_id, set_id) / SET_PAYLOAD_FILENAME


def set_meta_path(character_id: int | str, set_id: str) -> Path:
    return set_dir(character_id, set_id) / SET_META_FILENAME


def snapshots_dir(character_id: int | str, set_id: str) -> Path:
    p = set_dir(character_id, set_id) / SNAPSHOTS_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def snapshot_path(character_id: int | str, set_id: str, snap_id: str) -> Path:
    _require_safe_id(snap_id, "snapshot_id")
    return snapshots_dir(character_id, set_id) / f"{snap_id}.json"


def active_set_path(character_id: int | str) -> Path:
    return character_dir(character_id) / ACTIVE_SET_FILENAME


_ID_RE = re.compile(r"^[A-Za-z0-9]{1,32}$")


def _require_safe_id(value: str, label: str) -> None:
    if not isinstance(value, str) or not _ID_RE.match(value):
        raise ValueError(f"unsafe {label}: {value!r}")


def mint_id() -> str:
    return uuid.uuid4().hex[:12]


def validate_set_name(name: Any) -> str:
    if not isinstance(name, str):
        raise ValueError("set name must be a string")
    if "\x00" in name:
        raise ValueError("set name must not contain NUL")
    stripped = name.strip()
    if len(stripped) < _SET_NAME_MIN or len(stripped) > _SET_NAME_MAX:
        raise ValueError(
            f"set name must be 1..{_SET_NAME_MAX} chars (after trim)"
        )
    return stripped


def _read_json_or_none(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        out = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(out, dict):
        return None
    return out


def read_set_meta(character_id: int | str, set_id: str) -> SetMeta | None:
    raw = _read_json_or_none(set_meta_path(character_id, set_id))
    if raw is None:
        return None
    name = raw.get("name")
    if not isinstance(name, str):
        return None
    snaps = raw.get("snapshots") or []
    snapshot_count = len(snaps) if isinstance(snaps, list) else 0
    return SetMeta(
        id=str(raw.get("id") or set_id),
        name=name,
        created_at=int(raw.get("createdAt") or 0),
        updated_at=int(raw.get("updatedAt") or 0),
        snapshot_count=snapshot_count,
    )


def write_set_meta(
    character_id: int | str,
    set_id: str,
    *,
    name: str,
    created_at: int,
    updated_at: int,
    snapshots: list[dict[str, Any]] | None = None,
) -> SetMeta:
    _require_safe_id(set_id, "set_id")
    name = validate_set_name(name)
    snap_list = list(snapshots or [])
    payload = {
        "id": set_id,
        "name": name,
        "createdAt": int(created_at),
        "updatedAt": int(updated_at),
        "snapshots": snap_list,
    }
    _atomic_write_json(set_meta_path(character_id, set_id), payload)
    return SetMeta(
        id=set_id,
        name=name,
        created_at=int(created_at),
        updated_at=int(updated_at),
        snapshot_count=len(snap_list),
    )


def read_set_payload(
    character_id: int | str, set_id: str
) -> dict[str, Any] | None:
    p = set_payload_path(character_id, set_id)
    if not p.exists():
        return None
    try:
        raw = p.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        payload = json.loads(raw)
    except ValueError:
        try:
            p.rename(p.with_name(f"{p.name}.corrupt-{int(time.time())}"))
        except OSError:
            pass
        return None
    if not isinstance(payload, dict):
        return None
    version = payload.get("_schema_version")
    if isinstance(version, int) and version > WORKING_SCHEMA_VERSION:
        print(
            f"[flist] refusing to load set payload v{version} "
            f"(this build understands up to v{WORKING_SCHEMA_VERSION})",
            flush=True,
        )
        return None
    migrated = _migrate_working_payload(payload)
    if isinstance(version, int) and version < WORKING_SCHEMA_VERSION:
        try:
            _atomic_write_json(p, migrated)
        except OSError:
            pass
    return migrated


def set_payload_etag(character_id: int | str, set_id: str) -> str | None:
    return _file_sha256(set_payload_path(character_id, set_id))


def write_set_payload(
    character_id: int | str,
    set_id: str,
    payload: dict[str, Any],
    *,
    expected_etag: str | None = None,
) -> str:
    if not isinstance(payload, dict):
        raise ValueError("set payload must be a dict")
    _require_safe_id(set_id, "set_id")
    payload = _migrate_working_payload(dict(payload))
    overlay = payload.get("_overlay")
    if not isinstance(overlay, list) or not all(isinstance(s, str) for s in overlay):
        raise ValueError("_overlay must be a list of strings")
    if not any(k in payload for k in _WORKING_TOP_LEVEL_KEYS):
        raise ValueError(
            "set payload must carry at least one of "
            f"{sorted(_WORKING_TOP_LEVEL_KEYS)}"
        )
    p = set_payload_path(character_id, set_id)
    current = _file_sha256(p)
    if expected_etag is not None and current != expected_etag:
        raise EtagMismatch(current)
    _atomic_write_json(p, payload)
    new_etag = _file_sha256(p)
    assert new_etag is not None
    # Touch updatedAt on the set's meta so the renderer can sort newest-
    # first without re-stat'ing every payload.
    meta = read_set_meta(character_id, set_id)
    if meta is not None:
        snapshots = _read_meta_snapshots(character_id, set_id)
        write_set_meta(
            character_id,
            set_id,
            name=meta.name,
            created_at=meta.created_at,
            updated_at=int(time.time()),
            snapshots=snapshots,
        )
    return new_etag


def list_sets(character_id: int | str) -> list[SetMeta]:
    out: list[SetMeta] = []
    sd = sets_dir(character_id)
    for entry in sd.iterdir():
        if not entry.is_dir():
            continue
        if not _ID_RE.match(entry.name):
            continue
        meta = read_set_meta(character_id, entry.name)
        if meta is None:
            continue
        out.append(meta)
    out.sort(key=lambda s: (-s.updated_at, s.id))
    return out


def read_active_set_id(character_id: int | str) -> str | None:
    """Return the active set id from `active_set.json`, falling back to
    the oldest set when the pointer is missing or invalid. Returns None
    only when no sets exist at all."""
    raw = _read_json_or_none(active_set_path(character_id))
    candidate: str | None = None
    if isinstance(raw, dict):
        v = raw.get("active_set_id")
        if isinstance(v, str) and _ID_RE.match(v):
            candidate = v
    sets = list_sets(character_id)
    if not sets:
        return None
    valid_ids = {s.id for s in sets}
    if candidate in valid_ids:
        return candidate
    fallback = min(sets, key=lambda s: (s.created_at, s.id)).id
    try:
        set_active_set_id(character_id, fallback)
    except OSError:
        pass
    return fallback


def set_active_set_id(character_id: int | str, set_id: str) -> None:
    _require_safe_id(set_id, "set_id")
    if not set_meta_path(character_id, set_id).exists():
        raise SetNotFound(set_id)
    _atomic_write_json(
        active_set_path(character_id),
        {"active_set_id": set_id},
    )


def _read_meta_snapshots(
    character_id: int | str, set_id: str
) -> list[dict[str, Any]]:
    raw = _read_json_or_none(set_meta_path(character_id, set_id))
    if raw is None:
        return []
    snaps = raw.get("snapshots") or []
    if not isinstance(snaps, list):
        return []
    return [s for s in snaps if isinstance(s, dict)]


# ---- snapshots --------------------------------------------------------


def list_snapshots(
    character_id: int | str, set_id: str
) -> list[SnapshotMeta]:
    out: list[SnapshotMeta] = []
    for raw in _read_meta_snapshots(character_id, set_id):
        sid = raw.get("id")
        name = raw.get("name")
        if not isinstance(sid, str) or not isinstance(name, str):
            continue
        if not _ID_RE.match(sid):
            continue
        out.append(
            SnapshotMeta(
                id=sid,
                name=name,
                created_at=int(raw.get("createdAt") or 0),
            )
        )
    out.sort(key=lambda s: (-s.created_at, s.id))
    return out


def _persist_snapshot_index(
    character_id: int | str,
    set_id: str,
    snapshots: list[dict[str, Any]],
) -> None:
    meta = read_set_meta(character_id, set_id)
    if meta is None:
        raise SetNotFound(set_id)
    write_set_meta(
        character_id,
        set_id,
        name=meta.name,
        created_at=meta.created_at,
        updated_at=meta.updated_at,
        snapshots=snapshots,
    )


def write_snapshot(
    character_id: int | str,
    set_id: str,
    *,
    name: str,
) -> SnapshotMeta:
    if not isinstance(name, str) or not name.strip():
        raise ValueError("snapshot name must be a non-empty string")
    if "\x00" in name:
        raise ValueError("snapshot name must not contain NUL")
    name = name.strip()[:200]
    payload = read_set_payload(character_id, set_id)
    if payload is None:
        raise SetNotFound(set_id)
    snap_id = mint_id()
    target = snapshot_path(character_id, set_id, snap_id)
    _atomic_write_json(target, payload)
    created_at = int(time.time())
    snapshots = _read_meta_snapshots(character_id, set_id)
    snapshots.append(
        {"id": snap_id, "name": name, "createdAt": created_at}
    )
    _persist_snapshot_index(character_id, set_id, snapshots)
    return SnapshotMeta(id=snap_id, name=name, created_at=created_at)


def rename_snapshot(
    character_id: int | str,
    set_id: str,
    snap_id: str,
    *,
    name: str,
) -> SnapshotMeta:
    if not isinstance(name, str) or not name.strip():
        raise ValueError("snapshot name must be a non-empty string")
    if "\x00" in name:
        raise ValueError("snapshot name must not contain NUL")
    name = name.strip()[:200]
    _require_safe_id(snap_id, "snapshot_id")
    snapshots = _read_meta_snapshots(character_id, set_id)
    target_row: dict[str, Any] | None = None
    for row in snapshots:
        if row.get("id") == snap_id:
            row["name"] = name
            target_row = row
            break
    if target_row is None:
        raise SnapshotNotFound(snap_id)
    _persist_snapshot_index(character_id, set_id, snapshots)
    return SnapshotMeta(
        id=snap_id,
        name=name,
        created_at=int(target_row.get("createdAt") or 0),
    )


def delete_snapshot(
    character_id: int | str, set_id: str, snap_id: str
) -> bool:
    _require_safe_id(snap_id, "snapshot_id")
    snapshots = _read_meta_snapshots(character_id, set_id)
    new_snapshots = [s for s in snapshots if s.get("id") != snap_id]
    removed = len(new_snapshots) != len(snapshots)
    if not removed:
        return False
    _persist_snapshot_index(character_id, set_id, new_snapshots)
    target = snapshot_path(character_id, set_id, snap_id)
    if target.exists():
        try:
            target.unlink()
        except OSError:
            pass
    return True


def read_snapshot_payload(
    character_id: int | str, set_id: str, snap_id: str
) -> dict[str, Any] | None:
    _require_safe_id(snap_id, "snapshot_id")
    p = snapshot_path(character_id, set_id, snap_id)
    if not p.exists():
        return None
    try:
        raw = p.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        payload = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    return _migrate_working_payload(payload)


def find_snapshot_meta(
    character_id: int | str, set_id: str, snap_id: str
) -> SnapshotMeta | None:
    _require_safe_id(snap_id, "snapshot_id")
    for s in list_snapshots(character_id, set_id):
        if s.id == snap_id:
            return s
    return None


# ---- v5 → v6 migration ------------------------------------------------


def migrate_v5_working_to_sets(character_id: int | str) -> str | None:
    """Promote a v5 `working.json` into `sets/<set_id>/payload.json`.

    Idempotent: when `sets/` already has at least one entry the call is
    a no-op and returns the current active set id (or None if there
    truly are no sets). Otherwise mints a fresh `<set_id>`, writes the
    payload + meta + `active_set.json`, and unlinks the legacy file
    only after a bytes-equal sha256 check confirms the new payload
    reads back cleanly.

    When `working.json` is absent, no set is minted — the renderer's
    materialise-on-first-edit path will create "Main" lazily through
    `write_set_payload` on the next user edit.
    """
    cdir = character_dir(character_id)
    sd = cdir / SETS_DIRNAME
    if sd.exists():
        for entry in sd.iterdir():
            if entry.is_dir() and _ID_RE.match(entry.name):
                return read_active_set_id(character_id)
    legacy = working_path(character_id)
    if not legacy.exists():
        return None
    raw = legacy.read_bytes()
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        # Can't safely migrate corrupt JSON; leave it for forensics.
        return None
    if not isinstance(payload, dict):
        return None
    migrated = _migrate_working_payload(payload)
    try:
        legacy_stat = legacy.stat()
        created_at = int(legacy_stat.st_mtime)
    except OSError:
        created_at = int(time.time())
    set_id = mint_id()
    target = set_payload_path(character_id, set_id)
    _atomic_write_json(target, migrated)
    expected_sha = hashlib.sha256(
        json.dumps(migrated, indent=2, ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    on_disk_sha = _file_sha256(target)
    write_set_meta(
        character_id,
        set_id,
        name="Main",
        created_at=created_at,
        updated_at=created_at,
        snapshots=[],
    )
    set_active_set_id(character_id, set_id)
    if on_disk_sha == expected_sha:
        try:
            legacy.unlink()
        except OSError as exc:
            print(
                f"[flist] migrate_v5_working_to_sets: kept legacy "
                f"working.json (unlink failed: {exc!r})",
                flush=True,
            )
    else:
        print(
            "[flist] migrate_v5_working_to_sets: kept legacy working.json "
            "(payload re-read sha mismatch)",
            flush=True,
        )
    return set_id


def create_set(
    character_id: int | str,
    *,
    name: str,
    seed: str | dict[str, Any],
) -> SetMeta:
    """Create a new working set. `seed` is one of:

    - ``"live"`` — seed from `live.json` via `_seed_working_from_live`
      (raises FileNotFoundError when no Live snapshot exists).
    - ``"empty"`` — start with `{_schema_version, _overlay: []}` only.
    - ``{"fork": "<other_set_id>"}`` — deep-copy another set's payload.
    """
    name = validate_set_name(name)
    seed_payload = _resolve_seed(character_id, seed)
    set_id = mint_id()
    set_dir(character_id, set_id).mkdir(parents=True, exist_ok=True)
    _atomic_write_json(set_payload_path(character_id, set_id), seed_payload)
    now = int(time.time())
    meta = write_set_meta(
        character_id,
        set_id,
        name=name,
        created_at=now,
        updated_at=now,
        snapshots=[],
    )
    # First set on this character: also stamp active_set.json so the
    # caller doesn't have to know whether to activate.
    if read_active_set_id(character_id) is None:
        set_active_set_id(character_id, set_id)
    return meta


def _resolve_seed(
    character_id: int | str, seed: str | dict[str, Any]
) -> dict[str, Any]:
    if seed == "empty":
        return {"_schema_version": WORKING_SCHEMA_VERSION, "_overlay": []}
    if seed == "live":
        live = read_live(character_id)
        if live is None:
            raise FileNotFoundError("no Live snapshot to seed from")
        return _seed_payload_from_live(live)
    if isinstance(seed, dict) and "fork" in seed:
        fork = seed.get("fork")
        if not isinstance(fork, str):
            raise ValueError("fork must reference a set_id string")
        _require_safe_id(fork, "set_id")
        source = read_set_payload(character_id, fork)
        if source is None:
            raise SetNotFound(fork)
        return json.loads(json.dumps(source))
    raise ValueError(f"unknown seed: {seed!r}")


def _seed_payload_from_live(live: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "_schema_version": WORKING_SCHEMA_VERSION,
        "_overlay": [],
    }
    char = live.get("character") if isinstance(live, dict) else None
    if isinstance(char, dict):
        out["character"] = dict(char)
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


def rename_set(
    character_id: int | str, set_id: str, *, name: str
) -> SetMeta:
    meta = read_set_meta(character_id, set_id)
    if meta is None:
        raise SetNotFound(set_id)
    new_name = validate_set_name(name)
    snapshots = _read_meta_snapshots(character_id, set_id)
    return write_set_meta(
        character_id,
        set_id,
        name=new_name,
        created_at=meta.created_at,
        updated_at=int(time.time()),
        snapshots=snapshots,
    )


def delete_set(character_id: int | str, set_id: str) -> bool:
    """Remove `sets/<set_id>/` including snapshots. Does NOT enforce
    business rules (must-have-one, active-handover) — the server layer
    owns those policies."""
    target = set_dir(character_id, set_id)
    if not target.exists():
        return False
    import shutil

    try:
        shutil.rmtree(target)
    except OSError:
        return False
    return True


# ---- v6 backup ZIPs --------------------------------------------------


def _canonical_payload_hash(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:8]


def _iso_timestamp_for_filename(ts: int | None = None) -> str:
    """ISO-8601 second-precision timestamp with `:` → `-` so the string
    is a legal NTFS filename component on Windows."""
    from datetime import datetime, timezone

    if ts is None:
        moment = datetime.now(timezone.utc)
    else:
        moment = datetime.fromtimestamp(int(ts), tz=timezone.utc)
    return moment.strftime("%Y-%m-%dT%H-%M-%S")


def compose_backup_filename(
    *,
    source: str,
    source_name: str | None,
    payload_hash: str,
    ts: int | None = None,
) -> str:
    if source not in _BACKUP_SOURCES:
        raise ValueError(f"unknown backup source: {source!r}")
    if not re.fullmatch(r"[0-9a-f]{8}", payload_hash):
        raise ValueError("payload_hash must be 8 lowercase hex")
    parts = [_iso_timestamp_for_filename(ts), source]
    if source != "auto-pull":
        parts.append(sanitise_backup_source_name(source_name or "untitled"))
    parts.append(payload_hash)
    return "__".join(parts) + ".zip"


def create_backup_from_payload(
    character_id: int | str,
    *,
    payload: dict[str, Any],
    source: str,
    source_name: str | None,
    avatar_path: Path | None = None,
) -> BackupListing:
    """Compose a userscript-compatible ZIP from `payload` + the bytes
    currently on disk under `images/`, write it under `backups/`, and
    return the listing row. Caller is responsible for resolving the
    payload (set / snapshot) and the avatar path."""
    if source not in _BACKUP_SOURCES:
        raise ValueError(f"unknown backup source: {source!r}")
    import zip_serialise

    data = zip_serialise.build_zip(
        character_id,
        payload,
        images_dir=images_dir(character_id),
        avatar_path=avatar_path,
    )
    payload_hash = _canonical_payload_hash(payload)
    filename = compose_backup_filename(
        source=source, source_name=source_name, payload_hash=payload_hash
    )
    target = backups_dir(character_id) / filename
    suffix = 2
    while target.exists():
        # Same-second double-clicks collide on hash; dedupe with a
        # parenthesised counter so neither write is lost.
        stem = filename[:-4]
        target = backups_dir(character_id) / f"{stem}({suffix}).zip"
        suffix += 1
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(target)
    try:
        st = target.stat()
        size = st.st_size
        created_at = int(st.st_mtime)
    except OSError:
        size = len(data)
        created_at = int(time.time())
    return BackupListing(
        filename=target.name,
        created_at=created_at,
        size=size,
        source=source,
        source_name=None if source == "auto-pull" else (source_name or None),
        payload_hash=payload_hash,
    )


def list_backups_v6(character_id: int | str) -> list[BackupListing]:
    """List ZIP backups + read-only legacy `*.json` rows. Newest-first
    by `created_at`."""
    out: list[BackupListing] = []
    bd = backups_dir(character_id)
    for entry in bd.iterdir():
        if not entry.is_file():
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        if entry.name.endswith(".zip"):
            m = _BACKUP_ZIP_PARTS_RE.match(entry.name)
            if m is None:
                continue
            ts_str = m.group("ts")
            source = m.group("source")
            source_name = m.group("name")
            payload_hash = m.group("hash")
            try:
                from datetime import datetime, timezone

                # `2026-06-02T18-44-00` → `2026-06-02T18:44:00`
                ts_iso = ts_str[:10] + "T" + ts_str[11:].replace("-", ":")
                created_at = int(
                    datetime.strptime(ts_iso, "%Y-%m-%dT%H:%M:%S")
                    .replace(tzinfo=timezone.utc)
                    .timestamp()
                )
            except ValueError:
                created_at = int(stat.st_mtime)
            out.append(
                BackupListing(
                    filename=entry.name,
                    created_at=created_at,
                    size=stat.st_size,
                    source=source,
                    source_name=source_name,
                    payload_hash=payload_hash,
                )
            )
            continue
        legacy = _BACKUP_FILE_RE.match(entry.name)
        if legacy is None:
            continue
        out.append(
            BackupListing(
                filename=entry.name,
                created_at=int(legacy.group(1)),
                size=stat.st_size,
                source="legacy-json",
                source_name=None,
                payload_hash="",
            )
        )
    out.sort(key=lambda r: (-r.created_at, r.filename))
    return out


def delete_backup_v6(character_id: int | str, filename: str) -> bool:
    """Delete a ZIP backup. Legacy `*.json` files are not removable
    through this path — the regex deliberately rejects them so the
    legacy view stays read-only."""
    if not BACKUP_FILENAME_RE.match(filename):
        return False
    target = backups_dir(character_id) / filename
    if not target.exists() or not target.is_file():
        return False
    try:
        target.unlink()
        return True
    except OSError:
        return False


def backup_v6_path(character_id: int | str, filename: str) -> Path | None:
    """Resolve `backups/<filename>` to an absolute path after regex
    validation. Returns None when the filename fails validation or the
    file isn't on disk. Legacy `*.json` is accepted here (read-only
    view) but only when the legacy regex matches."""
    if BACKUP_FILENAME_RE.match(filename):
        target = backups_dir(character_id) / filename
    elif _BACKUP_FILE_RE.match(filename):
        target = backups_dir(character_id) / filename
    else:
        return None
    if not target.exists() or not target.is_file():
        return None
    return target


# ---- image storage ----------------------------------------------------


# Whitelist for safe filename segments. The pre-dot section must have
# at least one non-`.` character, which is what excludes `.` and `..`
# (both would otherwise satisfy `[A-Za-z0-9_.-]+`). Without this, the
# inline_path("..") case resolved to the parent directory — caught by
# the test_inline_path_rejects_unsafe_basename test added 2026-05-30.
_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$")

# `<image_id>.<ext>` filename in `images/`. image_id is digits for F-list
# images, `local-<8 hex>` for pool-only user uploads not yet on F-list.
_IMAGE_FILE_RE = re.compile(r"^([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)$")


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
        m = _IMAGE_FILE_RE.match(p.name)
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
    if not _SAFE_NAME_RE.match(image_id):
        raise ValueError(f"unsafe image_id: {image_id!r}")
    if not _SAFE_NAME_RE.match(ext):
        raise ValueError(f"unsafe extension: {ext!r}")
    return images_dir(character_id) / f"{image_id}.{ext}"


def inline_path(character_id: int | str, basename: str) -> Path:
    """`inlines/<basename>`. The basename is the CDN URL's last segment
    (typically `<sha1>.<ext>`); validated against the safe-name regex."""
    if not _SAFE_NAME_RE.match(basename):
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


def _detect_image_ext_from_bytes(data: bytes) -> str | None:
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
    these rows with `description`/`sort_order` from working.json to
    decide which are on the profile vs. in the pool view.

    Side-effect: triggers the v4 → v5 pool migration if a legacy pool/
    directory is present. Idempotent — no-op once collapsed."""
    migrate_v4_pool_to_images(character_id)
    out: list[dict[str, Any]] = []
    d = images_dir(character_id)
    if not d.exists():
        return out
    for entry in d.iterdir():
        if not entry.is_file():
            continue
        m = _IMAGE_FILE_RE.match(entry.name)
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
    if not _SAFE_NAME_RE.match(image_id):
        raise ValueError(f"unsafe image_id: {image_id!r}")
    ext_n = normalise_image_ext(ext)
    target = images_dir(character_id) / f"{image_id}.{ext_n}"
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(target)


def add_uploaded_image(
    character_id: int | str,
    data: bytes,
) -> dict[str, Any] | None:
    """Save user-uploaded bytes under `images/local-<sha8>.<ext>`.
    Extension is sniffed from magic bytes — Content-Type is never
    trusted. Returns the metadata row (`{image_id, extension, size,
    added_at}`) or None when the bytes don't match a supported format.
    Idempotent — identical bytes always produce the same `local-<sha8>`
    and the file is written only when missing."""
    ext = _detect_image_ext_from_bytes(data)
    if ext is None:
        return None
    sha = _hash_bytes(data)
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
    }


def remove_character_image(character_id: int | str, image_id: str) -> bool:
    """Delete `images/<image_id>.<ext>`. Permanent — there's no
    secondary pool to fall back on under the v5 model, which is why the
    renderer wraps every call to this in an explicit confirm dialog.
    Returns True iff a file was removed."""
    if not _SAFE_NAME_RE.match(image_id):
        return False
    d = images_dir(character_id)
    if not d.exists():
        return False
    for entry in d.iterdir():
        if not entry.is_file():
            continue
        m = _IMAGE_FILE_RE.match(entry.name)
        if not m or m.group(1) != image_id:
            continue
        try:
            entry.unlink()
            return True
        except OSError:
            return False
    return False


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
            _SAFE_NAME_RE.match(iid) and (images_d / f"{iid}.{ext}").exists()
            for iid in image_ids
        )
        if already_preserved:
            continue
        chosen: str | None = None
        for iid in image_ids:
            if not _SAFE_NAME_RE.match(iid):
                continue
            chosen = iid
            break
        if chosen is None:
            chosen = f"local-{sha[:8]}"
        if not _SAFE_NAME_RE.match(chosen):
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
        if len(stem) < 8 or not _SAFE_NAME_RE.match(stem):
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
    if _SAFE_NAME_RE.match(slug):
        return avatars_root() / f"{slug}.png"
    # Hash the original (case-preserving + space-preserving) name so
    # two characters that only differ in casing land on distinct paths
    # — matches the merge_roster behaviour of keying by lowercase only
    # for collision rather than identity.
    digest = hashlib.sha1(name.strip().lower().encode("utf-8")).hexdigest()
    return avatars_root() / f"{digest}.png"


# ---- roster ----------------------------------------------------------


def list_archived_characters() -> list[dict[str, Any]]:
    """Walk `<userdata>/characters/` and surface every directory that
    looks like a character archive. Each entry: `{id, name, last_pulled_at,
    backup_count}`. Name comes from the last Live snapshot if present —
    we never had a name without a Live, so missing-name is impossible in
    normal use.
    """
    out: list[dict[str, Any]] = []
    root_p = root()
    for entry in root_p.iterdir():
        if not entry.is_dir():
            continue
        cid = entry.name
        live = read_live(cid)
        if live is None:
            # No Live yet — directory created but pull never finished.
            # Skip so the picker doesn't surface broken rows.
            continue
        char = live.get("character") if isinstance(live, dict) else None
        if not isinstance(char, dict):
            # Could be the raw character-data shape too.
            char = live
        name = (
            char.get("name") if isinstance(char, dict) else None
        ) or live.get("name")
        backups = list_backups(cid)
        out.append(
            {
                "id": cid,
                "name": name,
                "last_pulled_at": live.get("fetched_at"),
                "backup_count": len(backups),
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
        row = by_id.get(cid)
        if row is None:
            row = _new(name)
            row["id"] = cid
            by_id[cid] = row
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
