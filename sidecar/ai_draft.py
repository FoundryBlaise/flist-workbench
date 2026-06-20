"""On-disk store for AI-assistant edit proposals.

Each character carries at most one draft at
`<archive>/characters/<id>/ai-draft.json`. The draft is a journal of
proposed edits the model has emitted via tool calls; the user reviews
each as a diff card and accepts or rejects. Accepting routes the edits
through the same `write_working` code path a manual edit would use, so
`If-Match` etag semantics + Tier-2 overlay handling are unchanged.

Draft shape (`schema_version: 1`):

    {
      "schema_version": 1,
      "base_etag": "<sha256 of working.json at first append>",
      "base_working_schema_version": <int>,
      "created_at": "ISO-8601 UTC",
      "updated_at": "ISO-8601 UTC",
      "model_endpoint": "...",
      "model_id": "...",
      "edits": [<canonical-edit>, ...]
    }

Each `<canonical-edit>` is the dict `ai_draft_validate.validate_edit`
returned with `status` ('pending'|'stale'), `id` (incrementing per
draft), and metadata.

Design notes
------------
- One draft per character, one slot. Starting a new conversation while
  a draft exists is the caller's policy decision (the chat endpoint
  prompts the user to discard); this module just exposes the state.
- `append_edits` validates each input edit and returns a result envelope
  with `accepted_edit_ids`, `rejected`, and the canonical persisted
  edits. Rejected reasons flow back through the chat transcript so the
  model can self-correct.
- `accept_edits` applies a chosen subset of pending edits to
  `working.json` under a single `If-Match` write — all-or-nothing. On
  EtagMismatch the draft stays as-is and the caller surfaces the
  existing "another window saved" flow.
- `reject_edits` and `delete_draft` are pure on-disk mutations; they
  never touch the working copy.
"""

from __future__ import annotations

import copy
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import character_archive
import ai_draft_validate

DRAFT_FILENAME = "ai-draft.json"
DRAFT_SCHEMA_VERSION = 1


def _resolve_editable_slot(
    character_id: int | str,
) -> tuple[dict[str, Any] | None, str | None, str | None]:
    """Return `(payload, etag, set_id)` for the slot the assistant
    should read + write against.

    Honors working-sets v2: when an active set id is registered for
    this character, that set's payload is the editable slot. Falls
    back to the legacy `working.json` slot for characters that
    haven't been migrated to v2 yet.

    `set_id` is None when the fallback slot is in use; callers use
    that as the routing signal for write_back.
    """
    set_id = character_archive.read_active_set_id(character_id)
    if set_id:
        payload = character_archive.read_set_payload(character_id, set_id)
        etag = character_archive.set_payload_etag(character_id, set_id)
        return payload, etag, set_id
    payload = character_archive.read_working(character_id)
    etag = character_archive.working_etag(character_id)
    return payload, etag, None


def _write_editable_slot(
    character_id: int | str,
    set_id: str | None,
    payload: dict[str, Any],
    *,
    expected_etag: str | None,
) -> str:
    """Persist to the right backing store for the current editable slot.
    Raises `character_archive.EtagMismatch` on a stale `expected_etag`
    in both paths — the assistant chat layer maps that to the same
    409 the working-copy PUT uses."""
    if set_id:
        return character_archive.write_set_payload(
            character_id, set_id, payload, expected_etag=expected_etag
        )
    return character_archive.write_working(
        character_id, payload, expected_etag=expected_etag
    )
# Hard ceiling on total edits a single draft may carry. A runaway tool
# loop (model keeps emitting tool calls until MAX_TOOL_ROUNDS) combined
# with composite tools (bulk_set_standard_kinks across 559 entries) can
# rapidly inflate the journal otherwise. Real review sessions should
# never breach this; the renderer is unusable past ~150 cards anyway.
MAX_EDITS_PER_DRAFT = 500


# ---- on-disk path helpers --------------------------------------------


