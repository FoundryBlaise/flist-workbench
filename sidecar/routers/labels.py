"""Labels: counts, clearing, filling and overriding.

Clearing moves the Labels to the Trash; the Trash routes are in
`images_trash`.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import aliases as aliases_store
import labels as labels_store
import settings as settings_store
from logs import LogDirError, data_dir, list_partners, read_messages
from services import label_rollup
from services import label_trash as label_trash_service

router = APIRouter()


@router.get("/labels/stats")
def labels_stats(char: str, partner: str) -> dict:
    messages = list(read_messages(char, partner))
    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    try:
        lab_settings = labels_store.load_settings(settings_conn)
        alias_group = aliases_store.all_names_for(labels_conn, char, partner)
        counts = labels_store.stats(
            labels_conn,
            char,
            partner,
            messages,
            lab_settings,
            partner_aliases=alias_group,
        )
    finally:
        settings_conn.close()
        labels_conn.close()
    return {
        "character": char,
        "partner": partner,
        "ic": counts[labels_store.LABEL_IC],
        "ooc": counts[labels_store.LABEL_OOC],
        "unlabeled": counts[labels_store.LABEL_UNLABELED],
        "total": sum(counts.values()),
    }


@router.get("/labels/stats-all")
def labels_stats_all(char: str) -> dict:
    """Batch labels stats for every partner of a character.

    The sidebar uses this to render per-partner coverage pips without
    firing one request per row. Reuses the same resolver as
    /labels/stats so a partner's per-row counts always match the
    detailed view. Linked aliases are folded into their primary partner.

    Also returns `log_mtime` (latest of all alias-group log files) and
    `last_label_at` (newest labels.updated_at across the same alias
    group). A stale partner is one where log_mtime > last_label_at —
    log activity arrived after the last classify run for that
    conversation.
    """
    entries = list_partners(char)

    base = data_dir() / char / "logs"
    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    out: list[dict] = []
    try:
        lab_settings = labels_store.load_settings(settings_conn)
        for entry in entries:
            try:
                messages = list(read_messages(char, entry.name))
            except LogDirError:
                # Partner present in the directory listing but unreadable
                # (deleted between calls, permission denied) — skip silently
                # so a single bad file doesn't 500 the whole sidebar.
                continue
            alias_group = aliases_store.all_names_for(
                labels_conn, char, entry.name
            )
            counts = labels_store.stats(
                labels_conn,
                char,
                entry.name,
                messages,
                lab_settings,
                partner_aliases=alias_group,
            )
            # Walk every on-disk file in the alias group for the mtime
            # high-water mark. A folded partner only counts stale when
            # ANY of its underlying files moved after the last label.
            log_mtime = 0.0
            for member in alias_group or [entry.name]:
                p = base / member
                try:
                    log_mtime = max(log_mtime, p.stat().st_mtime)
                except OSError:
                    continue
            last_label = labels_store.max_label_time(
                labels_conn,
                char,
                entry.name,
                partner_aliases=alias_group,
            )
            out.append(
                {
                    "partner": entry.name,
                    "ic": counts[labels_store.LABEL_IC],
                    "ooc": counts[labels_store.LABEL_OOC],
                    "unlabeled": counts[labels_store.LABEL_UNLABELED],
                                "total": sum(counts.values()),
                    "log_mtime": log_mtime if log_mtime > 0 else None,
                    "last_label_at": last_label,
                }
            )
    finally:
        settings_conn.close()
        labels_conn.close()
    return {"character": char, "partners": out}


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
    cleared = label_trash_service.clear(body.character, body.partner)
    return {
        "character": body.character,
        "partner": body.partner,
        **cleared,
    }


@router.post("/labels/clear-all")
def labels_clear_all() -> dict:
    """Wipe every stored IC/OOC verdict across all characters.

    The Settings → Labels "Reset all labels…" button calls this. After
    it returns, every message in every conversation falls back to
    rule-on-read — manual overrides are gone too. Each character's
    cleared Labels go to its Trash first, as one entry per character;
    the renderer still confirms before invoking this.
    """
    cleared = label_trash_service.clear_all()
    return {"labels_deleted": cleared["deleted"], "trash_ids": cleared["trash_ids"]}


@router.get("/labels/rollup")
def labels_rollup() -> dict:
    """Aggregate IC/OOC/Unlabeled counts across every character.

    Walks every (character × partner) log under the configured data
    directory; for large corpora this is a few seconds the first time
    Settings opens. Used by the Labels rollup pane to show one-glance
    state ("3,402 IC · 18,720 OOC · …").
    """
    try:
        return label_rollup.rollup()
    except LogDirError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


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
    if body.label not in (labels_store.LABEL_IC, labels_store.LABEL_OOC):
        raise HTTPException(
            status_code=400,
            detail=f"label must be IC or OOC, got {body.label!r}",
        )
    messages = list(read_messages(body.character, body.partner))
    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    try:
        lab_settings = labels_store.load_settings(settings_conn)
        alias_group = aliases_store.all_names_for(
            labels_conn, body.character, body.partner
        )
        # Written under the alias group's primary, like every other
        # label, so a later rename does not orphan them.
        primary = aliases_store.primary_for(
            labels_conn, body.character, body.partner
        )
        result = labels_store.fill_unlabeled(
            labels_conn,
            body.character,
            primary,
            messages,
            lab_settings,
            body.label,
            partner_aliases=alias_group,
        )
    finally:
        settings_conn.close()
        labels_conn.close()
    return {"character": body.character, "partner": body.partner, **result}


@router.post("/labels/delete-hashes")
def labels_delete_hashes(body: LabelsDeleteHashes) -> dict:
    """Remove named labels and nothing else — the undo for
    `/labels/fill-unlabeled`. Distinct from `/labels/clear`, which
    drops every verdict in the conversation including a model's."""
    conn = labels_store.connect()
    try:
        removed = labels_store.delete_labels_by_hash(
            conn,
            body.hashes,
            character=body.character,
            partner=body.partner,
        )
    finally:
        conn.close()
    return {
        "character": body.character,
        "partner": body.partner,
        "deleted": removed,
    }


