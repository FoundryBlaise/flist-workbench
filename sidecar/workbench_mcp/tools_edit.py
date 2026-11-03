"""Editing a character's Workbench (design §3.3–3.7).

Everything here changes local files only. Nothing is uploaded to
f-list.net — when a profile is ready the user reviews it in the
app window and publishes it themselves in the browser. Say so if
a user asks whether a change is live; it is not.

The rules a payload has to satisfy live in `services/payload_ops.py`,
which is where the overlay bookkeeping, the gallery renumbering and the
custom-kink tombstones are enforced. These tools are the addressing and
validation layer on top.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

import archive_backups
import archive_images
import archive_workbench
import bbcode_rules

from ._context import (
    ResolvedCharacter,
    ToolError,
    audit,
    confirm_required,
    load_payload,
    resolve_character,
    resolve_workbench,
    workbench_target,
)
from ._registry import TAG_CHARACTER, TAG_FULL, tool
from .tools_session import NO_PUSH_NOTE


def _writable(character: str) -> ResolvedCharacter:
    """Resolve a character for an edit, making its Workbench from Live
    if it has none yet. An edit has no other copy it could change."""
    target = resolve_character(character)
    resolve_workbench(target)
    return target


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


def _apply(target, mutate) -> Any:  # noqa: ANN001, ANN202
    from services import payload_ops

    try:
        return payload_ops.edit(target.id, mutate)
    except payload_ops.PayloadError as exc:
        raise ToolError("validation_failed", str(exc)) from exc
    except archive_workbench.EtagMismatch as exc:
        raise ToolError(
            "etag_mismatch",
            "The Workbench changed while the edit was in flight. Read "
            "the field again and redo the change.",
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
# the Workbench and shows it directly under "Live on F-List". Editing
# tools create it on their own; there is nothing to open first.
# --------------------------------------------------------------------


@tool(
    tags=TAG_CHARACTER,
    title="Load a backup into the workbench",
    destructive=True,
    warning=(
        "Loading a backup replaces everything currently in the "
        "Workbench; the Workbench is saved as a Backup first."
    ),
)
def load_backup_into_workbench(
    character: str, backup: str, confirm: bool = False
) -> dict[str, Any]:
    """Restore: replace the Workbench contents with a Backup's.

    Overwrites everything in the Workbench, so it needs `confirm=true`.
    The Workbench it replaces is always saved as a Backup first
    (occasion `before-restore`), named in `kept_as`; restoring that
    Backup undoes this. If that Backup cannot be written, nothing is
    replaced. `backup` is a filename from `list_backups`.
    """
    target = resolve_character(character)
    replaced = archive_backups.load_zip_backup_into_workbench(target.id, backup)
    kept = replaced.kept["filename"] if replaced.kept else None
    audit(
        "load_backup_into_workbench",
        character=target.name,
        backup=backup,
        kept_as=kept,
    )
    return {
        "character": target.name,
        "loaded": backup,
        "kept_as": kept,
    }


# --------------------------------------------------------------------
# Description
# --------------------------------------------------------------------


@tool(
    tags=TAG_CHARACTER,
    title="Replace the description",
    confirm_when="the new text is less than half as long as the old",
)
def set_description(
    character: str,
    text: str,
    confirm: bool = False,
) -> dict[str, Any]:
    """Replace a profile's whole description with `text`, in F-list
    BBCode.

    This overwrites everything — for a targeted change use
    edit_description, which is far less likely to lose work. A `text`
    less than half as long as the description it replaces needs
    `confirm=true`. Call get_bbcode_reference first if unsure which
    tags F-list supports.
    """
    from services import payload_ops

    target = _writable(character)
    body = payload_ops.normalise_newlines(str(text))

    _guard_bbcode(body)

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        previous = payload_ops.get_description(payload)
        # Measured against the text on disk, under the lock: a shorter
        # text is a summary written over the original as often as it is
        # a deliberate cut.
        if len(body) * 2 < len(previous) and not confirm:
            raise confirm_required(
                f"The new description is {len(body)} characters long and "
                f"replaces one of {len(previous)}, so most of the text "
                "would go. For a targeted change use edit_description."
            )
        payload_ops.set_description(payload, body)
        return payload_ops.EditResult(
            etag="",
            changed=[payload_ops.DESCRIPTION_PATH],
            detail={"previous_length": len(previous)},
        )

    result = _apply(target, mutate)
    audit(
        "set_description",
        character=target.name,
        length=len(body),
    )
    return {
        "character": target.name,
        "length": len(body),
        "previous_length": result.detail.get("previous_length"),
    }


@tool(tags=TAG_CHARACTER, title="Edit part of the description")
def edit_description(
    character: str,
    old_string: str,
    new_string: str,
    replace_all: bool = False,
) -> dict[str, Any]:
    """Replace an exact piece of text inside the description.

    `old_string` must appear exactly once, or nothing is changed —
    which is the point: it makes a targeted edit safe on a description
    that is tens of kilobytes long. Pass replace_all=true to change
    every occurrence instead.
    """
    from services import payload_ops

    target = _writable(character)
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

    result = _apply(target, mutate)
    audit("edit_description", character=target.name)
    return {
        "character": target.name,
        "replacements": result.detail.get("replacements"),
        "length": result.detail.get("length"),
    }


@tool(tags=TAG_CHARACTER, title="Append to the description")
def append_description(
    character: str,
    text: str,
) -> dict[str, Any]:
    """Add text to the end of the description, on a new line."""
    from services import payload_ops

    target = _writable(character)
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

    result = _apply(target, mutate)
    audit("append_description", character=target.name)
    return {
        "character": target.name,
        "length": result.detail.get("length"),
        "note": NO_PUSH_NOTE,
    }


@tool(tags=TAG_CHARACTER, title="Set the custom title")
def set_custom_title(
    character: str,
    title: str,
) -> dict[str, Any]:
    """Set the line shown under the character's name on their profile."""
    from services import payload_ops

    target = _writable(character)
    value = str(title).strip()

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        char = payload_ops.container(payload, "character")
        char["custom_title"] = value
        return payload_ops.EditResult(
            etag="", changed=["character.custom_title"]
        )

    _apply(target, mutate)
    audit("set_custom_title", character=target.name)
    return {"character": target.name, "custom_title": value}


