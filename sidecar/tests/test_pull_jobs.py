"""Pull and Back up all run as jobs.

A Pull or Back up all is a job of the one job model (`services.jobs`):
starting one answers with its id, the progress stream only follows it,
and only a cancel by id stops it. One job holds a character at a time;
Back up all holds every character.

F-list is faked at the HTTP seam, with a gate that holds a chosen image
download until the test lets it through, so a job can be caught while it
runs. Everything else is the real app.
"""

from __future__ import annotations

import asyncio
import io
import json
import re
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from sidecar_client import SECRET_HEADER, TEST_LAUNCH_SECRET, app_client, error_code

NAME = "Corin Ashvale"
CID = "5150"
OTHER = "Brisk Tallow"
OTHER_CID = "5151"
IMAGES = ("101", "102", "103")
DESCRIPTION = "[b]Pulled whole.[/b]"


def png(n: int) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (8 + n, 8), (n * 20 % 255, 10, 10)).save(out, "PNG")
    return out.getvalue()


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    data = tmp_path / "data"
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(data))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import archive_registry
    import paths
    import restore as restore_svc
    from services import jobs

    importlib.reload(paths)
    importlib.reload(archive_registry)
    importlib.reload(restore_svc)
    monkeypatch.setattr(jobs, "_registry", jobs.JobRegistry())
    yield data
    restore_svc.revoke_token()


@pytest.fixture
def client(data_dir: Path) -> TestClient:
    import server

    return app_client(server.app)


class Gate:
    """Holds the download of one image until `open()`: `reached` is set
    once a download has stopped at it."""

    def __init__(self) -> None:
        self.image_id: str | None = None
        self.reached = threading.Event()
        self._open = threading.Event()

    def hold(self, image_id: str) -> None:
        self.image_id = image_id
        self.reached.clear()
        self._open.clear()

    def open(self) -> None:
        self._open.set()

    async def pass_through(self, image_id: str) -> None:
        # Waits by sleeping, so the job's loop stays free to take a
        # cancel while a download hangs here.
        if image_id != self.image_id:
            return
        self.reached.set()
        deadline = time.monotonic() + 10
        while not self._open.is_set():
            assert time.monotonic() < deadline, "the test never opened the gate"
            await asyncio.sleep(0.01)


@pytest.fixture
def flist(httpx_mock, monkeypatch: pytest.MonkeyPatch):  # noqa: ANN001, ANN201
    """Signed in with two characters, each with three gallery images.
    F-list answers at once (no pacing); `flist.gate` holds a download."""
    import httpx

    import flist_api

    fast = flist_api.RateLimiter(per_second=1000.0, per_hour_cap=1_000_000)
    monkeypatch.setattr(flist_api, "_LIMITER", fast)
    monkeypatch.setattr(flist_api, "_CDN_LIMITER", fast)
    flist_api.ticket_store().set(
        flist_api.Ticket(
            account="corin-account",
            value="test-ticket",
            password="test-password",
            acquired_at=time.monotonic(),
        ),
        characters=[{"id": int(CID), "name": NAME}, {"id": int(OTHER_CID), "name": OTHER}],
    )
    gate = Gate()
    ids = {NAME: CID, OTHER: OTHER_CID}

    def character_data(request):  # noqa: ANN001, ANN202
        name = dict(httpx.QueryParams(request.content.decode()))["name"]
        cid = ids[name]
        return httpx.Response(
            200,
            json={
                "error": "",
                "id": int(cid),
                "name": name,
                "description": DESCRIPTION,
                "infotags": {},
                "kinks": {},
                "custom_kinks": {},
                "inlines": {},
                "images": [
                    {"image_id": f"{cid}{i}", "extension": "png", "description": "", "sort_order": n}
                    for n, i in enumerate(IMAGES)
                ],
            },
        )

    async def image(request):  # noqa: ANN001, ANN202
        image_id = re.search(r"/(\d+)\.png$", str(request.url)).group(1)
        await gate.pass_through(image_id)
        return httpx.Response(200, content=png(int(image_id) % 97))

    httpx_mock.add_callback(
        character_data, url=flist_api.CHARACTER_DATA_URL, method="POST", is_reusable=True
    )
    httpx_mock.add_callback(
        image,
        url=re.compile(re.escape(flist_api.STATIC_BASE) + r"/images/charimage/\d+\.png"),
        method="GET",
        is_optional=True,
        is_reusable=True,
    )
    httpx_mock.add_response(
        url=re.compile(re.escape(flist_api.STATIC_BASE) + r"/images/avatar/.*"),
        method="GET",
        content=png(1),
        is_optional=True,
        is_reusable=True,
    )
    yield gate
    gate.open()
    flist_api.ticket_store().clear()


# ---- helpers ------------------------------------------------------------------


def sse_events(body: str) -> list[tuple[str, dict]]:
    out = []
    for block in body.split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        if "event" in lines:
            out.append((lines["event"], json.loads(lines.get("data") or "{}")))
    return out


