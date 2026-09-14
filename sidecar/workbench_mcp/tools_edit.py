"""Editing a character's working set (design §3.3–3.7).

Everything here changes local files only. Nothing is uploaded to
f-list.net — when a profile is ready the user reviews it in the
Workbench window and publishes it themselves in the browser. Say so if
a user asks whether a change is live; it is not.

The rules a payload has to satisfy live in `services/payload_ops.py`,
which is where the overlay bookkeeping, the gallery renumbering and the
custom-kink tombstones are enforced. These tools are the addressing and
validation layer on top.
"""

from __future__ import annotations

from typing import Any

import bbcode_rules
import character_archive

from ._context import ToolError, audit, load_payload, resolve_character, resolve_set
from ._registry import TAG_CHARACTER, tool
from .tools_session import NO_PUSH_NOTE


def _writable(character: str, set_ref: str | None):  # noqa: ANN202
    """Resolve a character + set for writing, refusing `live`."""
    target = resolve_character(character)
    resolved = resolve_set(target, set_ref, for_write=True)
    return target, resolved


def _guard_bbcode(updated: str) -> None:
    """Stop a description F-list's own parser would reject.

    The check lives inside the write because a separate "validate
    this" tool is a step a model can skip, and the cost of skipping it
    lands on the user: they find out when the site refuses the upload,
    with the text already pasted into F-list's form and the app closed
    behind them.

    Only MCP writes are held to this. The window's editor stays free to
    hold anything, which is what keeps a broken description fixable by
    hand rather than a dead end.
    """
    warnings = bbcode_rules.validate(updated)
    if warnings:
        raise ToolError(
            "bbcode_rejected",
            bbcode_rules.explain(warnings),
            tags=[w.tag for w in warnings[:10]],
        )


def _apply(target, resolved, mutate) -> Any:  # noqa: ANN001, ANN202
    from services import payload_ops

    try:
        return payload_ops.edit(target.id, resolved.id or "", mutate)
    except payload_ops.PayloadError as exc:
        raise ToolError("validation_failed", str(exc)) from exc
    except character_archive.EtagMismatch as exc:
        raise ToolError(
            "etag_conflict",
            "The Workbench window saved this set while the edit was in "
            "flight, twice in a row. Read the field again and redo the "
            "change.",
            current_etag=exc.current_etag,
        ) from exc


async def _catalogue():  # noqa: ANN202
    from services import mapping as mapping_service

    catalogue = await mapping_service.catalogue()
    if catalogue.is_empty:
        raise ToolError(
            "mapping_unavailable",
            "F-list's field catalogue isn't cached and couldn't be "
            "fetched, so a field name or value can't be checked. "
            "Writing an id F-list doesn't know would be dropped when "
            "the profile is uploaded.",
        )
    return catalogue


# --------------------------------------------------------------------
# The workbench
#
# A character has one editable copy of its profile, always present,
# seeded from Live the first time anything needs it. The window calls it
# the Workbench and shows it directly under "Live on F-List".
#
# Several named drafts per character used to be the model, and the tools
# further down still address them because old archives still hold them.
# They are kept for that and nothing else: a model working over MCP
# should never create a second one, or the window and the tools stop
# describing the same thing.
# --------------------------------------------------------------------


@tool(tags=TAG_CHARACTER, title="Open the workbench")
def create_working_set(
    character: str, name: str | None = None, source: str = "live"
) -> dict[str, Any]:
    """The character's workbench, created from Live if it does not exist.

    Despite the name this never makes a second one. A character has one
    workbench; calling this when it already exists returns the existing
    bench untouched, edits and all, so it is safe to call before editing
    without checking first.

    To put something else in the bench use `load_backup_into_workbench`,
    which replaces the contents rather than adding another draft. `name`
    and `source` are ignored and kept only so existing callers do not
    break.
    """
    target = resolve_character(character)
    existed = character_archive.resolve_workbench(target.id, create=False)
    bench = character_archive.resolve_workbench(target.id)
    if bench is None:
        raise ToolError(
            "no_live_profile",
            "There is no pulled profile to seed a workbench from. Pull "
            "the character first with pull_character.",
        )
    if existed is None:
        audit("create_working_set", character=target.name, set=bench.name)
    return {
        "character": target.name,
        "set": bench.name,
        "set_id": bench.id,
        "active": True,
        "created": existed is None,
        "note": (
            "This character has one workbench"
            + ("." if existed is None else " — it already existed and is unchanged.")
            + " "
            + NO_PUSH_NOTE
        ),
    }


