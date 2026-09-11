"""Characters, working sets and descriptions (design §3.2–3.4).

Addressing note that runs through all of these: `character` takes a
name or an id, and `set` takes a set name, a set id, or the string
`"live"` for the read-only profile last pulled from F-list. Omitting
`set` means "the active one".
"""

from __future__ import annotations

from typing import Any

import character_archive

from ._context import (
    LIVE,
    ToolError,
    load_payload,
    resolve_character,
    resolve_set,
)
from ._registry import TAG_CHARACTER, TAG_CORE, tool
from .tools_session import NO_PUSH_NOTE


@tool(tags=(TAG_CORE, TAG_CHARACTER), title="List characters", read_only=True)
def list_characters(include_log_only: bool = True) -> dict[str, Any]:
    """Every character this Workbench knows about.

    Characters with a local archive can be edited; ones that only
    appear in the F-Chat logs can be read about but have no profile
    stored yet (pull_character fixes that).
    """
    import flist_api
    from logs import LogDirError
    from logs import list_characters as list_log_characters

    archived = character_archive.list_archived_characters()
    rows: list[dict[str, Any]] = []
    for row in archived:
        cid = str(row.get("id") or "")
        sets = character_archive.list_sets(cid)
        active = character_archive.read_active_set_id(cid)
        rows.append(
            {
                "name": row.get("name"),
                "id": cid,
                "has_archive": True,
                "last_pulled_at": row.get("last_pulled_at"),
                "snapshot_count": row.get("snapshot_count"),
                "backup_count": row.get("backup_count"),
                "working_sets": len(sets),
                "active_set": next(
                    (s.name for s in sets if s.id == active), None
                ),
            }
        )

    known = {str(r["name"]).lower() for r in rows if r.get("name")}
    if include_log_only:
        try:
            for char in list_log_characters():
                if char.name.lower() not in known:
                    rows.append(
                        {
                            "name": char.name,
                            "id": None,
                            "has_archive": False,
                            "note": "only seen in F-Chat logs; no profile pulled yet",
                        }
                    )
        except LogDirError:
            pass

    account = flist_api.ticket_store().characters()
    on_account = {str(c.get("name", "")).lower() for c in (account or [])}
    for row in rows:
        if row.get("name"):
            row["on_account"] = str(row["name"]).lower() in on_account

    rows.sort(key=lambda r: str(r.get("name") or "").lower())
    return {"characters": rows}


@tool(tags=TAG_CHARACTER, title="Live profile", read_only=True)
def get_live_profile(
    character: str, include_description: bool = False
) -> dict[str, Any]:
    """The profile as it stood at the last pull from F-list.

    Read-only by definition — this is the record of what is published,
    not a draft. Pass include_description=true to also get the BBCode,
    which can be tens of kilobytes.
    """
    target = resolve_character(character)
    live = character_archive.read_live(target.id)
    if live is None:
        raise ToolError(
            "live_not_found",
            f"No profile has been pulled for {target.name} yet. "
            "Run pull_character first.",
        )
    char = live.get("character") if isinstance(live.get("character"), dict) else live
    out: dict[str, Any] = {
        "character": target.name,
        "id": target.id,
        "fetched_at": live.get("fetched_at"),
        "custom_title": (char or {}).get("custom_title"),
        "infotag_count": len(live.get("infotags") or {}),
        "kink_count": len(live.get("kinks") or {}),
        "custom_kink_count": len(live.get("custom_kinks") or {}),
        "image_count": len(live.get("images") or []),
    }
    description = (char or {}).get("description") or ""
    out["description_length"] = len(description)
    if include_description:
        out["description"] = description
    return out