@router.post("/labels/override")
def labels_override(body: LabelOverride) -> dict:
    conn = labels_store.connect()
    try:
        if body.label is None:
            removed = labels_store.delete_label(conn, body.hash)
            return {"hash": body.hash, "deleted": removed, "label": None}
        if body.label not in (labels_store.LABEL_IC, labels_store.LABEL_OOC):
            raise HTTPException(
                status_code=400,
                detail=f"label must be IC or OOC, got {body.label!r}",
            )
        # Write labels under the alias group's canonical primary so
        # the partner column stays consistent post-rename. Lookup is
        # alias-aware (labels_for_partner expands the group) so old
        # rows under the alias name still resolve.
        primary = aliases_store.primary_for(conn, body.character, body.partner)
        labels_store.upsert_label(
            conn,
            hash=body.hash,
            character=body.character,
            partner=primary,
            ts=body.ts,
            speaker=body.speaker,
            label=body.label,
            source="manual",
            reason="manual override",
        )
        row = conn.execute(
            "SELECT label, source, prior_label, prior_source FROM labels WHERE hash = ?",
            (body.hash,),
        ).fetchone()
        return {
            "hash": body.hash,
            "label": row["label"],
            "source": row["source"],
            "prior_label": row["prior_label"],
            "prior_source": row["prior_source"],
        }
    finally:
        conn.close()


@router.post("/labels/override-many")
def labels_override_many(body: LabelOverrideMany) -> dict:
    """`/labels/override` for the log view's multi-select: one verdict,
    or a reset, for any set of messages in one conversation."""
    if body.label is not None and body.label not in (
        labels_store.LABEL_IC,
        labels_store.LABEL_OOC,
    ):
        raise HTTPException(
            status_code=400,
            detail=f"label must be IC or OOC, got {body.label!r}",
        )
    conn = labels_store.connect()
    try:
        if body.label is None:
            changed = labels_store.delete_labels_by_hash(
                conn,
                [i.hash for i in body.items],
                character=body.character,
                partner=body.partner,
            )
        else:
            # Canonical alias primary, as in /labels/override.
            primary = aliases_store.primary_for(conn, body.character, body.partner)
            changed = labels_store.upsert_labels_many(
                conn,
                [(i.hash, i.ts, i.speaker) for i in body.items],
                character=body.character,
                partner=primary,
                label=body.label,
            )
    finally:
        conn.close()
    return {
        "character": body.character,
        "partner": body.partner,
        "label": body.label,
        "changed": changed,
    }
