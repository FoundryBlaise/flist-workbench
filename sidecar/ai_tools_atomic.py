"""OpenAI-style function schemas for the assistant's atomic write tools.

The model gets a fixed catalogue of function tools registered with the
chat endpoint; each tool's `name` matches the `tool` key
`ai_draft_validate.validate_edit` dispatches on. The chat layer (PR 3)
takes the tool calls coming back from the model, runs each through
`build_edit_from_tool_call` to translate function args → the edit dict
shape `ai_draft.append_edits` consumes, and persists.

Cross-character read tools (`get_other_character`, `list_my_characters`,
etc.) and composite write tools (`copy_standard_kinks_from`, …) live
in `ai_tools_read.py` and `ai_tools_composite.py` respectively (PR 2).
This module only covers the 12 single-field atomic writes (§5.3 of
`/workspace/docs/PHASE9_AI_ASSISTANT_PLAN.md`).
"""

from __future__ import annotations

from typing import Any


# ---- function-tool schemas ------------------------------------------

# Each schema is the JSON Schema body a generic OpenAI-style chat
# endpoint expects under `tools[i].function`. Names line up with the
# dispatch tags in `ai_draft_validate.validate_edit` (`tool` field on
# the canonical edit). Descriptions are written for the model — keep
# them taut and behaviour-focused.

ATOMIC_TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "set_infotag",
        "description": (
            "Set or change a single profile infotag on the active character. "
            "Use label form for value (e.g. 'English', 'Anthro') — the server "
            "reverse-looks-up to the canonical listitem id."
        ),
        "parameters": {
            "type": "object",
            "required": ["infotag_id", "value", "rationale"],
            "properties": {
                "infotag_id": {
                    "type": "string",
                    "description": "Numeric id of the infotag (e.g. '49' for Language preference).",
                },
                "value": {
                    "type": "string",
                    "description": "Label or numeric listitem id.",
                },
                "rationale": {"type": "string", "maxLength": 300},
            },
        },
    },
    {
        "name": "clear_infotag",
        "description": "Unset an infotag entirely so the field returns to default.",
        "parameters": {
            "type": "object",
            "required": ["infotag_id", "rationale"],
            "properties": {
                "infotag_id": {"type": "string"},
                "rationale": {"type": "string", "maxLength": 300},
            },
        },
    },
    {
        "name": "replace_description",
        "description": (
            "Replace the entire character description with new BBCode. "
            "Preserve the user's voice; do not invent biographical facts. "
            "BBCode tags must be lowercase ([b], not [B]); no Markdown."
        ),
        "parameters": {
            "type": "object",
            "required": ["new_value", "rationale"],
            "properties": {
                "new_value": {"type": "string"},
                "rationale": {"type": "string", "maxLength": 300},
            },
        },
    },
    {
        "name": "patch_description",
        "description": (
            "Replace a specific excerpt of the description. `old_excerpt` "
            "must match the current text (whitespace-normalised); if not, "
            "the edit is rejected with anchor_mismatch."
        ),
        "parameters": {
            "type": "object",
            "required": ["old_excerpt", "new_value", "rationale"],
            "properties": {
                "old_excerpt": {"type": "string"},
                "new_value": {"type": "string"},
                "rationale": {"type": "string", "maxLength": 300},
            },
        },
    },
    {
        "name": "set_custom_kink",
        "description": (
            "Modify one attribute of an existing custom kink. `attr` is one "
            "of name|description|choice; choice values are "
            "fave|yes|maybe|no|undecided."
        ),
        "parameters": {
            "type": "object",
            "required": ["custom_kink_id", "attr", "new_value", "rationale"],
            "properties": {
                "custom_kink_id": {"type": "string"},
                "attr": {"enum": ["name", "description", "choice"]},
                "new_value": {"type": "string"},
                "rationale": {"type": "string", "maxLength": 300},
            },
        },
    },
    {
        "name": "add_custom_kink",
        "description": (
            "Create a brand-new custom kink. Server assigns an id."
        ),
        "parameters": {
            "type": "object",
            "required": ["name", "choice", "rationale"],
            "properties": {
                "name": {"type": "string"},
                "description": {"type": "string"},
                "choice": {"enum": ["fave", "yes", "maybe", "no", "undecided"]},
                "rationale": {"type": "string", "maxLength": 300},
            },
        },
    },
    {
        "name": "remove_custom_kink",
        "description": "Delete an existing custom kink by id.",
        "parameters": {
            "type": "object",
            "required": ["custom_kink_id", "rationale"],
            "properties": {
                "custom_kink_id": {"type": "string"},
                "rationale": {"type": "string", "maxLength": 300},
            },
        },
    },
    {
        "name": "set_standard_kink",
        "description": (
            "Assign a standard kink to a bucket. `kink_id` is the F-list "
            "listitem id; `choice` is fave|yes|maybe|no|undecided."
        ),
        "parameters": {
            "type": "object",
            "required": ["kink_id", "choice", "rationale"],
            "properties": {
                "kink_id": {"type": "string"},
                "choice": {"enum": ["fave", "yes", "maybe", "no", "undecided"]},
                "rationale": {"type": "string", "maxLength": 300},
            },
        },
    },
    {
        "name": "set_character_setting",
        "description": (
            "Toggle a boolean profile setting. Allowed keys: "
            "customs_first, show_friends, guestbook, prevent_bookmarks, "
            "public."
        ),
        "parameters": {
            "type": "object",
            "required": ["key", "value", "rationale"],
            "properties": {
                "key": {
                    "enum": [
                        "customs_first",
                        "show_friends",
                        "guestbook",
                        "prevent_bookmarks",
                        "public",
                    ]
                },
                "value": {"type": "boolean"},
                "rationale": {"type": "string", "maxLength": 300},
            },
        },
    },
    {
        "name": "add_image_to_gallery",
        "description": (
            "Move an image from the pool to the visible profile gallery. "
            "Bytes don't move on disk — this is a working-copy edit only."
        ),
        "parameters": {
            "type": "object",
            "required": ["image_id", "rationale"],
            "properties": {
                "image_id": {"type": "string"},
                "rationale": {"type": "string", "maxLength": 300},
            },
        },
    },
    {
        "name": "remove_image_from_gallery",
        "description": (
            "Hide an image from the gallery. The image stays in the pool; "
            "bytes are NOT deleted. (To delete bytes, the user must use "
            "the Images tab.)"
        ),
        "parameters": {
            "type": "object",
            "required": ["image_id", "rationale"],
            "properties": {
                "image_id": {"type": "string"},
                "rationale": {"type": "string", "maxLength": 300},
            },
        },
    },
    {
        "name": "reorder_gallery",
        "description": (
            "Re-sort the visible gallery. `image_ids` MUST be an exact "
            "permutation of the current gallery — no additions or "
            "removals via this tool."
        ),
        "parameters": {
            "type": "object",
            "required": ["image_ids", "rationale"],
            "properties": {
                "image_ids": {"type": "array", "items": {"type": "string"}},
                "rationale": {"type": "string", "maxLength": 300},
            },
        },
    },
]


