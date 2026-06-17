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

import json
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import paths

CHARACTERS_DIRNAME = "characters"
AVATARS_DIRNAME = "avatars"
CACHE_DIRNAME = "cache"
LIVE_FILENAME = "live.json"
PULL_STATE_FILENAME = "pull_state.json"
WORKING_FILENAME = "working.json"
REGISTRY_FILENAME = "_registry.json"

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
# v5 → v6 (working sets v2): payload moves out of `working.json` into a
#   per-set folder `sets/<set_id>/payload.json`. Structurally the payload
#   shape is unchanged. M3 migration unlinks the legacy `working.json` on
#   first read of any v5-era character directory under the new build.
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
    if not _FOLDER_SAFE_RE.match(name):
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
        # Brand-new character with no legacy folder. Lazy-create on
        # first character_dir() call.
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


def character_dir(character_id: int | str) -> Path:
    cid = str(character_id)
    reg = load_registry()
    entry = reg.get(cid)
    if entry and entry.get("folder"):
        p = root() / entry["folder"]
    else:
        # Unregistered id (no pull yet, or registry corruption) — fall
        # back to the legacy id-named folder so existing data keeps
        # working.
        p = root() / cid
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


def snapshots_dir(character_id: int | str) -> Path:
    """Per-character `snapshots/` dir — JSON checkpoints of `live.json`.

    Terminology: a *snapshot* is the cheap JSON-only checkpoint that
    fires automatically on every pull. A *backup* (see `backups_dir`)
    is a full userscript-restoreable ZIP. They're different artefacts
    in different directories; we keep them strictly separated so the
    user-facing "Back up" never confuses with the auto-save history.

    One-shot migration: pre-rename archives had JSON files under
    `backups/`. If we see that legacy directory and the new
    `snapshots/` doesn't exist yet, move the JSON files over. ZIP
    files in the legacy `backups/` (if any — there shouldn't be) are
    left alone for the user to inspect.
    """
    p = character_dir(character_id) / "snapshots"
    if not p.exists():
        legacy = character_dir(character_id) / "backups"
        if legacy.exists() and legacy.is_dir():
            json_files = [
                e for e in legacy.iterdir()
                if e.is_file() and e.suffix.lower() == ".json"
            ]
            if json_files:
                p.mkdir(parents=True, exist_ok=True)
                for entry in json_files:
                    try:
                        entry.replace(p / entry.name)
                    except OSError:
                        # If a JSON file can't move (locked, perms),
                        # skip it — the legacy backups/ stays around.
                        pass
    p.mkdir(parents=True, exist_ok=True)
    return p


def backups_dir(character_id: int | str) -> Path:
    """Per-character `backups/` dir — full ZIP backups, restorable via
    the userscript. Created lazily by `save_zip_backup`."""
    p = character_dir(character_id) / "backups"
    p.mkdir(parents=True, exist_ok=True)
    return p


# ---- live + snapshot read/write ---------------------------------------


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
    _atomic_write_json(character_dir(character_id) / LIVE_FILENAME, payload)


def read_live(character_id: int | str) -> dict[str, Any] | None:
    p = character_dir(character_id) / LIVE_FILENAME
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save_snapshot(character_id: int | str) -> dict[str, Any]:
    """Snapshot the current Live into `snapshots/<unix>.json`.

    Returns `{path, created_at, filename}` so the renderer can show
    the new entry without re-listing. Raises FileNotFoundError if
    there's no Live to snapshot.
    """
    live = read_live(character_id)
    if live is None:
        raise FileNotFoundError("no Live snapshot to capture")
    now = int(time.time())
    target = snapshots_dir(character_id) / f"{now}.json"
    # On the very-unlikely same-second collision, suffix with a counter.
    i = 1
    while target.exists():
        target = snapshots_dir(character_id) / f"{now}-{i}.json"
        i += 1
    _atomic_write_json(target, live)
    return {"path": str(target), "created_at": now, "filename": target.name}