@tool(tags=TAG_CHARACTER, title="Load a backup into the workbench")
def load_backup_into_workbench(
    character: str, backup: str, confirm: bool = False
) -> dict[str, Any]:
    """Replace the workbench contents with a backup's.

    Overwrites whatever is in the bench, so it needs `confirm=true`.
    Nothing is saved first — if the current edits matter, call
    `create_backup` before this. `backup` is a filename from
    `list_backups`.
    """
    target = resolve_character(character)
    if not confirm:
        raise ToolError(
            "confirm_required",
            "Loading a backup replaces everything currently in the "
            "workbench. If those edits matter, call create_backup "
            "first, then call this again with confirm=true.",
        )
    try:
        meta = character_archive.load_zip_backup_into_workbench(target.id, backup)
    except FileNotFoundError as exc:
        raise ToolError("backup_not_found", str(exc)) from exc
    except KeyError as exc:
        raise ToolError(
            "backup_too_old",
            "That backup predates the stored profile payload, so there "
            "is nothing in it to load into the bench.",
        ) from exc
    except ValueError as exc:
        raise ToolError("validation_failed", str(exc)) from exc
    audit("load_backup_into_workbench", character=target.name, backup=backup)
    return {
        "character": target.name,
        "set": meta.name,
        "loaded": backup,
        "note": NO_PUSH_NOTE,
    }


@tool(tags=TAG_CHARACTER, title="Rename a working set (legacy)")
def rename_working_set(
    character: str, working_set: str, name: str
) -> dict[str, Any]:
    """Rename a draft.

    Legacy: the window shows one workbench per character and does not
    name it, so this only matters for drafts an older version left
    behind.
    """
    target = resolve_character(character)
    resolved = resolve_set(target, working_set, allow_live=False)
    try:
        meta = character_archive.rename_set(target.id, resolved.id or "", name)
    except ValueError as exc:
        raise ToolError("validation_failed", str(exc)) from exc
    audit("rename_working_set", character=target.name, set=meta.name)
    return {"character": target.name, "set": meta.name, "set_id": meta.id}


@tool(tags=TAG_CHARACTER, title="Activate a working set (legacy)")
def activate_working_set(character: str, working_set: str) -> dict[str, Any]:
    """Choose which draft is the workbench.

    Legacy: with one bench per character there is nothing to switch
    between, unless an older version left several drafts behind — then
    this is how to pick the one to keep working in. Passing `live` still
    drops out of editing and shows the published profile read-only.
    """
    target = resolve_character(character)
    resolved = resolve_set(target, working_set)
    if resolved.is_live:
        character_archive.clear_active_set_id(target.id)
        audit("activate_working_set", character=target.name, set="live")
        return {
            "character": target.name,
            "active_set": None,
            "note": "Showing the published profile, read-only.",
        }
    character_archive.set_active_set_id(target.id, resolved.id or "")
    audit("activate_working_set", character=target.name, set=resolved.name)
    return {"character": target.name, "active_set": resolved.name}


@tool(
    tags=TAG_CHARACTER,
    title="Delete a working set (legacy)",
    destructive=True,
)
def delete_working_set(
    character: str,
    working_set: str,
    confirm: bool = False,
) -> dict[str, Any]:
    """Delete a draft and everything in it. Permanent.

    The published profile is untouched — this only removes a local
    draft. Legacy: deleting a character's only workbench throws away
    unpublished edits and gains nothing, since the bench is recreated
    from Live on next use. Its purpose is clearing out extra drafts an
    older version left behind. Ask the user before calling with
    confirm=true.
    """
    target = resolve_character(character)
    resolved = resolve_set(target, working_set, allow_live=False)
    if not confirm:
        raise ToolError(
            "confirm_required",
            f"Deleting the working set {resolved.name!r} discards its "
            "edits permanently. Ask the user, then call again with "
            "confirm=true.",
        )
    character_archive.delete_set(target.id, resolved.id or "")
    audit("delete_working_set", character=target.name, set=resolved.name)
    return {
        "character": target.name,
        "deleted": resolved.name,
        "remaining_sets": [m.name for m in character_archive.list_sets(target.id)],
    }


