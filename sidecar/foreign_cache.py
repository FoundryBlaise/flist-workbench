"""Read-only cache for *other people's* F-list profiles.

Deliberately a separate store from the character archive (the
`archive_*` modules), with its own root:

    <userdata>/foreign/<slug>/profile.json     character-data.php verbatim
    <userdata>/foreign/<slug>/avatar.png
    <userdata>/foreign/<slug>/images/<image_id>.<ext>

`profile.json` carries exactly the shape `archive_live.write_live`
stores — the same `character-data.php` payload with a `fetched_at`
stamp — so the renderer's existing profile panes read it without a
translation layer.

The separate root is the point. Everything that can copy, back up,
export or edit a character resolves its paths through
`archive_registry.character_dir()`, and nothing under `foreign/` is
reachable that way. Copying one of these into a Workbench is still
*possible* for anyone with a file manager; what the app must not offer
is a button that does it.

Nothing here is user data in the durable sense — it is a cache so a
second look at a profile does not re-download a 40-image gallery. Age
alone never clears an entry: a stale profile still answers "how was
this written", which is what the viewer is for. What does clear one is
F-list saying the profile is gone or not for us (deleted, private,
blocked): `delete_profile` drops it with its images and avatar.

The cache is bounded by size, not age. `.index.json` in the root
tracks each profile folder's total size (profile, gallery images,
avatar) and when it was last viewed. Whenever a file lands, the least
recently viewed profiles go, whole, until the total fits the cap
again; the profile the file belongs to is never the one evicted, so a
single profile larger than the cap still opens. The index is checked
against the folders on every use, so a folder deleted by hand, or one
cached before the index existed, is accounted for.
"""

from __future__ import annotations

import json
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Iterable

import atomic_write
import paths

FOREIGN_DIRNAME = "foreign"
PROFILE_FILENAME = "profile.json"
IMAGES_DIRNAME = "images"
AVATAR_FILENAME = "avatar.png"
#: Starts with a dot, which no slug does (`slug_for` hashes such names).
INDEX_FILENAME = ".index.json"

MB = 1024 * 1024
#: The cap when Settings has none: 1 GB.
DEFAULT_CAP_MB = 1024

#: Re-entrant: `store_fetched` holds it across a write and the eviction
#: that follows, and both take it again. Settings changes arrive on a
#: worker thread while the event loop serves the viewer.
_LOCK = threading.RLock()

#: How long a cached profile is served without asking F-list again.
#: The viewer's ↻ button and `refresh=True` bypass it.
DEFAULT_TTL_SEC = 24 * 3600


def root() -> Path:
    p = paths.user_data_dir() / FOREIGN_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def slug_for(name: str) -> str:
    """On-disk folder name for a character name.

    Mirrors `archive_registry._slug_for` — readable folder when the
    name is filesystem-safe, sha1 fallback otherwise — with two
    differences. The fallback prefix is `f_`, so a directory listing
    distinguishes these from the `c_` folders of the user's own
    archive. And the slug is built from the *lowercased* name.

    The lowercasing matters. F-list resolves a character by name
    case-insensitively, and F-Chat writes its log directories
    lowercased, so the same profile arrives here spelled three ways
    ("Foo Bar" typed, "foo bar" from a log, "FOO BAR" from a
    bookmark). Slugging case-insensitively makes all three one cache
    entry instead of three, and matches what a Windows filesystem
    would have done to them anyway. The canonical spelling F-list
    returns is kept inside `profile.json`, which is what the viewer
    displays.
    """
    import hashlib

    n = (name or "").strip().lower()
    if not n:
        raise ValueError("character name is empty")
    # Reuse the archive's safety predicate rather than keeping a second
    # copy of the Windows reserved-name list in sync.
    from archive_registry import _is_folder_safe

    if _is_folder_safe(n):
        return n
    digest = hashlib.sha1(n.encode("utf-8")).hexdigest()[:16]
    return f"f_{digest}"


def profile_dir(name: str) -> Path:
    return root() / slug_for(name)


def images_dir(name: str) -> Path:
    p = profile_dir(name) / IMAGES_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def avatar_path(name: str) -> Path:
    return profile_dir(name) / AVATAR_FILENAME


def _profile_path(name: str) -> Path:
    return profile_dir(name) / PROFILE_FILENAME