# Fields that don't represent F-list-side state — excluding them from
# the content hash means "pulled twice in a row with no F-list change"
# doesn't bloat the snapshot directory with identical entries. The pull
# stamps `fetched_at` every time, so without this it would never dedup.
_SNAPSHOT_DEDUP_EXCLUDE = {"fetched_at"}


def _live_content_hash(live: dict[str, Any]) -> str:
    """Canonical-JSON sha256 of `live`, ignoring fields that aren't
    really part of the F-list profile state (currently just
    `fetched_at`). Used by `save_snapshot_if_changed` to skip identical
    snapshots after a no-op pull, and by the ZIP backup dedup."""
    import hashlib

    filtered = {k: v for k, v in live.items() if k not in _SNAPSHOT_DEDUP_EXCLUDE}
    canonical = json.dumps(filtered, sort_keys=True, ensure_ascii=False).encode(
        "utf-8"
    )
    return hashlib.sha256(canonical).hexdigest()


def latest_snapshot_content_hash(character_id: int | str) -> str | None:
    """Content-hash of the most recent snapshot, or None when no
    snapshots exist (or the latest is unreadable). Hashes the same
    shape as `_live_content_hash` so callers can compare in either
    direction."""
    snapshots = list_snapshots(character_id)
    if not snapshots:
        return None
    latest = read_snapshot(character_id, snapshots[0]["filename"])
    if latest is None:
        return None
    return _live_content_hash(latest)


def save_snapshot_if_changed(character_id: int | str) -> dict[str, Any]:
    """Save a snapshot *only* when the current Live differs in content
    from the latest existing snapshot. Returns one of:

      `{saved: True, ...save_snapshot payload}` — wrote a new snapshot.
      `{saved: False, reason: 'unchanged'}`     — Live matches latest.
      `{saved: False, reason: 'no_live'}`       — Live missing.

    Callers (the pull SSE handler) use this to keep a forever-history
    of JSON deltas without thrashing the disk on every pull. Snapshots
    are never pruned — they're a few KB each and the owner explicitly
    wants every change archived.
    """
    live = read_live(character_id)
    if live is None:
        return {"saved": False, "reason": "no_live"}
    current_hash = _live_content_hash(live)
    prior_hash = latest_snapshot_content_hash(character_id)
    if prior_hash == current_hash:
        return {"saved": False, "reason": "unchanged"}
    snapshot = save_snapshot(character_id)
    return {"saved": True, **snapshot}


_SNAPSHOT_FILE_RE = re.compile(r"^(\d+)(?:-(\d+))?\.json$")


def list_snapshots(character_id: int | str) -> list[dict[str, Any]]:
    """List snapshots newest first. Each entry: `{filename, created_at, size}`.

    When two snapshots share the same epoch (same-second collision,
    broken by the `-N` suffix counter in `save_snapshot`), the higher-N
    file is the more recent write — sort key includes the suffix so
    the forever-history dedup check always compares against the
    *truly* latest snapshot.
    """
    out: list[dict[str, Any]] = []
    p = snapshots_dir(character_id)
    for entry in p.iterdir():
        if not entry.is_file():
            continue
        m = _SNAPSHOT_FILE_RE.match(entry.name)
        if not m:
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        suffix = int(m.group(2)) if m.group(2) else 0
        out.append(
            {
                "filename": entry.name,
                "created_at": int(m.group(1)),
                "_suffix": suffix,
                "size": stat.st_size,
            }
        )
    out.sort(key=lambda r: (r["created_at"], r["_suffix"]), reverse=True)
    for row in out:
        row.pop("_suffix", None)
    return out


_ZIP_BACKUP_FILE_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-(\d+))?\.zip$"
)