@tool(tags=TAG_CHARACTER, title="List working sets", read_only=True)
def list_working_sets(character: str) -> dict[str, Any]:
    """The named drafts stored for a character.

    Exactly one is active at a time — that is the one the Workbench
    window is showing and the one tools edit when `set` is omitted.
    """
    target = resolve_character(character)
    active = character_archive.read_active_set_id(target.id)
    sets = [
        {
            "id": meta.id,
            "name": meta.name,
            "created_at": meta.created_at,
            "updated_at": meta.updated_at,
            "active": meta.id == active,
        }
        for meta in character_archive.list_sets(target.id)
    ]
    return {
        "character": target.name,
        "sets": sets,
        "active_set": next((s["name"] for s in sets if s["active"]), None),
        "note": (
            "No set is active; the window is showing the read-only live "
            "profile. Create one with create_working_set before editing."
            if active is None
            else NO_PUSH_NOTE
        ),
    }


#: What `get_working_set` can be asked for. Descriptions are excluded by
#: default because a single one can run to 30 KB.
SET_SECTIONS = ("summary", "infotags", "kinks", "custom_kinks", "images", "settings")


@tool(tags=TAG_CHARACTER, title="Read a working set", read_only=True)
async def get_working_set(
    character: str,
    set: str | None = None,  # noqa: A002 — the domain word
    include: list[str] | None = None,
) -> dict[str, Any]:
    """A working set's contents, by section.

    `include` picks from summary, infotags, kinks, custom_kinks, images
    and settings; the default is summary only. The description is not
    in here at any setting — use get_description, which can page
    through it.
    """
    target = resolve_character(character)
    resolved = resolve_set(target, set)
    payload = load_payload(resolved)
    sections = [s.strip().lower() for s in (include or ["summary"])]
    unknown = [s for s in sections if s not in SET_SECTIONS]
    if unknown:
        raise ToolError(
            "validation_failed",
            f"unknown section(s): {', '.join(unknown)}",
            allowed=list(SET_SECTIONS),
        )

    from services import mapping as mapping_service

    catalogue = await mapping_service.catalogue()

    char = payload.get("character") if isinstance(payload.get("character"), dict) else {}
    infotags = payload.get("infotags") or {}
    kinks = payload.get("kinks") or {}
    custom_kinks = payload.get("custom_kinks") or {}
    images = payload.get("images") or []

    out: dict[str, Any] = {
        "character": target.name,
        "set": resolved.name,
        "read_only": resolved.is_live,
    }

    if "summary" in sections:
        out["summary"] = {
            "custom_title": (char or {}).get("custom_title"),
            "description_length": len((char or {}).get("description") or ""),
            "profile_fields_set": len(infotags),
            "kinks_set": len(kinks),
            "custom_kinks": sum(
                1
                for v in custom_kinks.values()
                if isinstance(v, dict) and not v.get("_deleted")
            ),
            "images": len(images),
            "edited_paths": len(payload.get("_overlay") or []),
        }

    if "infotags" in sections:
        out["profile_fields"] = [
            _describe_infotag(catalogue, str(key), value)
            for key, value in sorted(infotags.items())
        ]

    if "kinks" in sections:
        out["kinks"] = [
            {
                "kink": catalogue.kinks.get(str(k), f"kink#{k}"),
                "id": str(k),
                "choice": str(v),
            }
            for k, v in sorted(kinks.items())
        ]

    if "custom_kinks" in sections:
        out["custom_kinks"] = [
            {
                "id": str(key),
                "name": entry.get("name"),
                "description": entry.get("description"),
                "choice": entry.get("choice"),
            }
            for key, entry in custom_kinks.items()
            if isinstance(entry, dict) and not entry.get("_deleted")
        ]

    if "images" in sections:
        out["images"] = [
            {
                "image_id": row.get("image_id"),
                "description": row.get("description"),
                "sort_order": row.get("sort_order"),
            }
            for row in images
            if isinstance(row, dict)
        ]

    if "settings" in sections:
        out["settings"] = payload.get("settings") or {}

    return out


def _describe_infotag(catalogue, key: str, value: Any) -> dict[str, Any]:  # noqa: ANN001
    field_def = catalogue.resolve_field(key)
    if field_def is None:
        return {
            "id": key,
            "label": f"info_{key}",
            "value": value,
            "note": "not in the mapping list",
        }
    return field_def.to_dict(value=value)


