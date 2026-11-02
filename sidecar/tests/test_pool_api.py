"""HTTP tests for the v5 unified-images upload + export ZIP."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
import archive_images
import archive_live
import archive_registry
from sidecar_client import app_client



_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
_PNG_VARIANT = b"\x89PNG\r\n\x1a\n" + b"\xff" * 32
_JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
_GIF = b"GIF89a" + b"\x00" * 32


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    import archive_registry
    from server import app

    # The characters these tests use, as a Pull would have left them.
    for cid in ("7777", "8888", "9999"):
        archive_registry.create_character_dir(cid)
    return app_client(app)


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


def _seed_workbench_with_gallery(
    client: TestClient,
    character_id: str,
    name: str,
    images: list[dict],
) -> None:
    """Pull a Live, open its Workbench and save a gallery into it, so
    the export route has something to bundle. Caller is responsible for
    placing the actual image bytes in <char>/images/ via
    write_character_image."""
    archive_live.write_live(
        character_id,
        {
            "id": character_id,
            "name": name,
            "description": "test profile",
            "fetched_at": 1,
        },
    )
    url = f"/flist/character/{character_id}/workbench/payload"
    current = client.get(url).json()
    payload = current["payload"]
    payload["images"] = images
    payload["_overlay"] = ["images"]
    saved = client.put(url, json=payload, headers={"If-Match": current["etag"]})
    assert saved.status_code == 200


def test_export_zip_includes_character_json_and_images(
    client: TestClient,
) -> None:
    # F-list-pulled image goes to images/<id>.png via write_character_image.
    archive_images.write_character_image("9999", "30012128", "png", _PNG)
    # User-uploaded image lands as local-<sha8> directly via add_uploaded_image
    # — v5 has no separate pool to materialise from.
    row = archive_images.add_uploaded_image("9999", _PNG_VARIANT)
    assert row is not None
    local_id = row["image_id"]
    _seed_workbench_with_gallery(
        client,
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


def _zip_of(client: TestClient, character_id: str) -> zipfile.ZipFile:
    res = client.get(f"/flist/character/{character_id}/export.zip")
    assert res.status_code == 200
    return zipfile.ZipFile(io.BytesIO(res.content))


def test_export_zip_contains_the_workbench_not_a_stale_legacy_working_copy(
    client: TestClient,
) -> None:
    """The export modal counts the Workbench, so the download has to be
    the Workbench: its description, its gallery and its image files."""
    archive_images.write_character_image("9999", "42", "png", _PNG)
    archive_images.write_character_image("9999", "43", "png", _PNG_VARIANT)
    archive_live.write_live(
        "9999",
        {
            "id": "9999",
            "name": "Ember Vale",
            "description": "Live description",
            "images": [{"image_id": "42", "extension": "png", "description": "old"}],
            "fetched_at": 1,
        },
    )
    url = "/flist/character/9999/workbench/payload"
    current = client.get(url).json()
    payload = current["payload"]
    payload["character"]["description"] = "Workbench description"
    payload["images"] = [
        {"image_id": "43", "description": "new cover", "sort_order": 0},
        {"image_id": "42", "description": "old", "sort_order": 1},
    ]
    payload["_overlay"] = ["character.description", "images"]
    saved = client.put(url, json=payload, headers={"If-Match": current["etag"]})
    assert saved.status_code == 200
    # A legacy working copy left on disk from an older build.
    (archive_registry.character_dir("9999") / "working.json").write_text(
        json.dumps(
            {
                "_schema_version": 1,
                "_overlay": ["character.description", "images"],
                "character": {"id": "9999", "name": "Ember Vale", "description": "Stale"},
                "images": [],
            }
        ),
        encoding="utf-8",
    )

    z = _zip_of(client, "9999")

    character_json = json.loads(z.read("character.json"))
    assert character_json["character"]["description"] == "Workbench description"
    gallery = character_json["images"]["list"]
    assert [(g["filename"], g["description"]) for g in gallery] == [
        ("images/43.png", "new cover"),
        ("images/42.png", "old"),
    ]
    assert z.read("images/43.png") == _PNG_VARIANT
    assert z.read("images/42.png") == _PNG


def test_export_zip_of_a_character_with_no_workbench_is_live(
    client: TestClient,
) -> None:
    archive_images.write_character_image("8888", "42", "png", _PNG)
    archive_live.write_live(
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
    z = _zip_of(client, "8888")
    character_json = json.loads(z.read("character.json"))
    assert character_json["character"]["description"] == "Live-only"
    assert z.read("images/42.png") == _PNG
    # Exporting reads; it does not start a Workbench.
    bench = client.get("/flist/character/8888/workbench?create=false").json()
    assert bench["workbench"] is None


def test_export_zip_404_when_nothing_to_export(client: TestClient) -> None:
    res = client.get("/flist/character/7777/export.zip")
    assert res.status_code == 404
