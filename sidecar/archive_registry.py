"""Where the character archive lives on disk, and which characters it holds.

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

The archive is five modules; each imports only the ones listed above it:

    archive_registry   folders, the id → folder registry, the roster, and
                       what every writer shares (the per-character
                       lock, `_publish`, `_atomic_write_json`)
    archive_live       Live: what F-list showed at the last Pull
    archive_workbench  the Workbench: the one editable copy
    archive_images     images, inlines, avatars, the pull manifest, and
                       the gallery's dedupe, repair and adopt
    archive_backups    Backups, and replacing the whole Workbench, which
                       keeps it as a Backup first
"""
from __future__ import annotations

import functools
import json
import re
import threading
from pathlib import Path
from typing import Any, Callable, Iterable, TypeVar

import atomic_write
import paths
from archive_errors import CharacterNotFound, InvalidCharacterId

CHARACTERS_DIRNAME = "characters"
AVATARS_DIRNAME = "avatars"
CACHE_DIRNAME = "cache"
LIVE_FILENAME = "live.json"
REGISTRY_FILENAME = "_registry.json"

#: The folder of a character's Backups, below its character folder.
#: Code that walks folders without an id (the startup migration) joins
#: it on; everything else asks `backups_dir`.
BACKUPS_DIRNAME = "backups"


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
#: Re-entrant: `register_character` holds it across its whole
#: read-modify-write, and the load and save inside take it again.
_REGISTRY_LOCK = threading.RLock()


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
    with _REGISTRY_LOCK:
        return _register_character(str(character_id), name)


def _register_character(cid: str, name: str) -> str:
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


# ---- one lock per character ----------------------------------------
#
# Every read-modify-write of a character's Live, Workbench, Backups or
# images runs under that character's lock, whoever asks: a REST route
# on the event loop, an MCP tool, threadpool work. So two writers that
# read the same Workbench cannot both pass the etag check, and a reader
# never meets a file halfway through being replaced (on Windows a
# replace and an open reader refuse each other).
#
# Re-entrant, because the archive's writers call each other: a Backup
# repairs the gallery first, replacing the Workbench takes a Backup
# first, image-id adoption rewrites the Workbench. Held only around
# synchronous work, never across an `await`, so a coroutine waiting on
# the network never holds it. Order: a character's lock before the
# registry's or any module lock (`image_trash._lock` ...), never the
# other way round.

_CHARACTER_LOCKS: dict[str, threading.RLock] = {}
_CHARACTER_LOCKS_GUARD = threading.Lock()


def character_lock(character_id: int | str) -> threading.RLock:
    """The lock for one character, the same object for every caller."""
    cid = str(character_id)
    with _CHARACTER_LOCKS_GUARD:
        lock = _CHARACTER_LOCKS.get(cid)
        if lock is None:
            lock = _CHARACTER_LOCKS[cid] = threading.RLock()
        return lock


_F = TypeVar("_F", bound=Callable[..., Any])


def under_character_lock(fn: _F) -> _F:
    """Run `fn(character_id, ...)` holding that character's lock."""

    @functools.wraps(fn)
    def locked(character_id: int | str, *args: Any, **kwargs: Any) -> Any:
        with character_lock(character_id):
            return fn(character_id, *args, **kwargs)

    return locked  # type: ignore[return-value]


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
    the archive. Only a Pull (`write_live`) calls this; every other path
    finds the character with `character_dir`."""
    p, _registered = _folder_for(character_id)
    p.mkdir(parents=True, exist_ok=True)
    return p


# ---- shared by the archive modules ----------------------------------
#
# The event bus and the archive's JSON writer, used by every archive
# module that writes (Live, the Workbench, the pull manifest).


def _events() -> Any:
    """The event bus module. Imported lazily, so the archive imports
    without `services`."""
    from services import events

    return events


def _publish(event: str, **data: Any) -> None:
    """Announce a change on the event bus, if one is running.

    Publishing lives here rather than in the callers so *every* writer
    is covered — the REST routes the window calls and the MCP tools a
    model calls alike. Imported lazily and failure-swallowing: a
    notification is never worth failing a write for, and the archive
    must stay importable in tests that don't run a loop.
    """
    try:
        _events().publish(event, **data)
    except Exception:  # noqa: BLE001
        pass


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """Write `payload` as the archive's indented JSON, atomically."""
    atomic_write.write_json(path, payload, indent=2, ensure_ascii=False)


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
        zip_dir = character_dir(cid) / BACKUPS_DIRNAME
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
