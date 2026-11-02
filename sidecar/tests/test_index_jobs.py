"""One job model, and one ingest at a time (spec #4, #73).

Long work starts as a job: the start answers with a job id, and status
and cancel go by that id, the same calls for every kind of job. The
Index is the first resource a job holds: while an ingest runs, a second
ingest, a wipe and a lexical rebuild are refused as busy, and the Index
status says busy instead of claiming zero chunks.

Everything here goes through the sidecar from outside (Seam A): the
window's REST routes and the MCP tools. Embedding is stubbed and held
at a gate, so an ingest stays running until the test lets it finish.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sidecar_client import app_client, is_refusal_shaped

import rag_embed
from refusals import IndexBusy
from fchat_logs import chat, utc, write_log
from mcp_helpers import call_tool, mcp_client, tool_error_text
from test_rag_jobs import ME, OPENING, PARTNER, REPLY, _label, _stub_index_services

CONV = {"character": ME, "partner": PARTNER}
#: A second conversation of ME, so an ingest of the whole character has
#: a point between conversations where a cancel takes effect.
OTHER = "Quill Ashgrove"
FINISHED = ("done", "failed", "cancelled")


@dataclass
class Index:
    client: TestClient
    #: Set once the ingest is inside the embedding step.
    embedding: threading.Event
    #: Lets a held embedding step go on.
    gate: threading.Event

    def start_ingest(self, **body) -> dict:
        res = self.client.post("/rag/ingest", json={**CONV, **body})
        assert res.status_code == 202, res.text
        return res.json()

    def running_ingest(self, **body) -> dict:
        """An ingest held inside its embedding step."""
        job = self.start_ingest(**body)
        assert self.embedding.wait(10), "the ingest never reached the embedding step"
        return job

    def finish(self, job_id: str) -> dict:
        self.gate.set()
        return self.wait(job_id)

    def wait(self, job_id: str) -> dict:
        deadline = time.time() + 10
        while time.time() < deadline:
            job = self.client.get(f"/jobs/{job_id}").json()
            if job["state"] in FINISHED:
                return job
            time.sleep(0.05)
        raise AssertionError(f"job {job_id} never finished")


@pytest.fixture
def index(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    from services import jobs

    monkeypatch.setattr(jobs, "_registry", jobs.JobRegistry())
    _stub_index_services(monkeypatch)

    embedding, gate = threading.Event(), threading.Event()
    embed = rag_embed.embed_texts

    def held_embed(*args, **kwargs):
        embedding.set()
        gate.wait(10)
        return embed(*args, **kwargs)

    monkeypatch.setattr(rag_embed, "embed_texts", held_embed)

    from server import app

    client = app_client(app)
    write_log(
        tmp_path / "fchat" / ME / "logs" / PARTNER,
        [chat(ME, OPENING, at=utc(2024, 3, 9, 20)), chat(PARTNER, REPLY, at=utc(2024, 3, 9, 21))],
    )
    _label(client, OPENING, "IC")
    write_log(tmp_path / "fchat" / ME / "logs" / OTHER, [chat(OTHER, OPENING, at=utc(2024, 3, 10))])
    _label_in(client, OTHER, OPENING)
    yield Index(client, embedding, gate)
    # Never leave a worker holding the Index open past the test.
    gate.set()
    for job in jobs.registry().list():
        if job.state not in FINISHED:
            Index(client, embedding, gate).wait(job.id)


def _label_in(client: TestClient, partner: str, text: str) -> None:
    """Label the message `text` of ME's conversation with `partner` IC."""
    res = client.get("/logs/messages", params={"char": ME, "partner": partner})
    (msg,) = [m for m in res.json()["messages"] if m["text"] == text]
    res = client.post(
        "/labels/override",
        json={"character": ME, "partner": partner, "hash": msg["hash"], "ts": msg["ts"],
              "speaker": msg["speaker"], "label": "IC"},
    )
    assert res.status_code == 200, res.text


# ---- one ingest at a time ------------------------------------------------