# --------------------------------------------------------------------
# Description
# --------------------------------------------------------------------


@tool(tags=TAG_CHARACTER, title="Replace the description")
def set_description(
    character: str,
    text: str,
    working_set: str | None = None,
) -> dict[str, Any]:
    """Replace a profile's whole description with `text`, in F-list
    BBCode.

    This overwrites everything — for a targeted change use
    edit_description, which is far less likely to lose work. Call
    get_bbcode_reference first if unsure which tags F-list supports.
    """
    from services import payload_ops

    target, resolved = _writable(character, working_set)
    body = payload_ops.normalise_newlines(str(text))

    _guard_bbcode(body)

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        previous = payload_ops.get_description(payload)
        payload_ops.set_description(payload, body)
        return payload_ops.EditResult(
            etag="",
            changed=[payload_ops.DESCRIPTION_PATH],
            detail={"previous_length": len(previous)},
        )

    result = _apply(target, resolved, mutate)
    audit(
        "set_description",
        character=target.name,
        set=resolved.name,
        length=len(body),
    )
    return {
        "character": target.name,
        "set": resolved.name,
        "length": len(body),
        "previous_length": result.detail.get("previous_length"),
        "note": NO_PUSH_NOTE,
    }


@tool(tags=TAG_CHARACTER, title="Edit part of the description")
def edit_description(
    character: str,
    old_string: str,
    new_string: str,
    working_set: str | None = None,
    replace_all: bool = False,
) -> dict[str, Any]:
    """Replace an exact piece of text inside the description.

    `old_string` must appear exactly once, or nothing is changed —
    which is the point: it makes a targeted edit safe on a description
    that is tens of kilobytes long. Pass replace_all=true to change
    every occurrence instead.
    """
    from services import payload_ops

    target, resolved = _writable(character, working_set)
    needle = payload_ops.normalise_newlines(str(old_string))
    replacement = payload_ops.normalise_newlines(str(new_string))
    if not needle:
        raise ToolError("validation_failed", "old_string is empty")

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        current = payload_ops.get_description(payload)
        count = current.count(needle)
        if count == 0:
            raise payload_ops.PayloadError(
                "old_string doesn't appear in the description. Read it "
                "with get_description and copy the text exactly, "
                "including its BBCode tags."
            )
        if count > 1 and not replace_all:
            raise payload_ops.PayloadError(
                f"old_string appears {count} times. Include enough "
                "surrounding text to make it unique, or pass "
                "replace_all=true."
            )
        updated = (
            current.replace(needle, replacement)
            if replace_all
            else current.replace(needle, replacement, 1)
        )
        _guard_bbcode(updated)
        payload_ops.set_description(payload, updated)
        return payload_ops.EditResult(
            etag="",
            changed=[payload_ops.DESCRIPTION_PATH],
            detail={"replacements": count if replace_all else 1, "length": len(updated)},
        )

    result = _apply(target, resolved, mutate)
    audit("edit_description", character=target.name, set=resolved.name)
    return {
        "character": target.name,
        "set": resolved.name,
        "replacements": result.detail.get("replacements"),
        "length": result.detail.get("length"),
        "note": NO_PUSH_NOTE,
    }


@tool(tags=TAG_CHARACTER, title="Append to the description")
def append_description(
    character: str,
    text: str,
    working_set: str | None = None,
) -> dict[str, Any]:
    """Add text to the end of the description, on a new line."""
    from services import payload_ops

    target, resolved = _writable(character, working_set)
    addition = payload_ops.normalise_newlines(str(text))

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        current = payload_ops.get_description(payload)
        joined = f"{current}\n{addition}" if current else addition
        _guard_bbcode(joined)
        payload_ops.set_description(payload, joined)
        return payload_ops.EditResult(
            etag="",
            changed=[payload_ops.DESCRIPTION_PATH],
            detail={"length": len(joined)},
        )

    result = _apply(target, resolved, mutate)
    audit("append_description", character=target.name, set=resolved.name)
    return {
        "character": target.name,
        "set": resolved.name,
        "length": result.detail.get("length"),
        "note": NO_PUSH_NOTE,
    }


