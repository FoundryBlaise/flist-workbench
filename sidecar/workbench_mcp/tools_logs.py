"""Reading the user's F-Chat logs and their IC/OOC labels (§3.9).

These logs are the user's own private roleplay, and their partners'
lines are in them too. Tools here read them from disk and never write
to F-Chat's data directory, but whatever a tool returns goes to the
connected client: to a cloud model's provider, when that is the client.
So the tools that return message text carry `TAG_LOG_TEXT` and stay
hidden until the user turns them on in Settings → MCP; names, counts
and Labels are not message text and stay available.
"""

from __future__ import annotations

from typing import Any

import aliases as aliases_store
import logs as log_store
from services import labels as label_service

from ._context import ToolError, page, resolve_conversation, resolve_log_character
from ._registry import TAG_CLASSIFY, TAG_LOG_TEXT, TAG_LOGS, tool

#: A single read can pull in a lot of text; keep the default modest and
#: let the caller page with `offset`.
DEFAULT_MESSAGE_LIMIT = 200
MAX_MESSAGE_LIMIT = 1000
#: The most partners one list_partners call returns; `offset` pages on.
MAX_PARTNERS = 100


# Note: every `except` below names the exception through `log_store`
# rather than importing the class. `logs` is reloaded between tests, and
# a class captured at import time is then a different object from the
# one the reloaded module raises — the except clause silently stops
# matching and the error surfaces as an unhandled crash.
def _log_dir_error(exc: Exception) -> ToolError:
    return ToolError(
        "log_dir_unavailable",
        f"{exc} The F-Chat data directory is set in Settings → General.",
    )


@tool(tags=(TAG_LOGS, TAG_CLASSIFY), title="Characters with logs", read_only=True)
def list_log_characters() -> dict[str, Any]:
    """Which of the user's characters have F-Chat logs on this machine."""
    try:
        chars = log_store.list_characters()
    except log_store.LogDirError as exc:
        raise _log_dir_error(exc) from exc
    return {
        "characters": [
            {"name": c.name, "last_activity": c.mtime} for c in chars
        ],
        "log_dir": str(log_store.data_dir()),
    }


@tool(tags=(TAG_LOGS, TAG_CLASSIFY), title="Conversation partners", read_only=True)
def list_partners(
    character: str,
    include_channels: bool = False,
    query: str | None = None,
    limit: int = MAX_PARTNERS,
    offset: int = 0,
) -> dict[str, Any]:
    """Everyone a character has logs with.

    Channel logs (names starting with `#`) are excluded by default —
    they are group chat, not roleplay between two characters.
    """
    character = resolve_log_character(character)
    try:
        entries = log_store.list_partners(character)
    except log_store.LogDirError as exc:
        raise _log_dir_error(exc) from exc

    needle = (query or "").strip().lower()
    rows = []
    for entry in entries:
        if not include_channels and entry.name.startswith("#"):
            continue
        if needle and needle not in entry.name.lower():
            continue
        row: dict[str, Any] = {"partner": entry.name, "bytes": entry.bytes}
        if entry.aliases:
            row["also_known_as"] = list(entry.aliases)
        rows.append(row)
    rows.sort(key=lambda r: -int(r["bytes"]))
    rows, paged = page(rows, offset=offset, limit=limit, cap=MAX_PARTNERS)
    return {"character": character, "partners": rows, "page": paged}


