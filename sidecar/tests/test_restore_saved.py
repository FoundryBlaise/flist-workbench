"""After the user publishes on f-list.net, Live catches up — and only Live.

The extension writes a profile into F-list's own edit form and the user
presses Save. At that moment Workbench's copy of Live is stale: it
still holds whatever the last pull found. The extension says so, and
the app re-pulls.

What must not happen is the Workbench being touched. The user may have
carried on editing their draft while the upload was going on, and
replacing it with what they just published would throw away work they
never asked to lose.

The Pull here is the real one; only F-list is faked, at the HTTP seam.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def _wait_until(predicate, timeout: float = 2.0) -> None:
    """Poll until the background pull has run, or give up and let the
    assertion report what it found."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)


@pytest.fixture
def paired(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import character_archive
    import restore as restore_svc
    import server

    importlib.reload(character_archive)
    importlib.reload(restore_svc)

    character_archive.register_character("42", "Lady Amber Blaise")
    character_archive.write_live(
        "42",
        {
            # live.json is the raw F-list payload: the name sits at the
            # top level, which is where restore._character_id_for_name
            # looks for it.
            "name": "Lady Amber Blaise",
            "character": {
                "id": 42,
                "name": "Lady Amber Blaise",
                "description": "[b]Published.[/b]",
            },
            "infotags": {},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
            "fetched_at": 1000,
        },
    )
    hs = restore_svc.begin_handshake()
    restore_svc.accept_handshake(hs["handshake_id"])
    client = TestClient(server.app)
    client.headers.update({"X-Workbench-Auth": hs["token"]})
    return client, character_archive, server


@pytest.fixture
def fake_flist(httpx_mock):
    """F-list at the HTTP seam, as the extension leaves it: the profile
    now carries what the user just saved on f-list.net. A session is
    open, so the Pull needs no sign-in."""
    import flist_api

    flist_api.ticket_store().set(
        flist_api.Ticket(
            account="azure-viper-account",
            value="test-ticket",
            password="test-password",
            acquired_at=time.monotonic(),
        )
    )
    httpx_mock.add_response(
        url=flist_api.CHARACTER_DATA_URL,
        method="POST",
        json={
            "error": "",
            "id": 42,
            "name": "Lady Amber Blaise",
            "description": "[b]Just saved on f-list.net.[/b]",
            "infotags": {},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
        },
    )
    httpx_mock.add_response(
        url=flist_api.avatar_url("Lady Amber Blaise"),
        method="GET",
        content=PNG,
        is_optional=True,
    )
    yield httpx_mock
    flist_api.ticket_store().clear()


def test_the_workbench_is_not_touched_while_live_catches_up(paired, fake_flist) -> None:
    client, _archive, _server = paired
    bench = client.get("/flist/character/42/workbench").json()["workbench"]
    payload_url = f"/flist/character/42/sets/{bench['id']}/payload"
    current = client.get(payload_url).json()
    draft = current["payload"]
    draft["_overlay"] = ["character.description"]
    draft["character"] = {"description": "a draft I am still writing"}
    res = client.put(payload_url, json=draft, headers={"If-Match": current["etag"]})
    assert res.status_code == 200, res.text
    before = client.get(payload_url).json()
    asked_at = time.time()

    res = client.post(
        "/restore/saved",
        json={"character": "Lady Amber Blaise", "delay_seconds": 0},
    )
    assert res.status_code == 200
    assert res.json()["scheduled"] is True

    def pull_finished() -> bool:
        events = client.get("/flist/activity").json()["events"]
        return any(
            e["kind"] in ("pull-done", "pull-error") and e["t"] >= asked_at
            for e in events
        )

    # Fire-and-forget: wait for the Pull to finish in the app's thread.
    _wait_until(pull_finished, timeout=10.0)
    assert pull_finished(), "the Pull never finished, so this proves nothing"
    live = client.get("/flist/character/42/live").json()
    assert live["description"] == "[b]Just saved on f-list.net.[/b]"
    assert client.get(payload_url).json() == before
    sets = client.get("/flist/character/42/sets").json()
    assert [s["id"] for s in sets["sets"]] == [bench["id"]]


def test_it_needs_the_pairing_token(paired) -> None:
    client, _archive, _server = paired
    res = client.post(
        "/restore/saved",
        json={"character": "Lady Amber Blaise"},
        headers={"X-Workbench-Auth": "not-the-token"},
    )
    assert res.status_code in (401, 403)


def test_a_nameless_save_is_refused(paired) -> None:
    client, _archive, _server = paired
    res = client.post("/restore/saved", json={"character": "   "})
    assert res.status_code == 422


# ---- the ids F-list gave our uploads ------------------------------------


PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


def test_the_extensions_early_id_report_defers(paired) -> None:
    """The extension learns real ids at upload time — before the profile
    is saved — so the report must not rewrite anything. The fold-over to
    F-list's id happens at the pull that proves the picture is really on
    the profile (see test_dedupe_local_after_pull_*)."""
    client, archive, _server = paired
    local_id = archive.add_uploaded_image("42", PNG)["image_id"]
    bench = archive.resolve_workbench("42")
    archive.write_set_payload(
        "42",
        bench.id,
        {
            "_schema_version": archive.WORKING_SCHEMA_VERSION,
            "_overlay": ["images"],
            "character": {"description": "x"},
            "images": [{"image_id": local_id, "description": "", "sort_order": 0}],
        },
        expected_etag=None,
    )

    res = client.post(
        "/restore/image-ids",
        json={"character": "Lady Amber Blaise", "mapping": {local_id: "47000849"}},
    )

    assert res.status_code == 200
    assert res.json()["deferred"] is True
    payload = archive.read_set_payload("42", bench.id)
    assert [r["image_id"] for r in payload["images"]] == [local_id]
    local_file = next(archive.images_dir("42").glob(f"{local_id}.*"))
    assert local_file.exists()
    assert not (archive.images_dir("42") / "47000849.png").exists()


def test_reporting_ids_needs_the_pairing_token(paired) -> None:
    client, _archive, _server = paired
    res = client.post(
        "/restore/image-ids",
        json={"character": "Lady Amber Blaise", "mapping": {}},
        headers={"X-Workbench-Auth": "not-the-token"},
    )
    assert res.status_code in (401, 403)


def test_an_unknown_character_is_a_404(paired) -> None:
    client, _archive, _server = paired
    res = client.post(
        "/restore/image-ids",
        json={"character": "Nobody At All", "mapping": {}},
    )
    assert res.status_code == 404
