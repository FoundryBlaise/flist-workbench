"""Long tools behave alike on every endpoint (spec #6, #80).

A long tool is one that takes `wait`: an ingest, a Pull, Back up all.
With `wait=false` each answers a job id at once, and an endpoint that
carries one also carries `get_job` and `cancel_job`, so a model that
started a job can always follow it and stop it.

The ingest runs for real here, over the shared fixture Logs
(`two_characters`): real chunker, real Index, through the same client
session a real MCP client uses. Only embedding and reranking are
stubbed, as in `test_rag_jobs`. Pull and Back up all have their MCP job
tests in `test_pull_jobs`, beside the F-list fake they need.
"""

from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Iterator

import pytest

import rag_embed
import workbench_mcp
from mcp_helpers import allow_log_text, call_tool, mcp_client
from test_rag_jobs import _stub_index_services
from two_characters import (  # noqa: F401  (the fixture is used by name)
    AMBER,
    AZURE,
    OLD_NAME_LINE,
    PARTNER,
    PARTNER_LINE,
    SEARCH_TERM,
    SHARED_LINE,
    TwoCharacters,
    two_characters,
)

FINISHED = ("done", "failed", "cancelled")

#: The tools that run long enough to offer `wait`.
LONG_TOOLS = {"ingest_logs", "pull_character", "backup_all_characters"}


def _long_tools(tools) -> set[str]:  # noqa: ANN001
    return {t.name for t in tools if "wait" in (t.inputSchema.get("properties") or {})}


# ---- every endpoint ------------------------------------------------------


async def test_every_long_tool_offers_wait() -> None:
    async with mcp_client("") as session:
        tools = (await session.list_tools()).tools
    assert LONG_TOOLS <= _long_tools(tools)


@pytest.mark.parametrize("suffix", sorted(workbench_mcp.ENDPOINTS), ids=lambda s: f"/mcp/{s}")
async def test_an_endpoint_that_carries_a_long_tool_can_poll_and_cancel_its_job(
    suffix: str,
) -> None:
    async with mcp_client(suffix) as session:
        tools = (await session.list_tools()).tools
    names = {t.name for t in tools}
    if _long_tools(tools):
        assert {"get_job", "cancel_job"} <= names, (
            f"/mcp/{suffix} starts jobs it cannot follow or stop"
        )


# ---- ingest, end to end ---------------------------------------------------


@pytest.fixture
def labelled(
    two_characters: TwoCharacters,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[TwoCharacters]:
    """The fixture Logs with Azure Viper's lines to Antiquill and to Lady
    Amber Blaise labelled IC: two conversations for the Index. Her line
    from when Antiquill was Quill Ashgrove stays Unlabeled."""
    from services import jobs

    monkeypatch.setattr(jobs, "_registry", jobs.JobRegistry())
    _stub_index_services(monkeypatch)
    two_characters.label_by_hand(AZURE, PARTNER, PARTNER_LINE, "IC")
    two_characters.label_by_hand(AZURE, AMBER, SHARED_LINE, "IC")
    # A search after an ingest returns Log text.
    allow_log_text()
    yield two_characters
    # Never leave a worker holding the Index open past the test.
    deadline = time.monotonic() + 10
    while any(not j.finished for j in jobs.registry().list()):
        assert time.monotonic() < deadline, "an ingest outlived its test"
        time.sleep(0.05)


async def _until_finished(session, job_id: str) -> dict:  # noqa: ANN001
    """Poll get_job the way a model would, until the job ends."""
    deadline = time.monotonic() + 10
    while True:
        _, job = await call_tool(session, "get_job", job_id=job_id)
        if job["state"] in FINISHED:
            return job
        assert time.monotonic() < deadline, f"job {job_id} never finished: {job}"
        await asyncio.sleep(0.05)


async def test_an_ingest_started_without_waiting_runs_to_the_end_and_is_searchable(
    labelled: TwoCharacters,
) -> None:
    async with mcp_client("classify") as session:
        _, started = await call_tool(session, "ingest_logs", character=AZURE, wait=False)
        # The same answer Pull and Back up all give.
        assert set(started) == {"job_id", "kind", "state", "note"}
        assert started["kind"] == "ingest"
        assert "get_job" in started["note"] and "cancel_job" in started["note"]

        job = await _until_finished(session, started["job_id"])

    assert job["state"] == "done", job
    assert job["error"] is None
    assert job["progress"]["embedded"] == 2
    assert job["result"]["chunks_indexed"] == 2
    assert job["result"]["skipped_unlabeled"] == 1

    async with mcp_client("logs") as session:
        _, found = await call_tool(
            session, "search_logs_semantic", question=SEARCH_TERM, character=AZURE
        )
    assert any(PARTNER_LINE in hit["text"] for hit in found["hits"]), found
    assert not any(OLD_NAME_LINE in hit["text"] for hit in found["hits"])


async def test_a_waiting_ingest_says_what_it_skipped_unlabeled_and_what_to_do(
    labelled: TwoCharacters,
) -> None:
    """Silently indexing half a Log and reporting success is the failure
    this guards against."""
    async with mcp_client("logs") as session:
        _, body = await call_tool(session, "ingest_logs", character=AZURE)

    assert body["state"] == "done", body
    assert body["chunks_indexed"] == 2
    assert body["skipped_unlabeled"] == 1
    assert "get_messages_to_classify" in body["note"]


async def test_an_ingest_is_stopped_by_cancel_job_on_the_classify_endpoint(
    labelled: TwoCharacters, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Hold the first embedding batch, so the job is caught running with
    # the second conversation still ahead of it: the cancel takes effect
    # there.
    embedding, gate = threading.Event(), threading.Event()
    embed = rag_embed.embed_texts

    def held_embed(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        embedding.set()
        gate.wait(10)
        return embed(*args, **kwargs)

    monkeypatch.setattr(rag_embed, "embed_texts", held_embed)

    async with mcp_client("classify") as session:
        _, started = await call_tool(session, "ingest_logs", character=AZURE, wait=False)
        assert await asyncio.to_thread(embedding.wait, 10)
        _, running = await call_tool(session, "get_job", job_id=started["job_id"])
        _, asked = await call_tool(session, "cancel_job", job_id=started["job_id"])
        gate.set()
        job = await _until_finished(session, started["job_id"])

    assert running["state"] == "running"
    assert running["progress"]["current_partner"]
    assert asked["cancel_requested"] is True
    assert job["state"] == "cancelled", job
    assert job["progress"]["embedded"] == 1
