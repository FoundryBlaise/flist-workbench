"""Looking at somebody else's F-list profile, read-only.

Three things live here: where the candidate names come from, fetching
one profile into the cache, and the shared budget check that stops an
MCP client spending the user's F-list quota.

What this module deliberately does *not* have is a write path into
`character_archive`. Nothing here produces a working set, a snapshot,
a backup or an export, and no tool or route is offered that would. The
viewer exists to answer "how is this profile put together", and that
question is answered by reading.

Gallery images are not downloaded here. A profile can carry fifty of
them and downloading the set would turn a profile open into a
half-minute wait; `GET /foreign/character/{name}/image/{id}` fetches
and caches each one the first time something asks for it instead.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

import flist_api
import foreign_cache
import logs as log_store

#: Where a list of candidate names can come from. `name` is the free
#: text case — F-list has no character-search endpoint, so the typed
#: string is taken as an exact name to look up rather than a query.
SOURCES = ("bookmarks", "friends", "logs", "name")

#: Bookmarks and friends cost an API call to read, and they change on
#: a human timescale. Ten minutes keeps a user flipping between the
#: two source tabs from spending a call each time.
SOCIAL_TTL_SEC = 600

#: Upper bound on rows handed back. The window pulls the whole pool
#: once per source and filters it locally, so this has to be big
#: enough to be the *pool*, not a page of it.
MAX_RESULTS = 5000

#: The log sweep walks every character directory on disk. It changes
#: when the user roleplays, not between keystrokes.
LOG_PARTNERS_TTL_SEC = 120

_social_cache: dict[str, list[str]] | None = None
_social_cached_at: float = 0.0

_log_partner_cache: list[str] | None = None
_log_partner_cached_at: float = 0.0


class ForeignError(Exception):
    """Something the caller should see as a message, not a traceback."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


def _trim(names: list[str], query: str) -> list[str]:
    q = query.strip().lower()
    if not q:
        return names[:MAX_RESULTS]
    return [n for n in names if q in n.lower()][:MAX_RESULTS]


async def social_lists(*, force: bool = False) -> dict[str, list[str]]:
    """The account's bookmarks and friends, cached for `SOCIAL_TTL_SEC`."""
    global _social_cache, _social_cached_at
    fresh = (
        _social_cache is not None
        and (time.monotonic() - _social_cached_at) < SOCIAL_TTL_SEC
    )
    if fresh and not force:
        return _social_cache  # type: ignore[return-value]
    try:
        lists = await flist_api.fetch_social_lists()
    except (flist_api.TicketRequired, flist_api.AuthFailure) as exc:
        raise ForeignError("not_signed_in", str(exc)) from exc
    except flist_api.RateLimited as exc:
        raise ForeignError("rate_limited", str(exc)) from exc
    except flist_api.FlistApiError as exc:
        raise ForeignError("flist_error", str(exc)) from exc
    _social_cache = lists
    _social_cached_at = time.monotonic()
    return lists


def reset_social_cache() -> None:
    """Drop the memoised bookmarks/friends. Sign-out calls this so the
    next account does not see the previous one's lists."""
    global _social_cache, _social_cached_at
    _social_cache = None
    _social_cached_at = 0.0


def _scan_log_partner_names(root: Path) -> list[str]:
    """Walk `<root>/<character>/logs/` and collect partner names.

    Deliberately not `logs.list_partners()`. That returns a
    `PartnerEntry` carrying each conversation's byte size, which costs
    a `stat()` per log file — on a well-used log directory the sweep
    took several seconds, and the picker was running it on every
    keystroke. Here only the names are wanted, and `os.scandir`
    answers `is_file()` from the directory entry the OS already handed
    over, with no second syscall.

    Channels are dropped: a `#channel` or `#adh-...` row is a room,
    not a character, and looking one up on F-list returns nothing.
    Names come back as F-Chat wrote them (lowercased); F-list resolves
    them case-insensitively and the canonical spelling arrives with
    the profile.
    """
    seen: dict[str, str] = {}
    try:
        top = os.scandir(root)
    except OSError as exc:
        raise ForeignError("no_logs", f"cannot read {root}: {exc}") from exc
    with top:
        for char_entry in top:
            if char_entry.name.startswith(".") or not char_entry.is_dir():
                continue
            logs_dir = os.path.join(char_entry.path, "logs")
            try:
                inner = os.scandir(logs_dir)
            except OSError:
                # A character directory with no logs subdir. Nothing to
                # contribute, and not a reason to fail the whole sweep.
                continue
            with inner:
                for entry in inner:
                    name = entry.name
                    if name.endswith(".idx") or name == "_" or name.startswith("#"):
                        continue
                    if not entry.is_file():
                        continue
                    name = name.strip()
                    if name:
                        seen.setdefault(name.lower(), name)
    return sorted(seen.values(), key=str.lower)


