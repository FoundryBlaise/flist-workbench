"""Slow work leaves the sidecar answering.

The window, a connected model and the browser extension all talk to
one event loop. A Backup's zip, a gallery repair, a semantic search or
the sweep of every Log folder can each take seconds; run on that loop,
they froze health checks, the window's live updates and every other
call until they were done.

Each test here slows one step of such work down for real: the step
waits until the test lets go of it. While it waits, the test asks for
`/health` and saves another character's Workbench, and the event
stream has to report that save. Only then is the step let go, and the
work has to finish as it would have anyway. A step that ran on the
loop could not be overtaken like that: the test learns so because the
step stopped waiting (it gives up after `HOLD_S`) before the sidecar
answered.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib
import json
import threading
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

import archive_live
import archive_registry
import archive_workbench
from mcp_helpers import allow_log_text, call_tool, mcp_client
from sidecar_client import BASE_URL, SECRET_HEADER, TEST_LAUNCH_SECRET
from test_mcp_reads import MAPPING

NAME = "Lady Amber Blaise"
OTHER = "Corin Ashvale"
PNG = b"\x89PNG\r\n\x1a\n" + b"gallery" * 32
UPLOAD = b"\x89PNG\r\n\x1a\n" + b"upload" * 32

#: How long a slowed step waits for the test before giving up. Only a
#: step that blocks the loop ever waits this long.
HOLD_S = 5.0


def _live(cid: int, name: str, images: list[dict[str, str]]) -> dict[str, Any]:
    return {
        "character": {"id": cid, "name": name, "description": "start"},
        "infotags": {},
        "kinks": {},
        "custom_kinks": {},
        "inlines": {},
        "images": images,
        "fetched_at": 1700000000,
    }


@pytest.fixture
def sidecar(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Two characters with a Workbench each; the first has an image."""
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")

    import paths

    importlib.reload(paths)
    importlib.reload(archive_registry)
    # A semantic search returns Log text.
    allow_log_text()

    cache = archive_registry.cache_root() / "mapping-list.json"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(MAPPING), encoding="utf-8")

    archive_registry.register_character("42", NAME)
    archive_live.write_live(
        "42", _live(42, NAME, [{"image_id": "9001", "extension": "png"}])
    )
    archive_workbench.read_workbench("42", create=True)
    import archive_images

    archive_images.write_character_image("42", "9001", "png", PNG)

    archive_registry.register_character("43", OTHER)
    archive_live.write_live("43", _live(43, OTHER, []))
    archive_workbench.read_workbench("43", create=True)

    # One Log, so the sweep behind Foreign search has a folder to walk.
    log = tmp_path / "fchat" / "lady amber blaise" / "logs" / "corin ashvale"
    log.parent.mkdir(parents=True)
    log.write_bytes(b"")

    import server
    from services import foreign as foreign_service
    from services import mapping as mapping_service

    mapping_service.invalidate()
    foreign_service.reset_log_partner_cache()
    importlib.reload(server)
    yield server
    mapping_service.invalidate()
    foreign_service.reset_log_partner_cache()


class SlowStep:
    """Stands in for one slow step: whoever runs it waits until the
    test lets go, or `HOLD_S` at most."""

    def __init__(self) -> None:
        self.started = threading.Event()
        self.let_go = threading.Event()
        self.finished = threading.Event()

    def around(self, fn: Callable[..., Any]) -> Callable[..., Any]:
        def slow(*args: Any, **kwargs: Any) -> Any:
            self.started.set()
            if not self.let_go.wait(HOLD_S):
                self.let_go.set()
            self.finished.set()
            return fn(*args, **kwargs)

        return slow


async def _until(flag: threading.Event, what: str) -> None:
    deadline = time.monotonic() + HOLD_S * 2
    while not flag.is_set():
        assert time.monotonic() < deadline, f"{what} never happened"
        await asyncio.sleep(0.01)


class EventStream:
    """`GET /events`, driven straight through ASGI: the stream never
    ends, and an HTTP client would wait for the whole body."""

    def __init__(self, frames: asyncio.Queue[bytes]) -> None:
        self._frames = frames

    async def until(self, *needles: bytes) -> bytes:
        async def scan() -> bytes:
            while True:
                frame = await self._frames.get()
                if all(n in frame for n in needles):
                    return frame

        return await asyncio.wait_for(scan(), timeout=HOLD_S * 2)


