"""HTTP tests for the v5 unified-images upload + export ZIP."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import character_archive


_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
_PNG_VARIANT = b"\x89PNG\r\n\x1a\n" + b"\xff" * 32
_JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
_GIF = b"GIF89a" + b"\x00" * 32


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    from server import app

    return TestClient(app)


# ---- image upload / list / delete ------------------------------------


def test_image_upload_returns_local_image_id(client: TestClient) -> None:
    res = client.post("/flist/character/9999/images", content=_PNG)
    assert res.status_code == 200
    body = res.json()
    assert body["extension"] == "png"
    assert body["image_id"].startswith("local-")
    assert isinstance(body["added_at"], int)


def test_image_upload_rejects_unsupported_type(client: TestClient) -> None:
    res = client.post("/flist/character/9999/images", content=b"not-an-image")
    assert res.status_code == 415


def test_image_upload_rejects_empty_body(client: TestClient) -> None:
    res = client.post("/flist/character/9999/images", content=b"")
    assert res.status_code == 400


def test_image_upload_then_list_round_trip(client: TestClient) -> None:
    client.post("/flist/character/9999/images", content=_PNG)
    client.post("/flist/character/9999/images", content=_JPG)
    client.post("/flist/character/9999/images", content=_GIF)
    res = client.get("/flist/character/9999/images").json()
    extensions = {e["extension"] for e in res["images"]}
    assert extensions == {"png", "jpg", "gif"}


def test_image_upload_is_idempotent_on_identical_bytes(client: TestClient) -> None:
    first = client.post("/flist/character/9999/images", content=_PNG).json()
    second = client.post("/flist/character/9999/images", content=_PNG).json()
    assert first["image_id"] == second["image_id"]
    images = client.get("/flist/character/9999/images").json()["images"]
    assert len(images) == 1


def test_image_delete_removes_file(client: TestClient) -> None:
    iid = client.post(
        "/flist/character/9999/images", content=_PNG
    ).json()["image_id"]
    res = client.delete(f"/flist/character/9999/images/{iid}")
    assert res.status_code == 200
    images = client.get("/flist/character/9999/images").json()["images"]
    assert images == []


def test_image_delete_404_for_unknown_id(client: TestClient) -> None:
    res = client.delete("/flist/character/9999/images/local-deadbeef")
    assert res.status_code == 404


def test_image_serves_uploaded_bytes(client: TestClient) -> None:
    body = client.post("/flist/character/9999/images", content=_PNG).json()
    iid = body["image_id"]
    res = client.get(f"/flist/character/9999/images/{iid}.png")
    assert res.status_code == 200
    assert res.content == _PNG


# ---- export.zip ------------------------------------------------------


def _seed_working_with_gallery(
    character_id: str,
    name: str,
    images: list[dict],
) -> None:
    """Drop a live + working pair onto disk so the export route has
    something to bundle. Caller is responsible for placing the actual
    image bytes in <char>/images/ via write_character_image."""
    character_archive.write_live(
        character_id,
        {
            "id": character_id,
            "name": name,
            "description": "test profile",
            "fetched_at": 1,
        },
    )
    character_archive.write_working(
        character_id,
        {
            "_schema_version": character_archive.WORKING_SCHEMA_VERSION,
            "_overlay": ["images"],
            "character": {"id": character_id, "name": name, "description": "test profile"},
            "images": images,
        },
    )


def test_export_zip_includes_character_json_and_images(
    client: TestClient,
) -> None:
    # F-list-pulled image goes to images/<id>.png via write_character_image.
    character_archive.write_character_image("9999", "30012128", "png", _PNG)
    # User-uploaded image lands as local-<sha8> directly via add_uploaded_image
    # — v5 has no separate pool to materialise from.
    row = character_archive.add_uploaded_image("9999", _PNG_VARIANT)
    assert row is not None
    local_id = row["image_id"]
    _seed_working_with_gallery(
        "9999",
        "OOC Hub",
        [
            {"image_id": "30012128", "description": "first", "sort_order": 0},
            {"image_id": local_id, "description": "", "sort_order": 1},
        ],
    )
    res = client.get("/flist/character/9999/export.zip")
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/zip"
    assert "attachment" in res.headers["content-disposition"]
    z = zipfile.ZipFile(io.BytesIO(res.content))
    names = set(z.namelist())
    assert "character.json" in names
    assert "images/30012128.png" in names
    assert f"images/{local_id}.png" in names
    character_json = json.loads(z.read("character.json"))
    assert character_json["character"]["name"] == "OOC Hub"
    assert len(character_json["images"]["list"]) == 2
    assert character_json["images"]["list"][0]["description"] == "first"


def test_export_zip_falls_back_to_live_when_no_working(
    client: TestClient,
) -> None:
    character_archive.write_character_image("8888", "42", "png", _PNG)
    character_archive.write_live(
        "8888",
        {
            "id": "8888",
            "name": "Solo",
            "description": "Live-only",
            "images": [
                {"image_id": "42", "extension": "png", "description": ""},
            ],
            "fetched_at": 1,
        },
    )
    res = client.get("/flist/character/8888/export.zip")
    assert res.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(res.content))
    assert "images/42.png" in z.namelist()


def test_export_zip_404_when_nothing_to_export(client: TestClient) -> None:
    res = client.get("/flist/character/7777/export.zip")
    assert res.status_code == 404