def read_profile(name: str) -> dict[str, Any] | None:
    """The cached payload at whatever age, or None on a miss.

    A folder whose `profile.json` holds a different character is
    treated as a miss. Slugs are case-insensitive by design, so this
    only fires on a hand-edited cache directory — but serving one
    character's profile under another's name is the kind of mix-up
    worth one cheap check.
    """
    p = _profile_path(name)
    if not p.exists():
        return None
    try:
        payload = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    cached_name = payload.get("name")
    if isinstance(cached_name, str) and cached_name.strip():
        if cached_name.strip().lower() != name.strip().lower():
            return None
    return payload


def write_profile(name: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Store `payload` with a `fetched_at` stamp. Returns what landed.

    Written atomically, like the archive's `live.json`, so a
    half-written profile is never readable.
    """
    stamped = dict(payload)
    stamped["fetched_at"] = int(time.time())
    atomic_write.write_json(_profile_path(name), stamped, indent=2, ensure_ascii=False)
    return stamped


def delete_profile(name: str) -> bool:
    """Delete the cached Foreign profile for `name`: its `profile.json`,
    its gallery images and its avatar, the whole folder. Returns whether
    there was anything to delete.

    `profile.json` goes first, so a folder that cannot be removed in
    full (a file another program holds open) is no longer served as a
    cached copy. Any failure is raised: a profile its owner withdrew
    must not quietly stay on disk.

    Not the Trash: the recoverability rule protects the user's own data,
    and this is a copy of somebody else's.
    """
    folder = profile_dir(name)
    if not folder.exists():
        return False
    _remove_folder(folder)
    return True


def _remove_folder(folder: Path) -> None:
    (folder / PROFILE_FILENAME).unlink(missing_ok=True)
    shutil.rmtree(folder)


def age_sec(payload: dict[str, Any] | None) -> float | None:
    """Seconds since `fetched_at`, or None if the stamp is missing or
    unreadable. A payload we cannot date is treated as stale by
    `is_fresh` rather than as infinitely fresh."""
    if not isinstance(payload, dict):
        return None
    stamp = payload.get("fetched_at")
    if not isinstance(stamp, (int, float)):
        return None
    return max(0.0, time.time() - float(stamp))


def is_fresh(payload: dict[str, Any] | None, ttl_sec: float = DEFAULT_TTL_SEC) -> bool:
    age = age_sec(payload)
    if age is None:
        return False
    return age < ttl_sec


def image_path(name: str, image_id: str, ext: str) -> Path:
    return images_dir(name) / f"{image_id}.{ext}"


def find_image(name: str, image_id: str) -> Path | None:
    """The cached file for `image_id` whatever extension it landed
    under, so callers don't have to remember one."""
    d = profile_dir(name) / IMAGES_DIRNAME
    if not d.is_dir():
        return None
    for ext in ("png", "jpg", "gif"):
        candidate = d / f"{image_id}.{ext}"
        if candidate.exists():
            return candidate
    return None


# ---- size and eviction ------------------------------------------------


def _index_path() -> Path:
    return root() / INDEX_FILENAME


def _folder_bytes(folder: Path) -> int:
    total = 0
    for p in folder.rglob("*"):
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:
            continue
    return total


def _first_seen(folder: Path) -> float:
    """When a folder the index does not know was last viewed, as near as
    the disk can say: its profile's write time, else the folder's."""
    for p in (folder / PROFILE_FILENAME, folder):
        try:
            return p.stat().st_mtime
        except OSError:
            continue
    return 0.0


def _load_index() -> dict[str, dict[str, float]]:
    """`{slug: {bytes, viewed_at}}` for every profile folder on disk.

    A folder the stored index does not list is measured; an entry whose
    folder is gone is dropped."""
    try:
        stored = json.loads(_index_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        stored = {}
    if not isinstance(stored, dict):
        stored = {}
    index: dict[str, dict[str, float]] = {}
    for folder in root().iterdir():
        if not folder.is_dir():
            continue
        known = stored.get(folder.name)
        if (
            isinstance(known, dict)
            and isinstance(known.get("bytes"), int)
            and isinstance(known.get("viewed_at"), (int, float))
        ):
            index[folder.name] = {
                "bytes": known["bytes"],
                "viewed_at": float(known["viewed_at"]),
            }
        else:
            index[folder.name] = {
                "bytes": _folder_bytes(folder),
                "viewed_at": _first_seen(folder),
            }
    return index


def _save_index(index: dict[str, dict[str, float]]) -> None:
    atomic_write.write_json(_index_path(), index, indent=1, sort_keys=True)


def _view_stamp(index: dict[str, dict[str, float]]) -> float:
    """Now, but always later than every stamp already given out, so two
    views within the clock's resolution still have an order."""
    latest = max((e["viewed_at"] for e in index.values()), default=0.0)
    return max(time.time(), latest + 0.001)


def _evict(index: dict[str, dict[str, float]], cap_bytes: int, keep: str | None) -> list[str]:
    """Remove the least recently viewed folders, never `keep`, until the
    total fits `cap_bytes`. Returns the slugs removed. A folder that
    cannot be removed in full (a file another program holds open) is
    re-measured and left for the next pass; its profile no longer
    serves, as with `delete_profile`."""
    total = sum(int(e["bytes"]) for e in index.values())
    evicted: list[str] = []
    by_age = sorted((s for s in index if s != keep), key=lambda s: index[s]["viewed_at"])
    for slug in by_age:
        if total <= cap_bytes:
            break
        folder = root() / slug
        before = int(index[slug]["bytes"])
        try:
            _remove_folder(folder)
        except OSError:
            left = _folder_bytes(folder) if folder.exists() else 0
            index[slug]["bytes"] = left
            total -= before - left
            continue
        del index[slug]
        total -= before
        evicted.append(slug)
    return evicted


def store_fetched(
    name: str, payload: dict[str, Any], gallery_ids: Iterable[str], cap_bytes: int
) -> dict[str, Any]:
    """Store a profile F-list just sent, as `write_profile` does, and
    account for it: it becomes the most recently viewed profile, and
    older ones are evicted until the cache fits `cap_bytes`.

    When it replaces a cached copy (a refresh), gallery images whose id
    is not in `gallery_ids` go, and so does the avatar, which the avatar
    route then fetches anew."""
    with _LOCK:
        replaced = _profile_path(name).exists()
        stamped = write_profile(name, payload)
        if replaced:
            keep_ids = {str(i) for i in gallery_ids}
            images = profile_dir(name) / IMAGES_DIRNAME
            if images.is_dir():
                for image in images.iterdir():
                    if image.is_file() and image.stem not in keep_ids:
                        image.unlink(missing_ok=True)
            avatar_path(name).unlink(missing_ok=True)
        index = _load_index()
        slug = slug_for(name)
        index[slug] = {
            "bytes": _folder_bytes(profile_dir(name)),
            "viewed_at": _view_stamp(index),
        }
        _evict(index, cap_bytes, keep=slug)
        _save_index(index)
    return stamped


def mark_viewed(name: str) -> None:
    """Make `name` the most recently viewed profile, so it is the last
    one an eviction takes. Nothing happens when it is not cached."""
    with _LOCK:
        index = _load_index()
        slug = slug_for(name)
        if slug not in index:
            return
        index[slug]["viewed_at"] = _view_stamp(index)
        _save_index(index)


def file_landed(name: str, cap_bytes: int) -> list[str]:
    """Account for a file just written into `name`'s folder (a gallery
    image, the avatar) and evict other profiles until the cache fits
    `cap_bytes`. Returns the slugs evicted."""
    with _LOCK:
        index = _load_index()
        slug = slug_for(name)
        folder = root() / slug
        if slug in index:
            index[slug]["bytes"] = _folder_bytes(folder)
        evicted = _evict(index, cap_bytes, keep=slug)
        _save_index(index)
        return evicted


def enforce_cap(cap_bytes: int) -> list[str]:
    """Evict until the cache fits `cap_bytes`, keeping the most recently
    viewed profile whatever its size. For a cap that was just lowered."""
    with _LOCK:
        index = _load_index()
        newest = max(index, key=lambda s: index[s]["viewed_at"], default=None)
        evicted = _evict(index, cap_bytes, keep=newest)
        _save_index(index)
        return evicted


def usage() -> dict[str, int]:
    """`{bytes, profiles}`: what the cache holds now."""
    with _LOCK:
        index = _load_index()
        _save_index(index)
        return {
            "bytes": sum(int(e["bytes"]) for e in index.values()),
            "profiles": len(index),
        }


def clear() -> dict[str, int]:
    """Delete every cached profile. Returns `{removed, bytes, profiles}`:
    how many went, and what is left (a folder another program holds a
    file of stays until the next eviction or clear)."""
    with _LOCK:
        index = _load_index()
        removed = len(_evict(index, -1, keep=None))
        _save_index(index)
        return {
            "removed": removed,
            "bytes": sum(int(e["bytes"]) for e in index.values()),
            "profiles": len(index),
        }