def _zip_backup_filename(now: float | None = None) -> str:
    """`YYYY-MM-DDTHHMMSSZ.zip` — filesystem-safe ISO basic form. The
    explicit `Z` makes it clear the timestamp is UTC so a user copying
    the file off-machine isn't confused by their local-time mtime."""
    import datetime as _dt

    ts = _dt.datetime.fromtimestamp(
        time.time() if now is None else now, tz=_dt.timezone.utc
    )
    return ts.strftime("%Y-%m-%dT%H%M%SZ") + ".zip"


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
    """List ZIP backups newest first. Each entry: `{filename, created_at, size}`.
    Filenames are the ISO-basic-form written by `save_zip_backup`.

    Tiebreaker: same-second writes are disambiguated by the `-N`
    suffix counter on the filename; higher N = more recent. The sort
    key must reflect that so the dedup check always compares against
    the *truly* latest ZIP — relying on lex order alone would put the
    no-suffix (oldest) file at the top because `.` > `-` in ASCII.
    """
    import datetime as _dt

    out: list[dict[str, Any]] = []
    p = character_dir(character_id) / "backups"
    if not p.exists():
        return out
    for entry in p.iterdir():
        if not entry.is_file():
            continue
        m = _ZIP_BACKUP_FILE_RE.match(entry.name)
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
        out.append(
            {
                "filename": entry.name,
                "created_at": int(ts.timestamp()),
                "_suffix": suffix,
                "size": stat.st_size,
            }
        )
    out.sort(key=lambda r: (r["created_at"], r["_suffix"]), reverse=True)
    for row in out:
        row.pop("_suffix", None)
    return out


def latest_zip_backup_content_hash(character_id: int | str) -> str | None:
    """Hash of the most recent ZIP backup's `character.json`, in the same
    canonical-JSON shape used by `_live_content_hash`. Used by
    `save_zip_backup` to dedup against an unchanged Live so two
    Back-up-all clicks in a row don't write two identical ZIPs."""
    import hashlib
    import zipfile

    rows = list_zip_backups(character_id)
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
    force: bool = False,
) -> dict[str, Any]:
    """Pack the current Live into `<character>/backups/<ISO>.zip` —
    userscript-restoreable, includes every gallery image still on disk
    plus the avatar.

    Distinct from `save_snapshot` (JSON-only, cheap, auto-fires on
    every pull) — *backup* is the explicit "user clicked Back up"
    artefact that bundles bytes.

    Dedup: if the latest existing ZIP's `character.json` matches what
    we'd serialise now, returns `{saved: False, reason: 'unchanged'}`
    so a no-op Back-up-all doesn't bloat the directory. Pass
    `force=True` to bypass (used by the explicit per-character action;
    the bulk sweep dedups by default).

    Returns one of:
      `{saved: True, path, filename, created_at, size}`
      `{saved: False, reason: 'unchanged'}`
      `{saved: False, reason: 'no_live'}`
    """
    import zip_serialise

    live = read_live(character_id)
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
        prior_hash = latest_zip_backup_content_hash(character_id)
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
    )

    target = backups_dir(character_id) / _zip_backup_filename()
    # Collision suffix in case a same-second second click occurs.
    if target.exists():
        i = 1
        while True:
            stem = target.stem  # e.g. "2026-06-04T233015Z"
            candidate = backups_dir(character_id) / f"{stem}-{i}.zip"
            if not candidate.exists():
                target = candidate
                break
            i += 1

    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(target)
    return {
        "saved": True,
        "path": str(target),
        "filename": target.name,
        "created_at": int(time.time()),
        "size": len(data),
    }


def read_snapshot(character_id: int | str, filename: str) -> dict[str, Any] | None:
    if not _SNAPSHOT_FILE_RE.match(filename):
        # Reject anything that doesn't match the on-disk filename shape
        # so a caller can't path-traverse out of snapshots/.
        return None
    p = snapshots_dir(character_id) / filename
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


# ---- working sets v2 -------------------------------------------------

SETS_DIRNAME = "sets"
SET_PAYLOAD_FILENAME = "payload.json"
SET_META_FILENAME = "meta.json"
ACTIVE_SET_FILENAME = "active_set.json"

_SET_ID_RE = re.compile(r"^[0-9a-f]{12}$")
_MAX_SET_NAME_LEN = 80


@dataclass(frozen=True)
class SetMeta:
    id: str
    name: str
    created_at: int
    updated_at: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


def _is_valid_set_id(set_id: str) -> bool:
    return isinstance(set_id, str) and bool(_SET_ID_RE.match(set_id))


