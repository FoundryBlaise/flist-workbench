"""The change-broadcast bus (design §4.3).

Why this exists: the Workbench window used to be the only writer, so
it always knew the current state of what it displayed. A model editing
the same working set breaks that — the window shows a stale draft and
then autosaves it back over the model's work. These tests cover the
notification half; the renderer's reaction is in
`renderer/src/state/__tests__`.
"""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path

import pytest

from mcp_helpers import call_tool, mcp_client
from test_mcp_reads import MAPPING


@pytest.fixture
def workbench(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib
    import json

    import character_archive
    import paths

    importlib.reload(paths)
    importlib.reload(character_archive)

    cache = character_archive.cache_root() / "mapping-list.json"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(MAPPING), encoding="utf-8")

    character_archive.register_character("42", "Lady Amber Blaise")
    character_archive.write_live(
        "42",
        {
            "character": {"id": 42, "name": "Lady Amber Blaise", "description": "x"},
            "infotags": {},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
            "fetched_at": 1,
        },
    )

    import server
    from services import mapping as mapping_service

    mapping_service.invalidate()
    importlib.reload(server)
    yield character_archive
    mapping_service.invalidate()


async def collect(seconds: float = 0.4) -> list[dict]:
    """Subscribe, let the caller's writes land, return what arrived."""
    from services import events

    received: list[dict] = []

    async with events.subscribe() as sub:
        # Give the writes a moment; the bus hands off through the loop.
        deadline = asyncio.get_running_loop().time() + seconds
        while asyncio.get_running_loop().time() < deadline:
            try:
                received.append(
                    await asyncio.wait_for(sub.queue.get(), timeout=0.05)
                )
            except asyncio.TimeoutError:
                continue
    return received


async def test_a_payload_write_is_announced_with_its_etag(workbench) -> None:
    """The etag is what lets the window tell "I already have this" from
    "someone else changed it"."""
    from services import events

    events.bind_loop(asyncio.get_running_loop())
    meta = workbench.create_set_from_live("42", "Draft")

    async def write() -> None:
        await asyncio.sleep(0.05)
        payload = workbench.read_set_payload("42", meta.id)
        payload["character"]["description"] = "changed"
        workbench.write_set_payload("42", meta.id, payload, expected_etag=None)

    collector = asyncio.create_task(collect())
    await write()
    received = await collector

    changes = [e for e in received if e["event"] == "set-payload-changed"]
    assert changes, received
    assert changes[-1]["set_id"] == meta.id
    assert changes[-1]["etag"]


async def test_activating_a_set_is_announced(workbench) -> None:
    from services import events

    events.bind_loop(asyncio.get_running_loop())
    meta = workbench.create_set_from_live("42", "Draft")

    async def write() -> None:
        await asyncio.sleep(0.05)
        workbench.set_active_set_id("42", meta.id)

    collector = asyncio.create_task(collect())
    await write()
    received = await collector

    events_seen = {e["event"] for e in received}
    assert "active-set-changed" in events_seen


async def test_a_ui_write_is_attributed_to_the_ui(workbench) -> None:
    from services import events

    events.bind_loop(asyncio.get_running_loop())
    meta = workbench.create_set_from_live("42", "Draft")

    async def write() -> None:
        await asyncio.sleep(0.05)
        payload = workbench.read_set_payload("42", meta.id)
        workbench.write_set_payload("42", meta.id, payload, expected_etag=None)

    collector = asyncio.create_task(collect())
    await write()
    received = await collector
    changes = [e for e in received if e["event"] == "set-payload-changed"]
    assert changes[-1]["origin"] == "ui"


async def test_an_mcp_write_names_the_tool_that_made_it(workbench) -> None:
    """"The set you have open just changed" is far more useful when it
    can say what changed it."""
    from services import events

    events.bind_loop(asyncio.get_running_loop())
    workbench.create_set_from_live("42", "Draft")
    workbench.set_active_set_id(
        "42", next(m.id for m in workbench.list_sets("42"))
    )

    async def write() -> None:
        await asyncio.sleep(0.05)
        async with mcp_client("character") as session:
            await call_tool(
                session,
                "set_description",
                character="Lady Amber Blaise",
                text="by the model",
            )

    collector = asyncio.create_task(collect())
    await write()
    received = await collector

    changes = [e for e in received if e["event"] == "set-payload-changed"]
    assert changes, received
    assert changes[-1]["origin"] == "mcp:set_description"


async def test_label_writes_are_announced(workbench) -> None:
    from services import events
    import labels as labels_store

    events.bind_loop(asyncio.get_running_loop())

    async def write() -> None:
        await asyncio.sleep(0.05)
        conn = labels_store.connect()
        try:
            labels_store.upsert_label(
                conn,
                hash="abcdef0123456789",
                character="C",
                partner="P",
                ts=1,
                speaker="C",
                label="IC",
                source="manual",
            )
        finally:
            conn.close()

    collector = asyncio.create_task(collect())
    await write()
    received = await collector
    assert any(e["event"] == "labels-changed" for e in received)


async def test_publishing_without_subscribers_is_harmless(workbench) -> None:
    """Writes happen long before any window connects; publishing must
    never be worth failing one for."""
    from services import events

    events.bind_loop(asyncio.get_running_loop())
    events.publish("set-payload-changed", character_id="42")
    assert events.subscriber_count() == 0


async def test_a_slow_subscriber_drops_the_oldest_not_the_newest(
    workbench,
) -> None:
    """A backgrounded window must not hold memory hostage, and the
    newest event is the one that describes the current state."""
    from services import events

    events.bind_loop(asyncio.get_running_loop())
    async with events.subscribe() as sub:
        for n in range(events.QUEUE_LIMIT + 10):
            events.publish("set-payload-changed", seq=n)
        await asyncio.sleep(0.05)
        drained = []
        while not sub.queue.empty():
            drained.append(sub.queue.get_nowait())

    assert len(drained) <= events.QUEUE_LIMIT
    assert sub.dropped > 0
    assert drained[-1]["seq"] == events.QUEUE_LIMIT + 9


async def test_the_events_endpoint_streams(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`/events` never ends by design, so it is driven directly and
    stopped after the first frame. A client library would sit waiting
    for a response that is not coming."""
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import server
    from services import events

    importlib.reload(server)
    events.bind_loop(asyncio.get_running_loop())

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
        "headers": [(b"host", b"127.0.0.1:27384")],
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 27384),
    }

    started: dict = {}
    body = asyncio.Queue()

    async def receive():
        # Never disconnects; the test cancels instead.
        await asyncio.sleep(3600)
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.start":
            started.update(message)
        elif message["type"] == "http.response.body":
            await body.put(message.get("body", b""))

    task = asyncio.create_task(server.app(scope, receive, send))
    try:
        first = await asyncio.wait_for(body.get(), timeout=5.0)
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    assert started["status"] == 200
    headers = {k.decode(): v.decode() for k, v in started["headers"]}
    assert headers["content-type"].startswith("text/event-stream")
    # The first frame says the stream is live rather than merely
    # connected — a renderer waiting on data would otherwise have no
    # way to tell.
    assert b"event: ready" in first