# --------------------------------------------------------------------
# Profile fields
# --------------------------------------------------------------------


@tool(tags=TAG_CHARACTER, title="Set a profile field")
async def set_profile_field(
    character: str,
    field: str,
    value: str,
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

    target = _writable(character)
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

    _apply(target, mutate)
    audit(
        "set_profile_field",
        character=target.name,
        field=field_def.label,
    )
    out = {
        "character": target.name,
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
) -> dict[str, Any]:
    """Remove a profile field so it doesn't appear at all.

    Different from setting it to an empty string, which would publish
    an empty field.
    """
    from services import payload_ops

    target = _writable(character)
    catalogue = await _catalogue()
    field_def = catalogue.resolve_field(field)
    field_id = field_def.id if field_def else str(field).strip()
    label = field_def.label if field_def else field_id

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        path, existed = payload_ops.clear_infotag(payload, field_id)
        return payload_ops.EditResult(
            etag="", changed=[path], detail={"existed": existed}
        )

    result = _apply(target, mutate)
    audit("clear_profile_field", character=target.name, field=label)
    return {
        "character": target.name,
        "field": label,
        "was_set": result.detail.get("existed", False),
    }


@tool(tags=TAG_CHARACTER, title="Profile visibility settings")
def set_profile_settings(
    character: str,
    customs_first: bool | None = None,
    show_friends: bool | None = None,
    guestbook: bool | None = None,
    prevent_bookmarks: bool | None = None,
    public: bool | None = None,
) -> dict[str, Any]:
    """The profile's display and visibility switches. Omitted ones are
    left alone."""
    from services import payload_ops

    target = _writable(character)
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

    result = _apply(target, mutate)
    audit("set_profile_settings", character=target.name)
    return {
        "character": target.name,
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
) -> dict[str, Any]:
    """Set one standard kink to fave, yes, maybe, no — or `undecided`
    to remove the entry, which is how F-list represents no opinion.

    `kink` is the name as F-list lists it, or its id.
    """
    from services import payload_ops, profile_fields

    target = _writable(character)
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

    _apply(target, mutate)
    audit("set_kink", character=target.name, kink=kink)
    return {
        "character": target.name,
        "kink": catalogue.kinks.get(kink_id, kink_id),
        "choice": value,
    }


@tool(tags=TAG_CHARACTER, title="Set several kinks")
async def set_kinks(
    character: str,
    items: list[dict[str, str]],
) -> dict[str, Any]:
    """Set many kinks in one call. Each item is
    `{"kink": name or id, "choice": fave|yes|maybe|no|undecided}`.

    Everything is validated before anything is written, so one bad
    entry doesn't leave the Workbench half-updated.
    """
    from services import payload_ops, profile_fields

    target = _writable(character)
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

    _apply(target, mutate)
    audit(
        "set_kinks", character=target.name, count=len(prepared)
    )
    return {
        "character": target.name,
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
) -> dict[str, Any]:
    """Add a kink of the user's own wording, for something F-list's
    catalogue doesn't cover.

    Custom kinks appear in their own section of the profile.
    """
    from services import payload_ops, profile_fields

    target = _writable(character)
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

    result = _apply(target, mutate)
    audit("add_custom_kink", character=target.name, name=label)
    return {
        "character": target.name,
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
) -> dict[str, Any]:
    """Change a custom kink's name, description or choice. Omitted
    fields are left alone. `kink_id` comes from list_kinks."""
    from services import payload_ops, profile_fields

    target = _writable(character)
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

    _apply(target, mutate)
    audit("update_custom_kink", character=target.name, id=kink_id)
    return {
        "character": target.name,
        "id": kink_id,
        "changed": sorted(fields),
    }


@tool(
    tags=TAG_CHARACTER,
    title="Delete a custom kink",
    destructive=True,
    warning=(
        "Deleting a custom kink that was never uploaded drops it and "
        "its description for good."
    ),
)
def delete_custom_kink(
    character: str,
    kink_id: str,
    confirm: bool = False,
) -> dict[str, Any]:
    """Remove a custom kink from the profile; needs `confirm=true`.

    One that already exists on F-list is kept as a tombstone so the
    upload knows to remove it, and can be brought back with
    restore_custom_kink. One added locally and never uploaded is
    dropped for good.
    """
    from services import payload_ops

    target = _writable(character)

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        how, touched = payload_ops.delete_custom_kink(payload, kink_id)
        return payload_ops.EditResult(
            etag="", changed=touched, detail={"how": how}
        )

    result = _apply(target, mutate)
    how = result.detail.get("how")
    audit("delete_custom_kink", character=target.name, id=kink_id)
    return {
        "character": target.name,
        "id": kink_id,
        "outcome": how,
        "restorable": how == "tombstoned",
    }


@tool(tags=TAG_CHARACTER, title="Restore a deleted custom kink")
def restore_custom_kink(
    character: str,
    kink_id: str,
) -> dict[str, Any]:
    """Undo delete_custom_kink for a kink that was tombstoned."""
    from services import payload_ops

    target = _writable(character)

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        touched = payload_ops.restore_custom_kink(payload, kink_id)
        return payload_ops.EditResult(etag="", changed=touched)

    _apply(target, mutate)
    audit("restore_custom_kink", character=target.name, id=kink_id)
    return {"character": target.name, "id": kink_id}


@tool(tags=TAG_CHARACTER, title="Reorder custom kinks")
def reorder_custom_kinks(
    character: str,
    kink_ids: list[str],
) -> dict[str, Any]:
    """Set the order custom kinks appear in on the profile.

    Every custom kink that isn't deleted has to appear exactly once —
    a partial list would silently drop the rest.
    """
    from services import payload_ops

    target = _writable(character)

    def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
        touched = payload_ops.reorder_custom_kinks(payload, list(kink_ids))
        return payload_ops.EditResult(etag="", changed=touched)

    _apply(target, mutate)
    audit("reorder_custom_kinks", character=target.name)
    return {"character": target.name, "order": list(kink_ids)}


# --------------------------------------------------------------------
# Gallery
# --------------------------------------------------------------------


@tool(tags=TAG_CHARACTER, title="Image caption")
def set_image_description(
    character: str,
    image_id: str,
    description: str,
) -> dict[str, Any]:
    """Set the caption shown under a gallery image."""
    from services import payload_ops

    target = _writable(character)

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

    _apply(target, mutate)
    audit("set_image_description", character=target.name)
    return {
        "character": target.name,
        "image_id": image_id,
        "description": description,
    }


@tool(tags=TAG_CHARACTER, title="Reorder the gallery")
def reorder_images(
    character: str,
    image_ids: list[str],
) -> dict[str, Any]:
    """Set the order images appear in on the profile.

    Every image currently on the profile has to appear exactly once.
    """
    from services import payload_ops

    target = _writable(character)
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

    _apply(target, mutate)
    audit("reorder_images", character=target.name)
    return {"character": target.name, "order": wanted}


@tool(tags=TAG_CHARACTER, title="Remove an image from the profile")
def remove_image(
    character: str,
    image_id: str,
    delete_file: bool = False,
) -> dict[str, Any]:
    """Take an image off the profile.

    The file stays in the pool and can be put back with add_image.
    `delete_file=true` moves it to the character's Trash instead, where
    `restore_image` can bring it back; only the user can empty the Trash.
    """
    from services import payload_ops

    target = _writable(character)

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

    _apply(target, mutate)
    file_trashed = False
    if delete_file:
        from services import image_trash

        file_trashed = bool(
            image_trash.trash_images(target.id, [str(image_id)])["trashed"]
        )
    audit(
        "remove_image",
        character=target.name,
        image_id=image_id,
        file_trashed=file_trashed,
    )
    return {
        "character": target.name,
        "image_id": image_id,
        "file_trashed": file_trashed,
        "note": (
            "The file is in the Trash; restore_image puts it back in the pool."
            if file_trashed
            else "The file is still in the pool; add_image can put it back."
        ),
    }


@tool(tags=TAG_CHARACTER, title="Move pool images to the Trash")
def trash_images(character: str, image_ids: list[str]) -> dict[str, Any]:
    """Move images that are in the pool — on disk, not on the profile —
    to the character's Trash. `restore_image` brings them back; only the
    user can empty the Trash, in the window.

    An image still in the Workbench's gallery is refused (take it off
    with `remove_image` first), so no gallery is left pointing at a file
    that is gone. An image on the live profile can be trashed, but the
    next pull fetches it again; the result says which.
    """
    from services import image_import, image_trash

    target = resolve_character(character)
    ids = list(dict.fromkeys(str(i) for i in image_ids))
    if not ids:
        raise ToolError("validation_failed", "Give at least one image id.")
    refs = image_import.references(target.id)
    in_gallery = [i for i in ids if refs.get(i, {}).get("workbench")]
    if in_gallery:
        raise ToolError(
            "image_on_profile",
            "Still in the Workbench's gallery, so not trashed: "
            + ", ".join(in_gallery)
            + ". Take them off with remove_image first. Nothing was moved.",
        )
    result = image_trash.trash_images(target.id, ids)
    moved = [t["image_id"] for t in result["trashed"]]
    on_live = [i for i in moved if refs.get(i, {}).get("live")]
    audit("trash_images", character=target.name, image_ids=moved)
    out: dict[str, Any] = {
        "character": target.name,
        "trashed": moved,
        "not_found": result["not_found"],
    }
    if on_live:
        out["on_live_profile"] = on_live
        out["note"] = (
            "These are on the live profile, so the next pull downloads "
            "them into the pool again."
        )
    return out


@tool(tags=TAG_CHARACTER, title="List the Trash", read_only=True)
def list_trash(character: str) -> dict[str, Any]:
    """What the character's Trash holds, newest first, with when and by
    whom (`ui` or `mcp`): `items` are images deleted from the pool,
    which `restore_image` puts back by `trash_id` (the image id, unless
    the Trash holds several files under one id because a Pull replaced
    it); `backups` are deleted Backups and `labels` are cleared Labels
    (one entry per clear, with its conversation, or `partner` null for
    every conversation, and how many Labels it holds), both of which the
    user restores in the window. Emptying the Trash is the user's job,
    in the window."""
    from services import backup_trash, image_trash, label_trash

    target = resolve_character(character)
    return {
        "character": target.name,
        "items": image_trash.list_trash(target.id),
        "backups": backup_trash.list_backups(target.id),
        "labels": label_trash.list_labels(target.name),
    }


@tool(tags=TAG_CHARACTER, title="Restore images from the Trash")
def restore_image(
    character: str,
    image_id: str | None = None,
    image_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Move images from the Trash back into the pool — not onto the
    profile; use add_image for that. Give one `image_id` or several
    `image_ids`, as list_trash's `trash_id`. If the pool already holds
    the same bytes, the Trash entry is dropped and the existing id is
    reported instead. If it holds a different picture under that id,
    the restored one comes back as `local-<sha8>`, so both are kept.
    """
    from services import image_trash

    target = resolve_character(character)
    ids = [str(i) for i in (image_ids or [])]
    if image_id:
        ids.insert(0, str(image_id))
    if not ids:
        raise ToolError("validation_failed", "Give image_id or image_ids.")
    result = image_trash.restore_images(target.id, ids)
    if not result["restored"] and result["not_found"]:
        raise ToolError(
            "image_not_found",
            f"Not in {target.name}'s Trash: {result['not_found']}. "
            "list_trash shows what is there.",
        )
    audit(
        "restore_image",
        character=target.name,
        image_ids=[r["image_id"] for r in result["restored"]],
    )
    return {"character": target.name, **result}


@tool(tags=TAG_CHARACTER, title="Put an image on the profile")
def add_image(
    character: str,
    image_id: str,
    description: str = "",
) -> dict[str, Any]:
    """Add an image that is already in the character's image folder to
    the profile gallery, at the end.

    `list_images` shows what is available under `not_on_profile`.
    """
    from services import payload_ops

    target = _writable(character)
    on_disk = {
        str(row.get("image_id"))
        for row in archive_images.list_character_images(target.id)
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

    _apply(target, mutate)
    audit("add_image", character=target.name, image_id=image_id)
    return {
        "character": target.name,
        "image_id": image_id,
    }


# --------------------------------------------------------------------
# Importing files from elsewhere on the machine
#
# The pool is the character's image folder. Getting a picture edited
# outside the Workbench into it used to take the user copying files by
# hand, a model matching hashes to find the new ids, and an add, a
# remove and a full reorder per swapped image. One batch call does it
# now, with every source checked before anything is written.
# --------------------------------------------------------------------

MAX_IMPORT_ITEMS = 200


class ImportItem(BaseModel):
    """One file for `import_images`."""

    source_path: str
    replace_image_id: str | None = None
    description: str | None = None


def _import_batch(
    character: str,
    items: list[ImportItem],
    *,
    add_to_gallery: bool,
    convert_to_jpeg: bool,
) -> dict[str, Any]:
    from services import image_import, payload_ops

    target = resolve_character(character)
    if not items:
        raise ToolError("validation_failed", "No items to import.")
    if len(items) > MAX_IMPORT_ITEMS:
        raise ToolError(
            "validation_failed",
            f"{len(items)} items; one call takes at most {MAX_IMPORT_ITEMS}.",
        )
    targets = [str(i.replace_image_id) for i in items if i.replace_image_id]
    touches_gallery = add_to_gallery or bool(targets)

    # Everything that can be refused is refused before the first file is
    # copied: a half-done batch leaves the model guessing what landed.
    if touches_gallery:
        target = _writable(character)
        resolved = workbench_target(target)
        on_profile = {r["image_id"] for r in payload_ops.gallery(load_payload(resolved))}
        missing = [t for t in targets if t not in on_profile]
        if missing:
            raise ToolError(
                "validation_failed",
                f"Not on this profile, so nothing to replace: {missing}. "
                "list_images shows the gallery. Nothing was imported.",
            )
        twice = sorted({t for t in targets if targets.count(t) > 1})
        if twice:
            raise ToolError(
                "validation_failed",
                f"Replaced more than once in one call: {twice}. "
                "Nothing was imported.",
            )
    else:
        resolved = _workbench_for_reporting(target)

    roots = image_import.import_roots()
    prepared: list[image_import.PreparedImage] = []
    for index, item in enumerate(items):
        try:
            prepared.append(
                image_import.prepare(
                    item.source_path, roots=roots, convert_to_jpeg=convert_to_jpeg
                )
            )
        except image_import.ImportRefused as exc:
            raise ToolError(
                exc.code,
                f"Item {index}: {exc.message} Nothing was imported.",
                **exc.details,
            ) from exc

    try:
        stored = [image_import.store(target.id, p) for p in prepared]
    except image_import.ImportRefused as exc:
        raise ToolError(exc.code, exc.message, **exc.details) from exc

    replaced: dict[int, str] = {}
    if touches_gallery:

        def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
            replaced.clear()
            rows = payload_ops.gallery(payload)
            for index, (item, row) in enumerate(zip(items, stored)):
                new_id = str(row["image_id"])
                old_id = str(item.replace_image_id) if item.replace_image_id else None
                if old_id:
                    slot = next(
                        (i for i, r in enumerate(rows) if r["image_id"] == old_id),
                        None,
                    )
                    if slot is None:
                        raise payload_ops.PayloadError(
                            f"{old_id!r} is not on this profile."
                        )
                    if new_id == old_id:
                        continue
                    if any(r["image_id"] == new_id for r in rows):
                        raise payload_ops.PayloadError(
                            f"{prepared[index].source_name} is the same picture "
                            f"as {new_id!r}, which is already on this profile, "
                            f"so it can't also take {old_id!r}'s place. The "
                            "files were imported into the pool."
                        )
                    description = (
                        item.description
                        if item.description is not None
                        else rows[slot]["description"]
                    )
                    rows[slot] = {
                        "image_id": new_id,
                        "description": description,
                        "sort_order": rows[slot]["sort_order"],
                    }
                    replaced[index] = old_id
                elif add_to_gallery and not any(r["image_id"] == new_id for r in rows):
                    rows.append(
                        {
                            "image_id": new_id,
                            "description": item.description or "",
                            "sort_order": len(rows),
                        }
                    )
            return payload_ops.EditResult(
                etag="", changed=payload_ops.set_gallery(payload, rows)
            )

        _apply(target, mutate)

    positions: dict[str, int] = {}
    if resolved is not None:
        for row in payload_ops.gallery(load_payload(resolved)):
            positions[row["image_id"]] = row["sort_order"]

    results = []
    for index, (item, p, row) in enumerate(zip(items, prepared, stored)):
        image_id = str(row["image_id"])
        warnings = list(p.warnings)
        if item.replace_image_id and str(item.replace_image_id) == image_id:
            warnings.append("same_as_replaced")
        results.append(
            {
                "image_id": image_id,
                "deduplicated": row["deduplicated"],
                "extension": row["extension"],
                "bytes": row["size"],
                "width": p.width,
                "height": p.height,
                "sha256": row["sha256"],
                "source_name": p.source_name,
                "converted": p.converted,
                "on_profile": image_id in positions,
                "sort_order": positions.get(image_id),
                "replaced": replaced.get(index),
                "warnings": warnings,
            }
        )
    audit(
        "import_images",
        character=target.name,
        image_ids=[r["image_id"] for r in results],
        replaced=[r["replaced"] for r in results if r["replaced"]],
    )
    return {"character": target.name, "results": results}


def _workbench_for_reporting(target):  # noqa: ANN001, ANN202
    """The Workbench whose gallery a pool-only import reports against,
    or None when there is none yet. Never creates one: importing into
    the pool is not editing."""
    if archive_workbench.read_workbench(target.id) is None:
        return None
    return workbench_target(target)


@tool(tags=TAG_CHARACTER, title="Import images into the pool")
def import_images(
    character: str,
    items: list[ImportItem],
    add_to_gallery: bool = False,
    convert_to_jpeg: bool = False,
) -> dict[str, Any]:
    """Copy image files from this machine into the character's image
    folder (the pool), and optionally onto the profile.

    Each item names an absolute `source_path`. Only folders the user has
    cleared under Settings → Security can be read; there is no tool to
    change that list. The source file is copied, never moved or changed.

    - `replace_image_id`: the new picture takes exactly that image's
      place in the gallery, keeping its description unless `description`
      is given. The old image leaves the gallery and stays in the pool.
    - `add_to_gallery`: items without `replace_image_id` are appended to
      the end of the gallery, in the order given.
    - Identical bytes are stored once: the result then says
      `deduplicated: true` and gives the existing id.
    - Files at or over F-list's limits (2.0 MB, 4000 px a side) are
      imported with a warning (`over_2mb`, `over_4000px`).
      `convert_to_jpeg=true` re-encodes such files as JPEG quality 95
      when that makes them smaller; animations and images with visible
      transparency are left as they are, with a warning saying why.

    Every source is checked before anything is written, so a refused
    item means nothing was imported. Results come back in item order.
    """
    out = _import_batch(
        character,
        items,
        add_to_gallery=add_to_gallery,
        convert_to_jpeg=convert_to_jpeg,
    )
    return out


@tool(tags=TAG_CHARACTER, title="Import an image into the pool")
def import_image(
    character: str,
    source_path: str,
    add_to_gallery: bool = False,
    replace_image_id: str | None = None,
    description: str | None = None,
    convert_to_jpeg: bool = False,
) -> dict[str, Any]:
    """One-file form of `import_images`, which has the details. Prefer
    `import_images` for more than one file: it is one call, and a
    gallery change from it is one write."""
    out = _import_batch(
        character,
        [
            ImportItem(
                source_path=source_path,
                replace_image_id=replace_image_id,
                description=description,
            )
        ],
        add_to_gallery=add_to_gallery,
        convert_to_jpeg=convert_to_jpeg,
    )
    return {
        "character": out["character"],
        **out["results"][0],
        "note": NO_PUSH_NOTE,
    }


# --------------------------------------------------------------------
# Escape hatch
# --------------------------------------------------------------------


#
# Both tools are on the full endpoint only (`TAG_FULL`): a narrow
# endpoint is for a small model, and the targeted tools are what it
# should reach for.


@tool(tags=TAG_FULL, title="Raw Workbench payload", read_only=True)
def get_workbench_payload(character: str) -> dict[str, Any]:
    """The complete raw payload of the Workbench, including `_overlay`,
    and the `etag` to send back to put_workbench_payload.

    Large — a description alone can be tens of kilobytes. The targeted
    read tools are almost always the better choice; this exists for
    inspecting something they don't expose.
    """
    target = resolve_character(character)
    resolve_workbench(target)
    # The payload and its etag from one read, so the etag a model sends
    # back names exactly what it was shown.
    bench = archive_workbench.read_workbench(target.id)
    if bench is None:
        raise ToolError(
            "no_workbench",
            f"{target.name}'s Workbench has no payload on disk.",
        )
    return {"character": target.name, "etag": bench.etag, "payload": bench.payload}


@tool(
    tags=TAG_FULL,
    title="Replace the raw Workbench payload",
    destructive=True,
    warning=(
        "This replaces the whole Workbench without any of the validation "
        "the targeted editing tools apply; the Workbench is saved as a "
        "Backup first. Use the targeted tools unless there is no "
        "alternative."
    ),
)
def put_workbench_payload(
    character: str,
    payload: dict[str, Any],
    if_match: str | None = None,
    confirm: bool = False,
) -> dict[str, Any]:
    """Replace the Workbench's entire payload; needs `confirm=true`.

    The escape hatch, and a blunt one: none of the rules the targeted
    tools enforce are applied, so a malformed payload here can lose the
    overlay, scramble the gallery order, or write field ids F-list
    drops on upload. Prefer the targeted tools. Pass `if_match` with
    the etag from get_workbench_payload to avoid overwriting a change
    made in the meantime.

    The Workbench it replaces is saved as a Backup first (occasion
    `before-restore`), named in `kept_as`; load_backup_into_workbench
    with that Backup undoes this. If that Backup cannot be written,
    nothing is replaced.
    """
    target = resolve_character(character)
    if not isinstance(payload, dict):
        raise ToolError("validation_failed", "payload must be an object")
    try:
        replaced = archive_backups.replace_workbench(
            target.id, payload, expected_etag=if_match
        )
    except ValueError as exc:
        # Not a payload the Workbench takes; refused before any Backup.
        raise ToolError("validation_failed", str(exc)) from exc
    kept = replaced.kept["filename"] if replaced.kept else None
    audit("put_workbench_payload", character=target.name, kept_as=kept)
    return {
        "character": target.name,
        "etag": replaced.etag,
        "kept_as": kept,
    }
