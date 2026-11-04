"""Logs: F-Chat's own records, read in place, with each message's Label."""

from dataclasses import asdict
from typing import Literal

from fastapi import APIRouter

from logs import (
    find_contacts,
    list_characters,
    list_partners,
    read_messages,
    search_all_partners,
    search_messages,
)
from services import labels as label_service
from wire import LabelSource, Verdict, WireModel, omittable

router = APIRouter()


class LogCharacter(WireModel):
    """One of the user's characters with Logs. `mtime`: the newest
    change in its Logs folder (epoch seconds), 0 when it has none."""

    name: str
    mtime: float


class LogCharacters(WireModel):
    characters: list[LogCharacter]


class LogPartner(WireModel):
    """One conversation of a character. `name` is the partner, or the
    primary name of an alias group whose other members are `aliases`;
    `bytes` counts the whole group's Logs."""

    name: str
    bytes: int
    aliases: list[str]


class LogPartners(WireModel):
    character: str
    partners: list[LogPartner]


class LogMessage(WireModel):
    """One record of a Log, as the parser reads it. `kind` is F-Chat's
    bucket for its type (a system line is an ad, roll, warning or
    status event), not its Label."""

    ts: int
    iso: str
    type: int
    type_name: str
    speaker: str
    raw: str
    text: str
    mentions: list[str]
    kind: Literal["ic", "ooc", "system"]


class LabelledMessage(LogMessage):
    """A message with the Label it resolves to (null for a system line)
    and its `hash`, which the Label routes take. `label_source` and the
    rest are there only when a stored Label decides it: who set it, the
    reason given, and the verdict it replaced."""

    hash: str
    label: Literal["IC", "OOC", "Unlabeled"] | None
    label_source: LabelSource | None = omittable()
    label_reason: str | None = omittable()
    prior_label: Verdict | None = omittable()
    prior_source: LabelSource | None = omittable()


class LogMessages(WireModel):
    character: str
    partner: str
    offset: int
    messages: list[LabelledMessage]


class _HitIndex(WireModel):
    index: int


class LogSearchHit(LogMessage, _HitIndex):
    """A message that matches a search, with its `index` in its
    conversation. (Bases in this order put `index` first, as the
    answer has it.)"""


class LogSearch(WireModel):
    character: str
    partner: str
    query: str
    hits: list[LogSearchHit]


class LogSearchPartner(WireModel):
    """One conversation's matches; `truncated` when it had more than
    the limit (open the conversation to see the rest)."""

    partner: str
    bytes: int
    hits: list[LogSearchHit]
    truncated: bool


class LogSearchAll(WireModel):
    character: str
    query: str
    partners: list[LogSearchPartner]


class LogSearchAllNothing(WireModel):
    """What a search of every conversation answers for an empty query."""

    character: str
    query: str
    hits: list[LogSearchHit]


class LogContact(WireModel):
    """One of the user's characters with a 1-on-1 Log with the name."""

    character: str
    partner: str
    bytes: int
    mtime: float


class LogContacts(WireModel):
    name: str
    dm: list[LogContact]


@router.get("/logs/characters")
def logs_characters() -> LogCharacters:
    return LogCharacters.model_validate({"characters": [asdict(c) for c in list_characters()]})


@router.get("/logs/partners")
def logs_partners(char: str) -> LogPartners:
    entries = list_partners(char)
    return LogPartners.model_validate(
        {"character": char, "partners": [asdict(e) for e in entries]}
    )


@router.get("/logs/messages")
def logs_messages(
    char: str, partner: str, offset: int = 0, limit: int | None = None
) -> LogMessages:
    messages = list(read_messages(char, partner, offset=offset, limit=limit))

    # Resolve each message's IC/OOC/Unlabeled label live — labels are
    # rule-on-read, so settings changes (e.g. threshold) take effect
    # immediately without rebuilding the DB. A stored Label is found by
    # the message's hash, whichever of the user's Logs it was set in.
    for item in label_service.label_messages(messages):
        m = item.message
        # Send the hash so the renderer can call /labels/override
        # without re-implementing sha1(ts|speaker|raw) client-side.
        m["hash"] = item.hash
        m["label"] = item.label
        row = item.stored
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

    return LogMessages.model_validate(
        {"character": char, "partner": partner, "offset": offset, "messages": messages}
    )


@router.get("/logs/search")
def logs_search(char: str, partner: str, q: str) -> LogSearch:
    hits = search_messages(char, partner, q)
    return LogSearch.model_validate(
        {"character": char, "partner": partner, "query": q, "hits": hits}
    )


@router.get("/logs/search_all")
def logs_search_all(
    char: str, q: str, limit_per_partner: int = 50
) -> LogSearchAll | LogSearchAllNothing:
    found = search_all_partners(char, q, limit_per_partner=limit_per_partner)
    if "partners" not in found:
        # An empty query searches nothing.
        return LogSearchAllNothing.model_validate(found)
    return LogSearchAll.model_validate(found)


@router.get("/logs/contacts")
def logs_contacts(name: str) -> LogContacts:
    return LogContacts.model_validate(find_contacts(name))