def draft_path(character_id: int | str) -> Path:
    """Per-character location of `ai-draft.json`. Mirrors the
    `working_path` convention so all the per-character state lives
    side-by-side."""
    return character_archive.character_dir(character_id) / DRAFT_FILENAME


def read_draft(character_id: int | str) -> dict[str, Any] | None:
    """Load the draft from disk, or None if absent / malformed.

    Malformed files are renamed `.corrupt-<unix>` rather than deleted
    so the user keeps the bytes for forensics — same disposition as
    `read_working`. Future-version drafts are refused (kept on disk
    but treated as absent), mirroring `read_working`'s newer-version
    guard so a downgrade doesn't half-misinterpret an upgraded shape.
    """
    p = draft_path(character_id)
    if not p.exists():
        return None
    try:
        raw = p.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        payload = json.loads(raw)
    except ValueError:
        try:
            p.rename(p.with_name(f"{p.name}.corrupt-{int(time.time())}"))
        except OSError:
            pass
        return None
    if not isinstance(payload, dict):
        return None
    version = payload.get("schema_version")
    if isinstance(version, int) and version > DRAFT_SCHEMA_VERSION:
        print(
            f"[ai_draft] refusing to load ai-draft.json v{version} "
            f"(this build understands up to v{DRAFT_SCHEMA_VERSION}); "
            f"upgrade Workbench",
            flush=True,
        )
        return None
    return payload


def write_draft(character_id: int | str, draft: dict[str, Any]) -> None:
    """Persist atomically. The `_atomic_write_json` helper lives on
    character_archive and is already exercised by the working-copy
    write path, so we reuse it rather than redoing the temp+rename
    dance here."""
    p = draft_path(character_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    character_archive._atomic_write_json(p, draft)


def delete_draft(character_id: int | str) -> bool:
    """Idempotent — returns True iff the file existed and was removed."""
    p = draft_path(character_id)
    try:
        p.unlink()
        return True
    except FileNotFoundError:
        return False


def delete_all_drafts() -> int:
    """Walk every locally-archived character and remove their pending
    `ai-draft.json`. Returns the count actually deleted. Used by the
    Settings → Disable AI Assistant cleanup button so flipping the
    master toggle off really does evict every draft, not just the
    active character's.
    """
    registry = character_archive.load_registry()
    removed = 0
    for char_id in registry:
        if delete_draft(char_id):
            removed += 1
    return removed


# ---- mutation pipeline -----------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _empty_draft(
    character_id: int | str,
    *,
    model_endpoint: str = "",
    model_id: str = "",
    base_etag: str | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": DRAFT_SCHEMA_VERSION,
        "base_etag": base_etag,
        "base_working_schema_version": character_archive.WORKING_SCHEMA_VERSION,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "model_endpoint": model_endpoint,
        "model_id": model_id,
        "edits": [],
        # Monotonic counter — survives rejects so two appends never
        # collide on id even after the middle was removed. Counting
        # via len(edits) was wrong: rejecting edit-002 from a list of
        # three left the next id at edit-003, colliding with the still
        # -present edit-003.
        "next_edit_seq": 1,
    }


def _next_edit_id(draft: dict[str, Any]) -> str:
    """Monotonic per-draft id. Starts at 1; format `edit-001`.

    Reads `next_edit_seq` and bumps it in-place on the draft, so the
    caller doesn't need a second update. Legacy drafts written before
    the counter existed seed from `len(edits)+1` once."""
    seq = draft.get("next_edit_seq")
    if not isinstance(seq, int) or seq < 1:
        seq = len(draft.get("edits") or []) + 1
    draft["next_edit_seq"] = seq + 1
    return f"edit-{seq:03d}"


