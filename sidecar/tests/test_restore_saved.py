"""After the user publishes on f-list.net, Live catches up — and only Live.

The extension writes a profile into F-list's own edit form and the user
presses Save. At that moment Workbench's copy of Live is stale: it
still holds whatever the last pull found. The extension says so, and
the app re-pulls.

What must not happen is the Workbench being touched. The user may have
carried on editing their draft while the upload was going on, and
replacing it with what they just published would throw away work they
never asked to lose.
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


def test_saving_schedules_a_pull(paired, monkeypatch) -> None:
    client, _archive, server = paired
    pulled: list[str] = []

    async def fake_run(name: str):
        pulled.append(name)
        if False:  # pragma: no cover - generator shape only
            yield ("", {})

    monkeypatch.setattr(server.pull_service, "run", fake_run)

    res = client.post(
        "/restore/saved",
        json={"character": "Lady Amber Blaise", "delay_seconds": 0},
    )

    assert res.status_code == 200
    assert res.json()["scheduled"] is True
    # Fire-and-forget: the answer comes back before the pull runs. The
    # app's loop lives in the TestClient's own thread, so wait in real
    # time rather than trying to drive it from here.
    _wait_until(lambda: pulled == ["Lady Amber Blaise"])
    assert pulled == ["Lady Amber Blaise"]


def test_the_workbench_is_not_touched(paired, monkeypatch) -> None:
    client, archive, server = paired
    bench = archive.resolve_workbench("42")
    archive.write_set_payload(
        "42",
        bench.id,
        {
            "_schema_version": archive.WORKING_SCHEMA_VERSION,
            "_overlay": ["character.description"],
            "character": {"description": "a draft I am still writing"},
        },
        expected_etag=None,
    )
    before = archive.read_set_payload("42", bench.id)

    ran = {"done": False}

    async def fake_run(name: str):
        ran["done"] = True
        if False:  # pragma: no cover
            yield ("", {})

    monkeypatch.setattr(server.pull_service, "run", fake_run)
    client.post(
        "/restore/saved",
        json={"character": "Lady Amber Blaise", "delay_seconds": 0},
    )
    _wait_until(lambda: ran["done"])

    assert ran["done"], "the pull never ran, so this proves nothing"
    assert archive.read_set_payload("42", bench.id) == before
    assert len(archive.list_sets("42")) == 1


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


def test_the_extension_can_hand_over_the_real_ids(paired) -> None:
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
    assert res.json()["sets_rewritten"] == 1
    payload = archive.read_set_payload("42", bench.id)
    assert [r["image_id"] for r in payload["images"]] == ["47000849"]
    assert (archive.images_dir("42") / "47000849.png").exists()


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