@tool(tags=TAG_CHARACTER, title="Read the description", read_only=True)
def get_description(
    character: str,
    set: str | None = None,  # noqa: A002
    offset: int = 0,
    length: int | None = None,
) -> dict[str, Any]:
    """The profile description, in F-list BBCode.

    Descriptions run long; `offset` and `length` page through one.
    Pass set="live" to read what is currently published.
    """
    target = resolve_character(character)
    resolved = resolve_set(target, set)
    payload = load_payload(resolved)
    char = payload.get("character") if isinstance(payload.get("character"), dict) else {}
    text = (char or {}).get("description") or ""

    start = max(0, int(offset))
    end = len(text) if length is None else min(len(text), start + max(0, int(length)))
    slice_ = text[start:end]
    return {
        "character": target.name,
        "set": resolved.name,
        "read_only": resolved.is_live,
        "total_length": len(text),
        "offset": start,
        "returned_length": len(slice_),
        "has_more": end < len(text),
        "description": slice_,
    }


@tool(tags=TAG_CHARACTER, title="Profile fields", read_only=True)
async def list_profile_fields(
    character: str,
    set: str | None = None,  # noqa: A002
    group: str | None = None,
    only_set: bool = False,
    query: str | None = None,
) -> dict[str, Any]:
    """The structured profile fields — species, height, orientation and
    the rest — with each field's type, allowed options and current value.

    Every field F-list offers is listed, so this is also how to find out
    what *can* be set. `only_set=true` narrows to fields that have a
    value; `group` and `query` filter by category and by name.
    """
    target = resolve_character(character)
    resolved = resolve_set(target, set)
    payload = load_payload(resolved)
    values = payload.get("infotags") or {}

    from services import mapping as mapping_service

    catalogue = await mapping_service.catalogue()
    if catalogue.is_empty:
        raise ToolError(
            "mapping_unavailable",
            "F-list's field catalogue isn't cached yet and couldn't be "
            "fetched. Field names and options are unknown until it is.",
        )

    needle = (query or "").strip().lower()
    group_needle = (group or "").strip().lower()

    rows: list[dict[str, Any]] = []
    for field_def in catalogue.fields:
        value = values.get(field_def.id)
        if only_set and value is None:
            continue
        if group_needle and (field_def.group or "").lower() != group_needle:
            continue
        if needle and needle not in field_def.label.lower():
            continue
        rows.append(field_def.to_dict(value=value))

    # Fields the user set that F-list no longer describes. Worth
    # surfacing: they are still in the payload and will be uploaded.
    unknown = [
        {"id": str(k), "value": v, "note": "not in the mapping list"}
        for k, v in values.items()
        if catalogue.field_by_id(str(k)) is None
    ]

    return {
        "character": target.name,
        "set": resolved.name,
        "read_only": resolved.is_live,
        "fields": rows,
        "unknown_fields": unknown,
        "groups": sorted({f.group for f in catalogue.fields if f.group}),
    }