def _new_set_id() -> str:
    import uuid

    return uuid.uuid4().hex[:12]


def validate_set_name(name: Any) -> str:
    """Strip + length-check a set name. Duplicates are allowed — the
    underlying set_id is the unique identity per the design doc."""
    if not isinstance(name, str):
        raise ValueError("set name must be a string")
    stripped = name.strip()
    if not stripped:
        raise ValueError("set name is empty")
    if "\x00" in stripped:
        raise ValueError("set name contains NUL")
    if len(stripped) > _MAX_SET_NAME_LEN:
        raise ValueError(f"set name longer than {_MAX_SET_NAME_LEN} chars")
    return stripped


def sets_dir(character_id: int | str) -> Path:
    p = character_dir(character_id) / SETS_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def set_dir(character_id: int | str, set_id: str) -> Path:
    if not _is_valid_set_id(set_id):
        raise ValueError(f"invalid set_id: {set_id!r}")
    return sets_dir(character_id) / set_id


def set_payload_path(character_id: int | str, set_id: str) -> Path:
    return set_dir(character_id, set_id) / SET_PAYLOAD_FILENAME


def set_meta_path(character_id: int | str, set_id: str) -> Path:
    return set_dir(character_id, set_id) / SET_META_FILENAME


def active_set_path(character_id: int | str) -> Path:
    return character_dir(character_id) / ACTIVE_SET_FILENAME


def _migrate_working_v2(character_id: int | str) -> None:
    """M3: drop the legacy `working.json` (and any orphan tmp/bak siblings)
    on first read of a v5-era character directory under the working-sets
    v2 build. Owner-chosen (2026-06-02) — all current users are test users
    and a clean disk is preferred over importing a stale single-set blob.

    Idempotent: re-running on a directory with no legacy file is a no-op.
    Safe to call from every working-sets-v2 helper that touches a
    character directory.
    """
    cdir = character_dir(character_id)
    for name in (WORKING_FILENAME, f"{WORKING_FILENAME}.tmp", "working.bak"):
        path = cdir / name
        if path.exists():
            try:
                path.unlink()
            except OSError:
                pass


def read_set_meta(character_id: int | str, set_id: str) -> SetMeta | None:
    if not _is_valid_set_id(set_id):
        return None
    p = set_meta_path(character_id, set_id)
    if not p.exists():
        return None
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    rid = raw.get("id")
    rname = raw.get("name")
    rcreated = raw.get("created_at")
    rupdated = raw.get("updated_at")
    if not isinstance(rid, str) or not isinstance(rname, str):
        return None
    if not isinstance(rcreated, int) or not isinstance(rupdated, int):
        return None
    return SetMeta(id=rid, name=rname, created_at=rcreated, updated_at=rupdated)


def write_set_meta(
    character_id: int | str,
    set_id: str,
    *,
    name: str,
    created_at: int,
    updated_at: int,
) -> SetMeta:
    if not _is_valid_set_id(set_id):
        raise ValueError(f"invalid set_id: {set_id!r}")
    clean = validate_set_name(name)
    meta = SetMeta(
        id=set_id,
        name=clean,
        created_at=int(created_at),
        updated_at=int(updated_at),
    )
    _atomic_write_json(set_meta_path(character_id, set_id), meta.to_dict())
    return meta


def read_set_payload(character_id: int | str, set_id: str) -> dict[str, Any] | None:
    if not _is_valid_set_id(set_id):
        return None
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
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def set_payload_etag(character_id: int | str, set_id: str) -> str | None:
    if not _is_valid_set_id(set_id):
        return None
    return _file_sha256(set_payload_path(character_id, set_id))


