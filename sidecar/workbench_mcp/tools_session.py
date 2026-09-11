"""Session, status and reference tools (docs/MCP_DESIGN.md §3.1)."""

from __future__ import annotations

from typing import Any

import character_archive
import flist_activity
import flist_api
import rag_store
from logs import LogDirError, list_characters
from paths import user_data_dir

from ._registry import TAG_CHARACTER, TAG_CORE, TAG_LOGS, tool

#: Repeated in every tool description that touches profile data. The
#: single most important thing a connected model must not get wrong.
NO_PUSH_NOTE = (
    "Workbench never writes to f-list.net; the user uploads changes "
    "themselves in the browser."
)


@tool(
    tags=(TAG_CORE, TAG_CHARACTER, TAG_LOGS),
    title="Workbench status",
    read_only=True,
)
def get_workbench_status(include_label_rollup: bool = False) -> dict[str, Any]:
    """Overall state of the local Workbench: version, data directory,
    F-list session, archived characters, log corpus and vector index.

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

    characters = character_archive.list_archived_characters()

    try:
        log_chars = [c.name for c in list_characters()]
        log_error = None
    except LogDirError as exc:
        log_chars = []
        log_error = str(exc)

    manifest = rag_store.read_manifest()
    chunk_count = 0
    if manifest.embed_dimension is not None:
        try:
            with rag_store.RagStore() as store:
                chunk_count = store.count() if store.collection_exists() else 0
        except Exception:  # noqa: BLE001 — status must always answer
            chunk_count = 0

    out: dict[str, Any] = {
        "data_dir": str(user_data_dir()),
        "session": session,
        "characters": [
            {
                "name": row.get("name"),
                "id": row.get("id"),
                "last_pulled_at": row.get("last_pulled_at"),
                "snapshot_count": row.get("snapshot_count"),
                "backup_count": row.get("backup_count"),
            }
            for row in characters
        ],
        "log_characters": log_chars,
        "log_dir_error": log_error,
        "vector_index": {
            "embed_model": manifest.embed_model,
            "embed_dimension": manifest.embed_dimension,
            "chunk_count": chunk_count,
            "last_ingest_at": manifest.last_ingest_at,
        },
        "note": NO_PUSH_NOTE,
    }

    if include_label_rollup:
        from services import label_rollup

        out["label_rollup"] = label_rollup.rollup()

    return out


@tool(
    tags=(TAG_CORE, TAG_CHARACTER, TAG_LOGS),
    title="Activity log",
    read_only=True,
)
def get_activity_log(limit: int = 50) -> dict[str, Any]:
    """Recent Workbench activity: sign-ins, pulls, backups and every
    change an MCP tool made (those are prefixed `mcp:`).

    Useful to check what already happened before acting, and to show
    the user what you changed.
    """
    snap = flist_activity.snapshot()
    events = snap.get("events") or []
    if limit > 0:
        events = events[-limit:]
    return {
        "started_at": snap.get("started_at"),
        "event_count": snap.get("event_count"),
        "events": events,
    }