def atomic_tool_names() -> set[str]:
    return {schema["name"] for schema in ATOMIC_TOOL_SCHEMAS}


# ---- tool-call → edit dict translation ------------------------------


def build_edit_from_tool_call(tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Translate `(tool_name, args)` from a model tool call into the
    raw edit dict shape `ai_draft.append_edits` expects.

    Returns a dict with `tool`, `field_path`, `new_value` (and the
    per-tool optional fields like `old_excerpt`). The chat layer
    persists this via `append_edits`, which runs the full validator
    pipeline — `build_edit_from_tool_call` doesn't validate.

    Raises `ValueError` only when the args dict is missing a required
    key the validator wouldn't see (e.g. no `kink_id` for
    `set_standard_kink` means there's no field_path to construct).
    """
    rationale = args.get("rationale", "")

    if tool_name == "set_infotag":
        infotag_id = args.get("infotag_id")
        if not infotag_id:
            raise ValueError("set_infotag missing infotag_id")
        return {
            "tool": "set_infotag",
            "field_path": f"infotags.{infotag_id}",
            "new_value": args.get("value"),
            "rationale": rationale,
        }

    if tool_name == "clear_infotag":
        infotag_id = args.get("infotag_id")
        if not infotag_id:
            raise ValueError("clear_infotag missing infotag_id")
        return {
            "tool": "clear_infotag",
            "field_path": f"infotags.{infotag_id}",
            "rationale": rationale,
        }

    if tool_name == "replace_description":
        return {
            "tool": "replace_description",
            "field_path": "character.description",
            "new_value": args.get("new_value"),
            "rationale": rationale,
        }

    if tool_name == "patch_description":
        return {
            "tool": "patch_description",
            "field_path": "character.description",
            "old_excerpt": args.get("old_excerpt"),
            "new_value": args.get("new_value"),
            "rationale": rationale,
        }

    if tool_name == "set_custom_kink":
        ck_id = args.get("custom_kink_id")
        attr = args.get("attr")
        if not ck_id or not attr:
            raise ValueError("set_custom_kink requires custom_kink_id + attr")
        return {
            "tool": "set_custom_kink",
            "field_path": f"custom_kinks.{ck_id}.{attr}",
            "new_value": args.get("new_value"),
            "rationale": rationale,
        }

    if tool_name == "add_custom_kink":
        return {
            "tool": "add_custom_kink",
            "field_path": "custom_kinks",
            "new_value": {
                "name": args.get("name"),
                "description": args.get("description", ""),
                "choice": args.get("choice", "undecided"),
            },
            "rationale": rationale,
        }

    if tool_name == "remove_custom_kink":
        ck_id = args.get("custom_kink_id")
        if not ck_id:
            raise ValueError("remove_custom_kink missing custom_kink_id")
        return {
            "tool": "remove_custom_kink",
            "field_path": f"custom_kinks.{ck_id}",
            "rationale": rationale,
        }

    if tool_name == "set_standard_kink":
        kink_id = args.get("kink_id")
        if not kink_id:
            raise ValueError("set_standard_kink missing kink_id")
        return {
            "tool": "set_standard_kink",
            "field_path": f"kinks.{kink_id}",
            "new_value": args.get("choice"),
            "rationale": rationale,
        }

    if tool_name == "set_character_setting":
        key = args.get("key")
        if not key:
            raise ValueError("set_character_setting missing key")
        return {
            "tool": "set_character_setting",
            "field_path": f"settings.{key}",
            "new_value": args.get("value"),
            "rationale": rationale,
        }

    if tool_name == "add_image_to_gallery":
        return {
            "tool": "add_image_to_gallery",
            "field_path": "images",
            "new_value": args.get("image_id"),
            "rationale": rationale,
        }

    if tool_name == "remove_image_from_gallery":
        return {
            "tool": "remove_image_from_gallery",
            "field_path": "images",
            "old_value": args.get("image_id"),
            "rationale": rationale,
        }

    if tool_name == "reorder_gallery":
        return {
            "tool": "reorder_gallery",
            "field_path": "images",
            "new_value": args.get("image_ids"),
            "rationale": rationale,
        }

    raise ValueError(f"unknown atomic tool '{tool_name}'")
