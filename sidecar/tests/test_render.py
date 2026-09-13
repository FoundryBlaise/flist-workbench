"""The render broker: a tool asks for a picture, the window draws it.

The sidecar has no way to rasterise HTML — the point of this seam is
that the app does the drawing and the sidecar only carries the request
and the bytes back.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from services import render as render_service


@pytest.fixture(autouse=True)
def clean_broker():
    render_service.reset()
    yield
    render_service.reset()


@pytest.fixture
def api(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    from server import app

    return TestClient(app)


PNG = b"\x89PNG\r\n\x1a\n" + b"fake"


async def test_a_request_waits_for_the_window_to_answer() -> None:
    task = asyncio.create_task(
        render_service.request(bbcode="[b]hi[/b]", theme="dark", width=900)
    )
    await asyncio.sleep(0)

    handed = await render_service.next_request(timeout=1)
    assert handed is not None
    assert handed.bbcode == "[b]hi[/b]"
    assert render_service.deliver(handed.id, PNG) is True

    assert await asyncio.wait_for(task, timeout=1) == (PNG, "image/png")


async def test_the_window_is_told_there_is_nothing_to_draw() -> None:
    # The long-poll has to return on its own, or the app's loop would
    # hang forever on a quiet session.
    assert await render_service.next_request(timeout=0.05) is None


async def test_polling_is_how_the_app_says_it_is_there() -> None:
    assert render_service.window_attached() is False
    await render_service.next_request(timeout=0.05)
    assert render_service.window_attached() is True


async def test_a_render_that_fails_reports_instead_of_timing_out() -> None:
    task = asyncio.create_task(
        render_service.request(
            bbcode="x", theme="dark", width=900, timeout=5
        )
    )
    await asyncio.sleep(0)
    handed = await render_service.next_request(timeout=1)
    assert handed is not None

    render_service.fail(handed.id, "offscreen window died")

    with pytest.raises(RuntimeError, match="offscreen window died"):
        await asyncio.wait_for(task, timeout=1)


async def test_a_late_answer_is_dropped_not_crashed_on() -> None:
    # The caller gave up; delivering to nobody must be a quiet False.
    assert render_service.deliver("no-such-request", PNG) is False
    assert render_service.fail("no-such-request", "boom") is False


async def test_giving_up_leaves_nothing_queued() -> None:
    with pytest.raises(asyncio.TimeoutError):
        await render_service.request(
            bbcode="x", theme="dark", width=900, timeout=0.05
        )
    # The abandoned request must not be handed to the window later.
    assert await render_service.next_request(timeout=0.05) is None


def test_the_result_route_reports_an_answer_nobody_wanted(
    api: TestClient,
) -> None:
    # A render that finished after its caller gave up. Saying so beats
    # a 500, and the app just moves on to the next poll.
    res = api.post("/render/result/unknown-id", content=PNG)
    assert res.status_code == 200
    assert res.json() == {
        "delivered": False,
        "bytes": len(PNG),
        "mime": "image/png",
    }


def test_an_empty_body_is_not_a_picture(api: TestClient) -> None:
    assert api.post("/render/result/whatever", content=b"").status_code == 422


def test_the_long_poll_returns_empty_handed(api: TestClient) -> None:
    res = api.get("/render/requests?timeout=1")
    assert res.status_code == 200
    assert res.json()["request"] is None