def write_set_payload(
    character_id: int | str,
    set_id: str,
    payload: dict[str, Any],
    *,
    expected_etag: str | None,
) -> str:
    """Persist a set's payload atomically; return the new sha256 etag.

    Mirrors `write_working`'s validation: `_overlay` must be a list of
    strings; at least one recognised top-level content key must be
    present; schema version is stamped to v6.
    """
    if not _is_valid_set_id(set_id):
        raise ValueError(f"invalid set_id: {set_id!r}")
    if not isinstance(payload, dict):
        raise ValueError("set payload must be a dict")
    payload = _migrate_working_payload(dict(payload))
    overlay = payload.get("_overlay")
    if not isinstance(overlay, list) or not all(isinstance(s, str) for s in overlay):
        raise ValueError("_overlay must be a list of strings")
    if not any(k in payload for k in _WORKING_TOP_LEVEL_KEYS):
        raise ValueError(
            "set payload must carry at least one of "
            f"{sorted(_WORKING_TOP_LEVEL_KEYS)}"
        )
    meta = read_set_meta(character_id, set_id)
    if meta is None:
        raise FileNotFoundError(f"set {set_id} not found")
    p = set_payload_path(character_id, set_id)
    current = _file_sha256(p)
    if expected_etag is not None and current != expected_etag:
        raise EtagMismatch(current)
    _atomic_write_json(p, payload)
    now = int(time.time())
    write_set_meta(
        character_id,
        set_id,
        name=meta.name,
        created_at=meta.created_at,
        updated_at=now,
    )
    new_etag = _file_sha256(p)
    assert new_etag is not None
    return new_etag


def read_active_set_id(character_id: int | str) -> str | None:
    p = active_set_path(character_id)
    if not p.exists():
        return None
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    val = raw.get("active_set_id")
    if val is None:
        return None
    if isinstance(val, str) and _is_valid_set_id(val):
        return val
    return None


def set_active_set_id(character_id: int | str, set_id: str) -> None:
    if not _is_valid_set_id(set_id):
        raise ValueError(f"invalid set_id: {set_id!r}")
    _atomic_write_json(active_set_path(character_id), {"active_set_id": set_id})


def clear_active_set_id(character_id: int | str) -> None:
    _atomic_write_json(active_set_path(character_id), {"active_set_id": None})


def list_sets(character_id: int | str) -> list[SetMeta]:
    """List every set on disk for a character, newest first.

    Triggers the M3 migration once per directory before walking. Sets
    with corrupt or missing meta.json are skipped — a half-written set
    folder is invisible until repaired by another write.
    """
    _migrate_working_v2(character_id)
    out: list[SetMeta] = []
    d = sets_dir(character_id)
    if not d.exists():
        return out
    for entry in d.iterdir():
        if not entry.is_dir():
            continue
        if not _is_valid_set_id(entry.name):
            continue
        meta = read_set_meta(character_id, entry.name)
        if meta is None:
            continue
        out.append(meta)
    out.sort(key=lambda m: (-m.updated_at, m.id))
    return out


def create_set_from_live(character_id: int | str, name: str) -> SetMeta:
    """Seed a new set from `live.json`. Raises ValueError if no Live
    exists yet — the renderer disables `+ New working set` in that case
    (design doc §"Seed-from-F-list on create")."""
    _migrate_working_v2(character_id)
    clean = validate_set_name(name)
    live = read_live(character_id)
    if live is None:
        raise ValueError("no live snapshot to seed from")
    payload = _seed_payload_from_live(live)
    return _materialise_set(character_id, clean, payload)


def duplicate_set(
    character_id: int | str,
    source_set_id: str,
    name: str,
) -> SetMeta:
    """Copy `source_set_id`'s payload into a new set with a fresh id and
    meta. Raises FileNotFoundError if the source set is missing."""
    _migrate_working_v2(character_id)
    clean = validate_set_name(name)
    if not _is_valid_set_id(source_set_id):
        raise FileNotFoundError(f"set {source_set_id} not found")
    src_payload = read_set_payload(character_id, source_set_id)
    src_meta = read_set_meta(character_id, source_set_id)
    if src_payload is None or src_meta is None:
        raise FileNotFoundError(f"set {source_set_id} not found")
    return _materialise_set(character_id, clean, src_payload)


def rename_set(
    character_id: int | str,
    set_id: str,
    new_name: str,
) -> SetMeta:
    _migrate_working_v2(character_id)
    clean = validate_set_name(new_name)
    meta = read_set_meta(character_id, set_id)
    if meta is None:
        raise FileNotFoundError(f"set {set_id} not found")
    now = int(time.time())
    return write_set_meta(
        character_id,
        set_id,
        name=clean,
        created_at=meta.created_at,
        updated_at=now,
    )