@contextlib.asynccontextmanager
async def event_stream(app: Any) -> AsyncIterator[EventStream]:
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "path": "/events",
        "raw_path": b"/events",
        "query_string": b"",
        "root_path": "",
        "scheme": "http",
        "headers": [
            (b"host", b"127.0.0.1:27384"),
            (SECRET_HEADER.lower().encode(), TEST_LAUNCH_SECRET.encode()),
        ],
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 27384),
    }
    frames: asyncio.Queue[bytes] = asyncio.Queue()
    closed = asyncio.Event()

    async def receive() -> dict[str, Any]:
        await closed.wait()
        return {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.body":
            await frames.put(message.get("body", b""))

    task = asyncio.create_task(app(scope, receive, send))
    stream = EventStream(frames)
    try:
        await stream.until(b"event: ready")
        yield stream
    finally:
        closed.set()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


@contextlib.asynccontextmanager
async def window(sidecar: Any) -> AsyncIterator[tuple[httpx.AsyncClient, EventStream]]:
    """The app window: REST calls and the event stream, on the test's
    own loop, which is the sidecar's loop for the length of the test."""
    from services import events

    events.bind_loop(asyncio.get_running_loop())
    transport = httpx.ASGITransport(app=sidecar.app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url=BASE_URL,
        headers={SECRET_HEADER: TEST_LAUNCH_SECRET},
        timeout=HOLD_S * 4,
    ) as api, event_stream(sidecar.app) as stream:
        yield api, stream


async def _still_answers(api: httpx.AsyncClient, stream: EventStream) -> None:
    """Health answers, and a save of another character reaches the
    event stream."""
    health = await api.get("/health")
    assert health.status_code == 200, health.text

    url = "/flist/character/43/workbench/payload"
    read = (await api.get(url)).json()
    payload = read["payload"]
    payload["character"]["description"] = "saved meanwhile"
    saved = await api.put(url, json=payload, headers={"If-Match": read["etag"]})
    assert saved.status_code == 200, saved.text
    await stream.until(b"event: set-payload-changed", b'"character_id": "43"')


async def _answers_while(
    step: SlowStep,
    work: Awaitable[Any],
    api: httpx.AsyncClient,
    stream: EventStream,
    *,
    meanwhile: Callable[[], Awaitable[None]] | None = None,
) -> Any:
    """Start `work`, check the sidecar answers while `step` holds it,
    then let go and return what `work` came to."""
    running = asyncio.ensure_future(work)
    try:
        await _until(step.started, "the slow step")
        await _still_answers(api, stream)
        if meanwhile is not None:
            await meanwhile()
        assert not step.finished.is_set(), (
            "the sidecar answered only after the slow step was over: "
            "it ran on the event loop"
        )
    finally:
        step.let_go.set()
    return await running


# ---- REST ---------------------------------------------------------------


def _zip(monkeypatch: pytest.MonkeyPatch, step: SlowStep) -> None:
    import zip_serialise

    monkeypatch.setattr(zip_serialise, "build_zip", step.around(zip_serialise.build_zip))


def _hashing(monkeypatch: pytest.MonkeyPatch, step: SlowStep) -> None:
    import archive_images

    monkeypatch.setattr(archive_images, "_hash_bytes", step.around(archive_images._hash_bytes))


def _log_sweep(monkeypatch: pytest.MonkeyPatch, step: SlowStep) -> None:
    from services import foreign

    monkeypatch.setattr(
        foreign, "_scan_log_partner_names", step.around(foreign._scan_log_partner_names)
    )


REST_WORK = {
    "a Backup": (_zip, "POST", "/flist/character/42/zip-backup", None),
    "an export for Upload": (_zip, "GET", "/flist/character/42/export.zip", None),
    "a gallery repair": (_hashing, "POST", "/flist/character/42/images/repair", None),
    "an image upload": (_hashing, "POST", "/flist/character/42/images", UPLOAD),
    "listing the images": (_hashing, "GET", "/flist/character/42/images", None),
    "a Foreign search of the Logs": (
        _log_sweep,
        "GET",
        "/foreign/search?source=logs&q=corin",
        None,
    ),
}


@pytest.mark.parametrize("work", list(REST_WORK))
async def test_the_window_stays_live_while_slow_rest_work_runs(
    sidecar: Any, monkeypatch: pytest.MonkeyPatch, work: str
) -> None:
    slow, method, url, body = REST_WORK[work]
    step = SlowStep()
    slow(monkeypatch, step)

    async with window(sidecar) as (api, stream):
        res = await _answers_while(
            step, api.request(method, url, content=body), api, stream
        )

    assert res.status_code == 200, res.text


async def test_the_slow_work_still_comes_to_its_result(
    sidecar: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    step = SlowStep()
    _log_sweep(monkeypatch, step)

    async with window(sidecar) as (api, stream):
        res = await _answers_while(
            step, api.get("/foreign/search?source=logs&q=corin"), api, stream
        )

    assert res.json()["results"] == ["corin ashvale"]


async def test_a_save_waits_for_a_backup_of_the_same_character_and_then_conflicts_or_wins_cleanly(
    sidecar: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The Backup holds the character's lock while its zip is built. Two
    saves that read the same Workbench wait for it without holding up
    anything else; then exactly one lands and the other is told."""
    step = SlowStep()
    _zip(monkeypatch, step)
    url = "/flist/character/42/workbench/payload"

    async with window(sidecar) as (api, stream):
        read = (await api.get(url)).json()

        def save(text: str) -> Awaitable[httpx.Response]:
            payload = json.loads(json.dumps(read["payload"]))
            payload["character"]["description"] = text
            return api.put(url, json=payload, headers={"If-Match": read["etag"]})

        saves: list[asyncio.Future[httpx.Response]] = []

        async def two_saves() -> None:
            saves.extend(asyncio.ensure_future(save(t)) for t in ("one", "two"))
            # Both are in flight and neither got through the lock.
            await asyncio.sleep(0.2)
            assert not any(s.done() for s in saves)
            await _still_answers(api, stream)

        backup = await _answers_while(
            step,
            api.post("/flist/character/42/zip-backup"),
            api,
            stream,
            meanwhile=two_saves,
        )
        answers = [await s for s in saves]

    assert backup.status_code == 200, backup.text
    assert sorted(r.status_code for r in answers) == [200, 409]
    lost = next(r for r in answers if r.status_code == 409)
    assert lost.json()["code"] == "etag_mismatch"
    won = "one" if answers[0].status_code == 200 else "two"
    now = archive_workbench.read_workbench("42")
    assert now is not None
    assert now.payload["character"]["description"] == won


# ---- Pull and Back up all ----------------------------------------------


@pytest.fixture
def flist(httpx_mock):  # noqa: ANN001, ANN201
    """Signed in, and F-list serves the first character as it is."""
    import flist_api

    flist_api.ticket_store().set(
        flist_api.Ticket(
            account="amber-account",
            value="test-ticket",
            password="test-password",
            acquired_at=time.monotonic(),
        ),
        characters=[{"id": 42, "name": NAME}],
    )
    profile = _live(42, NAME, [{"image_id": "9001", "extension": "png"}])
    httpx_mock.add_response(
        url=flist_api.CHARACTER_DATA_URL,
        method="POST",
        json={"error": "", "id": 42, "name": NAME, **profile},
        is_reusable=True,
    )
    httpx_mock.add_response(
        url=flist_api.avatar_url(NAME),
        method="GET",
        content=PNG,
        is_optional=True,
        is_reusable=True,
    )
    yield
    flist_api.ticket_store().clear()


def _repair(monkeypatch: pytest.MonkeyPatch, step: SlowStep) -> None:
    import archive_images

    monkeypatch.setattr(
        archive_images, "repair_gallery", step.around(archive_images.repair_gallery)
    )


STREAMED_WORK = {
    "a Pull": (_repair, f"/flist/character/{NAME}/pull"),
    "Back up all": (_zip, "/flist/backup-all"),
}


@pytest.mark.parametrize("work", list(STREAMED_WORK))
async def test_the_window_stays_live_while_a_pull_or_back_up_all_runs(
    sidecar: Any, flist: None, monkeypatch: pytest.MonkeyPatch, work: str
) -> None:
    slow, url = STREAMED_WORK[work]
    step = SlowStep()
    slow(monkeypatch, step)

    async with window(sidecar) as (api, stream):
        res = await _answers_while(step, api.post(url), api, stream)

    assert res.status_code == 200
    assert "event: done" in res.text, res.text


# ---- MCP ----------------------------------------------------------------


def _semantic_search(monkeypatch: pytest.MonkeyPatch, step: SlowStep) -> None:
    from services import retrieval

    def search(question: str, **kwargs: Any) -> retrieval.SearchResult:
        return retrieval.SearchResult(
            hits=[],
            embed_model="test-embed",
            rerank_model="test-rerank",
            rerank_applied=True,
            hybrid_applied=False,
            scope=kwargs.get("scope"),
        )

    monkeypatch.setattr(retrieval, "search", step.around(search))


MCP_WORK = {
    "a semantic search": (
        _semantic_search,
        "logs",
        "search_logs_semantic",
        {"question": "what did I tell her about my sister"},
    ),
    "a Backup": (_zip, "character", "create_backup", {"character": NAME}),
    "an export for Upload": (
        _zip,
        "character",
        "export_upload_zip",
        {"character": NAME, "path": "{exports}"},
    ),
    "a Foreign search of the Logs": (
        _log_sweep,
        "",
        "search_foreign_characters",
        {"source": "logs", "query": "corin"},
    ),
}


@pytest.mark.parametrize("work", list(MCP_WORK))
async def test_the_window_stays_live_while_a_model_runs_slow_work(
    sidecar: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, work: str
) -> None:
    slow, endpoint, tool, arguments = MCP_WORK[work]
    exports = tmp_path / "exports"
    exports.mkdir()
    arguments = {
        k: v.format(exports=exports) if isinstance(v, str) else v
        for k, v in arguments.items()
    }
    step = SlowStep()
    slow(monkeypatch, step)

    async with window(sidecar) as (api, stream), mcp_client(endpoint) as session:
        result, body = await _answers_while(
            step, call_tool(session, tool, **arguments), api, stream
        )

    assert not result.isError, body