def wait_finished(client: TestClient, job_id: str, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = client.get(f"/jobs/{job_id}").json()
        if job["state"] in ("done", "cancelled", "failed"):
            return job
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} never finished: {job}")


def start(client: TestClient, path: str) -> dict:
    """Start a job without following it: the job, as the route answers it."""
    res = client.post(path, params={"wait": "false"})
    assert res.status_code == 202, res.text
    return res.json()


def pulled_images(cid: str) -> set[str]:
    import archive_images

    return {p.stem for p in archive_images.images_dir(cid).glob("*.png")}


def pull_status(client: TestClient, cid: str) -> str:
    """The Pull integrity the character list shows for `cid`."""
    rows = client.get("/flist/characters").json()["characters"]
    row = next(r for r in rows if str(r.get("id")) == cid)
    return row["pull_status"]["status"]


def live_description(client: TestClient, cid: str = CID) -> str | None:
    res = client.get(f"/flist/character/{cid}/live")
    if res.status_code != 200:
        return None
    return json.dumps(res.json())


async def close_after_first_event(path: str) -> list[tuple[str, dict]]:
    """POST `path` the way the window does, read the first event of its
    stream, then go away as a closed progress view would."""
    import server

    received: list[bytes] = []
    gone = asyncio.Event()
    asked = False

    async def receive() -> dict:
        nonlocal asked
        if not asked:
            asked = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await gone.wait()
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        if message["type"] == "http.response.body" and message.get("body"):
            received.append(message["body"])
            gone.set()

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"host", b"127.0.0.1:27384"),
            (SECRET_HEADER.lower().encode(), TEST_LAUNCH_SECRET.encode()),
            (b"accept", b"text/event-stream"),
        ],
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 27384),
        "state": {},
    }
    await asyncio.wait_for(server.app(scope, receive, send), timeout=10)
    return sse_events(b"".join(received).decode())


# ---- the stream only follows -------------------------------------------------


async def test_a_pull_whose_stream_is_closed_still_finishes_and_live_is_whole(
    client: TestClient, flist: Gate
) -> None:
    flist.hold(f"{CID}{IMAGES[1]}")

    events = await close_after_first_event(f"/flist/character/{NAME}/pull")
    (name, job), *_ = events
    assert name == "job"
    assert await asyncio.to_thread(flist.reached.wait, 10)
    flist.open()

    finished = await asyncio.to_thread(wait_finished, client, job["id"])
    assert finished["state"] == "done", finished
    assert "Pulled whole." in (live_description(client) or "")
    assert pulled_images(CID) == {f"{CID}{i}" for i in IMAGES}
    assert pull_status(client, CID) == "complete"


def test_a_second_pull_of_the_same_character_is_refused_busy(
    client: TestClient, flist: Gate
) -> None:
    flist.hold(f"{CID}{IMAGES[0]}")
    first = start(client, f"/flist/character/{NAME}/pull")
    assert flist.reached.wait(10)

    second = client.post(f"/flist/character/{NAME}/pull")

    assert second.status_code == 409
    assert error_code(second) == "character_busy"
    assert second.json()["details"]["job_id"] == first["id"]
    flist.open()
    assert wait_finished(client, first["id"])["state"] == "done"


def test_a_pull_of_another_character_runs_alongside(client: TestClient, flist: Gate) -> None:
    flist.hold(f"{CID}{IMAGES[0]}")
    first = start(client, f"/flist/character/{NAME}/pull")
    assert flist.reached.wait(10)

    other = start(client, f"/flist/character/{OTHER}/pull")

    assert wait_finished(client, other["id"])["state"] == "done"
    flist.open()
    assert wait_finished(client, first["id"])["state"] == "done"


def test_back_up_all_is_refused_while_a_pull_runs(client: TestClient, flist: Gate) -> None:
    flist.hold(f"{CID}{IMAGES[0]}")
    pull = start(client, f"/flist/character/{NAME}/pull")
    assert flist.reached.wait(10)

    res = client.post("/flist/backup-all")

    assert res.status_code == 409
    assert error_code(res) == "character_busy"
    assert res.json()["details"]["job_id"] == pull["id"]
    flist.open()
    wait_finished(client, pull["id"])


def test_a_pull_is_refused_while_back_up_all_runs(client: TestClient, flist: Gate) -> None:
    flist.hold(f"{CID}{IMAGES[0]}")
    sweep = start(client, "/flist/backup-all")
    assert flist.reached.wait(10)

    pull = client.post(f"/flist/character/{OTHER}/pull")
    again = client.post("/flist/backup-all")

    for refused in (pull, again):
        assert refused.status_code == 409
        assert error_code(refused) == "character_busy"
        assert refused.json()["details"]["job_id"] == sweep["id"]
    flist.open()
    assert wait_finished(client, sweep["id"])["state"] == "done"


def test_a_reopened_progress_view_follows_the_job_from_its_start(
    client: TestClient, flist: Gate
) -> None:
    job = start(client, f"/flist/character/{NAME}/pull")
    wait_finished(client, job["id"])

    with client.stream("GET", f"/jobs/{job['id']}/events") as res:
        events = sse_events("".join(res.iter_text()))

    names = [name for name, _ in events]
    assert names[:3] == ["job", "ticket", "fetching"]
    assert names.count("image") == len(IMAGES)
    assert names[-1] == "done"
    assert events[-1][1]["character_id"] == CID


