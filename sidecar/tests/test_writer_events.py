"""Every character writer publishes its event, once per change.

The window shows what is on disk whatever changed it: a model over
MCP, the paired extension, or the app's own maintenance. It learns of
a change from the event bus (`GET /events`), so a writer that publishes
nothing leaves the window on stale state until the user reloads. The
mutation audit found Live and the image Trash silent without any test
noticing; this file holds every writer to it: Live, the registry,
images, the image Trash, Backups and the Backup Trash. The Workbench's
own events are in `test_events.py`.

A change is one event, not one per file: a Pull of a whole gallery is
one `images-changed`, or the window reloads once per picture.

Driven from outside: the window's REST routes, MCP tools and the
extension's routes, with F-list faked at the HTTP seam.
"""

from __future__ import annotations

import asyncio
import io
import re
import time
from collections import Counter
from pathlib import Path
from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import archive_backups
from mcp_helpers import call_tool, mcp_client
from sidecar_client import app_client
from test_mcp_edit import workbench  # noqa: F401

CID = "42"
NAME = "Lady Amber Blaise"
BACKUPS = f"/flist/character/{CID}/zip-backups"
TRASH = f"/flist/character/{CID}/trash"
IMAGES = f"/flist/character/{CID}/images"


def png(n: int) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (8 + n, 8), (n * 20 % 255, 10, 10)).save(out, "PNG")
    return out.getvalue()


async def published(action: Callable[[], Any], *, until: str | None = None) -> list[dict]:
    """Every event the bus delivers to a subscriber while `action` runs,
    and after it until an `until` event arrives (for work the action
    only schedules).

    `action` runs on a worker thread, as the sidecar runs a request,
    unless it is a coroutine function."""
    from services import events

    events.bind_loop(asyncio.get_running_loop())
    received: list[dict] = []
    async with events.subscribe() as sub:
        if asyncio.iscoroutinefunction(action):
            await action()
        else:
            await asyncio.to_thread(action)
        while until is not None and not any(e["event"] == until for e in received):
            received.append(await asyncio.wait_for(sub.queue.get(), timeout=10))
        # The bus hands off through the loop; let the rest land.
        await asyncio.sleep(0.05)
        while not sub.queue.empty():
            received.append(sub.queue.get_nowait())
    return received


def counts(received: list[dict], character_id: str = CID) -> Counter:
    """How often each event arrived for one character."""
    return Counter(
        e["event"] for e in received if e.get("character_id") == character_id
    )


@pytest.fixture
def client(workbench) -> TestClient:  # noqa: F811
    import server

    return app_client(server.app)


# ---- Live and the registry: a Pull -------------------------------------------


@pytest.fixture
def flist(httpx_mock):  # noqa: ANN001, ANN201
    """Signed in. F-list serves character `flist["id"]`, named
    `flist["name"]`, with the gallery `flist["images"]` (image id ->
    bytes)."""
    import httpx

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
    state: dict[str, Any] = {"id": 42, "name": NAME, "images": {}}

    def character_data(request):  # noqa: ANN001, ANN202
        return httpx.Response(
            200,
            json={
                "error": "",
                "id": state["id"],
                "name": state["name"],
                "description": "[b]Published.[/b]",
                "infotags": {},
                "kinks": {},
                "custom_kinks": {},
                "inlines": {},
                "images": [
                    {"image_id": image_id, "extension": "png", "description": "", "sort_order": i}
                    for i, image_id in enumerate(state["images"])
                ],
            },
        )

    def image(request):  # noqa: ANN001, ANN202
        image_id = re.search(r"/(\d+)\.png$", str(request.url)).group(1)
        return httpx.Response(200, content=state["images"][image_id])

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
    yield state
    flist_api.ticket_store().clear()


def pull(client: TestClient, name: str = NAME) -> None:
    with client.stream("POST", f"/flist/character/{name}/pull") as res:
        body = "".join(res.iter_text())
    assert "event: done" in body, body


async def test_a_pull_announces_live_and_its_images_once_each(client, flist) -> None:
    """Three pictures downloaded are one change to the image pool."""
    flist["images"] = {"9001": png(1), "9002": png(2), "9003": png(3)}

    received = await published(lambda: pull(client))

    seen = counts(received)
    assert seen["live-changed"] == 1, received
    assert seen["images-changed"] == 1, received


