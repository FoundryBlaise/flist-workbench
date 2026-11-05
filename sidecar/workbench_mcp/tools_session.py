"""Session, status and reference tools (docs/MCP_DESIGN.md §3.1)."""

from __future__ import annotations

from typing import Any

import archive_registry
import flist_activity
import flist_api
from logs import LogDirError, list_characters
from paths import user_data_dir

from ._context import page
from ._registry import NO_PUSH_NOTE, TAG_CHARACTER, TAG_CORE, TAG_LOGS, tool

#: The most events one get_activity_log call returns.
MAX_ACTIVITY_EVENTS = 100


@tool(
    tags=(TAG_CORE, TAG_CHARACTER, TAG_LOGS),
    title="App status",
    read_only=True,
)
def get_app_status(include_label_rollup: bool = False) -> dict[str, Any]:
    """Overall state of the app: version, data directory, F-list
    session, archived characters, the Logs and the Index.

    Call this first in a session to find out what exists locally.
    `include_label_rollup=true` also counts IC/OOC labels across every
    character, which walks the whole log corpus and can take seconds.
    """
    ticket = flist_api.ticket_store().status()
    session: dict[str, Any] = {
        "signed_in": bool(ticket.get("active")),
        "account": ticket.get("account"),
        "ticket_expires_in_sec": ticket.get("expires_in_sec"),
        "api_calls_this_hour": flist_api.api_rate_limiter().hourly_count(),
    }

    characters = archive_registry.list_archived_characters()

    try:
        log_chars = [c.name for c in list_characters()]
        log_error = None
    except LogDirError as exc:
        log_chars = []
        log_error = str(exc)

    from refusals import IndexUnreadable
    from services import index as index_service

    # The status of everything else must not fail with the Index: an
    # Index that cannot be read is reported as its error instead.
    try:
        vector_index: dict[str, Any] = index_service.status()
    except IndexUnreadable as exc:
        vector_index = {"error": exc.body()}

    out: dict[str, Any] = {
        "data_dir": str(user_data_dir()),
        "session": session,
        "characters": [
            {
                "name": row.get("name"),
                "id": row.get("id"),
                "last_pulled_at": row.get("last_pulled_at"),
                "backup_count": row.get("backup_count"),
            }
            for row in characters
        ],
        "log_characters": log_chars,
        "log_dir_error": log_error,
        "vector_index": vector_index,
        "note": NO_PUSH_NOTE,
    }

    if include_label_rollup:
        from services import labels as label_service

        out["label_rollup"] = label_service.rollup()

    return out


@tool(
    tags=(TAG_CORE, TAG_CHARACTER, TAG_LOGS),
    title="Activity log",
    read_only=True,
)
def get_activity_log(
    limit: int = 50, offset: int = 0, as_of: int | None = None
) -> dict[str, Any]:
    """Recent activity, newest first: sign-ins, pulls, backups and every
    change an MCP tool made (those are prefixed `mcp:`).

    Useful to check what already happened before acting, and to show
    the user what you changed.

    Every event has a `seq`, rising. The log grows while you page it,
    so the answer carries `as_of`, the `seq` of the newest event it
    pages: pass it back with `offset` and the next pages go on from
    where the first one was, leaving out events that came later.
    """
    snap = flist_activity.snapshot()
    oldest_first = snap.get("events") or []
    if as_of is not None:
        oldest_first = [e for e in oldest_first if e["seq"] <= as_of]
    events, paged = page(
        list(reversed(oldest_first)),
        offset=offset,
        limit=limit,
        cap=MAX_ACTIVITY_EVENTS,
    )
    return {
        "started_at": snap.get("started_at"),
        "event_count": snap.get("event_count"),
        "as_of": oldest_first[-1]["seq"] if oldest_first else as_of,
        "events": events,
        "page": paged,
    }