@tool(tags=TAG_CHARACTER, title="Set the custom title")
def set_custom_title(
    character: str,
    title: str,
    working_set: str | None = None,
) -> dict[str, Any]:
    """Set the line shown under the character's name on their profile."""
    from services import payload_ops

    target, resolved = _writable(character, working_set)
    value = str(title).strip()

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        char = payload_ops.container(payload, "character")
        char["custom_title"] = value
        return payload_ops.EditResult(
            etag="", changed=["character.custom_title"]
        )

    _apply(target, resolved, mutate)
    audit("set_custom_title", character=target.name, set=resolved.name)
    return {"character": target.name, "set": resolved.name, "custom_title": value}


# --------------------------------------------------------------------
# Profile fields
# --------------------------------------------------------------------


@tool(tags=TAG_CHARACTER, title="Set a profile field")
async def set_profile_field(
    character: str,
    field: str,
    value: str,
    working_set: str | None = None,
) -> dict[str, Any]:
    """Set one structured profile field — species, height, orientation
    and so on.

    `field` is the field's name as F-list shows it (case-insensitive)
    or its id. For a dropdown field, `value` may be the option's label
    or its id; anything else is refused with the list of options, since
    a value F-list doesn't recognise is dropped when the profile is
    uploaded.
    """
    from services import payload_ops, profile_fields

    target, resolved = _writable(character, working_set)
    catalogue = await _catalogue()
    field_def = catalogue.resolve_field(field)
    if field_def is None:
        raise ToolError(
            "field_not_found",
            f"F-list has no profile field called {field!r}. "
            "list_profile_fields shows what exists.",
        )
    try:
        stored = profile_fields.coerce_value(field_def, value)
    except profile_fields.FieldValidationError as exc:
        raise ToolError(
            "validation_failed",
            exc.reason,
            field=field_def.label,
            allowed=exc.allowed,
        ) from exc

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        path = payload_ops.set_infotag(payload, field_def.id, stored)
        return payload_ops.EditResult(etag="", changed=[path])

    _apply(target, resolved, mutate)
    audit(
        "set_profile_field",
        character=target.name,
        set=resolved.name,
        field=field_def.label,
    )
    out = {
        "character": target.name,
        "set": resolved.name,
        "field": field_def.label,
        "value": field_def.option_label(stored) or stored,
    }
    if field_def.type == "list":
        out["stored_as"] = stored
    return out


@tool(tags=TAG_CHARACTER, title="Clear a profile field")
async def clear_profile_field(
    character: str,
    field: str,
    working_set: str | None = None,
) -> dict[str, Any]:
    """Remove a profile field so it doesn't appear at all.

    Different from setting it to an empty string, which would publish
    an empty field.
    """
    from services import payload_ops

    target, resolved = _writable(character, working_set)
    catalogue = await _catalogue()
    field_def = catalogue.resolve_field(field)
    field_id = field_def.id if field_def else str(field).strip()
    label = field_def.label if field_def else field_id

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        path, existed = payload_ops.clear_infotag(payload, field_id)
        return payload_ops.EditResult(
            etag="", changed=[path], detail={"existed": existed}
        )

    result = _apply(target, resolved, mutate)
    audit("clear_profile_field", character=target.name, set=resolved.name, field=label)
    return {
        "character": target.name,
        "set": resolved.name,
        "field": label,
        "was_set": result.detail.get("existed", False),
    }


@tool(tags=TAG_CHARACTER, title="Profile visibility settings")
def set_profile_settings(
    character: str,
    working_set: str | None = None,
    customs_first: bool | None = None,
    show_friends: bool | None = None,
    guestbook: bool | None = None,
    prevent_bookmarks: bool | None = None,
    public: bool | None = None,
) -> dict[str, Any]:
    """The profile's display and visibility switches. Omitted ones are
    left alone."""
    from services import payload_ops

    target, resolved = _writable(character, working_set)
    wanted = {
        "customs_first": customs_first,
        "show_friends": show_friends,
        "guestbook": guestbook,
        "prevent_bookmarks": prevent_bookmarks,
        "public": public,
    }

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        touched = payload_ops.set_profile_settings(payload, wanted)
        return payload_ops.EditResult(
            etag="",
            changed=touched,
            detail={"settings": dict(payload.get("settings") or {})},
        )

    result = _apply(target, resolved, mutate)
    audit("set_profile_settings", character=target.name, set=resolved.name)
    return {
        "character": target.name,
        "set": resolved.name,
        "settings": result.detail.get("settings"),
        "meanings": payload_ops.PROFILE_SETTINGS,
    }


