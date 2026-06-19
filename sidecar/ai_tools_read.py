"""Read-side tools the assistant can call.

Six function tools that let the model fetch character data without
proposing any edits. Every read is local-archive-scoped — the
assistant never makes an outbound F-list call. Designed so the chat
endpoint (PR 3) can register the schemas, dispatch by name, and pass
the args dict straight to `execute_read_tool`.

Compressed shape
----------------
`get_active_character` / `get_other_character` return a compressed
view of the working copy by default (gallery as `[image_ids]`, kinks
bucketed as `{fave: [ids], yes: [ids], …}` rather than `{id: choice}`)
so a typical prompt doesn't pay for 559 standard-kink entries it
won't actually consult. Callers asking for `fields=["kinks.raw"]` or
`fields=["images.full"]` opt into the verbose form.

This module is deliberately thin: it does not validate edits (PR 1)
and does not write working copies (PR 1's `accept_edits`). It is
pure data extraction with sensible defaults.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
import json
import zipfile

import character_archive


READ_TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "get_active_character",
        "description": (
            "Return the active character's working copy. "
            "Without `fields`, returns a compressed shape "
            "(kinks bucketed, gallery as ids)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "fields": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Optional fine-grained selection. Accepts dotted "
                        "field_paths plus the special 'kinks.raw' and "
                        "'images.full' to unpack the compressed shape."
                    ),
                }
            },
        },
    },
    {
        "name": "list_my_characters",
        "description": (
            "List every character archived locally. Use the returned "
            "ids when calling get_other_character / copy_* tools."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "get_other_character",
        "description": (
            "Return the working copy (or Live snapshot fallback) of "
            "another character in the local archive. Errors if id is "
            "not local — no F-list lookup is performed."
        ),
        "parameters": {
            "type": "object",
            "required": ["character_id"],
            "properties": {
                "character_id": {"type": "string"},
                "fields": {
                    "type": "array",
                    "items": {"type": "string"},
                },
            },
        },
    },
    {
        "name": "list_backups",
        "description": (
            "List ZIP backups for a character (defaults to active)."
        ),
        "parameters": {
            "type": "object",
            "properties": {"character_id": {"type": "string"}},
        },
    },
    {
        "name": "get_backup_field",
        "description": (
            "Read one field out of a backup ZIP without unpacking the "
            "rest. `field_path` is a dotted path against working.json."
        ),
        "parameters": {
            "type": "object",
            "required": ["filename", "field_path"],
            "properties": {
                "character_id": {"type": "string"},
                "filename": {"type": "string"},
                "field_path": {"type": "string"},
            },
        },
    },
    {
        "name": "get_mapping_list_options",
        "description": (
            "Return the listitem options for a specific infotag id. Use "
            "when the model needs to know what labels are valid for, "
            "say, Species or Language."
        ),
        "parameters": {
            "type": "object",
            "required": ["infotag_id"],
            "properties": {"infotag_id": {"type": "string"}},
        },
    },
]


def read_tool_names() -> set[str]:
    return {t["name"] for t in READ_TOOL_SCHEMAS}


# ---- read-tool implementations --------------------------------------


def get_active_character(
    active_character_id: str,
    fields: list[str] | None = None,
) -> dict[str, Any]:
    payload = character_archive.read_working(active_character_id)
    if payload is None:
        # Fall back to live if there's no working copy yet — assistant
        # can still ground itself for inspection prompts.
        live = character_archive.read_live(active_character_id)
        if live is None:
            raise LookupError("no working copy or live snapshot on disk")
        payload = live
    return _shape_character_payload(payload, fields)


def list_my_characters() -> list[dict[str, Any]]:
    """Walk the registry + backup index. Each row carries enough info
    for the model to pick a target without follow-up calls."""
    out: list[dict[str, Any]] = []
    registry = character_archive.load_registry()
    for char_id, meta in registry.items():
        backups = character_archive.list_zip_backups(char_id)
        last = backups[0] if backups else None
        out.append(
            {
                "id": char_id,
                "name": meta.get("name") or "",
                "has_working_copy": character_archive.working_path(char_id).exists(),
                "last_backup_at": (last or {}).get("created_at"),
                "backup_count": len(backups),
            }
        )
    out.sort(key=lambda r: r["name"].lower())
    return out


def get_other_character(
    character_id: str,
    *,
    fields: list[str] | None = None,
) -> dict[str, Any]:
    """Same shape as `get_active_character`, but explicit-id and
    refuses unknown locals. Critically: NO F-list call ever — if the
    user hasn't archived the character locally, the model gets an
    error and learns to ask the user to archive it first."""
    registry = character_archive.load_registry()
    if character_id not in registry:
        raise LookupError("unknown_local_character")
    payload = character_archive.read_working(character_id)
    if payload is None:
        payload = character_archive.read_live(character_id)
    if payload is None:
        raise LookupError("no_data_for_character")
    return _shape_character_payload(payload, fields)


def list_backups(character_id: str) -> list[dict[str, Any]]:
    rows = character_archive.list_zip_backups(character_id)
    # Keep the shape close to what the renderer's BackupsList consumes
    # already so the model sees a familiar payload.
    return [
        {
            "filename": r.get("filename"),
            "kind": r.get("kind"),
            "name": r.get("name"),
            "created_at": r.get("created_at"),
            "size_bytes": r.get("size_bytes"),
        }
        for r in rows
    ]


def get_backup_field(
    character_id: str, filename: str, field_path: str
) -> Any:
    """Cheap targeted read — opens the ZIP, extracts only
    working.json, walks the path. Doesn't load images or other
    auxiliary files."""
    backups_path = character_archive.backups_dir(character_id) / filename
    if not backups_path.exists():
        raise LookupError("backup not found")
    try:
        with zipfile.ZipFile(backups_path) as zf:
            # Prefer working.json (working-copy form); fall back to
            # the older live.json shape some backups carried.
            for candidate in ("working.json", "live.json"):
                try:
                    raw = zf.read(candidate).decode("utf-8")
                    break
                except KeyError:
                    continue
            else:
                raise LookupError("no character payload inside backup ZIP")
    except zipfile.BadZipFile as exc:
        raise LookupError("backup ZIP is corrupt") from exc
    payload = json.loads(raw)
    return _read_path(payload, field_path)


def get_mapping_list_options(
    infotag_id: str, mapping_list: dict[str, Any]
) -> list[dict[str, Any]]:
    infotags = mapping_list.get("infotags")
    entry: dict[str, Any] | None = None
    if isinstance(infotags, dict):
        candidate = infotags.get(str(infotag_id))
        if isinstance(candidate, dict):
            entry = candidate
    elif isinstance(infotags, list):
        for it in infotags:
            if isinstance(it, dict) and str(it.get("id")) == str(infotag_id):
                entry = it
                break
    if entry is None:
        return []
    listitems = entry.get("list") or entry.get("listitems") or []
    return [
        {"listitem_id": str(li.get("id")), "label": str(li.get("name", ""))}
        for li in listitems
        if isinstance(li, dict)
    ]


# ---- shape helpers ---------------------------------------------------


_COMPRESS_KINKS_MARKER = "kinks.raw"
_COMPRESS_IMAGES_MARKER = "images.full"


def _shape_character_payload(
    payload: dict[str, Any], fields: list[str] | None
) -> dict[str, Any]:
    """Return either a `fields`-projected slice or the compressed shape.

    A `fields` array is treated as a selector: only the requested
    dotted paths are returned. Two magic strings — `kinks.raw` and
    `images.full` — opt those collections out of the compression
    default while still letting the model request `character.description`
    + others alongside.
    """
    if not fields:
        return _compressed(payload)

    want_kinks_raw = _COMPRESS_KINKS_MARKER in fields
    want_images_full = _COMPRESS_IMAGES_MARKER in fields
    out: dict[str, Any] = {}
    for path in fields:
        if path in (_COMPRESS_KINKS_MARKER, _COMPRESS_IMAGES_MARKER):
            continue
        val = _read_path(payload, path)
        if val is not None:
            _write_path(out, path, val)

    if want_kinks_raw:
        kinks = payload.get("kinks")
        if isinstance(kinks, dict):
            out["kinks"] = dict(kinks)
    if want_images_full:
        images = payload.get("images")
        if isinstance(images, list):
            out["images"] = list(images)
    return out


def _compressed(payload: dict[str, Any]) -> dict[str, Any]:
    """The default low-token view. Bucket kinks, strip gallery entries
    down to image_ids, keep description + infotags + custom_kinks +
    settings at full fidelity. Tag with `_compressed: True` so the
    model can tell at a glance which shape it has."""
    out: dict[str, Any] = {"_compressed": True}
    if isinstance(payload.get("character"), dict):
        out["character"] = dict(payload["character"])
    for key in ("infotags", "settings", "custom_kinks", "_custom_kinks_order"):
        if key in payload:
            out[key] = payload[key]
    kinks = payload.get("kinks") or {}
    buckets: dict[str, list[str]] = {
        "fave": [], "yes": [], "maybe": [], "no": [], "undecided": []
    }
    if isinstance(kinks, dict):
        for kid, choice in kinks.items():
            if choice in buckets:
                buckets[choice].append(str(kid))
    out["kinks"] = buckets
    images = payload.get("images") or []
    if isinstance(images, list):
        out["images"] = [
            str(e.get("image_id"))
            for e in images
            if isinstance(e, dict) and e.get("image_id") is not None
        ]
    return out


def _read_path(payload: dict[str, Any], path: str) -> Any:
    cur: Any = payload
    for seg in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(seg)
    return cur


def _write_path(payload: dict[str, Any], path: str, value: Any) -> None:
    parts = path.split(".")
    cur = payload
    for seg in parts[:-1]:
        nxt = cur.get(seg)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[seg] = nxt
        cur = nxt
    cur[parts[-1]] = value


# ---- dispatch -------------------------------------------------------


def execute_read_tool(
    tool_name: str,
    args: dict[str, Any],
    *,
    active_character_id: str | None,
    mapping_list: dict[str, Any],
) -> Any:
    """Single entry point the chat endpoint calls. Returns plain
    Python; the caller serialises to JSON for the model.

    `active_character_id` is the chip-selected character context; tools
    that don't need it (e.g. `list_my_characters`) ignore it.
    """
    if tool_name == "get_active_character":
        if not active_character_id:
            raise LookupError("no active character")
        return get_active_character(active_character_id, fields=args.get("fields"))
    if tool_name == "list_my_characters":
        return list_my_characters()
    if tool_name == "get_other_character":
        cid = args.get("character_id")
        if not cid:
            raise LookupError("character_id required")
        return get_other_character(str(cid), fields=args.get("fields"))
    if tool_name == "list_backups":
        cid = args.get("character_id") or active_character_id
        if not cid:
            raise LookupError("character_id required")
        return list_backups(str(cid))
    if tool_name == "get_backup_field":
        cid = args.get("character_id") or active_character_id
        if not cid:
            raise LookupError("character_id required")
        filename = args.get("filename")
        field_path = args.get("field_path")
        if not filename or not field_path:
            raise LookupError("filename + field_path required")
        return get_backup_field(str(cid), str(filename), str(field_path))
    if tool_name == "get_mapping_list_options":
        infotag_id = args.get("infotag_id")
        if not infotag_id:
            raise LookupError("infotag_id required")
        return get_mapping_list_options(str(infotag_id), mapping_list)
    raise LookupError(f"unknown read tool '{tool_name}'")