@tool(tags=TAG_CHARACTER, title="Kinks", read_only=True)
async def list_kinks(
    character: str,
    set: str | None = None,  # noqa: A002
    choice: str | None = None,
    query: str | None = None,
    include_unset: bool = False,
) -> dict[str, Any]:
    """The character's kink choices, by name.

    Shows only kinks that have a choice unless `include_unset=true`,
    which lists F-list's whole catalogue (~560 entries). `choice`
    filters to fave / yes / maybe / no. Custom kinks are included
    separately — they are free text the user wrote.
    """
    target = resolve_character(character)
    resolved = resolve_set(target, set)
    payload = load_payload(resolved)
    chosen = payload.get("kinks") or {}

    from services import mapping as mapping_service

    catalogue = await mapping_service.catalogue()
    wanted = (choice or "").strip().lower()
    needle = (query or "").strip().lower()

    rows: list[dict[str, Any]] = []
    ids = catalogue.kinks.keys() if include_unset else chosen.keys()
    for kink_id in ids:
        key = str(kink_id)
        value = chosen.get(key)
        if wanted and str(value or "").lower() != wanted:
            continue
        name = catalogue.kinks.get(key, f"kink#{key}")
        if needle and needle not in name.lower():
            continue
        group_id = catalogue.kink_group_of.get(key)
        rows.append(
            {
                "kink": name,
                "id": key,
                "choice": value or "undecided",
                "group": catalogue.kink_groups.get(group_id or "", group_id),
            }
        )
    rows.sort(key=lambda r: (str(r["group"] or ""), str(r["kink"]).lower()))

    custom = [
        {
            "id": str(key),
            "name": entry.get("name"),
            "description": entry.get("description"),
            "choice": entry.get("choice"),
        }
        for key, entry in (payload.get("custom_kinks") or {}).items()
        if isinstance(entry, dict) and not entry.get("_deleted")
    ]

    return {
        "character": target.name,
        "set": resolved.name,
        "read_only": resolved.is_live,
        "kinks": rows,
        "custom_kinks": custom,
        "counts": _choice_counts(chosen),
    }