# --------------------------------------------------------------------
# Kinks
# --------------------------------------------------------------------


@tool(tags=TAG_CHARACTER, title="Set a kink choice")
async def set_kink(
    character: str,
    kink: str,
    choice: str,
    working_set: str | None = None,
) -> dict[str, Any]:
    """Set one standard kink to fave, yes, maybe, no — or `undecided`
    to remove the entry, which is how F-list represents no opinion.

    `kink` is the name as F-list lists it, or its id.
    """
    from services import payload_ops, profile_fields

    target, resolved = _writable(character, working_set)
    catalogue = await _catalogue()
    kink_id = catalogue.kink_id_for(kink)
    if kink_id is None:
        raise ToolError(
            "kink_not_found",
            f"F-list has no standard kink called {kink!r}. "
            "list_kinks(include_unset=true) shows the catalogue; for "
            "something F-list doesn't have, use add_custom_kink.",
        )
    try:
        value = profile_fields.validate_kink_choice(choice)
    except profile_fields.FieldValidationError as exc:
        raise ToolError(
            "validation_failed", exc.reason, allowed=exc.allowed
        ) from exc

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        path = payload_ops.set_kink(payload, kink_id, value)
        return payload_ops.EditResult(etag="", changed=[path])

    _apply(target, resolved, mutate)
    audit("set_kink", character=target.name, set=resolved.name, kink=kink)
    return {
        "character": target.name,
        "set": resolved.name,
        "kink": catalogue.kinks.get(kink_id, kink_id),
        "choice": value,
    }


@tool(tags=TAG_CHARACTER, title="Set several kinks")
async def set_kinks(
    character: str,
    items: list[dict[str, str]],
    working_set: str | None = None,
) -> dict[str, Any]:
    """Set many kinks in one call. Each item is
    `{"kink": name or id, "choice": fave|yes|maybe|no|undecided}`.

    Everything is validated before anything is written, so one bad
    entry doesn't leave the set half-updated.
    """
    from services import payload_ops, profile_fields

    target, resolved = _writable(character, working_set)
    if not isinstance(items, list) or not items:
        raise ToolError("validation_failed", "items is empty")
    catalogue = await _catalogue()

    prepared: list[tuple[str, str, str]] = []
    problems: list[dict[str, Any]] = []
    for raw in items:
        if not isinstance(raw, dict):
            problems.append({"item": str(raw), "reason": "not an object"})
            continue
        name = str(raw.get("kink") or "")
        kink_id = catalogue.kink_id_for(name)
        if kink_id is None:
            problems.append({"kink": name, "reason": "no such kink on F-list"})
            continue
        try:
            value = profile_fields.validate_kink_choice(raw.get("choice"))
        except profile_fields.FieldValidationError as exc:
            problems.append({"kink": name, "reason": exc.reason})
            continue
        prepared.append((kink_id, value, catalogue.kinks.get(kink_id, kink_id)))

    if problems:
        raise ToolError(
            "validation_failed",
            "nothing was written; fix these and call again",
            problems=problems,
        )

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        touched = [
            payload_ops.set_kink(payload, kink_id, value)
            for kink_id, value, _ in prepared
        ]
        return payload_ops.EditResult(etag="", changed=touched)

    _apply(target, resolved, mutate)
    audit(
        "set_kinks", character=target.name, set=resolved.name, count=len(prepared)
    )
    return {
        "character": target.name,
        "set": resolved.name,
        "updated": [
            {"kink": label, "choice": value} for _, value, label in prepared
        ],
    }