# ---- cancel by id ------------------------------------------------------------


def test_cancelling_a_pull_by_id_stops_it_and_keeps_what_it_wrote(
    client: TestClient, flist: Gate
) -> None:
    flist.hold(f"{CID}{IMAGES[1]}")
    job = start(client, f"/flist/character/{NAME}/pull")
    assert flist.reached.wait(10)

    asked = client.delete(f"/jobs/{job['id']}").json()

    assert asked["cancel_requested"] is True
    finished = wait_finished(client, job["id"])
    assert finished["state"] == "cancelled", finished
    # Live came first and is whole; the images stop where the cancel
    # found the Pull, and the Pull reads as interrupted.
    assert "Pulled whole." in (live_description(client) or "")
    assert pulled_images(CID) == {f"{CID}{IMAGES[0]}"}
    assert pull_status(client, CID) == "interrupted"
    with client.stream("GET", f"/jobs/{job['id']}/events") as res:
        assert sse_events("".join(res.iter_text()))[-1][0] == "cancelled"
    # The character is free again.
    flist.open()
    again = start(client, f"/flist/character/{NAME}/pull")
    assert wait_finished(client, again["id"])["state"] == "done"


def test_cancelling_back_up_all_by_id_stops_it_and_keeps_what_it_wrote(
    client: TestClient, flist: Gate
) -> None:
    flist.hold(f"{OTHER_CID}{IMAGES[0]}")
    job = start(client, "/flist/backup-all")
    assert flist.reached.wait(10)

    client.delete(f"/jobs/{job['id']}")

    finished = wait_finished(client, job["id"])
    assert finished["state"] == "cancelled", finished
    assert finished["progress"]["saved"] == 1
    assert len(client.get(f"/flist/character/{CID}/zip-backups").json()["backups"]) == 1
    assert client.get(f"/flist/character/{OTHER_CID}/zip-backups").json()["backups"] == []
    assert pulled_images(OTHER_CID) == set()
    assert pull_status(client, OTHER_CID) == "interrupted"


# ---- MCP ---------------------------------------------------------------------


async def test_mcp_pull_without_waiting_answers_a_job_that_get_job_and_cancel_job_take(
    client: TestClient, flist: Gate
) -> None:
    from mcp_helpers import call_tool, mcp_client

    flist.hold(f"{CID}{IMAGES[1]}")
    async with mcp_client("character") as session:
        _, started = await call_tool(session, "pull_character", character=NAME, wait=False)
        assert await asyncio.to_thread(flist.reached.wait, 10)
        _, polled = await call_tool(session, "get_job", job_id=started["job_id"])
        _, asked = await call_tool(session, "cancel_job", job_id=started["job_id"])

    assert polled["kind"] == "pull" and polled["state"] == "running"
    assert asked["cancel_requested"] is True
    finished = await asyncio.to_thread(wait_finished, client, started["job_id"])
    assert finished["state"] == "cancelled"


async def test_mcp_back_up_all_without_waiting_answers_a_job_that_finishes_on_its_own(
    client: TestClient, flist: Gate
) -> None:
    from mcp_helpers import call_tool, mcp_client

    async with mcp_client("character") as session:
        _, started = await call_tool(session, "backup_all_characters", wait=False)
    finished = await asyncio.to_thread(wait_finished, client, started["job_id"])

    assert finished["kind"] == "backup-all"
    assert finished["state"] == "done"
    assert finished["result"]["saved"] == 2
    assert {row["name"] for row in finished["result"]["characters"]} == {NAME, OTHER}


async def test_mcp_pull_of_a_character_a_pull_holds_is_refused_busy(
    client: TestClient, flist: Gate
) -> None:
    from mcp_helpers import call_tool, mcp_client, tool_error_text

    flist.hold(f"{CID}{IMAGES[0]}")
    first = await asyncio.to_thread(start, client, f"/flist/character/{NAME}/pull")
    assert await asyncio.to_thread(flist.reached.wait, 10)
    async with mcp_client("character") as session:
        result, _ = await call_tool(session, "pull_character", character=NAME)

    text = tool_error_text(result)
    assert "character_busy" in text and first["id"] in text
    flist.open()
    await asyncio.to_thread(wait_finished, client, first["id"])


# ---- one image step ----------------------------------------------------------


def test_back_up_all_has_no_image_download_of_its_own() -> None:
    """It pulls each character with Pull's own steps (`pull.store_live`,
    `pull.pull_images`), so the two cannot drift apart."""
    source = (Path(__file__).parent.parent / "services" / "backup_all.py").read_text(
        encoding="utf-8"
    )
    for name in (
        "fetch_bytes",
        "download_to",
        "write_character_image",
        "write_pull_state",
        "images_dir",
        "charimage",
    ):
        assert name not in source, name
    assert "pull_service.pull_images" in source
