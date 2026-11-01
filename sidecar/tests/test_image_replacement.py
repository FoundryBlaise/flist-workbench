"""Images the app replaces go to the Trash, never away for good.

A Pull or Back up all that finds an image under the id it already
holds, but with another extension on F-list, replaces the old file.
Gallery repair drops files a re-upload left behind. Either way the old
bytes land in the character's Trash and can be put back from there.

F-list is faked at the HTTP seam; everything else is the real app.
"""

from __future__ import annotations

import hashlib
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sidecar_client import app_client

NAME = "Mira Thornfield"
CID = 4242
IMAGE_ID = "777"
OLD_PNG = b"\x89PNG\r\n\x1a\n" + b"old picture " * 8
NEW_JPG = b"\xff\xd8\xff\xe0" + b"new picture " * 8


@pytest.fixture
def archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):  # noqa: ANN201
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import character_archive
    import restore as restore_svc

    importlib.reload(character_archive)
    importlib.reload(restore_svc)
    character_archive.register_character(str(CID), NAME)
    # What an earlier Pull left in the pool: image 777 as a png.
    character_archive.write_character_image(str(CID), IMAGE_ID, "png", OLD_PNG)
    yield character_archive
    restore_svc.revoke_token()


@pytest.fixture
def client(archive) -> TestClient:  # noqa: ANN001
    import server

    return app_client(server.app)


@pytest.fixture
def fake_flist(httpx_mock):  # noqa: ANN001, ANN201
    """F-list now has image 777 as a jpg with other bytes."""
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
            "images": [{"image_id": IMAGE_ID, "extension": "jpg", "description": ""}],
        },
        is_reusable=True,
    )
    httpx_mock.add_response(
        url=f"{flist_api.STATIC_BASE}/images/charimage/{IMAGE_ID}.jpg",
        method="GET",
        content=NEW_JPG,
        is_reusable=True,
    )
    httpx_mock.add_response(
        url=flist_api.avatar_url(NAME),
        method="GET",
        content=OLD_PNG,
        is_optional=True,
        is_reusable=True,
    )
    yield httpx_mock
    flist_api.ticket_store().clear()


def pool(client: TestClient) -> dict[str, bytes]:
    """filename -> bytes of every image in the pool."""
    rows = client.get(f"/flist/character/{CID}/images").json()["images"]
    out = {}
    for r in rows:
        name = f"{r['image_id']}.{r['extension']}"
        out[name] = client.get(f"/flist/character/{CID}/images/{name}").content
    return out


def trash(client: TestClient) -> list[dict]:
    return client.get(f"/flist/character/{CID}/trash").json()["items"]


def trash_bytes(client: TestClient, item: dict) -> bytes:
    return client.get(f"/flist/character/{CID}/trash/{item['filename']}").content


def restore(client: TestClient, *trash_ids: str) -> dict:
    return client.post(
        f"/flist/character/{CID}/trash/restore", json={"image_ids": list(trash_ids)}
    ).json()


def local_name(data: bytes, ext: str) -> str:
    return f"local-{hashlib.sha256(data).hexdigest()[:8]}.{ext}"


def stream(client: TestClient, path: str) -> str:
    with client.stream("POST", path) as res:
        body = "".join(res.iter_text())
    assert "event: done" in body, body
    return body


@pytest.mark.parametrize("sweep", ["pull", "backup-all"])
def test_a_replaced_image_waits_in_the_trash_and_comes_back(
    client: TestClient, fake_flist, sweep: str  # noqa: ANN001
) -> None:
    path = f"/flist/character/{NAME}/pull" if sweep == "pull" else "/flist/backup-all"
    stream(client, path)

    assert pool(client) == {f"{IMAGE_ID}.jpg": NEW_JPG}
    items = trash(client)
    assert [i["image_id"] for i in items] == [IMAGE_ID]
    assert trash_bytes(client, items[0]) == OLD_PNG

    res = restore(client, items[0]["trash_id"])

    # The pool's 777 is F-list's new picture; the old one comes back
    # under the name the pool gives a picture only this machine has.
    assert res["not_found"] == [] and res["conflicts"] == []
    assert pool(client) == {
        f"{IMAGE_ID}.jpg": NEW_JPG,
        local_name(OLD_PNG, "png"): OLD_PNG,
    }
    assert trash(client) == []


def test_gallery_repair_moves_a_superseded_image_to_the_trash(
    client: TestClient, archive  # noqa: ANN001
) -> None:
    # The extension re-uploaded the gallery: F-list now holds the same
    # picture under 888, and 777 is gone from the profile.
    archive.write_character_image(str(CID), "888", "png", OLD_PNG)
    live = {
        "character": {"id": CID, "name": NAME, "description": "x"},
        "infotags": {},
        "kinks": {},
        "custom_kinks": {},
        "inlines": {},
        "images": [{"image_id": "888"}],
        "fetched_at": 1000,
    }
    archive.write_live(str(CID), live)
    bench = archive.resolve_workbench(str(CID))
    archive.write_set_payload(
        str(CID),
        bench.id,
        {
            "_schema_version": archive.WORKING_SCHEMA_VERSION,
            "_overlay": ["images"],
            "character": {"description": "x"},
            "images": [{"image_id": IMAGE_ID, "description": "", "sort_order": 0}],
        },
        expected_etag=None,
    )

    result = client.post(f"/flist/character/{CID}/images/repair").json()

    assert result["stale_removed"] == [IMAGE_ID]
    assert pool(client) == {"888.png": OLD_PNG}
    items = trash(client)
    assert [i["image_id"] for i in items] == [IMAGE_ID]
    assert trash_bytes(client, items[0]) == OLD_PNG

    # The pool holds the same bytes under 888, so restoring finds them
    # there rather than making a twin.
    res = restore(client, items[0]["trash_id"])
    assert res["restored"] == [
        {"image_id": "888", "deduplicated": True, "from": items[0]["trash_id"]}
    ]
    assert pool(client) == {"888.png": OLD_PNG}