async def test_a_second_ingest_while_one_runs_is_refused_and_status_says_busy(
    index: Index,
) -> None:
    first = index.running_ingest()

    second = index.client.post("/rag/ingest", json=CONV)
    assert second.status_code == 409, second.text
    assert is_refusal_shaped(second)
    assert second.json()["code"] == "index_busy"
    assert second.json()["details"]["job_id"] == first["id"]

    status = index.client.get("/rag/status").json()
    assert status["busy"] is True
    assert status["job"]["id"] == first["id"]
    assert status["chunk_count"] is None, "busy is not zero chunks"

    async with mcp_client("logs") as session:
        result, _ = await call_tool(session, "ingest_logs", **CONV, wait=False)
        assert "index_busy" in tool_error_text(result)
        _, mcp_status = await call_tool(session, "get_rag_status")
    assert mcp_status["busy"] is True
    assert mcp_status["job"]["id"] == first["id"]
    assert mcp_status["chunk_count"] is None

    assert index.finish(first["id"])["state"] == "done"
    idle = index.client.get("/rag/status").json()
    assert idle["busy"] is False
    assert idle["job"] is None
    assert idle["chunk_count"] == 1


@pytest.mark.parametrize("route", ["/rag/wipe", "/rag/lexical/rebuild"])
def test_a_wipe_or_lexical_rebuild_while_an_ingest_runs_is_refused(
    index: Index, route: str
) -> None:
    running = index.running_ingest()

    res = index.client.post(route)

    assert res.status_code == 409, res.text
    assert is_refusal_shaped(res)
    assert res.json()["code"] == "index_busy"
    assert res.json()["details"]["job_id"] == running["id"]
    assert index.finish(running["id"])["state"] == "done", "the ingest was left alone"
    assert index.client.get("/rag/status").json()["chunk_count"] == 1


async def test_a_wipe_over_mcp_while_an_ingest_runs_is_refused(index: Index) -> None:
    running = index.running_ingest()

    async with mcp_client("logs") as session:
        result, _ = await call_tool(session, "wipe_search_index", confirm=True)

    assert "index_busy" in tool_error_text(result)
    assert index.finish(running["id"])["state"] == "done"


def test_an_ingest_while_a_wipe_holds_the_index_is_refused(index: Index) -> None:
    from services import index as index_service
    from services import jobs

    with jobs.registry().hold("wipe", index_service.INDEX, busy=IndexBusy):
        res = index.client.post("/rag/ingest", json=CONV)

    assert res.status_code == 409, res.text
    assert res.json()["code"] == "index_busy"
    assert res.json()["details"]["kind"] == "wipe"


# ---- one way to poll and cancel ------------------------------------------


async def test_a_job_is_polled_and_cancelled_by_id_the_same_way_over_rest_and_mcp(
    index: Index,
) -> None:
    started = index.running_ingest(partner=None)
    assert started["kind"] == "ingest"
    assert started["resource"] == "index"

    polled = index.client.get(f"/jobs/{started['id']}").json()
    async with mcp_client("logs") as session:
        _, over_mcp = await call_tool(session, "get_job", job_id=started["id"])
        assert over_mcp["state"] == polled["state"] == "running"
        assert set(over_mcp) == set(polled)

        _, cancelled = await call_tool(session, "cancel_job", job_id=started["id"])
    assert cancelled["id"] == started["id"]
    assert cancelled["cancel_requested"] is True

    ended = index.finish(started["id"])
    assert ended["state"] == "cancelled"
    assert ended["error"] is None


def test_a_job_cancelled_over_rest_stops(index: Index) -> None:
    started = index.running_ingest(partner=None)

    res = index.client.delete(f"/jobs/{started['id']}")

    assert res.status_code == 200, res.text
    assert res.json()["cancel_requested"] is True
    assert index.finish(started["id"])["state"] == "cancelled"