def append_edits(
    character_id: int | str,
    new_edits: list[dict[str, Any]],
    mapping_list: dict[str, Any],
    *,
    model_endpoint: str = "",
    model_id: str = "",
) -> dict[str, Any]:
    """Validate + persist a batch of proposed edits.

    Returns an envelope:

        {
          "draft": <full draft after append>,
          "accepted_edit_ids": [<id>, ...],
          "rejected": [{"input": <original>, "reason": "...", "message": "..."}],
        }

    The original input is echoed in `rejected` so the model can see
    what it sent next to the reason for failure.

    The first call for a character creates the draft and stamps
    `base_etag` from the current `working.json`. Subsequent appends
    on a still-current draft leave `base_etag` alone. If the working
    etag has moved since `base_etag`, edits are marked `stale` on
    persist — the chat UI will surface the staleness so the user can
    re-prompt or discard.
    """
    working, current_etag, _set_id = _resolve_editable_slot(character_id)
    if working is None:
        return {
            "draft": None,
            "accepted_edit_ids": [],
            "rejected": [
                {"input": e, "reason": "no_working_copy",
                 "message": "no working copy on disk yet"}
                for e in new_edits
            ],
        }
    allowlist = ai_draft_validate.generate_allowlist(mapping_list)

    draft = read_draft(character_id)
    if draft is None:
        draft = _empty_draft(
            character_id,
            model_endpoint=model_endpoint,
            model_id=model_id,
            base_etag=current_etag,
        )

    is_stale_base = (
        draft.get("base_etag") is not None
        and current_etag is not None
        and draft["base_etag"] != current_etag
    )
    # When the working copy moved under us, every still-pending edit
    # in the draft now anchors on a stale snapshot too — not just the
    # incoming batch. Re-stamp them so the accept path's status filter
    # catches them and the UI surfaces the staleness on every card.
    if is_stale_base:
        for existing in draft.get("edits") or []:
            if existing.get("status") == "pending":
                existing["status"] = "stale"

    accepted: list[str] = []
    rejected: list[dict[str, Any]] = []
    existing_count = len(draft.get("edits") or [])
    capacity = MAX_EDITS_PER_DRAFT - existing_count
    for edit in new_edits:
        if is_stale_base:
            # Refuse new edits while the base is stale. The draft is
            # anchored on a working state the model never saw; letting
            # any more edits accumulate would silently grow a journal
            # the user can't safely accept. Surface in `rejected` so
            # the model sees the failure and can ask the user to
            # discard before re-prompting.
            rejected.append(
                {
                    "input": edit,
                    "reason": "stale_base",
                    "message": (
                        "working copy changed since draft was opened; "
                        "discard the draft and re-prompt before adding more edits"
                    ),
                }
            )
            continue
        if capacity <= 0:
            rejected.append(
                {
                    "input": edit,
                    "reason": "draft_full",
                    "message": (
                        f"draft already carries {MAX_EDITS_PER_DRAFT} edits; "
                        f"accept or reject some before adding more"
                    ),
                }
            )
            continue
        result = ai_draft_validate.validate_edit(
            edit, working, allowlist, mapping_list, character_id=character_id
        )
        if not result.ok:
            rejected.append(
                {"input": edit, "reason": result.reason, "message": result.message}
            )
            continue
        canonical = dict(result.edit or {})
        canonical["id"] = _next_edit_id(draft)
        canonical["status"] = "pending"
        canonical["created_at"] = _now_iso()
        draft.setdefault("edits", []).append(canonical)
        accepted.append(canonical["id"])
        capacity -= 1

    draft["updated_at"] = _now_iso()
    if model_endpoint:
        draft["model_endpoint"] = model_endpoint
    if model_id:
        draft["model_id"] = model_id
    write_draft(character_id, draft)
    return {"draft": draft, "accepted_edit_ids": accepted, "rejected": rejected}


