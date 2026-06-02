"""Tier 7 Step 4 — backup ZIP create/list/delete endpoint tests."""
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


_PNG_HEADER = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    import importlib

    import character_archive

    importlib.reload(character_archive)
    from server import app

    return TestClient(app)


def _seed_set_with_image(client: TestClient, cid: str) -> dict:
    import character_archive

    character_archive.write_character_image(cid, "30012128", "png", _PNG_HEADER)
    s = client.post(
        f"/flist/character/{cid}/sets",
        json={"name": "Main", "seed": "empty"},
    ).json()["set"]
    client.put(
        f"/flist/character/{cid}/sets/{s['id']}/payload",
        json={
            "_schema_version": 6,
            "_overlay": [],
            "character": {"id": cid, "name": "Probe", "description": "hi"},
            "images": [
                {"image_id": "30012128", "description": "shot", "sort_order": 0}
            ],
        },
    )
    return s


def test_create_backup_from_set_produces_valid_zip(client: TestClient, tmp_path: Path) -> None:
    cid = "600"
    s = _seed_set_with_image(client, cid)
    res = client.post(
        f"/flist/character/{cid}/backups-v6",
        json={"source": "set", "set_id": s["id"]},
    )
    assert res.status_code == 201, res.text
    listing = res.json()["backup"]
    assert listing["source"] == "manual-set"
    assert listing["sourceName"] == "Main"
    assert listing["filename"].endswith(".zip")

    path_res = client.get(
        f"/flist/character/{cid}/backups-v6/{listing['filename']}/path"
    )
    assert path_res.status_code == 200
    abs_path = Path(path_res.json()["abs_path"])
    assert abs_path.exists()

    with zipfile.ZipFile(abs_path) as zf:
        names = zf.namelist()
    assert "character.json" in names
    assert any(n.startswith("images/") for n in names)


def test_create_backup_from_snapshot(client: TestClient) -> None:
    cid = "601"
    s = _seed_set_with_image(client, cid)
    snap = client.post(
        f"/flist/character/{cid}/sets/{s['id']}/snapshots",
        json={"name": "First"},
    ).json()["snapshot"]
    res = client.post(
        f"/flist/character/{cid}/backups-v6",
        json={"source": "snapshot", "set_id": s["id"], "snapshot_id": snap["id"]},
    )
    assert res.status_code == 201
    listing = res.json()["backup"]
    assert listing["source"] == "manual-snapshot"
    assert listing["sourceName"] == "First"
    assert "__manual-snapshot__" in listing["filename"]


def test_create_backup_snapshot_requires_snapshot_id(client: TestClient) -> None:
    cid = "602"
    s = _seed_set_with_image(client, cid)
    res = client.post(
        f"/flist/character/{cid}/backups-v6",
        json={"source": "snapshot", "set_id": s["id"]},
    )
    assert res.status_code == 422


def test_list_backups_newest_first(client: TestClient) -> None:
    import time

    cid = "603"
    s = _seed_set_with_image(client, cid)
    a = client.post(
        f"/flist/character/{cid}/backups-v6",
        json={"source": "set", "set_id": s["id"]},
    ).json()["backup"]
    # Bump the second backup's ts by tampering with payload to change hash.
    client.put(
        f"/flist/character/{cid}/sets/{s['id']}/payload",
        json={
            "_schema_version": 6,
            "_overlay": [],
            "character": {"id": cid, "name": "Probe2"},
        },
    )
    time.sleep(1.1)  # forces a different ISO-second in the filename
    b = client.post(
        f"/flist/character/{cid}/backups-v6",
        json={"source": "set", "set_id": s["id"]},
    ).json()["backup"]
    rows = client.get(f"/flist/character/{cid}/backups-v6").json()["backups"]
    assert len(rows) == 2
    assert rows[0]["createdAt"] >= rows[1]["createdAt"]
    assert rows[0]["filename"] == b["filename"]


def test_delete_backup_removes_file(client: TestClient) -> None:
    cid = "604"
    s = _seed_set_with_image(client, cid)
    listing = client.post(
        f"/flist/character/{cid}/backups-v6",
        json={"source": "set", "set_id": s["id"]},
    ).json()["backup"]
    res = client.delete(
        f"/flist/character/{cid}/backups-v6/{listing['filename']}"
    )
    assert res.status_code == 200
    assert res.json()["deleted"] is True
    res2 = client.delete(
        f"/flist/character/{cid}/backups-v6/{listing['filename']}"
    )
    assert res2.status_code == 404


def test_filename_regex_rejects_traversal(client: TestClient) -> None:
    cid = "605"
    res = client.delete(
        f"/flist/character/{cid}/backups-v6/../etc/passwd.zip"
    )
    # Path traversal can be caught either at the router (404 for unmatched
    # path) or our validator (400). Either way, it must not delete files.
    assert res.status_code in (400, 404)
    # The path endpoint applies the regex directly.
    res = client.get(
        f"/flist/character/{cid}/backups-v6/has%2Fslash.zip/path"
    )
    assert res.status_code in (400, 404)


def test_legacy_json_listed_as_legacy(client: TestClient) -> None:
    import character_archive

    cid = "606"
    bd = character_archive.backups_dir(cid)
    (bd / "1700000000.json").write_text(json.dumps({"name": "x"}))
    rows = client.get(f"/flist/character/{cid}/backups-v6").json()["backups"]
    sources = [r["source"] for r in rows]
    assert "legacy-json" in sources


def test_legacy_json_cannot_be_deleted_through_v6(client: TestClient) -> None:
    import character_archive

    cid = "607"
    bd = character_archive.backups_dir(cid)
    legacy = bd / "1700000000.json"
    legacy.write_text(json.dumps({"name": "x"}))
    res = client.delete(f"/flist/character/{cid}/backups-v6/1700000000.json")
    assert res.status_code == 400
    assert legacy.exists()


def test_download_backup_returns_zip_bytes(client: TestClient) -> None:
    cid = "608"
    s = _seed_set_with_image(client, cid)
    listing = client.post(
        f"/flist/character/{cid}/backups-v6",
        json={"source": "set", "set_id": s["id"]},
    ).json()["backup"]
    res = client.get(
        f"/flist/character/{cid}/backups-v6/{listing['filename']}/download"
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
        assert "character.json" in zf.namelist()


def test_create_backup_missing_set_returns_404(client: TestClient) -> None:
    cid = "609"
    res = client.post(
        f"/flist/character/{cid}/backups-v6",
        json={"source": "set", "set_id": "abcd1234abcd"},
    )
    assert res.status_code == 404


def test_path_endpoint_resolves_legacy_json(client: TestClient) -> None:
    import character_archive

    cid = "610"
    bd = character_archive.backups_dir(cid)
    legacy = bd / "1700000000.json"
    legacy.write_text(json.dumps({"name": "x"}))
    res = client.get(
        f"/flist/character/{cid}/backups-v6/1700000000.json/path"
    )
    assert res.status_code == 200
    assert res.json()["abs_path"] == str(legacy)