def delete_set(character_id: int | str, set_id: str) -> None:
    """Unlink `sets/<set_id>/` and, if it was active, clear the active
    pointer. Raises FileNotFoundError if the set does not exist."""
    _migrate_working_v2(character_id)
    if not _is_valid_set_id(set_id):
        raise FileNotFoundError(f"set {set_id} not found")
    d = set_dir(character_id, set_id)
    if not d.exists():
        raise FileNotFoundError(f"set {set_id} not found")
    import shutil

    shutil.rmtree(d, ignore_errors=True)
    if read_active_set_id(character_id) == set_id:
        clear_active_set_id(character_id)


def _materialise_set(
    character_id: int | str,
    name: str,
    payload: dict[str, Any],
) -> SetMeta:
    sid = _new_set_id()
    while set_dir(character_id, sid).exists():
        sid = _new_set_id()
    set_dir(character_id, sid).mkdir(parents=True, exist_ok=True)
    stamped = _migrate_working_payload(dict(payload))
    _atomic_write_json(set_payload_path(character_id, sid), stamped)
    now = int(time.time())
    return write_set_meta(
        character_id,
        sid,
        name=name,
        created_at=now,
        updated_at=now,
    )


def _seed_payload_from_live(live: dict[str, Any]) -> dict[str, Any]:
    """Build a fresh working payload from a Live snapshot. Mirrors the
    renderer's `seedWorkingFromLive` so a sidecar-only create still hands
    the editor something structurally complete."""
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