def _choice_counts(chosen: dict[str, Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for value in chosen.values():
        key = str(value or "undecided")
        counts[key] = counts.get(key, 0) + 1
    return counts


@tool(tags=(TAG_CORE, TAG_CHARACTER), title="F-list field catalogue", read_only=True)
async def get_mapping_list(section: str = "infotags") -> dict[str, Any]:
    """F-list's own catalogue of what a profile can contain.

    `section` is one of infotags, infotag_groups, kinks, kink_groups or
    listitems. Mostly useful for looking up what a field or kink is
    called before setting it — list_profile_fields and list_kinks
    already resolve names for a specific character.
    """
    allowed = ("infotags", "infotag_groups", "kinks", "kink_groups", "listitems")
    wanted = (section or "").strip().lower()
    if wanted not in allowed:
        raise ToolError(
            "validation_failed",
            f"unknown section {section!r}",
            allowed=list(allowed),
        )
    from services import mapping as mapping_service

    payload = await mapping_service.raw()
    return {"section": wanted, "entries": payload.get(wanted) or []}


@tool(tags=(TAG_CORE, TAG_CHARACTER), title="BBCode reference", read_only=True)
def get_bbcode_reference() -> dict[str, Any]:
    """F-list's BBCode dialect — the markup a profile description uses.

    Worth reading before writing or editing a description: F-list's
    dialect is not the same as any other forum's, and unsupported tags
    are rendered as literal text on the profile.
    """
    return {
        "tags": _BBCODE_TAGS,
        "notes": [
            "F-list has no [img] tag. Images are attached to the profile "
            "as gallery entries, or referenced with [eicon].",
            "[icon]name[/icon] renders a character's avatar and links to "
            "their profile. [eicon]name[/eicon] renders an uploaded "
            "eicon — no link.",
            "Unsupported tags are shown literally, brackets and all.",
            "Newlines are preserved; there is no paragraph tag.",
        ],
        "note": NO_PUSH_NOTE,
    }


_BBCODE_TAGS: list[dict[str, str]] = [
    {"tag": "[b]…[/b]", "does": "bold"},
    {"tag": "[i]…[/i]", "does": "italic"},
    {"tag": "[u]…[/u]", "does": "underline"},
    {"tag": "[s]…[/s]", "does": "strikethrough"},
    {"tag": "[sub]…[/sub]", "does": "subscript"},
    {"tag": "[sup]…[/sup]", "does": "superscript"},
    {"tag": "[big]…[/big]", "does": "larger text"},
    {"tag": "[small]…[/small]", "does": "smaller text"},
    {
        "tag": "[color=name]…[/color]",
        "does": "coloured text; F-list accepts a fixed palette of names "
        "(red, orange, yellow, green, cyan, blue, purple, pink, black, "
        "brown, white, gray) — not hex codes",
    },
    {"tag": "[heading]…[/heading]", "does": "section heading"},
    {"tag": "[center]…[/center]", "does": "centred block"},
    {"tag": "[quote]…[/quote]", "does": "quoted block"},
    {"tag": "[hr]", "does": "horizontal rule; no closing tag"},
    {
        "tag": "[collapse=Title]…[/collapse]",
        "does": "collapsible section with a clickable title — the usual "
        "way to keep a long profile navigable",
    },
    {"tag": "[spoiler]…[/spoiler]", "does": "hidden until clicked"},
    {"tag": "[noparse]…[/noparse]", "does": "show BBCode literally"},
    {"tag": "[url=https://…]…[/url]", "does": "link"},
    {"tag": "[icon]Character Name[/icon]", "does": "avatar, links to that profile"},
    {"tag": "[eicon]name[/eicon]", "does": "uploaded eicon image"},
    {"tag": "[user]Character Name[/user]", "does": "plain link to a profile"},
]


@tool(tags=TAG_CHARACTER, title="List snapshots", read_only=True)
def list_snapshots(character: str) -> dict[str, Any]:
    """Automatic JSON snapshots, one per pull that found a change.

    This is the history of what the profile looked like on F-list over
    time — distinct from backups, which the user makes deliberately.
    """
    target = resolve_character(character)
    return {
        "character": target.name,
        "snapshots": character_archive.list_snapshots(target.id),
    }


@tool(tags=TAG_CHARACTER, title="List backups", read_only=True)
def list_backups(character: str) -> dict[str, Any]:
    """ZIP backups of a character, newest first.

    Backups include images and the avatar, and can be restored into a
    new working set with create_working_set(source="backup:<file>").
    """
    target = resolve_character(character)
    return {
        "character": target.name,
        "backups": character_archive.list_zip_backups(target.id),
    }


@tool(tags=TAG_CHARACTER, title="List images", read_only=True)
def list_images(
    character: str,
    set: str | None = None,  # noqa: A002
) -> dict[str, Any]:
    """The character's gallery, plus any images on disk that are not
    currently on the profile.

    `sort_order` is the position on the profile page, counting from 0.
    """
    target = resolve_character(character)
    resolved = resolve_set(target, set)
    payload = load_payload(resolved)

    gallery = [
        {
            "image_id": str(row.get("image_id")),
            "description": row.get("description") or "",
            "sort_order": row.get("sort_order"),
            "on_profile": True,
        }
        for row in (payload.get("images") or [])
        if isinstance(row, dict) and row.get("image_id")
    ]
    on_profile = {row["image_id"] for row in gallery}

    pool = []
    for row in character_archive.list_character_images(target.id):
        image_id = str(row.get("image_id") or row.get("id") or "")
        if not image_id or image_id in on_profile:
            continue
        pool.append(
            {
                "image_id": image_id,
                "extension": row.get("extension"),
                "bytes": row.get("bytes") or row.get("size"),
                "on_profile": False,
            }
        )

    return {
        "character": target.name,
        "set": resolved.name,
        "gallery": sorted(gallery, key=lambda r: r.get("sort_order") or 0),
        "not_on_profile": pool,
    }


@tool(tags=TAG_CHARACTER, title="Set addressing help", read_only=True)
def explain_set_addressing() -> dict[str, Any]:
    """How `character` and `set` arguments are interpreted.

    Read this if a tool call failed with character_not_found,
    set_not_found or no_active_set and the reason isn't obvious.
    """
    return {
        "character": (
            "A character name (case-insensitive) or the numeric F-list "
            "id. Only characters with a local archive can be edited; "
            "list_characters shows which."
        ),
        "set": (
            f"A working set's name or id, or {LIVE!r} for the read-only "
            "profile last pulled from F-list. Omit it to use the "
            "character's active set — the one the Workbench window is "
            "showing. If no set is active, create one with "
            "create_working_set; editing tools refuse to guess."
        ),
        "live": (
            "Never writable. It is the record of what is published, and "
            "overwriting it would lose the ability to tell what changed."
        ),
        "note": NO_PUSH_NOTE,
    }