@tool(tags=(TAG_LOGS, TAG_LOG_TEXT), title="Read a conversation", read_only=True)
def read_log_messages(
    character: str,
    partner: str,
    offset: int = 0,
    limit: int = DEFAULT_MESSAGE_LIMIT,
    labels: list[str] | None = None,
) -> dict[str, Any]:
    """Messages from one conversation, oldest first.

    Each message carries its `hash` (needed to set a label) and its
    resolved IC/OOC Label. `labels` filters to any of IC, OOC or
    Unlabeled. Long conversations run to tens of thousands of messages
    — page with `offset`.
    """
    conv = resolve_conversation(character, partner)
    character, partner = conv.character, conv.partner
    capped = max(1, min(MAX_MESSAGE_LIMIT, int(limit)))
    wanted = {str(l).strip().lower() for l in (labels or [])}

    try:
        messages = list(log_store.read_messages(character, partner))
    except log_store.LogDirError as exc:
        raise _log_dir_error(exc) from exc

    resolved = []
    for item in label_service.label_messages(character, partner, messages):
        if wanted and item.label.lower() not in wanted:
            continue
        msg = item.message
        entry: dict[str, Any] = {
            "hash": item.hash,
            "timestamp": msg.get("iso"),
            "speaker": msg.get("speaker"),
            "text": msg.get("text"),
            "label": item.label,
        }
        if msg.get("type") == 1:
            entry["is_action"] = True
        if item.stored is not None:
            entry["label_source"] = item.stored["source"]
        resolved.append(entry)

    start = max(0, int(offset))
    window = resolved[start : start + capped]
    return {
        "character": character,
        "partner": partner,
        "total_matching": len(resolved),
        "offset": start,
        "returned": len(window),
        "has_more": start + len(window) < len(resolved),
        "messages": window,
    }