def reject_edits(
    character_id: int | str, edit_ids: Iterable[str]
) -> dict[str, Any] | None:
    """Remove the given edit ids from the draft. Returns the updated
    draft, or None if no draft on disk. If removing leaves the draft
    empty the file is deleted (matches the renderer's "no draft" UX —
    an empty draft and no draft are the same thing)."""
    draft = read_draft(character_id)
    if draft is None:
        return None
    targets = set(edit_ids)
    draft["edits"] = [e for e in draft.get("edits") or [] if e.get("id") not in targets]
    draft["updated_at"] = _now_iso()
    if not draft["edits"]:
        delete_draft(character_id)
        return draft
    write_draft(character_id, draft)
    return draft


def accept_edits(
    character_id: int | str,
    edit_ids: Iterable[str],
    if_match: str | None,
) -> dict[str, Any]:
    """Apply the given edit ids to `working.json` and prune them from
    the draft.

    Returns:

        {
          "applied_edit_ids": [...],
          "new_etag": "<sha256>",
          "draft": <remaining draft or None>,
        }

    Raises `character_archive.EtagMismatch` on a stale `if_match`. The
    draft is untouched on mismatch so the renderer can recover via the
    existing reload flow.

    All edits apply or none do — partial commits would split the
    user's expectation in confusing ways. Build the new payload in
    memory, write once.
    """
    draft = read_draft(character_id)
    if draft is None:
        return {"applied_edit_ids": [], "new_etag": None, "draft": None}
    working, current_etag, set_id = _resolve_editable_slot(character_id)
    if working is None:
        raise ValueError("no working copy to apply edits onto")

    targets = list(edit_ids)
    target_set = set(targets)
    # Filter to actually-pending edits. Stale entries name a working
    # state the model never saw, so accepting them would silently
    # apply the model's intent against a different baseline. Surface
    # them in the response so the renderer can re-prompt or discard
    # rather than re-issuing the same accept.
    candidates = [e for e in draft.get("edits") or [] if e.get("id") in target_set]
    pending = [e for e in candidates if e.get("status") == "pending"]
    skipped_stale = [e.get("id") for e in candidates if e.get("status") == "stale"]
    if not pending:
        return {
            "applied_edit_ids": [],
            "new_etag": current_etag,
            "draft": draft,
            "skipped_stale": skipped_stale,
        }

    # Sort so collection-level edits apply in a deterministic order;
    # the only ordering constraint right now is that gallery reorder
    # runs after image add/remove on the same draft.
    pending.sort(key=_apply_priority)

    new_payload = copy.deepcopy(working)
    overlay: set[str] = set(new_payload.get("_overlay") or [])
    for edit in pending:
        _apply_edit(new_payload, edit, overlay)
    new_payload["_overlay"] = sorted(overlay)

    new_etag = _write_editable_slot(
        character_id, set_id, new_payload, expected_etag=if_match
    )

    # Prune accepted edits from the draft. Skipped-stale entries
    # stay so the user can review them; the renderer surfaces them
    # via the skipped_stale field.
    applied_ids = {e["id"] for e in pending}
    draft["edits"] = [e for e in draft.get("edits") or [] if e.get("id") not in applied_ids]
    draft["updated_at"] = _now_iso()
    if not draft["edits"]:
        delete_draft(character_id)
        return {
            "applied_edit_ids": list(applied_ids),
            "new_etag": new_etag,
            "draft": None,
            "skipped_stale": skipped_stale,
        }
    # base_etag follows the working copy forward after a successful
    # write so subsequent appends don't immediately mark themselves
    # stale.
    draft["base_etag"] = new_etag
    write_draft(character_id, draft)
    return {
        "applied_edit_ids": list(applied_ids),
        "new_etag": new_etag,
        "draft": draft,
        "skipped_stale": skipped_stale,
    }


# ---- application internals ------------------------------------------


def _apply_priority(edit: dict[str, Any]) -> tuple[int, str]:
    """Reorder happens last so the model can say "add A, remove B,
    then reorder remaining" without us caring about list-state mid-batch."""
    if edit.get("tool") == "reorder_gallery":
        return (2, edit.get("id", ""))
    if edit.get("tool") in {"add_image_to_gallery", "remove_image_from_gallery"}:
        return (1, edit.get("id", ""))
    return (0, edit.get("id", ""))