def _find_image_with_sha(
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
        if not _IMAGE_FILE_RE.match(entry.name):
            continue
        try:
            if entry.stat().st_size == 0:
                continue
            if _hash_bytes(entry.read_bytes()) == sha:
                return entry
        except OSError:
            continue
    return None


def collapse_local_duplicates(character_id: int | str) -> int:
    """Walk `images/` and remove any `local-<sha8>.<ext>` whose bytes
    are byte-identical to a real-id (digits-only) file in the same
    directory. Patches working.json so any gallery slot that referenced
    the doomed local id now points at the real id, then unlinks the
    local file. Returns the number of locals collapsed.

    This is the cure for stuck archives where the user has the same
    image visible twice in the Pool — once as `id <digits>` (the file
    they originally pulled) and once as `Local · <sha8>` (a re-upload
    of the same bytes that pre-dates the `add_uploaded_image` dedup
    fix). Idempotent — re-runs are no-ops once all locals are unique.
    Best-effort — any OSError on a single entry is skipped, not raised."""
    d = images_dir(character_id)
    if not d.exists():
        return 0
    locals_: list[Path] = []
    reals: list[Path] = []
    for entry in d.iterdir():
        if not entry.is_file():
            continue
        m = _IMAGE_FILE_RE.match(entry.name)
        if not m:
            continue
        iid = m.group(1)
        if iid.startswith("local-"):
            locals_.append(entry)
        elif iid.isdigit():
            reals.append(entry)
    if not locals_ or not reals:
        return 0
    real_shas: dict[str, str] = {}
    for r in reals:
        try:
            real_shas[r.name] = _hash_bytes(r.read_bytes())
        except OSError:
            continue
    collapsed = 0
    for lp in locals_:
        try:
            l_sha = _hash_bytes(lp.read_bytes())
        except OSError:
            continue
        match: str | None = None
        for rname, rsha in real_shas.items():
            if rsha == l_sha:
                rm = _IMAGE_FILE_RE.match(rname)
                if rm:
                    match = rm.group(1)
                    break
        if match is None:
            continue
        lm = _IMAGE_FILE_RE.match(lp.name)
        if lm is None:
            continue
        local_id = lm.group(1)
        for _ in range(3):
            payload = read_working(character_id)
            if payload is None:
                break
            images = payload.get("images")
            if not isinstance(images, list):
                break
            changed = False
            kept: list[Any] = []
            seen_real = False
            for entry in images:
                if not isinstance(entry, dict):
                    kept.append(entry)
                    continue
                eid = entry.get("image_id")
                if eid == local_id:
                    if seen_real:
                        changed = True
                        continue
                    entry["image_id"] = match
                    seen_real = True
                    changed = True
                    kept.append(entry)
                elif eid == match:
                    if seen_real:
                        changed = True
                        continue
                    seen_real = True
                    kept.append(entry)
                else:
                    kept.append(entry)
            if changed:
                payload["images"] = kept
                try:
                    etag = _file_sha256(working_path(character_id))
                    write_working(character_id, payload, expected_etag=etag)
                    break
                except EtagMismatch:
                    continue
                except (ValueError, OSError):
                    break
            else:
                break
        try:
            lp.unlink()
            collapsed += 1
        except OSError:
            continue
    return collapsed


def dedupe_local_after_pull(
    character_id: int | str,
    pulled_image_id: str,
    pulled_bytes: bytes,
) -> str | None:
    """If a freshly-downloaded image's bytes match a `local-<sha8>` file
    on disk (the same bytes the user uploaded locally, now coming back
    from F-list under a real id), remove the local copy and rewrite any
    working.json gallery slot that pointed at it so the user doesn't end
    up with the image visible twice (once in the pool, once on profile).

    Best-effort — failures here never block the pull. Returns the
    local-id that was removed, or None.
    """
    if pulled_image_id.startswith("local-"):
        return None
    full = _hash_bytes(pulled_bytes)
    sha8 = full[:8]
    d = images_dir(character_id)
    candidates = sorted(d.glob(f"local-{sha8}.*"))
    if not candidates:
        return None
    matched: Path | None = None
    for c in candidates:
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
    # Patch working.json so any gallery slot that referenced the local
    # id now points at the real F-list id — preserves slot order and
    # whatever description the user already typed. Stale ref left in
    # place if the swap fails; the file removal below still cures the
    # visible "image shows in both panes" bug.
    for _ in range(3):
        payload = read_working(character_id)
        if payload is None:
            break
        images = payload.get("images")
        if not isinstance(images, list):
            break
        changed = False
        for entry in images:
            if isinstance(entry, dict) and entry.get("image_id") == local_id:
                entry["image_id"] = pulled_image_id
                changed = True
        if not changed:
            break
        try:
            etag = _file_sha256(working_path(character_id))
            write_working(character_id, payload, expected_etag=etag)
            break
        except EtagMismatch:
            continue
        except (ValueError, OSError):
            break
    try:
        matched.unlink()
    except OSError:
        return None
    return local_id


def add_uploaded_image(
    character_id: int | str,
    data: bytes,
) -> dict[str, Any] | None:
    """Save user-uploaded bytes under `images/local-<sha8>.<ext>`.
    Extension is sniffed from magic bytes — Content-Type is never
    trusted. Returns the metadata row (`{image_id, extension, size,
    added_at}`) or None when the bytes don't match a supported format.
    Idempotent — identical bytes always produce the same `local-<sha8>`
    and the file is written only when missing.

    If a byte-identical file already exists in `images/` (regardless of
    whether it's keyed by a real F-list id or a prior `local-<sha8>`),
    return that file's row instead of minting a parallel copy. Prevents
    the "same image shows twice in pool" symptom when a user re-uploads
    bytes that came from an earlier F-list pull."""
    ext = _detect_image_ext_from_bytes(data)
    if ext is None:
        return None
    sha = _hash_bytes(data)
    existing = _find_image_with_sha(character_id, sha)
    if existing is not None:
        try:
            stat = existing.stat()
            m = _IMAGE_FILE_RE.match(existing.name)
            return {
                "image_id": m.group(1) if m else existing.stem,
                "extension": (m.group(2).lower() if m else ext),
                "size": stat.st_size,
                "added_at": int(stat.st_mtime),
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
    snapshot_count, backup_count}`. Name comes from the last Live
    snapshot if present — we never had a name without a Live, so
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
        snapshots = list_snapshots(cid)
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
                "snapshot_count": len(snapshots),
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