async def test_the_first_pull_of_a_character_announces_the_roster(client, flist) -> None:
    """The character comes into the archive: the character list gains it."""
    flist.update(id=77, name="Corin Ashvale")

    received = await published(lambda: pull(client, "Corin Ashvale"))

    assert counts(received, "77")["characters-changed"] == 1, received


async def test_pulling_a_known_character_leaves_the_roster_alone(client, flist) -> None:
    received = await published(lambda: pull(client))

    assert counts(received)["characters-changed"] == 0, received


@pytest.fixture
def extension(client, flist):  # noqa: ANN001, ANN201
    """The paired extension, for a character it finds by name: pulled
    once, as it is before any Upload."""
    from services import upload as upload_service
    import server

    pull(client)
    hs = upload_service.begin_handshake()
    upload_service.accept_handshake(hs["handshake_id"])
    # Entered, so a task a request schedules outlives the request.
    with app_client(server.app, headers={"X-Workbench-Auth": hs["token"]}) as c:
        yield c
    upload_service.revoke_token()


async def test_the_pull_after_an_upload_reaches_the_window(extension) -> None:
    """The extension reports Save on f-list.net and the sidecar pulls a
    moment later. The window ignores events attributed to itself, so
    that Pull must not say `ui`."""
    received = await published(
        lambda: extension.post("/restore/saved", json={"character": NAME, "delay_seconds": 0}),
        until="live-changed",
    )

    live = [e for e in received if e["event"] == "live-changed"]
    assert live[-1]["origin"] == "extension", received


# ---- images ------------------------------------------------------------------


async def test_an_uploaded_image_is_announced(client) -> None:
    received = await published(lambda: client.post(IMAGES, content=png(5)))

    assert counts(received)["images-changed"] == 1, received


async def test_uploading_bytes_the_pool_already_holds_changes_nothing(client) -> None:
    client.post(IMAGES, content=png(5))

    received = await published(lambda: client.post(IMAGES, content=png(5)))

    assert counts(received)["images-changed"] == 0, received


async def test_a_model_importing_several_images_is_one_change(workbench, tmp_path) -> None:  # noqa: F811
    from services import settings as settings_service

    folder = tmp_path / "Outputs"
    folder.mkdir()
    settings_service.update({"image_import_roots": [str(folder)]})
    sources = []
    for n in (1, 2, 3):
        src = folder / f"pic{n}.png"
        src.write_bytes(png(n))
        sources.append({"source_path": str(src)})

    async def import_them() -> None:
        async with mcp_client("character") as session:
            await call_tool(session, "import_images", character=NAME, items=sources)

    received = await published(import_them)

    changes = [e for e in received if e["event"] == "images-changed"]
    assert len(changes) == 1, received
    assert changes[0]["origin"] == "mcp:import_images"


# ---- the image Trash ---------------------------------------------------------


async def test_moving_images_to_the_trash_and_back_is_announced(client) -> None:
    image_id = client.post(IMAGES, content=png(6)).json()["image_id"]

    trashed = await published(
        lambda: client.post(f"{IMAGES}/trash", json={"image_ids": [image_id]})
    )
    restored = await published(
        lambda: client.post(f"{TRASH}/put-back", json={"image_ids": [image_id]})
    )

    assert counts(trashed)["images-changed"] == 1, trashed
    assert counts(restored)["images-changed"] == 1, restored


async def test_a_model_moving_an_image_to_the_trash_is_announced(client) -> None:
    image_id = client.post(IMAGES, content=png(7)).json()["image_id"]

    async def trash_it() -> None:
        async with mcp_client("character") as session:
            await call_tool(session, "trash_images", character=NAME, image_ids=[image_id])

    received = await published(trash_it)

    changes = [e for e in received if e["event"] == "images-changed"]
    assert changes and changes[-1]["origin"] == "mcp:trash_images", received


@pytest.mark.invariant_exempt(
    "nothing_vanishes",
    reason="a human emptying the Trash is the one deletion the rule allows",
)
async def test_deleting_images_from_the_trash_for_good_is_announced(client) -> None:
    image_id = client.post(IMAGES, content=png(8)).json()["image_id"]
    client.post(f"{IMAGES}/trash", json={"image_ids": [image_id]})

    received = await published(
        lambda: client.post(f"{TRASH}/purge", json={"image_ids": [image_id]})
    )

    assert counts(received)["images-changed"] == 1, received


