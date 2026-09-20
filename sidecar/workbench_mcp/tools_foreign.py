"""Reading somebody else's profile (design §3.x, the foreign viewer).

The window's Tools -> Search Foreign Character, as tools. Same cache,
same 24-hour TTL, same three sources for candidate names.

Two constraints shape this module.

*It only reads.* There is no tool here that turns a foreign profile
into a working set, a backup or an export, and none should be added.
The cache is a separate on-disk root precisely so no existing write
path can reach it. A model asked to "copy this profile" should say
that Workbench does not do that.

*It spends a quarter of the hourly F-list budget, at most.* The user's
own pulls and the model's browsing share one 200-requests-per-hour
ceiling, and a model that decides to walk a friend list would empty it
in three minutes. `flist_api.mcp_character_budget()` is charged before
each fetch; a cache hit costs nothing.
"""

from __future__ import annotations

from typing import Any

import flist_api
from services import foreign as foreign_service

from ._context import ToolError, audit
from ._registry import TAG_CHARACTER, tool

#: Top-level keys of a `character-data.php` payload this module reports
#: under a name of its own. Everything else is handed back verbatim
#: under `extra` — see `_extra_fields`.
_REPORTED_KEYS = frozenset(
    {
        "name",
        "id",
        "description",
        "infotags",
        "kinks",
        "custom_kinks",
        "images",
        "custom_title",
        "created_at",
        "updated_at",
        "views",
        "settings",
        "fetched_at",
        "error",
    }
)

#: A passthrough field longer than this is reported as a summary
#: instead of inline. Keeps one surprise field from filling a model's
#: context window.
_EXTRA_MAX_CHARS = 2000


def _as_tool_error(exc: foreign_service.ForeignError) -> ToolError:
    """Map a service error onto the tool vocabulary. `not_signed_in`
    already means the same thing on both sides; the rest keep their
    codes so a model can tell a missing character from a spent
    budget."""
    return ToolError(exc.code, exc.message)


def _extra_fields(profile: dict[str, Any]) -> dict[str, Any]:
    """Everything in the payload this module does not name explicitly.

    This is where a linked-profile or alt list would show up if F-list
    ever exposes one. `character-data.php` carries no such field today
    — the account's own character list rides on `getApiTicket.php` and
    is not a property of the profile being viewed. Rather than guess
    at a shape that does not exist, or scrape the description for
    names, anything unrecognised is passed through as-is and a model
    can make of it what it will.
    """
    import json

    out: dict[str, Any] = {}
    for key, value in profile.items():
        if key in _REPORTED_KEYS:
            continue
        try:
            rendered = json.dumps(value, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            out[key] = repr(value)[:_EXTRA_MAX_CHARS]
            continue
        if len(rendered) <= _EXTRA_MAX_CHARS:
            out[key] = value
        elif isinstance(value, list):
            out[key] = {
                "truncated": True,
                "count": len(value),
                "first": value[:10],
            }
        else:
            out[key] = {"truncated": True, "preview": rendered[:_EXTRA_MAX_CHARS]}
    return out


@tool(
    tags=TAG_CHARACTER,
    title="Search for another character",
    read_only=True,
    open_world=True,
)
async def search_foreign_characters(
    source: str, query: str = ""
) -> dict[str, Any]:
    """Candidate names to look up, from one of four sources.

    - `bookmarks` / `friends` — the signed-in account's own lists.
      One F-list call, cached for ten minutes.
    - `logs` — everyone the user has roleplayed with, read from the
      local F-Chat logs. Costs nothing and works offline. Names come
      back lowercased because that is how F-Chat stores them.
    - `name` — free text. F-list has no character search, so this
      hands the string straight back as a name to look up.

    `query` filters the first three case-insensitively; leave it empty
    to browse the whole list. Feed a result to `get_foreign_profile`.
    """
    try:
        result = await foreign_service.search(query, source)
    except foreign_service.ForeignError as exc:
        raise _as_tool_error(exc) from exc
    audit("search_foreign_characters", source=source, hits=len(result["results"]))
    return result


@tool(
    tags=TAG_CHARACTER,
    title="Read another character's profile",
    read_only=True,
    open_world=True,
)
async def get_foreign_profile(
    character: str,
    include_description: bool = False,
    refresh: bool = False,
) -> dict[str, Any]:
    """Somebody else's public F-list profile, read-only.

    This is for looking at how a profile is put together — how the
    BBCode is structured, which infotags are filled, how the kink
    lists are arranged. Workbench offers no way to copy one of these
    into the user's own characters, and this tool is not a step
    towards one: there is no working set, backup or export behind it.

    Served from a local cache for 24 hours; `refresh=true` fetches
    again. Pass `include_description=true` for the BBCode itself,
    which can run to tens of kilobytes.

    Fetching costs one call against a quarter-share of the hourly
    F-list budget. Cache hits are free, so re-reading a profile you
    already opened costs nothing.
    """
    try:
        result = await foreign_service.get_profile(
            character,
            refresh=refresh,
            budget=flist_api.mcp_character_budget(),
        )
    except foreign_service.ForeignError as exc:
        raise _as_tool_error(exc) from exc

    profile = result["profile"]
    description = profile.get("description") or ""
    out: dict[str, Any] = {
        "character": result["name"],
        "id": profile.get("id"),
        "custom_title": profile.get("custom_title"),
        "created_at": profile.get("created_at"),
        "updated_at": profile.get("updated_at"),
        "views": profile.get("views"),
        "infotags": profile.get("infotags") or {},
        "kink_count": len(profile.get("kinks") or {}),
        "custom_kink_count": len(profile.get("custom_kinks") or {}),
        "image_count": len(profile.get("images") or []),
        "description_length": len(description),
        "from_cache": result["from_cache"],
        "fetched_at": result.get("fetched_at"),
        "read_only": True,
    }
    if include_description:
        out["description"] = description
    if result.get("stale"):
        out["stale"] = True
        out["refresh_error"] = result.get("refresh_error")
    extra = _extra_fields(profile)
    if extra:
        out["extra"] = extra
    out["budget_remaining"] = flist_api.mcp_character_budget().remaining()
    audit(
        "get_foreign_profile",
        character=result["name"],
        from_cache=result["from_cache"],
    )
    return out


@tool(
    tags=TAG_CHARACTER,
    title="List another character's kinks",
    read_only=True,
    open_world=True,
)
async def get_foreign_kinks(character: str) -> dict[str, Any]:
    """The kink choices on somebody else's profile.

    Split the way F-list stores them: `kinks` maps a numeric kink id
    to one of fave / yes / maybe / no, and `custom_kinks` holds the
    free-text ones the character wrote themselves. Use
    `get_mapping_list(section="kinks")` turns an id into a name.

    Same cache and same budget as `get_foreign_profile`, and equally
    read-only.
    """
    try:
        result = await foreign_service.get_profile(
            character, budget=flist_api.mcp_character_budget()
        )
    except foreign_service.ForeignError as exc:
        raise _as_tool_error(exc) from exc
    profile = result["profile"]
    return {
        "character": result["name"],
        "kinks": profile.get("kinks") or {},
        "custom_kinks": profile.get("custom_kinks") or {},
        "from_cache": result["from_cache"],
        "read_only": True,
    }
