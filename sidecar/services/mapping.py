"""Access to F-list's mapping list, with the resolver cached.

`flist_api.fetch_mapping_list` already caches the raw payload on disk
for a week. Resolving it into a `profile_fields.Catalogue` is a few
thousand dict lookups, which is cheap once but wasteful on every tool
call, so the resolved form is memoised against the file's mtime.
"""

from __future__ import annotations

from typing import Any

import character_archive
import flist_api

from . import profile_fields

_cache: tuple[float, profile_fields.Catalogue] | None = None


def _cache_path():  # noqa: ANN202 — Path, imported lazily by caller
    return character_archive.cache_root() / "mapping-list.json"


async def raw(force: bool = False) -> dict[str, Any]:
    """The mapping-list payload, fetched or from the week-long cache."""
    return await flist_api.fetch_mapping_list(_cache_path(), force=force)


async def catalogue(force: bool = False) -> profile_fields.Catalogue:
    """The resolved catalogue: fields, their options, and kink names.

    Falls back to an empty catalogue when F-list is unreachable and
    nothing is cached — callers that need it to validate a write should
    check `is_empty` and say so rather than silently accepting anything.
    """
    global _cache
    path = _cache_path()
    try:
        payload = await raw()
    except flist_api.FlistApiError:
        return _cache[1] if _cache else profile_fields.EMPTY

    try:
        stamp = path.stat().st_mtime
    except OSError:
        stamp = 0.0
    if _cache is not None and _cache[0] == stamp:
        return _cache[1]

    resolved = profile_fields.build(payload)
    _cache = (stamp, resolved)
    return resolved


def invalidate() -> None:
    """Drop the memo — used by tests and after a forced refresh."""
    global _cache
    _cache = None
