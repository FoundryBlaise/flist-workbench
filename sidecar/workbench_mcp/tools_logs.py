"""Reading the user's F-Chat logs and their IC/OOC labels (§3.9).

These logs are the user's own private roleplay. Tools here read them
from disk; nothing is sent anywhere. F-Chat's data directory is never
written to.
"""

from __future__ import annotations

from typing import Any

import aliases as aliases_store
import labels as labels_store
import logs as log_store
import settings as settings_store

from ._context import ToolError, resolve_conversation, resolve_log_character
from ._registry import TAG_LOGS, tool

#: A single read can pull in a lot of text; keep the default modest and
#: let the caller page with `offset`.
DEFAULT_MESSAGE_LIMIT = 200
MAX_MESSAGE_LIMIT = 1000


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


@tool(tags=TAG_LOGS, title="Characters with logs", read_only=True)
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


@tool(tags=TAG_LOGS, title="Conversation partners", read_only=True)
def list_partners(
    character: str, include_channels: bool = False, query: str | None = None
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
    return {"character": character, "partners": rows}


@tool(tags=TAG_LOGS, title="Read a conversation", read_only=True)
def read_log_messages(
    character: str,
    partner: str,
    offset: int = 0,
    limit: int = DEFAULT_MESSAGE_LIMIT,
    labels: list[str] | None = None,
) -> dict[str, Any]:
    """Messages from one conversation, oldest first.

    Each message carries its `hash` (needed to set a label) and its
    resolved IC/OOC verdict. `labels` filters to any of IC, OOC or
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

    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    try:
        lab_settings = labels_store.load_settings(settings_conn)
        alias_group = aliases_store.all_names_for(labels_conn, character, partner)
        by_hash = labels_store.labels_for_partner(
            labels_conn, character, partner, partner_aliases=alias_group
        )
        resolved = []
        for msg in messages:
            h = labels_store.msg_hash(msg)
            row = by_hash.get(h)
            label = labels_store.resolve(msg, row, lab_settings)
            if wanted and label.lower() not in wanted:
                continue
            entry: dict[str, Any] = {
                "hash": h,
                "timestamp": msg.get("iso"),
                "speaker": msg.get("speaker"),
                "text": msg.get("text"),
                "label": label,
            }
            if msg.get("type") == 1:
                entry["is_action"] = True
            if row is not None:
                entry["label_source"] = row["source"]
            resolved.append(entry)
    finally:
        settings_conn.close()
        labels_conn.close()

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


@tool(tags=TAG_LOGS, title="Search one conversation", read_only=True)
def search_logs(
    character: str, partner: str, query: str, limit: int = 50
) -> dict[str, Any]:
    """Literal substring search in one conversation.

    Case-insensitive, matched against the message text with BBCode
    stripped. For "what did we say about X" questions across a whole
    corpus, search_logs_semantic is usually the better tool.
    """
    if not (query or "").strip():
        raise ToolError("validation_failed", "query is empty")
    conv = resolve_conversation(character, partner)
    character, partner = conv.character, conv.partner
    try:
        hits = log_store.search_messages(character, partner, query)
    except log_store.LogDirError as exc:
        raise _log_dir_error(exc) from exc
    capped = max(1, int(limit))
    return {
        "character": character,
        "partner": partner,
        "query": query,
        "total_hits": len(hits),
        "hits": [
            {
                "timestamp": h.get("iso"),
                "speaker": h.get("speaker"),
                "text": h.get("text"),
            }
            for h in hits[:capped]
        ],
        "truncated": len(hits) > capped,
    }


@tool(tags=TAG_LOGS, title="Search all partners", read_only=True)
def search_all_partners(
    character: str, query: str, limit_per_partner: int = 20
) -> dict[str, Any]:
    """Literal substring search across every conversation of one
    character. Linear scan — slow on a large corpus."""
    if not (query or "").strip():
        raise ToolError("validation_failed", "query is empty")
    character = resolve_log_character(character)
    try:
        result = log_store.search_all_partners(
            character, query, limit_per_partner=max(1, int(limit_per_partner))
        )
    except log_store.LogDirError as exc:
        raise _log_dir_error(exc) from exc
    return {
        "character": character,
        "query": query,
        "partners": [
            {
                "partner": row.get("partner"),
                "hit_count": len(row.get("hits") or []),
                "truncated": row.get("truncated", False),
                "hits": [
                    {
                        "timestamp": h.get("iso"),
                        "speaker": h.get("speaker"),
                        "text": h.get("text"),
                    }
                    for h in (row.get("hits") or [])
                ],
            }
            for row in (result.get("partners") or [])
        ],
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


@tool(tags=TAG_LOGS, title="Label coverage", read_only=True)
def get_label_stats(
    character: str, partner: str | None = None
) -> dict[str, Any]:
    """How much of a conversation — or of everything — has an IC/OOC
    verdict.

    Unlabeled messages are the ones a model can still decide, and the
    ones ingest skips. Omitting `partner` walks every conversation of
    the character, which takes a moment on a large corpus.
    """
    if partner:
        conv = resolve_conversation(character, partner)
        character, partner = conv.character, conv.partner
    else:
        character = resolve_log_character(character)
    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    try:
        lab_settings = labels_store.load_settings(settings_conn)
        if partner:
            counts = _stats_for(
                labels_conn, lab_settings, character, partner
            )
            return {
                "character": character,
                "partner": partner,
                **counts,
                "note": _coverage_note(counts),
            }

        try:
            entries = log_store.list_partners(character)
        except log_store.LogDirError as exc:
            raise _log_dir_error(exc) from exc
        rows = []
        totals = {"ic": 0, "ooc": 0, "unlabeled": 0, "total": 0}
        for entry in entries:
            if entry.name.startswith("#"):
                continue
            counts = _stats_for(
                labels_conn, lab_settings, character, entry.name
            )
            rows.append({"partner": entry.name, **counts})
            for key in totals:
                totals[key] += counts[key]
        rows.sort(key=lambda r: -int(r["unlabeled"]))
        return {
            "character": character,
            "totals": totals,
            "partners": rows,
            "note": _coverage_note(totals),
        }
    finally:
        settings_conn.close()
        labels_conn.close()


def _stats_for(labels_conn, lab_settings, character: str, partner: str) -> dict[str, int]:  # noqa: ANN001
    try:
        messages = list(log_store.read_messages(character, partner))
    except log_store.LogDirError:
        messages = []
    alias_group = aliases_store.all_names_for(labels_conn, character, partner)
    counts = labels_store.stats(
        labels_conn,
        character,
        partner,
        messages,
        lab_settings,
        partner_aliases=alias_group,
    )
    return {
        "ic": counts.get(labels_store.LABEL_IC, 0),
        "ooc": counts.get(labels_store.LABEL_OOC, 0),
        "unlabeled": counts.get(labels_store.LABEL_UNLABELED, 0),
        "total": sum(counts.values()),
    }


def _coverage_note(counts: dict[str, int]) -> str:
    if counts.get("unlabeled", 0) == 0:
        return "Everything has a verdict; this conversation is ready to ingest."
    return (
        f"{counts['unlabeled']} message(s) have no IC/OOC verdict. They are "
        "skipped by ingest. Use get_messages_to_classify to judge them."
    )


@tool(tags=TAG_LOGS, title="Partner aliases", read_only=True)
def list_aliases(character: str) -> dict[str, Any]:
    """Names that have been linked as the same person.

    F-Chat starts a new log file when someone renames mid-roleplay;
    linking the names merges the conversations everywhere — the log
    viewer, label lookups and search scope.
    """
    character = resolve_log_character(character, required=False)
    conn = labels_store.connect()
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
