"""Labels: counts, clearing, filling and overriding.

Every route parses, calls the Labels service (`services/labels.py`)
and shapes its answer; MCP's classification and Log tools call the
same service. Clearing moves the Labels to the Trash; the Trash routes
are in `images_trash`.
"""

from fastapi import APIRouter
from pydantic import BaseModel

from services import labels as label_service

router = APIRouter()


@router.get("/labels/stats")
def labels_stats(char: str, partner: str) -> dict:
    return {
        "character": char,
        "partner": partner,
        **label_service.conversation_stats(char, partner),
    }


@router.get("/labels/stats-all")
def labels_stats_all(char: str) -> dict:
    """Batch labels stats for every partner of a character.

    The sidebar uses this to render per-partner coverage pips without
    firing one request per row. Reuses the same counts as
    /labels/stats so a partner's per-row counts always match the
    detailed view. Linked aliases are folded into their primary partner.

    Each row also returns `log_mtime` (latest of all alias-group log
    files) and `last_label_at` (newest labels.updated_at across the
    same alias group). A stale partner is one where log_mtime >
    last_label_at — log activity arrived after the last classify run
    for that conversation.
    """
    return {"character": char, "partners": label_service.character_stats(char)}


# `character` and `partner` in the override and delete bodies name the
# conversation the window shows; a Label belongs to the message (ADR
# 0004), so they decide nothing and are only echoed back.
class LabelOverride(BaseModel):
    character: str
    partner: str
    hash: str
    ts: int
    speaker: str
    # label=None / missing deletes the row (revert to rule / Unlabeled).
    label: str | None = None


class LabelOverrideItem(BaseModel):
    hash: str
    ts: int
    speaker: str


class LabelOverrideMany(BaseModel):
    character: str
    partner: str
    items: list[LabelOverrideItem]
    # label=None deletes the rows (revert to rule / Unlabeled).
    label: str | None = None


class LabelsClearRequest(BaseModel):
    character: str
    partner: str


@router.post("/labels/clear")
def labels_clear(body: LabelsClearRequest) -> dict:
    """Delete every label (LLM + manual) for one conversation.

    Used by the renderer's "Reset all labels" context-menu action.
    After this returns, the resolver falls back to rule-on-read for
    every message in that conversation. The cleared Labels go to the
    character's Trash first (`trash_id`), where Restore puts them back.
    """
    cleared = label_service.clear(body.character, body.partner)
    return {
        "character": body.character,
        "partner": body.partner,
        "deleted": cleared["deleted"],
        "trash_id": cleared["trash_id"],
    }


@router.post("/labels/clear-all")
def labels_clear_all() -> dict:
    """Wipe every stored IC/OOC verdict across all characters.

    The Settings → Labels "Reset all labels…" button calls this. After
    it returns, every message in every conversation falls back to
    rule-on-read — manual overrides are gone too. The cleared Labels go
    to the Trash first, one entry per character whose Logs hold the
    messages and one, with no character, for messages in none of the
    Logs; the renderer still confirms before invoking this.
    """
    cleared = label_service.clear_all()
    return {"labels_deleted": cleared["deleted"], "trash_ids": cleared["trash_ids"]}


@router.get("/labels/rollup")
def labels_rollup() -> dict:
    """Aggregate IC/OOC/Unlabeled counts across every character.

    Walks every (character × partner) log under the configured data
    directory; for large corpora this is a few seconds the first time
    Settings opens. Used by the Labels rollup pane to show one-glance
    state ("3,402 IC · 18,720 OOC · …").
    """
    return label_service.rollup()


class LabelsFillUnlabeled(BaseModel):
    character: str
    partner: str
    label: str


class LabelsDeleteHashes(BaseModel):
    character: str
    partner: str
    hashes: list[str]


@router.post("/labels/fill-unlabeled")
def labels_fill_unlabeled(body: LabelsFillUnlabeled) -> dict:
    """Give every still-Unlabeled message in one conversation the same
    verdict.

    For a conversation the user knows is pure IC (or pure OOC) end to
    end. Walking it batch by batch through a connected model buys
    nothing when they already know the answer.

    Deliberately narrow: messages that already carry a verdict keep it,
    and messages the rules decide keep resolving through the rules. So
    this can add labels but never overwrite a model's or the user's
    own. The response carries every hash written, which is what makes
    the undo exact.
    """
    result = label_service.fill_unlabeled(body.character, body.partner, body.label)
    return {"character": body.character, "partner": body.partner, **result}


@router.post("/labels/delete-hashes")
def labels_delete_hashes(body: LabelsDeleteHashes) -> dict:
    """Remove named labels and nothing else — the undo for
    `/labels/fill-unlabeled`. Distinct from `/labels/clear`, which
    drops every verdict in the conversation including a model's."""
    return {
        "character": body.character,
        "partner": body.partner,
        "deleted": label_service.delete(body.hashes),
    }


@router.post("/labels/override")
def labels_override(body: LabelOverride) -> dict:
    return label_service.override(
        hash=body.hash,
        ts=body.ts,
        speaker=body.speaker,
        label=body.label,
    )


@router.post("/labels/override-many")
def labels_override_many(body: LabelOverrideMany) -> dict:
    """`/labels/override` for the log view's multi-select: one verdict,
    or a reset, for any set of messages in one conversation."""
    changed = label_service.override_many(
        [(i.hash, i.ts, i.speaker) for i in body.items], body.label
    )
    return {
        "character": body.character,
        "partner": body.partner,
        "label": body.label,
        "changed": changed,
    }
