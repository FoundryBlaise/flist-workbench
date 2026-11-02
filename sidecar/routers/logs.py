"""Logs: F-Chat's own records, read in place, with each message's Label."""

from dataclasses import asdict

from fastapi import APIRouter, HTTPException

import aliases as aliases_store
import labels as labels_store
import settings as settings_store
from logs import (
    LogDirError,
    find_contacts,
    list_characters,
    list_partners,
    read_messages,
    search_all_partners,
    search_messages,
)

router = APIRouter()


@router.get("/logs/characters")
def logs_characters() -> dict:
    try:
        return {"characters": [asdict(c) for c in list_characters()]}
    except LogDirError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/logs/partners")
def logs_partners(char: str) -> dict:
    entries = list_partners(char)
    return {"character": char, "partners": [asdict(e) for e in entries]}


@router.get("/logs/messages")
def logs_messages(char: str, partner: str, offset: int = 0, limit: int | None = None) -> dict:
    messages = list(read_messages(char, partner, offset=offset, limit=limit))

    # Resolve each message's IC/OOC/Unlabeled label live — labels are
    # rule-on-read, so settings changes (e.g. threshold) take effect
    # immediately without rebuilding the DB.
    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    try:
        lab_settings = labels_store.load_settings(settings_conn)
        # Folding label rows from any linked alternate names — labels
        # written under "Daelan Envale" pre-rename still apply when
        # the user opens the merged "Asmira" conversation.
        alias_group = aliases_store.all_names_for(labels_conn, char, partner)
        by_hash = labels_store.labels_for_partner(
            labels_conn, char, partner, partner_aliases=alias_group
        )
        for m in messages:
            h = labels_store.msg_hash(m)
            # Send the hash so the renderer can call /labels/override
            # without re-implementing sha1(ts|speaker|raw) client-side.
            m["hash"] = h
            row = by_hash.get(h)
            m["label"] = labels_store.resolve(m, row, lab_settings)
            if row is not None:
                m["label_source"] = row["source"]
                # Surface the labeller's own reason string in the badge
                # tooltip so the user can audit why a label was chosen.
                if row["reason"]:
                    m["label_reason"] = row["reason"]
                # Carry the prior snapshot so the UI can show "the model
                # said IC; you changed it to OOC" on manual overrides.
                if row["prior_label"] is not None:
                    m["prior_label"] = row["prior_label"]
                    m["prior_source"] = row["prior_source"]
            # Otherwise no source is attached — the UI infers "rule
            # or unlabeled" from absence of label_source.
    finally:
        settings_conn.close()
        labels_conn.close()

    return {"character": char, "partner": partner, "offset": offset, "messages": messages}


@router.get("/logs/search")
def logs_search(char: str, partner: str, q: str) -> dict:
    hits = search_messages(char, partner, q)
    return {"character": char, "partner": partner, "query": q, "hits": hits}


@router.get("/logs/search_all")
def logs_search_all(char: str, q: str, limit_per_partner: int = 50) -> dict:
    return search_all_partners(char, q, limit_per_partner=limit_per_partner)


@router.get("/logs/contacts")
def logs_contacts(name: str) -> dict:
    return find_contacts(name)
