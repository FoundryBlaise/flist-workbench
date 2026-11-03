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
from mcp_helpers import allow_log_text, call_tool, mcp_client, tool_error_text
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
    # Labelling fetches its batches with a tool that returns Log text.
    allow_log_text()
    return root


@pytest.fixture
def client(conversation) -> TestClient:
    import server

    with app_client(server.app) as c:
        yield c


async def label_everything(session) -> dict[str, str]:
    """Give the conversation's messages IC, IC, OOC; return hash -> verdict."""
    _, batch = await call_tool(
        session, "get_unlabeled_messages", character=AMBER, partner=DAELAN
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


def trashed(client: TestClient) -> list[dict]:
    return client.get(TRASH).json()["labels"]


async def test_the_window_clears_a_conversation_and_restore_brings_the_labels_back(
    client,
) -> None:
    async with mcp_client() as session:
        verdicts = await label_everything(session)

    res = client.post("/labels/clear", json={"character": AMBER, "partner": DAELAN})

    assert res.json()["deleted"] == 3
    assert stored_labels() == {}
    [entry] = trashed(client)
    assert entry["id"] == res.json()["trash_id"]
    assert (entry["partner"], entry["count"], entry["deleted_by"]) == (DAELAN, 3, "ui")

    restored = client.post(f"{TRASH}/labels/put-back", json={"ids": [entry["id"]]})

    assert restored.status_code == 200
    assert restored.json() == {
        "restored": [{"id": entry["id"], "restored": 3, "skipped": []}],
        "not_found": [],
    }
    assert stored_labels() == verdicts
    assert trashed(client) == []


async def test_a_message_labelled_again_since_the_clear_keeps_its_newer_label(
    client,
) -> None:
    async with mcp_client() as session:
        verdicts = await label_everything(session)
    client.post("/labels/clear", json={"character": AMBER, "partner": DAELAN})
    relabelled = next(h for h, v in verdicts.items() if v == "IC")
    client.post(
        "/labels/override",
        json={
            "character": AMBER,
            "partner": DAELAN,
            "hash": relabelled,
            "ts": 1700000000,
            "speaker": AMBER,
            "label": "OOC",
        },
    )
    [entry] = trashed(client)

    res = client.post(f"{TRASH}/labels/put-back", json={"ids": [entry["id"]]}).json()

    assert res["restored"] == [{"id": entry["id"], "restored": 2, "skipped": [relabelled]}]
    assert stored_labels() == {**verdicts, relabelled: "OOC"}


async def test_resetting_every_label_keeps_each_characters_labels_in_its_trash(
    client,
) -> None:
    async with mcp_client() as session:
        verdicts = await label_everything(session)

    res = client.post("/labels/clear-all").json()

    assert res["labels_deleted"] == 3
    [entry] = trashed(client)
    assert (entry["partner"], entry["count"]) == (None, 3)

    client.post(f"{TRASH}/labels/put-back", json={"ids": [entry["id"]]})

    assert stored_labels() == verdicts


async def test_only_the_window_deletes_cleared_labels_for_good(client) -> None:
    async with mcp_client() as session:
        await label_everything(session)
        await call_tool(
            session, "clear_labels", character=AMBER, partner=DAELAN, confirm=True
        )
        names = {t.name for t in (await session.list_tools()).tools}
        _, over_mcp = await call_tool(session, "list_trash", character=AMBER)

    destructive = ("purge", "empty", "delete", "remove", "wipe", "clear")
    assert not [
        n for n in names if "trash" in n and any(word in n for word in destructive)
    ], names
    [entry] = over_mcp["labels"]

    purged = client.post(f"{TRASH}/labels/purge", json={"ids": [entry["id"]]}).json()

    assert purged == {"purged": [entry["id"]], "not_found": []}
    assert trashed(client) == []


async def test_emptying_the_trash_takes_the_cleared_labels_with_it(client) -> None:
    async with mcp_client() as session:
        await label_everything(session)
    client.post("/labels/clear", json={"character": AMBER, "partner": DAELAN})

    emptied = client.delete(TRASH).json()

    assert emptied["purged"] == 1
    assert trashed(client) == []


# ---- the Labels section of the Trash: every entry, whoever owns it ------

CORIN = "Corin Vale"
LABELS_TRASH = "/labels/trash"


@pytest.fixture
def log_only(conversation) -> Path:
    """A second Log character with no Workbench: nothing in the
    character list, so no character Trash view, would ever show its
    cleared Labels."""
    write_log(
        conversation / CORIN / "logs" / DAELAN,
        [
            chat(CORIN, LONG_A, at=1700000000),
            chat(DAELAN, LONG_B, at=1700000060),
        ],
    )
    return conversation


async def test_cleared_labels_of_a_log_only_character_are_listed_and_restored(
    client, log_only
) -> None:
    async with mcp_client() as session:
        _, batch = await call_tool(
            session, "get_unlabeled_messages", character=CORIN, partner=DAELAN
        )
        items = [{"hash": m["hash"], "label": "IC"} for m in batch["messages"]]
        await call_tool(
            session, "set_message_labels", character=CORIN, partner=DAELAN, items=items
        )
    before = stored_labels()
    cleared = client.post("/labels/clear", json={"character": CORIN, "partner": DAELAN}).json()
    assert cleared["deleted"] == 2
    assert trashed(client) == [], "Amber's Trash shows only Amber's Labels"

    listing = client.get(LABELS_TRASH)

    assert listing.status_code == 200
    [entry] = listing.json()["labels"]
    assert (entry["id"], entry["character"], entry["count"]) == (cleared["trash_id"], CORIN, 2)

    restored = client.post(f"{LABELS_TRASH}/put-back", json={"ids": [entry["id"], "nope"]})

    assert restored.json() == {
        "restored": [{"id": entry["id"], "restored": 2, "skipped": []}],
        "not_found": ["nope"],
    }
    assert stored_labels() == before
    assert client.get(LABELS_TRASH).json()["labels"] == []


async def test_the_labels_section_lists_every_characters_entries_and_purges_one(
    client, log_only
) -> None:
    async with mcp_client() as session:
        await label_everything(session)
    client.post("/labels/clear", json={"character": AMBER, "partner": DAELAN})
    [amber_entry] = trashed(client)

    [listed] = client.get(LABELS_TRASH).json()["labels"]
    assert listed["id"] == amber_entry["id"]

    purged = client.post(f"{LABELS_TRASH}/purge", json={"ids": [listed["id"]]}).json()

    assert purged == {"purged": [listed["id"]], "not_found": []}
    assert client.get(LABELS_TRASH).json()["labels"] == []
    assert trashed(client) == []