# ---- Backups -----------------------------------------------------------------


def make_backup(client: TestClient) -> str:
    res = client.post(f"/flist/character/{CID}/zip-backup")
    assert res.status_code == 200, res.text
    return res.json()["filename"]


async def test_a_new_backup_is_announced(client) -> None:
    received = await published(lambda: make_backup(client))

    assert counts(received)["backups-changed"] == 1, received


async def test_naming_a_backup_is_announced(client) -> None:
    filename = make_backup(client)

    received = await published(
        lambda: client.patch(f"{BACKUPS}/{filename}", json={"name": "Before the rewrite"})
    )

    assert counts(received)["backups-changed"] == 1, received


async def test_a_model_making_a_named_backup_is_one_change(workbench) -> None:  # noqa: F811
    async def back_up() -> None:
        async with mcp_client("character") as session:
            await call_tool(session, "create_backup", character=NAME, note="Before the rewrite")

    received = await published(back_up)

    changes = [e for e in received if e["event"] == "backups-changed"]
    assert len(changes) == 1, received
    assert changes[0]["origin"] == "mcp:create_backup"


async def test_the_backup_before_an_upload_reaches_the_window(extension) -> None:
    """The extension backs up the form before every Upload. The window
    ignores events attributed to itself, so that Backup must not say
    `ui`."""
    form = {"character": {"id": "42", "name": NAME, "description": "[b]Before.[/b]"}}

    received = await published(
        lambda: extension.post(
            "/restore/snapshot/fresh", json={"character": NAME, "payload": form}
        )
    )

    changes = [e for e in received if e["event"] == "backups-changed"]
    assert changes and changes[-1]["origin"] == "extension", received


async def test_back_up_all_announces_each_character_once(client, flist) -> None:
    flist["images"] = {"9001": png(1), "9002": png(2)}

    def back_up_all() -> None:
        with client.stream("POST", "/flist/backup-all") as res:
            body = "".join(res.iter_text())
        assert "event: done" in body, body

    received = await published(back_up_all)

    seen = counts(received)
    assert seen["live-changed"] == 1, received
    assert seen["images-changed"] == 1, received
    assert seen["backups-changed"] == 1, received


# ---- the Backup Trash --------------------------------------------------------


async def test_moving_a_backup_to_the_trash_and_back_is_announced(client) -> None:
    filename = make_backup(client)
    client.patch(f"{BACKUPS}/{filename}", json={"name": "Before the rewrite"})

    trashed = await published(lambda: client.delete(f"{BACKUPS}/{filename}"))
    [entry] = client.get(TRASH).json()["backups"]
    restored = await published(
        lambda: client.post(f"{TRASH}/backups/put-back", json={"ids": [entry["id"]]})
    )

    assert counts(trashed)["backups-changed"] == 1, trashed
    assert counts(restored)["backups-changed"] == 1, restored


@pytest.mark.invariant_exempt(
    "nothing_vanishes",
    reason="a human emptying the Trash is the one deletion the rule allows",
)
async def test_deleting_a_backup_from_the_trash_for_good_is_announced(client) -> None:
    filename = make_backup(client)
    client.delete(f"{BACKUPS}/{filename}")
    [entry] = client.get(TRASH).json()["backups"]

    received = await published(
        lambda: client.post(f"{TRASH}/backups/purge", json={"ids": [entry["id"]]})
    )

    assert counts(received)["backups-changed"] == 1, received


# ---- the window listens ------------------------------------------------------


def test_the_window_subscribes_to_every_event_the_sidecar_declares() -> None:
    """The renderer has to name each event to receive it; one it does
    not name is dropped by the browser without a trace."""
    from services import events

    declared = {
        value
        for key, value in vars(events).items()
        if key.isupper() and key.endswith("_CHANGED")
    }
    stream = Path(__file__).resolve().parents[2] / "renderer/src/lib/eventStream.ts"
    named = set(re.findall(r"'([a-z-]+-changed)'", stream.read_text(encoding="utf-8")))

    assert declared - named == set()
    assert {"backups-changed", "characters-changed"} <= declared
