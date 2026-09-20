"""Read-only cache for *other people's* F-list profiles.

Deliberately a separate store from `character_archive`, with its own
root:

    <userdata>/foreign/<slug>/profile.json     character-data.php verbatim
    <userdata>/foreign/<slug>/avatar.png
    <userdata>/foreign/<slug>/images/<image_id>.<ext>

`profile.json` carries exactly the shape `character_archive.write_live`
stores — the same `character-data.php` payload with a `fetched_at`
stamp — so the renderer's existing profile panes read it without a
translation layer.

The separate root is the point. Everything that can copy, back up,
export or edit a character resolves its paths through
`character_archive.character_dir()`, and nothing under `foreign/` is
reachable that way. Copying one of these into a working set is still
*possible* for anyone with a file manager; what the app must not offer
is a button that does it.

Nothing here is user data in the durable sense — it is a cache so a
second look at a profile does not re-download a 40-image gallery. It
is never cleared automatically: a stale profile still answers "how was
this written", which is what the viewer is for.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import paths

FOREIGN_DIRNAME = "foreign"
PROFILE_FILENAME = "profile.json"
IMAGES_DIRNAME = "images"
AVATAR_FILENAME = "avatar.png"

#: How long a cached profile is served without asking F-list again.
#: The viewer's ↻ button and `refresh=True` bypass it.
DEFAULT_TTL_SEC = 24 * 3600


def root() -> Path:
    p = paths.user_data_dir() / FOREIGN_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def slug_for(name: str) -> str:
    """On-disk folder name for a character name.

    Mirrors `character_archive._slug_for` — readable folder when the
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
    from character_archive import _is_folder_safe

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

    Written the same way the archive writes `live.json` — temp file
    then replace — so a half-written profile is never readable.
    """
    stamped = dict(payload)
    stamped["fetched_at"] = int(time.time())
    target = _profile_path(name)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(
        json.dumps(stamped, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    try:
        tmp.replace(target)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    return stamped


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