@tool(tags=TAG_CHARACTER, title="Add a custom kink")
async def add_custom_kink(
    character: str,
    name: str,
    description: str = "",
    choice: str = "yes",
    working_set: str | None = None,
) -> dict[str, Any]:
    """Add a kink of the user's own wording, for something F-list's
    catalogue doesn't cover.

    Custom kinks appear in their own section of the profile.
    """
    from services import payload_ops, profile_fields

    target, resolved = _writable(character, working_set)
    label = str(name).strip()
    if not label:
        raise ToolError("validation_failed", "name is empty")
    try:
        value = profile_fields.validate_kink_choice(choice)
    except profile_fields.FieldValidationError as exc:
        raise ToolError("validation_failed", exc.reason, allowed=exc.allowed) from exc

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        kink_id, touched = payload_ops.add_custom_kink(
            payload, label, str(description), value
        )
        return payload_ops.EditResult(
            etag="", changed=touched, detail={"id": kink_id}
        )

    result = _apply(target, resolved, mutate)
    audit("add_custom_kink", character=target.name, set=resolved.name, name=label)
    return {
        "character": target.name,
        "set": resolved.name,
        "id": result.detail.get("id"),
        "name": label,
        "choice": value,
    }


@tool(tags=TAG_CHARACTER, title="Update a custom kink")
async def update_custom_kink(
    character: str,
    kink_id: str,
    name: str | None = None,
    description: str | None = None,
    choice: str | None = None,
    working_set: str | None = None,
) -> dict[str, Any]:
    """Change a custom kink's name, description or choice. Omitted
    fields are left alone. `kink_id` comes from list_kinks."""
    from services import payload_ops, profile_fields

    target, resolved = _writable(character, working_set)
    fields: dict[str, Any] = {}
    if name is not None:
        fields["name"] = str(name)
    if description is not None:
        fields["description"] = str(description)
    if choice is not None:
        try:
            fields["choice"] = profile_fields.validate_kink_choice(choice)
        except profile_fields.FieldValidationError as exc:
            raise ToolError(
                "validation_failed", exc.reason, allowed=exc.allowed
            ) from exc
    if not fields:
        raise ToolError(
            "validation_failed", "nothing to change — pass name, description or choice"
        )

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        touched = payload_ops.update_custom_kink(payload, kink_id, **fields)
        return payload_ops.EditResult(etag="", changed=touched)

    _apply(target, resolved, mutate)
    audit("update_custom_kink", character=target.name, set=resolved.name, id=kink_id)
    return {
        "character": target.name,
        "set": resolved.name,
        "id": kink_id,
        "changed": sorted(fields),
    }


@tool(tags=TAG_CHARACTER, title="Delete a custom kink", destructive=True)
def delete_custom_kink(
    character: str,
    kink_id: str,
    working_set: str | None = None,
) -> dict[str, Any]:
    """Remove a custom kink from the profile.

    One that already exists on F-list is kept as a tombstone so the
    upload knows to remove it, and can be brought back with
    restore_custom_kink. One added locally and never uploaded is
    dropped for good.
    """
    from services import payload_ops

    target, resolved = _writable(character, working_set)

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        how, touched = payload_ops.delete_custom_kink(payload, kink_id)
        return payload_ops.EditResult(
            etag="", changed=touched, detail={"how": how}
        )

    result = _apply(target, resolved, mutate)
    how = result.detail.get("how")
    audit("delete_custom_kink", character=target.name, set=resolved.name, id=kink_id)
    return {
        "character": target.name,
        "set": resolved.name,
        "id": kink_id,
        "outcome": how,
        "restorable": how == "tombstoned",
    }


@tool(tags=TAG_CHARACTER, title="Restore a deleted custom kink")
def restore_custom_kink(
    character: str,
    kink_id: str,
    working_set: str | None = None,
) -> dict[str, Any]:
    """Undo delete_custom_kink for a kink that was tombstoned."""
    from services import payload_ops

    target, resolved = _writable(character, working_set)

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        touched = payload_ops.restore_custom_kink(payload, kink_id)
        return payload_ops.EditResult(etag="", changed=touched)

    _apply(target, resolved, mutate)
    audit("restore_custom_kink", character=target.name, set=resolved.name, id=kink_id)
    return {"character": target.name, "set": resolved.name, "id": kink_id}


