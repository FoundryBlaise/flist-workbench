"""HTTP tests for the per-character image pool + export ZIP (Tier 6)."""

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


# ---- pool upload / list / delete -------------------------------------


def test_pool_upload_returns_manifest_entry(client: TestClient) -> None:
    res = client.post("/flist/character/9999/pool", content=_PNG)
    assert res.status_code == 200
    body = res.json()
    assert body["extension"] == "png"
    assert body["source"] == "user_upload"
    assert body["image_id"] is None
    assert len(body["sha256"]) == 64


def test_pool_upload_rejects_unsupported_type(client: TestClient) -> None:
    res = client.post("/flist/character/9999/pool", content=b"not-an-image")
    assert res.status_code == 415


def test_pool_upload_rejects_empty_body(client: TestClient) -> None:
    res = client.post("/flist/character/9999/pool", content=b"")
    assert res.status_code == 400


def test_pool_upload_then_list_round_trip(client: TestClient) -> None:
    client.post("/flist/character/9999/pool", content=_PNG)
    client.post("/flist/character/9999/pool", content=_JPG)
    client.post("/flist/character/9999/pool", content=_GIF)
    res = client.get("/flist/character/9999/pool").json()
    extensions = {e["extension"] for e in res["pool"]}
    assert extensions == {"png", "jpg", "gif"}


def test_pool_upload_is_idempotent_on_identical_bytes(client: TestClient) -> None:
    first = client.post("/flist/character/9999/pool", content=_PNG).json()
    second = client.post("/flist/character/9999/pool", content=_PNG).json()
    assert first["sha256"] == second["sha256"]
    pool = client.get("/flist/character/9999/pool").json()["pool"]
    assert len(pool) == 1


def test_pool_delete_removes_entry(client: TestClient) -> None:
    sha = client.post("/flist/character/9999/pool", content=_PNG).json()["sha256"]
    res = client.delete(f"/flist/character/9999/pool/{sha}")
    assert res.status_code == 200
    pool = client.get("/flist/character/9999/pool").json()["pool"]
    assert pool == []


def test_pool_delete_404_for_unknown_sha(client: TestClient) -> None:
    res = client.delete("/flist/character/9999/pool/" + "0" * 64)
    assert res.status_code == 404


def test_pool_file_serves_uploaded_bytes(client: TestClient) -> None:
    sha = client.post("/flist/character/9999/pool", content=_PNG).json()["sha256"]
    res = client.get(f"/flist/character/9999/pool/{sha}.png")
    assert res.status_code == 200
    assert res.content == _PNG


# ---- export.zip ------------------------------------------------------


def _seed_working_with_gallery(
    character_id: str,
    name: str,
    images: list[dict],
) -> None:
    """Drop a live + working pair onto disk so the export route has
    something to bundle. Pool entries are populated by direct calls to
    `add_to_pool` so the manifest carries the F-list image_id when set."""
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
            "_schema_version": 2,
            "_overlay": ["images"],
            "character": {"id": character_id, "name": name, "description": "test profile"},
            "images": images,
        },
    )


def test_export_zip_includes_character_json_and_images(
    client: TestClient,
) -> None:
    sha_a = character_archive.add_to_pool(
        "9999", _PNG, "png", image_id="30012128", source="flist_pull"
    )
    sha_b = character_archive.add_to_pool(
        "9999", _PNG_VARIANT, "png", source="user_upload"
    )
    _seed_working_with_gallery(
        "9999",
        "OOC Hub",
        [
            {"sha256": sha_a, "description": "first"},
            {"sha256": sha_b, "description": ""},
        ],
    )
    res = client.get("/flist/character/9999/export.zip")
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/zip"
    assert "attachment" in res.headers["content-disposition"]
    z = zipfile.ZipFile(io.BytesIO(res.content))
    names = set(z.namelist())
    assert "character.json" in names
    # F-list-known image keeps its image_id; user-uploaded gets a
    # local_<sha-prefix> stem so the ZIP entry is stable across exports.
    assert "images/30012128.png" in names
    assert any(n.startswith("images/local_") and n.endswith(".png") for n in names)
    character_json = json.loads(z.read("character.json"))
    assert character_json["character"]["name"] == "OOC Hub"
    assert len(character_json["images"]["list"]) == 2
    assert character_json["images"]["list"][0]["description"] == "first"


def test_export_zip_falls_back_to_live_when_no_working(
    client: TestClient,
) -> None:
    sha = character_archive.add_to_pool(
        "8888", _PNG, "png", image_id="42", source="flist_pull"
    )
    character_archive.write_live(
        "8888",
        {
            "id": "8888",
            "name": "Solo",
            "description": "Live-only",
            "images": [
                {"image_id": "42", "extension": "png", "sha256": sha, "description": ""},
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