def log_partners(*, force: bool = False) -> list[str]:
    """Every partner name across every character's F-Chat logs.

    Cached: the set changes when the user roleplays, not between
    keystrokes, and the sweep is the most expensive thing this module
    does.
    """
    global _log_partner_cache, _log_partner_cached_at
    fresh = (
        _log_partner_cache is not None
        and (time.monotonic() - _log_partner_cached_at) < LOG_PARTNERS_TTL_SEC
    )
    if fresh and not force:
        return _log_partner_cache  # type: ignore[return-value]
    try:
        root = log_store.data_dir()
    except log_store.LogDirError as exc:
        raise ForeignError("no_logs", str(exc)) from exc
    if not root.exists():
        raise ForeignError("no_logs", f"F-Chat data directory not found: {root}")
    names = _scan_log_partner_names(root)
    _log_partner_cache = names
    _log_partner_cached_at = time.monotonic()
    return names


def reset_log_partner_cache() -> None:
    """Drop the memoised sweep. Tests use it; so would a future
    "rescan logs" action."""
    global _log_partner_cache, _log_partner_cached_at
    _log_partner_cache = None
    _log_partner_cached_at = 0.0


async def search(query: str, source: str) -> dict[str, Any]:
    """Candidate names for the viewer's picker.

    Returns `{source, query, results, truncated, exact}`. `results` is
    a list of names; the caller turns a pick into a `get_profile`
    call.
    """
    q = (query or "").strip()
    if source not in SOURCES:
        raise ForeignError(
            "validation_failed",
            f"unknown source {source!r} - expected one of {', '.join(SOURCES)}",
        )
    if source == "name":
        # No search endpoint exists on F-list, so free text is a name
        # to look up verbatim. Handing back the typed string keeps the
        # two steps (pick, then open) identical across sources.
        return {
            "source": source,
            "query": q,
            "results": [q] if q else [],
            "truncated": False,
            "exact": True,
        }
    if source in ("bookmarks", "friends"):
        lists = await social_lists()
        pool = lists.get(source, [])
    else:
        pool = log_partners()
    results = _trim(pool, q)
    return {
        "source": source,
        "query": q,
        "results": results,
        "truncated": len(results) >= MAX_RESULTS,
        "exact": False,
    }


async def get_profile(
    name: str,
    *,
    refresh: bool = False,
    ttl_sec: float = foreign_cache.DEFAULT_TTL_SEC,
    budget: flist_api.HourlyBudget | None = None,
) -> dict[str, Any]:
    """A foreign profile, from cache when fresh enough.

    Returns `{name, profile, from_cache, age_sec, fetched_at}`. The
    `profile` is the `character-data.php` payload verbatim plus a
    `fetched_at` stamp — the same shape the archive stores as
    `live.json`, so the viewer's panes need no second reader.

    `budget`, when given, is charged one call before F-list is asked.
    The Workbench window passes none; MCP passes its own share.
    """
    clean = (name or "").strip()
    if not clean:
        raise ForeignError("validation_failed", "character name is empty")

    cached = foreign_cache.read_profile(clean)
    if cached is not None and not refresh and foreign_cache.is_fresh(cached, ttl_sec):
        return {
            "name": cached.get("name") or clean,
            "profile": cached,
            "from_cache": True,
            "age_sec": foreign_cache.age_sec(cached),
            "fetched_at": cached.get("fetched_at"),
        }

    if budget is not None:
        budget.charge()
    try:
        payload = await flist_api.fetch_character_data(clean)
    except (flist_api.TicketRequired, flist_api.AuthFailure) as exc:
        if budget is not None:
            budget.refund()
        raise ForeignError("not_signed_in", str(exc)) from exc
    except flist_api.RateLimited as exc:
        if budget is not None:
            budget.refund()
        raise ForeignError("rate_limited", str(exc)) from exc
    except flist_api.FlistApiError as exc:
        # Either the name does not exist or F-list is having a moment.
        # A stale copy still answers "how was this written", so serve
        # it rather than losing a profile the user could read.
        if cached is not None:
            return {
                "name": cached.get("name") or clean,
                "profile": cached,
                "from_cache": True,
                "stale": True,
                "age_sec": foreign_cache.age_sec(cached),
                "fetched_at": cached.get("fetched_at"),
                "refresh_error": str(exc),
            }
        raise ForeignError("not_found", str(exc)) from exc

    # Key the cache on the spelling F-list considers canonical, not on
    # whatever the caller typed, so a lookup from a lowercased log
    # name and one from a bookmark land on the same entry.
    canonical = payload.get("name")
    key = (
        canonical.strip()
        if isinstance(canonical, str) and canonical.strip()
        else clean
    )
    stored = foreign_cache.write_profile(key, payload)
    return {
        "name": key,
        "profile": stored,
        "from_cache": False,
        "age_sec": 0.0,
        "fetched_at": stored.get("fetched_at"),
    }


def gallery_index(profile: dict[str, Any]) -> dict[str, str]:
    """`{image_id: extension}` for the gallery in a cached profile.

    The image route consults this before fetching, so a caller cannot
    make the sidecar pull an arbitrary id off the CDN — only the
    images the profile itself lists.
    """
    out: dict[str, str] = {}
    images = profile.get("images")
    if not isinstance(images, list):
        return out
    for img in images:
        if not isinstance(img, dict):
            continue
        image_id = img.get("image_id") or img.get("id")
        ext = img.get("extension")
        if image_id is None or not isinstance(ext, str) or not ext:
            continue
        out[str(image_id)] = ext
    return out