@tool(tags=TAG_CHARACTER, title="Reorder custom kinks")
def reorder_custom_kinks(
    character: str,
    kink_ids: list[str],
    working_set: str | None = None,
) -> dict[str, Any]:
    """Set the order custom kinks appear in on the profile.

    Every custom kink that isn't deleted has to appear exactly once —
    a partial list would silently drop the rest.
    """
    from services import payload_ops

    target, resolved = _writable(character, working_set)

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        touched = payload_ops.reorder_custom_kinks(payload, list(kink_ids))
        return payload_ops.EditResult(etag="", changed=touched)

    _apply(target, resolved, mutate)
    audit("reorder_custom_kinks", character=target.name, set=resolved.name)
    return {"character": target.name, "set": resolved.name, "order": list(kink_ids)}


# --------------------------------------------------------------------
# Gallery
# --------------------------------------------------------------------


@tool(tags=TAG_CHARACTER, title="Image caption")
def set_image_description(
    character: str,
    image_id: str,
    description: str,
    working_set: str | None = None,
) -> dict[str, Any]:
    """Set the caption shown under a gallery image."""
    from services import payload_ops

    target, resolved = _writable(character, working_set)

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        rows = payload_ops.gallery(payload)
        match = next((r for r in rows if r["image_id"] == str(image_id)), None)
        if match is None:
            raise payload_ops.PayloadError(
                f"{image_id!r} is not on this profile. list_images shows "
                "what is in the gallery."
            )
        match["description"] = str(description)
        return payload_ops.EditResult(
            etag="", changed=payload_ops.set_gallery(payload, rows)
        )

    _apply(target, resolved, mutate)
    audit("set_image_description", character=target.name, set=resolved.name)
    return {
        "character": target.name,
        "set": resolved.name,
        "image_id": image_id,
        "description": description,
    }


@tool(tags=TAG_CHARACTER, title="Reorder the gallery")
def reorder_images(
    character: str,
    image_ids: list[str],
    working_set: str | None = None,
) -> dict[str, Any]:
    """Set the order images appear in on the profile.

    Every image currently on the profile has to appear exactly once.
    """
    from services import payload_ops

    target, resolved = _writable(character, working_set)
    wanted = [str(i) for i in image_ids]

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        rows = payload_ops.gallery(payload)
        have = {r["image_id"] for r in rows}
        if len(set(wanted)) != len(wanted):
            raise payload_ops.PayloadError("the order contains a duplicate id")
        unknown = [i for i in wanted if i not in have]
        if unknown:
            raise payload_ops.PayloadError(
                f"not on this profile: {', '.join(unknown)}"
            )
        missing = have - set(wanted)
        if missing:
            raise payload_ops.PayloadError(
                "the order must list every image on the profile; missing: "
                + ", ".join(sorted(missing))
            )
        by_id = {r["image_id"]: r for r in rows}
        return payload_ops.EditResult(
            etag="",
            changed=payload_ops.set_gallery(payload, [by_id[i] for i in wanted]),
        )

    _apply(target, resolved, mutate)
    audit("reorder_images", character=target.name, set=resolved.name)
    return {"character": target.name, "set": resolved.name, "order": wanted}


@tool(tags=TAG_CHARACTER, title="Remove an image from the profile")
def remove_image(
    character: str,
    image_id: str,
    working_set: str | None = None,
    delete_file: bool = False,
) -> dict[str, Any]:
    """Take an image off the profile.

    The file stays on disk and can be put back with add_image unless
    `delete_file=true`, which removes it permanently.
    """
    from services import payload_ops

    target, resolved = _writable(character, working_set)

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        rows = payload_ops.gallery(payload)
        remaining = [r for r in rows if r["image_id"] != str(image_id)]
        if len(remaining) == len(rows):
            raise payload_ops.PayloadError(
                f"{image_id!r} is not on this profile."
            )
        return payload_ops.EditResult(
            etag="", changed=payload_ops.set_gallery(payload, remaining)
        )

    _apply(target, resolved, mutate)
    file_deleted = False
    if delete_file:
        file_deleted = character_archive.remove_character_image(
            target.id, str(image_id)
        )
    audit(
        "remove_image",
        character=target.name,
        set=resolved.name,
        image_id=image_id,
        file_deleted=file_deleted,
    )
    return {
        "character": target.name,
        "set": resolved.name,
        "image_id": image_id,
        "file_deleted": file_deleted,
        "note": (
            "The file is gone."
            if file_deleted
            else "The file is still on disk; add_image can put it back."
        ),
    }


