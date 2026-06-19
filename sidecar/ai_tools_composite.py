"""Composite write tools — one tool call fans into many atomic edits.

Five tools that let the model express bulk and cross-character
operations without burning tokens enumerating each atomic edit:

- `bulk_set_standard_kinks` — N × `set_standard_kink` from a list
- `copy_standard_kinks_from(other, scope)` — read B, diff against A,
  emit only the deltas
- `copy_custom_kinks_from(other, mode)` — replace vs merge
- `copy_infotags_from(other, [ids])` — N × `set_infotag`
- `clear_all_custom_kinks` — N × `remove_custom_kink`

The output of each tool is a *list of raw edit dicts* in the same
shape `ai_tools_atomic.build_edit_from_tool_call` produces. The chat
endpoint hands the list to `ai_draft.append_edits` exactly like an
atomic call — stamping every member with a shared `composite_id` so
the renderer can show a single summary card with expand.

Cross-character reads come from `ai_tools_read.get_other_character`
(or its underlying `character_archive.read_working` / `read_live`).
NO outbound F-list call.
"""

from __future__ import annotations

import uuid
from typing import Any

import character_archive
import ai_tools_read


COMPOSITE_TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "bulk_set_standard_kinks",
        "description": (
            "Apply many standard-kink assignments in one call. "
            "Use when proposing several at once (saves tool-call "
            "round trips)."
        ),
        "parameters": {
            "type": "object",
            "required": ["assignments", "rationale"],
            "properties": {
                "assignments": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["kink_id", "choice"],
                        "properties": {
                            "kink_id": {"type": "string"},
                            "choice": {
                                "enum": [
                                    "fave", "yes", "maybe", "no", "undecided"
                                ]
                            },
                        },
                    },
                },
                "rationale": {"type": "string", "maxLength": 300},
            },
        },
    },
    {
        "name": "copy_standard_kinks_from",
        "description": (
            "Copy standard-kink bucket assignments from another locally-"
            "archived character. Only differences are emitted; identical "
            "assignments produce no edit."
        ),
        "parameters": {
            "type": "object",
            "required": ["other_character_id", "rationale"],
            "properties": {
                "other_character_id": {"type": "string"},
                "scope": {
                    "enum": ["all", "only_fave_yes"],
                    "description": (
                        "'all' copies every bucket; 'only_fave_yes' "
                        "imports only the source's fave + yes entries "
                        "without changing the rest."
                    ),
                },
                "rationale": {"type": "string", "maxLength": 300},
            },
        },
    },
    {
        "name": "copy_custom_kinks_from",
        "description": (
            "Copy custom kinks from another locally-archived character. "
            "`mode=replace` clears the target's custom kinks first; "
            "`mode=merge` appends only entries the target doesn't "
            "already have (matched by name, case-insensitive)."
        ),
        "parameters": {
            "type": "object",
            "required": ["other_character_id", "mode", "rationale"],
            "properties": {
                "other_character_id": {"type": "string"},
                "mode": {"enum": ["replace", "merge"]},
                "rationale": {"type": "string", "maxLength": 300},
            },
        },
    },
    {
        "name": "copy_infotags_from",
        "description": (
            "Copy specific infotag values from another locally-archived "
            "character. `infotag_ids` is the list of fields to mirror."
        ),
        "parameters": {
            "type": "object",
            "required": ["other_character_id", "infotag_ids", "rationale"],
            "properties": {
                "other_character_id": {"type": "string"},
                "infotag_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "rationale": {"type": "string", "maxLength": 300},
            },
        },
    },
    {
        "name": "clear_all_custom_kinks",
        "description": "Remove every custom kink from the active character.",
        "parameters": {
            "type": "object",
            "required": ["rationale"],
            "properties": {
                "rationale": {"type": "string", "maxLength": 300}
            },
        },
    },
]


def composite_tool_names() -> set[str]:
    return {t["name"] for t in COMPOSITE_TOOL_SCHEMAS}


def fresh_composite_id() -> str:
    """Short, transcript-safe id. Renderer surfaces this as
    `comp-<short>` on the summary card."""
    return f"comp-{uuid.uuid4().hex[:8]}"


# ---- composite implementations --------------------------------------


def bulk_set_standard_kinks(
    assignments: list[dict[str, Any]], rationale: str
) -> list[dict[str, Any]]:
    comp_id = fresh_composite_id()
    edits: list[dict[str, Any]] = []
    for a in assignments:
        kid = a.get("kink_id")
        choice = a.get("choice")
        if not kid or not choice:
            continue
        edits.append(
            {
                "tool": "set_standard_kink",
                "field_path": f"kinks.{kid}",
                "new_value": choice,
                "rationale": rationale,
                "composite_id": comp_id,
            }
        )
    return edits


def copy_standard_kinks_from(
    active_id: str,
    other_id: str,
    scope: str,
    rationale: str,
) -> list[dict[str, Any]]:
    if active_id == other_id:
        raise ValueError("source and target are the same character")
    other = _load_character(other_id, allow_unknown=False)
    active = _load_character(active_id, allow_unknown=False)
    other_kinks = other.get("kinks") if isinstance(other.get("kinks"), dict) else {}
    active_kinks = active.get("kinks") if isinstance(active.get("kinks"), dict) else {}
    comp_id = fresh_composite_id()
    edits: list[dict[str, Any]] = []
    for kid, choice in other_kinks.items():
        if scope == "only_fave_yes" and choice not in {"fave", "yes"}:
            continue
        if active_kinks.get(kid) == choice:
            continue
        edits.append(
            {
                "tool": "set_standard_kink",
                "field_path": f"kinks.{kid}",
                "new_value": choice,
                "rationale": rationale,
                "composite_id": comp_id,
            }
        )
    return edits