def _apply_edit(
    payload: dict[str, Any],
    edit: dict[str, Any],
    overlay: set[str],
) -> None:
    """Mutate `payload` in-place for one edit. Caller already vetted
    the shape via `validate_edit`, so we can dispatch on `tool` without
    re-validating. Overlay tracking mirrors how the renderer tags
    locally-edited fields for drift detection.
    """
    tool = edit.get("tool")
    field_path = edit.get("field_path") or ""

    if tool in {"set_infotag", "clear_infotag"}:
        infotags = payload.setdefault("infotags", {})
        if not isinstance(infotags, dict):
            infotags = {}
            payload["infotags"] = infotags
        tid = field_path.removeprefix("infotags.")
        if tool == "clear_infotag":
            infotags.pop(tid, None)
        else:
            infotags[tid] = edit.get("new_value")
        overlay.add(field_path)
        return

    if tool == "replace_description":
        character = payload.setdefault("character", {})
        if not isinstance(character, dict):
            character = {}
            payload["character"] = character
        character["description"] = edit.get("new_value", "")
        overlay.add(field_path)
        return

    if tool == "patch_description":
        # field_path may be `character.description` (the historical
        # default) OR `custom_kinks.<id>.description` when the
        # validator auto-discovered that the model's quote lived in
        # a custom kink. Walk the dotted path generically so both
        # surfaces work without duplicating the splice logic.
        old_excerpt = edit.get("old_excerpt") or ""
        new_value = edit.get("new_value") or ""
        current = _read_path_for_patch(payload, field_path)
        anchor_start = edit.get("anchor_start")
        anchor_end = edit.get("anchor_end")
        if not isinstance(current, str):
            return
        if (
            isinstance(anchor_start, int)
            and isinstance(anchor_end, int)
            and 0 <= anchor_start < anchor_end <= len(current)
        ):
            patched = current[:anchor_start] + new_value + current[anchor_end:]
            _write_path_for_patch(payload, field_path, patched)
            overlay.add(field_path)
        elif old_excerpt and old_excerpt in current:
            # Backstop for legacy draft edits written before
            # anchor_end was added — still safe (literal substring,
            # first occurrence).
            patched = current.replace(old_excerpt, new_value, 1)
            _write_path_for_patch(payload, field_path, patched)
            overlay.add(field_path)
        # No-op if neither path matches: the working copy drifted
        # between validate and apply (a stale edit slipped through).
        # Better to silently leave the field intact than risk a
        # whole-body clobber.
        return

    if tool == "set_custom_kink":
        ck = payload.setdefault("custom_kinks", {})
        if not isinstance(ck, dict):
            ck = {}
            payload["custom_kinks"] = ck
        parts = field_path.split(".")
        if len(parts) != 3:
            return
        _, ck_id, attr = parts
        row = ck.setdefault(ck_id, {})
        if not isinstance(row, dict):
            row = {}
            ck[ck_id] = row
        row[attr] = edit.get("new_value")
        overlay.add(field_path)
        return

    if tool == "add_custom_kink":
        ck = payload.setdefault("custom_kinks", {})
        order = payload.setdefault("_custom_kinks_order", [])
        if not isinstance(ck, dict):
            ck = {}
            payload["custom_kinks"] = ck
        if not isinstance(order, list):
            order = []
            payload["_custom_kinks_order"] = order
        # Synthesise a negative id so it can't collide with F-list ids;
        # F-list assigns positive ids on restore. The userscript will
        # remap on round-trip.
        next_id = _next_negative_id(ck)
        ck[str(next_id)] = dict(edit.get("new_value") or {})
        order.append(str(next_id))
        overlay.add(f"custom_kinks.{next_id}")
        return

    if tool == "remove_custom_kink":
        ck = payload.setdefault("custom_kinks", {})
        order = payload.get("_custom_kinks_order")
        if not isinstance(ck, dict):
            return
        parts = field_path.split(".")
        if len(parts) != 2:
            return
        ck_id = parts[1]
        ck.pop(ck_id, None)
        if isinstance(order, list):
            payload["_custom_kinks_order"] = [x for x in order if x != ck_id]
        overlay.add(field_path)
        return

    if tool == "set_standard_kink":
        kinks = payload.setdefault("kinks", {})
        if not isinstance(kinks, dict):
            kinks = {}
            payload["kinks"] = kinks
        kink_id = field_path.removeprefix("kinks.")
        kinks[kink_id] = edit.get("new_value")
        overlay.add(field_path)
        return

    if tool == "set_character_setting":
        settings = payload.setdefault("settings", {})
        if not isinstance(settings, dict):
            settings = {}
            payload["settings"] = settings
        key = field_path.removeprefix("settings.")
        settings[key] = edit.get("new_value")
        overlay.add(field_path)
        return

    if tool == "add_image_to_gallery":
        gallery = payload.setdefault("images", [])
        if not isinstance(gallery, list):
            gallery = []
            payload["images"] = gallery
        image_id = edit.get("new_value")
        next_sort = max((int(e.get("sort_order", 0)) for e in gallery if isinstance(e, dict)), default=-1) + 1
        gallery.append({"image_id": image_id, "description": "", "sort_order": next_sort})
        overlay.add("images")
        return

    if tool == "remove_image_from_gallery":
        gallery = payload.get("images")
        if isinstance(gallery, list):
            image_id = edit.get("old_value") or edit.get("new_value")
            payload["images"] = [
                e for e in gallery
                if not (isinstance(e, dict) and str(e.get("image_id")) == image_id)
            ]
        overlay.add("images")
        return

    if tool == "reorder_gallery":
        gallery = payload.get("images") or []
        new_order = edit.get("new_value") or []
        if isinstance(gallery, list):
            lookup = {
                str(e.get("image_id")): e
                for e in gallery
                if isinstance(e, dict) and e.get("image_id") is not None
            }
            reordered: list[dict[str, Any]] = []
            for idx, image_id in enumerate(new_order):
                entry = lookup.get(str(image_id))
                if entry is not None:
                    entry = dict(entry)
                    entry["sort_order"] = idx
                    reordered.append(entry)
            payload["images"] = reordered
        overlay.add("images")
        return