@tool(tags=TAG_CHARACTER, title="Put an image on the profile")
def add_image(
    character: str,
    image_id: str,
    working_set: str | None = None,
    description: str = "",
) -> dict[str, Any]:
    """Add an image that is already in the character's image folder to
    the profile gallery, at the end.

    `list_images` shows what is available under `not_on_profile`.
    """
    from services import payload_ops

    target, resolved = _writable(character, working_set)
    on_disk = {
        str(row.get("image_id"))
        for row in character_archive.list_character_images(target.id)
    }
    if str(image_id) not in on_disk:
        raise ToolError(
            "image_not_found",
            f"No image {image_id!r} in {target.name}'s image folder. "
            "list_images shows what is there.",
        )

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        rows = payload_ops.gallery(payload)
        if any(r["image_id"] == str(image_id) for r in rows):
            raise payload_ops.PayloadError(
                f"{image_id!r} is already on this profile."
            )
        rows.append(
            {
                "image_id": str(image_id),
                "description": str(description),
                "sort_order": len(rows),
            }
        )
        return payload_ops.EditResult(
            etag="", changed=payload_ops.set_gallery(payload, rows)
        )

    _apply(target, resolved, mutate)
    audit("add_image", character=target.name, set=resolved.name, image_id=image_id)
    return {
        "character": target.name,
        "set": resolved.name,
        "image_id": image_id,
        "note": NO_PUSH_NOTE,
    }


# --------------------------------------------------------------------
# Escape hatch
# --------------------------------------------------------------------


@tool(tags=TAG_CHARACTER, title="Raw payload", read_only=True)
def get_working_set_payload(
    character: str,
    working_set: str | None = None,
) -> dict[str, Any]:
    """The complete raw payload of a working set, including `_overlay`.

    Large — a description alone can be tens of kilobytes. The targeted
    read tools are almost always the better choice; this exists for
    inspecting something they don't expose.
    """
    target = resolve_character(character)
    resolved = resolve_set(target, working_set)
    payload = load_payload(resolved)
    etag = (
        None
        if resolved.is_live
        else character_archive.set_payload_etag(target.id, resolved.id or "")
    )
    return {
        "character": target.name,
        "set": resolved.name,
        "read_only": resolved.is_live,
        "etag": etag,
        "payload": payload,
    }


@tool(tags=TAG_CHARACTER, title="Write raw payload", destructive=True)
def put_working_set_payload(
    character: str,
    payload: dict[str, Any],
    working_set: str | None = None,
    if_match: str | None = None,
    confirm: bool = False,
) -> dict[str, Any]:
    """Replace a working set's entire payload.

    The escape hatch, and a blunt one: none of the rules the targeted
    tools enforce are applied, so a malformed payload here can lose the
    overlay, scramble the gallery order, or write field ids F-list
    drops on upload. Prefer the targeted tools. Pass `if_match` with
    the etag from get_working_set_payload to avoid overwriting a change
    made in the meantime.
    """
    target, resolved = _writable(character, working_set)
    if not confirm:
        raise ToolError(
            "confirm_required",
            "This replaces the whole payload without any of the "
            "validation the targeted editing tools apply. Use those "
            "unless there is no alternative; if there isn't, call again "
            "with confirm=true.",
        )
    if not isinstance(payload, dict):
        raise ToolError("validation_failed", "payload must be an object")

    try:
        etag = character_archive.write_set_payload(
            target.id, resolved.id or "", payload, expected_etag=if_match
        )
    except character_archive.EtagMismatch as exc:
        raise ToolError(
            "etag_conflict",
            "The set changed since you read it. Read it again and redo "
            "the change.",
            current_etag=exc.current_etag,
        ) from exc
    except ValueError as exc:
        raise ToolError("validation_failed", str(exc)) from exc

    audit("put_working_set_payload", character=target.name, set=resolved.name)
    return {
        "character": target.name,
        "set": resolved.name,
        "etag": etag,
        "note": NO_PUSH_NOTE,
    }
