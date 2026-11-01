"""Clearing Labels keeps a restorable copy in the Trash.

Hours of labelling must not be lost to one call. Before Labels are
cleared, from the window or over MCP, the cleared Labels go to the
character's Trash as one entry: each Label by message hash and verdict
(ADR 0004). The window lists it in the Trash view and Restore puts the
Labels back. A message labelled again since the clear keeps its newer
Label. Only the window deletes from the Trash; no MCP tool can.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sidecar_client import app_client

from fchat_logs import chat, write_log
from mcp_helpers import call_tool, mcp_client, tool_error_text
from test_mcp_edit import workbench  # noqa: F401

CID = "42"
AMBER = "Lady Amber Blaise"
DAELAN = "Daelan Envale"
TRASH = f"/flist/character/{CID}/trash"

LONG_A = "She set the lantern down and listened to the rain. " * 6
LONG_B = "He folded the map twice and tucked it into his coat. " * 6
LONG_C = "Honestly my commute today was a nightmare, took two hours. " * 6


@pytest.fixture
def conversation(workbench) -> Path:  # noqa: F811
    """Amber's Workbench character, and one conversation in her Logs
    with three messages that need a verdict."""
    root = Path(os.environ["FCHAT_DATA_DIR"])
    write_log(
        root / AMBER / "logs" / DAELAN,
        [
            chat(AMBER, LONG_A, at=1700000000),
            chat(DAELAN, LONG_B, at=1700000060),
            chat(DAELAN, LONG_C, at=1700000120),
        ],
    )
    return root


@pytest.fixture
def client(conversation) -> TestClient:
    import server

    with app_client(server.app) as c:
        yield c


async def label_everything(session) -> dict[str, str]:
    """Give the conversation's messages IC, IC, OOC; return hash -> verdict."""
    _, batch = await call_tool(
        session, "get_messages_to_classify", character=AMBER, partner=DAELAN
    )
    verdicts = dict(zip((m["hash"] for m in batch["messages"]), ("IC", "IC", "OOC")))
    await call_tool(
        session,
        "set_message_labels",
        character=AMBER,
        partner=DAELAN,
        items=[{"hash": h, "label": v} for h, v in verdicts.items()],
    )
    return verdicts


def stored_labels() -> dict[str, str]:
    import labels as labels_store

    conn = labels_store.connect()
    try:
        return {r["hash"]: r["label"] for r in conn.execute("SELECT hash, label FROM labels")}
    finally:
        conn.close()


async def test_clearing_labels_over_mcp_needs_confirm_and_leaves_them_in_the_trash(
    conversation,
) -> None:
    async with mcp_client() as session:
        verdicts = await label_everything(session)

        refused, _ = await call_tool(
            session, "clear_labels", character=AMBER, partner=DAELAN
        )
        assert "confirm_required" in tool_error_text(refused)
        assert stored_labels() == verdicts

        _, cleared = await call_tool(
            session, "clear_labels", character=AMBER, partner=DAELAN, confirm=True
        )
        _, trash = await call_tool(session, "list_trash", character=AMBER)

    assert cleared["deleted"] == 3
    assert stored_labels() == {}
    [entry] = trash["labels"]
    assert entry["id"] == cleared["trash_id"]
    assert entry["character"] == AMBER
    assert entry["partner"] == DAELAN
    assert entry["count"] == 3
    assert entry["deleted_by"] == "mcp"