def _read_path_for_patch(payload: dict[str, Any], path: str) -> Any:
    """Walk a dotted path into the working payload to read a string-
    valued leaf. Mirrors the validator's traversal so patch_description
    can address either `character.description` or
    `custom_kinks.<id>.description`."""
    cur: Any = payload
    for seg in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(seg)
    return cur


def _write_path_for_patch(payload: dict[str, Any], path: str, value: str) -> None:
    """Walk a dotted path and assign `value` at the leaf, creating
    intermediate dicts as needed. Used by patch_description's apply
    step so the new value lands at the same path the validator
    confirmed the anchor in."""
    parts = path.split(".")
    cur = payload
    for seg in parts[:-1]:
        nxt = cur.get(seg)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[seg] = nxt
        cur = nxt
    cur[parts[-1]] = value


def _next_negative_id(custom_kinks: dict[str, Any]) -> int:
    """Assign a fresh negative id for a newly-added custom kink.

    F-list uses positive ids for server-stored kinks; the userscript's
    restore flow remaps negatives on first POST. Picking the lowest
    existing negative id minus one keeps things stable across batches
    in the same draft.
    """
    smallest = 0
    for k in custom_kinks.keys():
        try:
            n = int(k)
        except (TypeError, ValueError):
            continue
        if n < smallest:
            smallest = n
    return smallest - 1
