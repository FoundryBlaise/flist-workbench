"""Working-sets v2 sidecar API tests.

Exercises every new `/flist/character/{id}/sets...` route end-to-end via
the FastAPI TestClient. Mirrors the snake_case JSON contract spelled out
in `docs/WORKING_SETS_V2_DESIGN.md` "Sidecar API surface".
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient


def _seed_live(client: TestClient, archive, cid: str = "123") -> None:
    archive.write_live(
        cid,
        {
            "character": {
                "id": int(cid),
                "name": "Lady Amber Blaise",
                "description": "[b]hi[/b]",
            },
            "infotags": {"info_9": "Human"},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
            "fetched_at": 100,
        },
    )


def _payload(**extra: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "_schema_version": 6,
        "_overlay": ["character.description"],
        "character": {"id": "123", "name": "Probe", "description": "[b]hi[/b]"},
    }
    out.update(extra)
    return out


@pytest.fixture
def archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    import importlib

    import character_archive

    importlib.reload(character_archive)
    return character_archive


@pytest.fixture
def client(archive) -> TestClient:
    import importlib

    import server

    importlib.reload(server)
    return TestClient(server.app)


# ---- list -------------------------------------------------------------


def test_list_sets_empty_returns_empty_array_and_null_active(
    client: TestClient,
) -> None:
    res = client.get("/flist/character/123/sets")
    assert res.status_code == 200
    body = res.json()
    assert body == {"sets": [], "active_set_id": None}


def test_list_sets_returns_snake_case_meta_keys(
    client: TestClient, archive
) -> None:
    _seed_live(client, archive)
    create = client.post(
        "/flist/character/123/sets", json={"name": "Main"}
    )
    assert create.status_code == 201
    meta = create.json()["set"]
    assert set(meta.keys()) == {"id", "name", "created_at", "updated_at"}
    listed = client.get("/flist/character/123/sets").json()
    assert listed["sets"][0]["id"] == meta["id"]


# ---- create -----------------------------------------------------------


def test_create_returns_201_with_set_meta(
    client: TestClient, archive
) -> None:
    _seed_live(client, archive)
    res = client.post("/flist/character/123/sets", json={"name": "Main"})
    assert res.status_code == 201
    meta = res.json()["set"]
    assert meta["name"] == "Main"
    assert len(meta["id"]) == 12


def test_create_without_live_returns_409(client: TestClient) -> None:
    res = client.post("/flist/character/123/sets", json={"name": "Main"})
    assert res.status_code == 409


def test_create_empty_name_returns_422(
    client: TestClient, archive
) -> None:
    _seed_live(client, archive)
    res = client.post("/flist/character/123/sets", json={"name": "   "})
    assert res.status_code == 422


def test_create_overlong_name_returns_422(
    client: TestClient, archive
) -> None:
    _seed_live(client, archive)
    res = client.post(
        "/flist/character/123/sets", json={"name": "x" * 81}
    )
    assert res.status_code == 422


def test_create_allows_duplicate_names(
    client: TestClient, archive
) -> None:
    _seed_live(client, archive)
    a = client.post("/flist/character/123/sets", json={"name": "Main"}).json()
    b = client.post("/flist/character/123/sets", json={"name": "Main"}).json()
    assert a["set"]["id"] != b["set"]["id"]


# ---- rename -----------------------------------------------------------


def test_rename_updates_meta(client: TestClient, archive) -> None:
    _seed_live(client, archive)
    sid = client.post(
        "/flist/character/123/sets", json={"name": "Main"}
    ).json()["set"]["id"]
    res = client.patch(
        f"/flist/character/123/sets/{sid}",
        json={"name": "Modern AU"},
    )
    assert res.status_code == 200
    assert res.json()["set"]["name"] == "Modern AU"


def test_rename_missing_returns_404(client: TestClient) -> None:
    res = client.patch(
        "/flist/character/123/sets/abcdef012345",
        json={"name": "Whatever"},
    )
    assert res.status_code == 404


def test_rename_invalid_id_returns_404(client: TestClient) -> None:
    res = client.patch(
        "/flist/character/123/sets/not-a-valid-id",
        json={"name": "Whatever"},
    )
    assert res.status_code == 404


def test_rename_empty_name_returns_422(
    client: TestClient, archive
) -> None:
    _seed_live(client, archive)
    sid = client.post(
        "/flist/character/123/sets", json={"name": "Main"}
    ).json()["set"]["id"]
    res = client.patch(
        f"/flist/character/123/sets/{sid}", json={"name": ""}
    )
    assert res.status_code == 422


# ---- delete -----------------------------------------------------------


def test_delete_clears_active_when_target_was_active(
    client: TestClient, archive
) -> None:
    _seed_live(client, archive)
    sid = client.post(
        "/flist/character/123/sets", json={"name": "Main"}
    ).json()["set"]["id"]
    client.post(f"/flist/character/123/sets/{sid}/activate")
    res = client.delete(f"/flist/character/123/sets/{sid}")
    assert res.status_code == 200
    body = res.json()
    assert body["deleted"] is True
    assert body["active_set_id"] is None


def test_delete_leaves_other_active_alone(
    client: TestClient, archive
) -> None:
    _seed_live(client, archive)
    keep = client.post(
        "/flist/character/123/sets", json={"name": "Keep"}
    ).json()["set"]["id"]
    toss = client.post(
        "/flist/character/123/sets", json={"name": "Toss"}
    ).json()["set"]["id"]
    client.post(f"/flist/character/123/sets/{keep}/activate")
    body = client.delete(f"/flist/character/123/sets/{toss}").json()
    assert body["active_set_id"] == keep


def test_delete_missing_returns_404(client: TestClient) -> None:
    res = client.delete("/flist/character/123/sets/abcdef012345")
    assert res.status_code == 404


def test_delete_invalid_id_returns_404(client: TestClient) -> None:
    res = client.delete("/flist/character/123/sets/not-a-valid-id")
    assert res.status_code == 404


# ---- duplicate --------------------------------------------------------


def test_duplicate_returns_201_with_new_id(
    client: TestClient, archive
) -> None:
    _seed_live(client, archive)
    sid = client.post(
        "/flist/character/123/sets", json={"name": "Main"}
    ).json()["set"]["id"]
    res = client.post(
        f"/flist/character/123/sets/{sid}/duplicate",
        json={"name": "Main (copy)"},
    )
    assert res.status_code == 201
    new = res.json()["set"]
    assert new["id"] != sid
    assert new["name"] == "Main (copy)"


def test_duplicate_missing_source_returns_404(client: TestClient) -> None:
    res = client.post(
        "/flist/character/123/sets/abcdef012345/duplicate",
        json={"name": "Copy"},
    )
    assert res.status_code == 404


def test_duplicate_empty_name_returns_422(
    client: TestClient, archive
) -> None:
    _seed_live(client, archive)
    sid = client.post(
        "/flist/character/123/sets", json={"name": "Main"}
    ).json()["set"]["id"]
    res = client.post(
        f"/flist/character/123/sets/{sid}/duplicate",
        json={"name": ""},
    )
    assert res.status_code == 422


# ---- activate ---------------------------------------------------------


def test_activate_sets_pointer(
    client: TestClient, archive
) -> None:
    _seed_live(client, archive)
    sid = client.post(
        "/flist/character/123/sets", json={"name": "Main"}
    ).json()["set"]["id"]
    res = client.post(f"/flist/character/123/sets/{sid}/activate")
    assert res.status_code == 200
    assert res.json() == {"active_set_id": sid}
    listed = client.get("/flist/character/123/sets").json()
    assert listed["active_set_id"] == sid


def test_activate_missing_returns_404(client: TestClient) -> None:
    res = client.post("/flist/character/123/sets/abcdef012345/activate")
    assert res.status_code == 404


def test_activate_invalid_id_returns_404(client: TestClient) -> None:
    res = client.post("/flist/character/123/sets/not-a-valid-id/activate")
    assert res.status_code == 404


def test_from_flist_activate_clears_pointer(
    client: TestClient, archive
) -> None:
    _seed_live(client, archive)
    sid = client.post(
        "/flist/character/123/sets", json={"name": "Main"}
    ).json()["set"]["id"]
    client.post(f"/flist/character/123/sets/{sid}/activate")
    res = client.post("/flist/character/123/from-flist/activate")
    assert res.status_code == 200
    assert res.json() == {"active_set_id": None}
    assert client.get("/flist/character/123/sets").json()["active_set_id"] is None


# ---- payload GET / PUT ------------------------------------------------


def test_get_payload_returns_payload_and_etag(
    client: TestClient, archive
) -> None:
    _seed_live(client, archive)
    sid = client.post(
        "/flist/character/123/sets", json={"name": "Main"}
    ).json()["set"]["id"]
    res = client.get(f"/flist/character/123/sets/{sid}/payload")
    assert res.status_code == 200
    body = res.json()
    assert body["payload"]["_schema_version"] == 6
    assert isinstance(body["etag"], str) and len(body["etag"]) == 64


def test_get_payload_missing_set_returns_404(client: TestClient) -> None:
    res = client.get("/flist/character/123/sets/abcdef012345/payload")
    assert res.status_code == 404


def test_put_payload_round_trips(client: TestClient, archive) -> None:
    _seed_live(client, archive)
    sid = client.post(
        "/flist/character/123/sets", json={"name": "Main"}
    ).json()["set"]["id"]
    seed = client.get(f"/flist/character/123/sets/{sid}/payload").json()
    next_payload = _payload(infotags={"info_9": "Elf"})
    put = client.put(
        f"/flist/character/123/sets/{sid}/payload",
        headers={"If-Match": seed["etag"]},
        json=next_payload,
    )
    assert put.status_code == 200
    etag = put.json()["etag"]
    assert etag != seed["etag"]
    out = client.get(f"/flist/character/123/sets/{sid}/payload").json()
    assert out["etag"] == etag
    assert out["payload"]["infotags"] == {"info_9": "Elf"}


def test_put_payload_stale_if_match_returns_409_with_current_etag(
    client: TestClient, archive
) -> None:
    _seed_live(client, archive)
    sid = client.post(
        "/flist/character/123/sets", json={"name": "Main"}
    ).json()["set"]["id"]
    current = client.get(
        f"/flist/character/123/sets/{sid}/payload"
    ).json()["etag"]
    res = client.put(
        f"/flist/character/123/sets/{sid}/payload",
        headers={"If-Match": "0" * 64},
        json=_payload(),
    )
    assert res.status_code == 409
    detail = res.json()["detail"]
    assert detail["detail"] == "etag_mismatch"
    assert detail["current_etag"] == current


def test_put_payload_missing_set_returns_404(client: TestClient) -> None:
    res = client.put(
        "/flist/character/123/sets/abcdef012345/payload",
        json=_payload(),
    )
    assert res.status_code == 404


def test_put_payload_invalid_set_id_returns_404(client: TestClient) -> None:
    res = client.put(
        "/flist/character/123/sets/not-a-valid-id/payload",
        json=_payload(),
    )
    assert res.status_code == 404


def test_put_payload_invalid_shape_returns_422(
    client: TestClient, archive
) -> None:
    _seed_live(client, archive)
    sid = client.post(
        "/flist/character/123/sets", json={"name": "Main"}
    ).json()["set"]["id"]
    res = client.put(
        f"/flist/character/123/sets/{sid}/payload",
        json={"_schema_version": 6, "_overlay": []},
    )
    assert res.status_code == 422


# ---- M3 migration via API ---------------------------------------------


def test_list_sets_call_unlinks_legacy_working_json(
    client: TestClient, archive
) -> None:
    cdir = archive.character_dir("123")
    legacy = cdir / "working.json"
    legacy.write_text(json.dumps({"_schema_version": 5, "_overlay": []}))
    res = client.get("/flist/character/123/sets")
    assert res.status_code == 200
    assert not legacy.exists()