async def test_an_unknown_job_id_is_reported_unknown(index: Index) -> None:
    """Jobs live in memory, so an id from before a restart is one the
    sidecar has never seen: the same answer as a made-up one."""
    for method in ("GET", "DELETE"):
        res = index.client.request(method, "/jobs/from-before-a-restart")
        assert res.status_code == 404, res.text
        assert is_refusal_shaped(res)
        assert res.json()["code"] == "job_not_found"
        assert "unknown" in res.json()["message"].lower()

    async with mcp_client("logs") as session:
        for tool in ("get_job", "cancel_job"):
            result, _ = await call_tool(session, tool, job_id="from-before-a-restart")
            assert "job_not_found" in tool_error_text(result)


def test_a_failed_job_reports_its_error_in_the_one_error_shape(
    index: Index, monkeypatch: pytest.MonkeyPatch
) -> None:
    def no_model(settings, *, timeout=30.0):  # noqa: ARG001
        raise rag_embed.EmbedError("model not loaded")

    monkeypatch.setattr(rag_embed, "probe", no_model)
    job = index.wait(index.start_ingest()["id"])

    assert job["state"] == "failed"
    assert set(job["error"]) == {"code", "message", "details"}
    assert job["error"]["code"] == "embedding_failed"
    assert "model not loaded" in job["error"]["message"]


# ---- the window hears about it --------------------------------------------


async def test_an_ingest_and_a_wipe_publish_index_changed(index: Index) -> None:
    """A model ingesting or wiping changes what the window's Index view
    shows; the event is what makes the window read it again."""
    import asyncio

    from services import events

    events.bind_loop(asyncio.get_running_loop())
    index.gate.set()
    async with events.subscribe() as sub:
        async with mcp_client("logs") as session:
            _, ingested = await call_tool(session, "ingest_logs", **CONV)
            assert ingested["state"] == "done", ingested
            _, wiped = await call_tool(session, "wipe_search_index", confirm=True)
            assert wiped["wiped"] is True
        await asyncio.sleep(0.1)
        received = []
        while not sub.queue.empty():
            received.append(sub.queue.get_nowait())

    changes = [e for e in received if e["event"] == "index-changed"]
    assert [e["state"] for e in changes if e["job_id"] == ingested["job_id"]] == [
        "running",
        "done",
    ], "the start and the end of the ingest"
    assert len(changes) == 3, "and the wipe"
    assert {e["origin"] for e in changes} == {"mcp:ingest_logs", "mcp:wipe_search_index"}
    finished = [e for e in changes if e["job_id"] == ingested["job_id"]][-1]
    assert finished["origin"] == "mcp:ingest_logs", "the worker keeps the caller's origin"


# ---- status tells failure from empty --------------------------------------


async def test_an_index_that_cannot_be_read_is_an_error_not_zero_chunks(
    index: Index,
) -> None:
    import rag_store

    rag_store.write_manifest(embed_model="some-model", embed_dimension=4)
    folder = rag_store.qdrant_dir()
    folder.mkdir(parents=True, exist_ok=True)
    # Damaged: the store's own description of itself is not readable.
    (folder / "meta.json").write_text("{not json", encoding="utf-8")

    res = index.client.get("/rag/status")
    assert res.status_code == 500, res.text
    assert is_refusal_shaped(res)
    assert res.json()["code"] == "index_unreadable"

    async with mcp_client("logs") as session:
        result, _ = await call_tool(session, "get_rag_status")
        assert "index_unreadable" in tool_error_text(result)
        _, overall = await call_tool(session, "get_workbench_status")
    assert overall["vector_index"]["error"]["code"] == "index_unreadable"


async def test_a_search_while_an_ingest_runs_is_refused_as_busy(index: Index) -> None:
    """The vector store opens once at a time, and the ingest has it: a
    search is told so instead of failing on the store's lock."""
    running = index.running_ingest()

    async with mcp_client("logs") as session:
        result, _ = await call_tool(session, "search_logs_semantic", question="lighthouse")

    assert "index_busy" in tool_error_text(result)
    assert index.finish(running["id"])["state"] == "done"
