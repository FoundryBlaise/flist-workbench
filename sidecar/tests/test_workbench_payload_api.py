"""The Workbench save contract, from outside the sidecar.

The window reads and saves a character's one Workbench through
`/flist/character/{id}/workbench/payload`. The read hands out the
payload with its etag; a write must send that etag back as `If-Match`,
or it is refused before anything on disk changes. A write that
goes through replaces the file in one step and is announced on the
change stream the window and MCP listen to.
"""

from __future__ import annotations

import importlib
from pathlib import Path
from typing import Any

import pytest
from sidecar_client import app_client

NAME = "Wren Ashdown"
URL = "/flist/character/42/workbench/payload"


@pytest.fixture
def sidecar(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)

    import character_archive
    import paths
    import server

    importlib.reload(paths)
    importlib.reload(character_archive)

    character_archive.register_character("42", NAME)
    character_archive.write_live(
        "42",
        {
            "character": {"id": 42, "name": NAME, "description": "[b]Published.[/b]"},
            "infotags": {"info_9": "Human"},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
            "fetched_at": 1000,
        },
    )
    return app_client(server.app), tmp_path


def _edited(description: str) -> dict[str, Any]:
    return {
        "_schema_version": 6,
        "_overlay": ["character.description"],
        "character": {"id": 42, "name": NAME, "description": description},
    }


def test_reading_the_workbench_gives_its_payload_and_etag(sidecar) -> None:
    api, _ = sidecar

    res = api.get(URL)

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["payload"]["character"]["description"] == "[b]Published.[/b]"
    assert isinstance(body["etag"], str) and len(body["etag"]) == 64


def test_a_write_carrying_the_etag_it_read_is_saved(sidecar) -> None:
    api, _ = sidecar
    read = api.get(URL).json()

    put = api.put(URL, json=_edited("Rewritten."), headers={"If-Match": read["etag"]})

    assert put.status_code == 200, put.text
    etag = put.json()["etag"]
    assert etag != read["etag"]
    again = api.get(URL).json()
    assert again["etag"] == etag
    assert again["payload"]["character"]["description"] == "Rewritten."


def test_a_write_without_if_match_is_refused_and_changes_nothing(sidecar) -> None:
    """The bug this guards: the window seeded its editor from Live,
    then autosaved that over a much longer draft with no etag, and the
    sidecar took it. A write that never read the Workbench has not seen
    what it is replacing."""
    api, _ = sidecar
    before = api.get(URL).json()

    res = api.put(URL, json=_edited("short"))

    assert res.status_code == 409
    assert res.json()["code"] == "etag_required"
    assert res.json()["current_etag"] == before["etag"]
    assert api.get(URL).json() == {**before, "created": False}


def test_a_write_with_a_stale_etag_is_refused_and_changes_nothing(sidecar) -> None:
    api, _ = sidecar
    first = api.get(URL).json()
    mine = api.put(URL, json=_edited("Mine."), headers={"If-Match": first["etag"]})
    assert mine.status_code == 200
    saved = api.get(URL).json()

    res = api.put(URL, json=_edited("Theirs."), headers={"If-Match": first["etag"]})

    assert res.status_code == 409
    assert res.json()["code"] == "etag_mismatch"
    assert res.json()["current_etag"] == mine.json()["etag"]
    assert api.get(URL).json() == saved


def test_a_write_that_fails_halfway_leaves_the_workbench_as_it_was(
    sidecar, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Atomic: the new contents go to a temporary file that replaces
    the Workbench in one step. When that step fails, the old Workbench
    is still whole and no temporary file is left behind."""
    api, data_dir = sidecar
    before = api.get(URL).json()

    def locked(self: Path, target: Any) -> Path:
        raise OSError("simulated lock")

    with monkeypatch.context() as m:
        m.setattr(Path, "replace", locked)
        with pytest.raises(OSError):
            api.put(URL, json=_edited("Lost."), headers={"If-Match": before["etag"]})

    assert api.get(URL).json() == {**before, "created": False}
    assert list(data_dir.rglob("*.tmp")) == []


async def test_a_saved_write_is_announced_with_its_new_etag(sidecar) -> None:
    """The etag in the change event is what lets the window tell its
    own save from someone else's."""
    import asyncio

    from services import events

    api, _ = sidecar
    events.bind_loop(asyncio.get_running_loop())
    read = await asyncio.to_thread(api.get, URL)
    received: list[dict] = []

    async with events.subscribe() as sub:
        put = await asyncio.to_thread(
            api.put,
            URL,
            json=_edited("Announced."),
            headers={"If-Match": read.json()["etag"]},
        )
        while not sub.queue.empty() or not received:
            received.append(await asyncio.wait_for(sub.queue.get(), timeout=1))

    changes = [
        e for e in received if e["event"] == events.SET_PAYLOAD_CHANGED
    ]
    assert changes, received
    assert changes[-1]["character_id"] == "42"
    assert changes[-1]["etag"] == put.json()["etag"]
    assert changes[-1]["origin"] == "ui"


async def test_a_refused_write_announces_nothing(sidecar) -> None:
    import asyncio

    from services import events

    api, _ = sidecar
    events.bind_loop(asyncio.get_running_loop())
    await asyncio.to_thread(api.get, URL)

    async with events.subscribe() as sub:
        res = await asyncio.to_thread(api.put, URL, json=_edited("Refused."))
        await asyncio.sleep(0.1)
        received = [sub.queue.get_nowait() for _ in range(sub.queue.qsize())]

    assert res.status_code == 409
    assert [e for e in received if e["event"] == events.SET_PAYLOAD_CHANGED] == []


def test_the_read_that_makes_the_workbench_from_live_says_so(sidecar) -> None:
    """`created` tells the window that nobody has edited this copy yet,
    so its own first save may go over it."""
    api, _ = sidecar

    first = api.get(URL).json()
    second = api.get(URL).json()

    assert first["created"] is True
    assert second["created"] is False
    assert second["etag"] == first["etag"]


def test_a_read_that_must_not_create_finds_no_workbench(sidecar) -> None:
    api, _ = sidecar

    res = api.get(URL, params={"create": "false"})

    assert res.status_code == 404
    assert res.json()["code"] == "no_workbench"
    assert api.get(URL).json()["created"] is True, "the read made nothing"


def test_a_character_without_live_has_no_workbench_to_read_or_write(
    sidecar,
) -> None:
    api, _ = sidecar
    import character_archive

    character_archive.register_character("43", "Moss Fernley")
    url = "/flist/character/43/workbench/payload"

    read = api.get(url)
    write = api.put(url, json=_edited("Nowhere."), headers={"If-Match": "0" * 64})

    assert read.status_code == 404
    assert read.json()["code"] == "no_workbench"
    assert write.status_code == 409
    assert write.json()["code"] == "etag_mismatch"
    assert write.json()["current_etag"] is None


def test_a_payload_that_is_not_a_workbench_is_refused(sidecar) -> None:
    api, _ = sidecar
    before = api.get(URL).json()

    res = api.put(
        URL,
        json={"_schema_version": 6, "_overlay": []},
        headers={"If-Match": before["etag"]},
    )

    assert res.status_code == 422
    assert res.json()["code"] == "invalid_workbench_payload"
    assert api.get(URL).json()["etag"] == before["etag"]
