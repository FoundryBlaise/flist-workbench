"""The archive holds only characters the user actually has.

A character comes into the archive when it is pulled from F-list,
whether by the window's Pull, by Back up all, or by the re-pull the
extension asks for after the user saves on f-list.net (which on a
fresh install is the first Pull too). Every route that names a
character by id only finds it. An id the archive does not know, even a
perfectly safe one, answers 404 `character_not_found` and leaves the
disk as it was, so which characters exist never depends on which URLs
happened to be requested.

F-list is faked at the HTTP seam; everything else is the real app.
"""

from __future__ import annotations

import io
import json
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import archive_registry
from sidecar_client import app_client, character_routes, disk_tree, error_code, sweep

NAME = "Mira Thornfield"
CID = 4242
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64

@pytest.fixture
def archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):  # noqa: ANN201
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import archive_registry
    from services import upload as upload_service

    importlib.reload(archive_registry)
    importlib.reload(upload_service)
    archive_registry.root()
    yield
    upload_service.revoke_token()


@pytest.fixture
def client(archive) -> TestClient:  # noqa: ANN001
    import server

    return app_client(server.app)


@pytest.fixture
def fake_flist(httpx_mock):  # noqa: ANN001, ANN201
    """F-list with a session open and one character on the account."""
    import flist_api

    flist_api.ticket_store().set(
        flist_api.Ticket(
            account="mira-account",
            value="test-ticket",
            password="test-password",
            acquired_at=time.monotonic(),
        ),
        characters=[{"id": CID, "name": NAME}],
    )
    httpx_mock.add_response(
        url=flist_api.CHARACTER_DATA_URL,
        method="POST",
        json={
            "error": "",
            "id": CID,
            "name": NAME,
            "description": "[b]On F-list.[/b]",
            "infotags": {},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
        },
        is_reusable=True,
    )
    httpx_mock.add_response(
        url=flist_api.avatar_url(NAME),
        method="GET",
        content=PNG,
        is_optional=True,
        is_reusable=True,
    )
    yield httpx_mock
    flist_api.ticket_store().clear()


def _not_found(res) -> bool:  # noqa: ANN001
    body = res.json() if res.headers.get("content-type", "").startswith("application/json") else {}
    return (
        res.status_code == 404
        and error_code(res) == "character_not_found"
        and isinstance(body.get("message"), str)
    )


# ---- unknown ids ---------------------------------------------------------


@pytest.mark.parametrize("cid", ["123", "Nobody", "never-pulled_1"])
def test_an_unknown_id_is_not_found_on_every_character_route_and_creates_nothing(
    client: TestClient, tmp_path: Path, cid: str
) -> None:
    before = disk_tree(tmp_path)
    routes = character_routes(client.app)
    assert len(routes) > 30
    assert sweep(client, routes, _not_found, json={}, character_id=cid) == []
    assert disk_tree(tmp_path) == before


def test_an_unknown_id_is_not_found_even_with_a_valid_body(client: TestClient, tmp_path: Path) -> None:
    """The answer does not depend on how far a request gets: a complete
    request for an unknown character is refused the same way."""
    before = disk_tree(tmp_path)
    res = client.put(
        "/flist/character/123/workbench/payload",
        json={"_overlay": [], "character": {}},
        headers={"If-Match": "0" * 64},
    )
    assert _not_found(res), res.text
    res = client.post(
        "/flist/character/123/workbench/load-backup", json={"filename": "a.zip"}
    )
    assert _not_found(res), res.text
    assert disk_tree(tmp_path) == before


# ---- the paths that bring a character into existence ---------------------


def _character_folder(archive) -> Path:  # noqa: ANN001
    return archive_registry.root() / NAME


def test_the_first_pull_creates_the_character(client: TestClient, archive, fake_flist) -> None:  # noqa: ANN001
    assert client.get(f"/flist/character/{CID}/live").status_code == 404

    with client.stream("POST", f"/flist/character/{NAME}/pull") as res:
        body = "".join(res.iter_text())
    assert "event: done" in body, body

    assert _character_folder(archive).is_dir()
    live = client.get(f"/flist/character/{CID}/live")
    assert live.status_code == 200
    assert live.json()["description"] == "[b]On F-list.[/b]"
    bench = client.get(f"/flist/character/{CID}/workbench").json()
    assert bench["workbench"] is not None


def test_back_up_all_creates_a_character_it_has_not_seen(
    client: TestClient, archive, fake_flist  # noqa: ANN001
) -> None:
    with client.stream("POST", "/flist/backup-all") as res:
        body = "".join(res.iter_text())
    assert "event: done" in body, body

    assert _character_folder(archive).is_dir()
    backups = client.get(f"/flist/character/{CID}/zip-backups").json()["backups"]
    assert len(backups) == 1


def test_a_save_on_flist_onto_a_fresh_install_creates_the_character(
    archive, fake_flist, monkeypatch: pytest.MonkeyPatch  # noqa: ANN001
) -> None:
    """The extension reports a Save for a character this install has
    never pulled; the re-pull that follows is its first Pull."""
    import server

    # Startup must not reach for the network F-list is faked on.
    monkeypatch.setattr(server, "OFFLINE_STARTUP", True)

    # Entered, so the app's loop outlives the request and runs the
    # fire-and-forget Pull.
    with app_client(server.app) as client:
        begun = client.post("/restore/handshake").json()
        client.post("/restore/handshake/accept", json={"handshake_id": begun["handshake_id"]})

        res = client.post(
            "/restore/saved",
            json={"character": NAME, "delay_seconds": 0},
            headers={"X-Workbench-Auth": begun["token"]},
        )
        assert res.status_code == 200

        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if client.get(f"/flist/character/{CID}/live").status_code == 200:
                break
            time.sleep(0.02)
        assert client.get(f"/flist/character/{CID}/live").status_code == 200
    assert _character_folder(archive).is_dir()


# ---- characters already in the archive -----------------------------------


def _zip_with_working(payload: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("working.json", json.dumps(payload))
    return buf.getvalue()


def test_a_legacy_id_named_folder_keeps_working(client: TestClient, archive) -> None:  # noqa: ANN001
    """Folders from before the name registry are named by id. One with
    no Live is never migrated, and must still be found."""
    backups = archive_registry.root() / "123" / "backups"
    backups.mkdir(parents=True)
    (backups / "2026-10-01T120000Z.zip").write_bytes(_zip_with_working({}))

    res = client.get("/flist/character/123/zip-backups")
    assert res.status_code == 200
    assert [b["filename"] for b in res.json()["backups"]] == ["2026-10-01T120000Z.zip"]
    assert client.get("/flist/character/123/live").status_code == 404
    assert error_code(client.get("/flist/character/123/live")) != "character_not_found"