@tool(tags=(TAG_LOGS, TAG_LOG_TEXT), title="Search Logs for a phrase", read_only=True)
def search_logs(
    character: str,
    query: str,
    partner: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """Literal substring search in one character's Logs.

    With `partner`, searches that conversation, at most 100 hits a page.
    Without it, searches every partner of the character and groups the
    hits by partner, 10 partners a page and at most 20 hits per partner
    (`truncated` says there were more: search that partner on its own
    to see them). Case-insensitive, matched against the message text
    with BBCode stripped. For "what did we say about X" questions,
    search_logs_semantic is usually the better tool.
    """
    if not (query or "").strip():
        raise ToolError("validation_failed", "query is empty")
    if not partner:
        return _search_every_partner(character, query, limit, offset)
    conv = resolve_conversation(character, partner)
    character, partner = conv.character, conv.partner
    try:
        hits = log_store.search_messages(character, partner, query)
    except log_store.LogDirError as exc:
        raise _log_dir_error(exc) from exc
    window, paged = page(hits, offset=offset, limit=limit, cap=MAX_HITS)
    return {
        "character": character,
        "partner": partner,
        "query": query,
        "total_hits": len(hits),
        "hits": [_hit(h) for h in window],
        "page": paged,
    }


#: The most hits one search of a conversation returns.
MAX_HITS = 100
#: Without a partner one search can touch hundreds of conversations; a
#: per-partner cap and a page of partners keep the answer readable and
#: still show where the phrase comes up.
MAX_HITS_PER_PARTNER = 20
PARTNERS_PER_PAGE = 10


def _search_every_partner(
    character: str, query: str, limit: int, offset: int
) -> dict[str, Any]:
    character = resolve_log_character(character)
    per_partner = max(1, min(MAX_HITS_PER_PARTNER, int(limit)))
    try:
        result = log_store.search_all_partners(
            character, query, limit_per_partner=per_partner
        )
    except log_store.LogDirError as exc:
        raise _log_dir_error(exc) from exc
    partners, paged = page(
        result.get("partners") or [],
        offset=offset,
        limit=PARTNERS_PER_PAGE,
        cap=PARTNERS_PER_PAGE,
    )
    return {
        "character": character,
        "query": query,
        "limit_per_partner": per_partner,
        "partners": [
            {
                "partner": row.get("partner"),
                "hit_count": len(row.get("hits") or []),
                "truncated": row.get("truncated", False),
                "hits": [_hit(h) for h in (row.get("hits") or [])],
            }
            for row in partners
        ],
        "page": paged,
    }


def _hit(message: dict[str, Any]) -> dict[str, Any]:
    return {
        "timestamp": message.get("iso"),
        "speaker": message.get("speaker"),
        "text": message.get("text"),
    }


@tool(tags=TAG_LOGS, title="Find a contact", read_only=True)
def find_contacts(name: str, partial: bool = False) -> dict[str, Any]:
    """Have I ever talked to this person, on any of my characters?

    Searches every one of the user's characters for a one-to-one log
    with `name`. Channels are not searched. `partial=true` matches any
    partner whose name contains the string, which is how to find
    someone whose exact spelling is uncertain.
    """
    needle = (name or "").strip()
    if not needle:
        raise ToolError("validation_failed", "name is empty")

    if not partial:
        try:
            result = log_store.find_contacts(needle)
        except log_store.LogDirError as exc:
            raise _log_dir_error(exc) from exc
        return {
            "name": needle,
            "matched": "exact",
            "conversations": result.get("dm") or [],
        }

    # Substring search: walk the partner directories, which is only a
    # directory listing per character — no message parsing.
    lowered = needle.lower()
    found: list[dict[str, Any]] = []
    try:
        characters = log_store.list_characters()
    except log_store.LogDirError as exc:
        raise _log_dir_error(exc) from exc
    for char in characters:
        try:
            partners = log_store.list_partners(char.name)
        except log_store.LogDirError:
            continue
        for entry in partners:
            if entry.name.startswith("#"):
                continue
            if lowered not in entry.name.lower():
                continue
            if entry.name.lower() == char.name.lower():
                continue
            found.append(
                {
                    "character": char.name,
                    "partner": entry.name,
                    "bytes": entry.bytes,
                }
            )
    found.sort(key=lambda r: (str(r["character"]).lower(), -int(r["bytes"])))
    return {"name": needle, "matched": "partial", "conversations": found}


@tool(tags=(TAG_LOGS, TAG_CLASSIFY), title="Label coverage", read_only=True)
def get_label_stats(
    character: str, partner: str | None = None
) -> dict[str, Any]:
    """How much of a conversation — or of everything — has an IC/OOC
    Label.

    Unlabeled messages are the ones a model can still decide, and the
    ones ingest skips. Omitting `partner` walks every conversation of
    the character, which takes a moment on a large corpus.
    """
    if partner:
        conv = resolve_conversation(character, partner)
        character, partner = conv.character, conv.partner
    else:
        character = resolve_log_character(character)
    if partner:
        counts = label_service.conversation_stats(character, partner)
        return {
            "character": character,
            "partner": partner,
            **counts,
            "note": _coverage_note(counts),
        }

    try:
        per_partner = label_service.character_stats(character)
    except log_store.LogDirError as exc:
        raise _log_dir_error(exc) from exc
    rows = []
    totals = {"ic": 0, "ooc": 0, "unlabeled": 0, "total": 0}
    for row in per_partner:
        if row["partner"].startswith("#"):
            continue
        counts = {key: row[key] for key in totals}
        rows.append({"partner": row["partner"], **counts})
        for key in totals:
            totals[key] += counts[key]
    rows.sort(key=lambda r: -int(r["unlabeled"]))
    return {
        "character": character,
        "totals": totals,
        "partners": rows,
        "note": _coverage_note(totals),
    }


def _coverage_note(counts: dict[str, int]) -> str:
    if counts.get("unlabeled", 0) == 0:
        return "Everything has a Label; this conversation is ready to ingest."
    return (
        f"{counts['unlabeled']} message(s) have no IC/OOC Label. They are "
        "skipped by ingest. Use get_unlabeled_messages to judge them."
    )


@tool(tags=TAG_LOGS, title="Partner aliases", read_only=True)
def list_aliases(character: str) -> dict[str, Any]:
    """Names that have been linked as the same person.

    F-Chat starts a new log file when someone renames mid-roleplay;
    linking the names merges the conversations everywhere — the log
    viewer, label lookups and search scope.
    """
    character = resolve_log_character(character, required=False)
    conn = aliases_store.connect()
    try:
        groups = aliases_store.list_groups(conn, character)
    finally:
        conn.close()
    return {
        "character": character,
        "groups": [
            {"primary": primary, "also_known_as": names}
            for primary, names in groups.items()
        ],
    }