def copy_custom_kinks_from(
    active_id: str,
    other_id: str,
    mode: str,
    rationale: str,
) -> list[dict[str, Any]]:
    if active_id == other_id:
        raise ValueError("source and target are the same character")
    if mode not in {"replace", "merge"}:
        raise ValueError(f"invalid mode '{mode}'")
    other = _load_character(other_id, allow_unknown=False)
    active = _load_character(active_id, allow_unknown=False)
    other_ck = other.get("custom_kinks") if isinstance(other.get("custom_kinks"), dict) else {}
    active_ck = active.get("custom_kinks") if isinstance(active.get("custom_kinks"), dict) else {}
    comp_id = fresh_composite_id()
    edits: list[dict[str, Any]] = []

    if mode == "replace":
        for ck_id in active_ck.keys():
            edits.append(
                {
                    "tool": "remove_custom_kink",
                    "field_path": f"custom_kinks.{ck_id}",
                    "rationale": rationale,
                    "composite_id": comp_id,
                }
            )

    existing_names = (
        {
            str(row.get("name", "")).lower()
            for row in active_ck.values()
            if isinstance(row, dict)
        }
        if mode == "merge"
        else set()
    )

    for row in other_ck.values():
        if not isinstance(row, dict):
            continue
        name = row.get("name") or ""
        if mode == "merge" and str(name).lower() in existing_names:
            continue
        edits.append(
            {
                "tool": "add_custom_kink",
                "field_path": "custom_kinks",
                "new_value": {
                    "name": name,
                    "description": row.get("description", ""),
                    "choice": row.get("choice", "undecided"),
                },
                "rationale": rationale,
                "composite_id": comp_id,
            }
        )
    return edits


def copy_infotags_from(
    active_id: str,
    other_id: str,
    infotag_ids: list[str],
    rationale: str,
) -> list[dict[str, Any]]:
    if active_id == other_id:
        raise ValueError("source and target are the same character")
    other = _load_character(other_id, allow_unknown=False)
    active = _load_character(active_id, allow_unknown=False)
    other_tags = other.get("infotags") if isinstance(other.get("infotags"), dict) else {}
    active_tags = active.get("infotags") if isinstance(active.get("infotags"), dict) else {}
    comp_id = fresh_composite_id()
    edits: list[dict[str, Any]] = []
    for tid in infotag_ids:
        value = other_tags.get(str(tid))
        if value is None:
            continue
        if active_tags.get(str(tid)) == value:
            continue
        edits.append(
            {
                "tool": "set_infotag",
                "field_path": f"infotags.{tid}",
                "new_value": str(value),
                "rationale": rationale,
                "composite_id": comp_id,
            }
        )
    return edits


def clear_all_custom_kinks(active_id: str, rationale: str) -> list[dict[str, Any]]:
    active = _load_character(active_id, allow_unknown=False)
    ck = active.get("custom_kinks") if isinstance(active.get("custom_kinks"), dict) else {}
    comp_id = fresh_composite_id()
    return [
        {
            "tool": "remove_custom_kink",
            "field_path": f"custom_kinks.{ck_id}",
            "rationale": rationale,
            "composite_id": comp_id,
        }
        for ck_id in ck.keys()
    ]


def _load_character(char_id: str, *, allow_unknown: bool) -> dict[str, Any]:
    """Read working-or-live for the given local character. Raises
    `LookupError('unknown_local_character')` if the id isn't in the
    registry — matches `ai_tools_read.get_other_character`'s scope
    rule."""
    registry = character_archive.load_registry()
    if char_id not in registry and not allow_unknown:
        raise LookupError("unknown_local_character")
    payload = character_archive.read_working(char_id) or character_archive.read_live(
        char_id
    )
    if payload is None:
        raise LookupError("no_data_for_character")
    return payload


# ---- dispatch -------------------------------------------------------


def execute_composite_tool(
    tool_name: str,
    args: dict[str, Any],
    *,
    active_character_id: str | None,
) -> list[dict[str, Any]]:
    if not active_character_id:
        raise LookupError("no active character")
    rationale = args.get("rationale", "")

    if tool_name == "bulk_set_standard_kinks":
        assignments = args.get("assignments") or []
        return bulk_set_standard_kinks(assignments, rationale)
    if tool_name == "copy_standard_kinks_from":
        other_id = args.get("other_character_id")
        scope = args.get("scope") or "all"
        if not other_id:
            raise LookupError("other_character_id required")
        return copy_standard_kinks_from(
            active_character_id, str(other_id), str(scope), rationale
        )
    if tool_name == "copy_custom_kinks_from":
        other_id = args.get("other_character_id")
        mode = args.get("mode")
        if not other_id or not mode:
            raise LookupError("other_character_id + mode required")
        return copy_custom_kinks_from(
            active_character_id, str(other_id), str(mode), rationale
        )
    if tool_name == "copy_infotags_from":
        other_id = args.get("other_character_id")
        infotag_ids = args.get("infotag_ids") or []
        if not other_id:
            raise LookupError("other_character_id required")
        return copy_infotags_from(
            active_character_id, str(other_id), [str(x) for x in infotag_ids], rationale
        )
    if tool_name == "clear_all_custom_kinks":
        return clear_all_custom_kinks(active_character_id, rationale)
    raise LookupError(f"unknown composite tool '{tool_name}'")
