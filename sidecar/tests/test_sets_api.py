"""Tier 7 Step 2 — sets CRUD endpoint tests."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    import importlib

    import character_archive

    importlib.reload(character_archive)
    from server import app

    return TestClient(app)


def _create(client: TestClient, cid: str, name: str, seed="empty") -> dict:
    res = client.post(
        f"/flist/character/{cid}/sets",
        json={"name": name, "seed": seed},
    )
    assert res.status_code == 201, res.text
    return res.json()["set"]


def test_get_sets_empty_when_no_archive(client: TestClient) -> None:
    res = client.get("/flist/character/100/sets")
    assert res.status_code == 200
    body = res.json()
    assert body["sets"] == []
    assert body["active_set_id"] is None


def test_sets_crud_roundtrip(client: TestClient) -> None:
    cid = "200"
    a = _create(client, cid, "A")
    b = _create(client, cid, "B")
    c = _create(client, cid, "C")
    assert a["name"] == "A"
    body = client.get(f"/flist/character/{cid}/sets").json()
    assert {s["id"] for s in body["sets"]} == {a["id"], b["id"], c["id"]}

    # Rename A → A-renamed.
    res = client.patch(
        f"/flist/character/{cid}/sets/{a['id']}",
        json={"name": "A-renamed"},
    )
    assert res.status_code == 200
    assert res.json()["set"]["name"] == "A-renamed"

    # Activate C.
    res = client.post(f"/flist/character/{cid}/sets/{c['id']}/activate")
    assert res.status_code == 200
    assert res.json()["active_set_id"] == c["id"]

    # Delete B (not active).
    res = client.delete(f"/flist/character/{cid}/sets/{b['id']}")
    assert res.status_code == 200
    assert res.json()["deleted"] is True
    body = client.get(f"/flist/character/{cid}/sets").json()
    assert b["id"] not in {s["id"] for s in body["sets"]}


def test_cannot_delete_only_set(client: TestClient) -> None:
    cid = "300"
    a = _create(client, cid, "Only")
    res = client.delete(f"/flist/character/{cid}/sets/{a['id']}")
    assert res.status_code == 409
    assert res.json()["detail"] == "cannot delete only set"


def test_delete_active_requires_next_active(client: TestClient) -> None:
    cid = "301"
    a = _create(client, cid, "A")
    b = _create(client, cid, "B")
    # A was created first and is active.
    res = client.delete(f"/flist/character/{cid}/sets/{a['id']}")
    assert res.status_code == 409
    assert res.json()["detail"] == "must specify next_active when deleting active set"

    res = client.delete(
        f"/flist/character/{cid}/sets/{a['id']}",
        params={"next_active": b["id"]},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["deleted"] is True
    assert body["new_active_set_id"] == b["id"]


def test_delete_active_next_active_must_exist(client: TestClient) -> None:
    cid = "302"
    a = _create(client, cid, "A")
    _ = _create(client, cid, "B")
    res = client.delete(
        f"/flist/character/{cid}/sets/{a['id']}",
        params={"next_active": "doesnotexist"},
    )
    assert res.status_code == 422


def test_delete_404_when_missing(client: TestClient) -> None:
    cid = "303"
    _ = _create(client, cid, "A")
    res = client.delete(f"/flist/character/{cid}/sets/abcd1234abcd")
    assert res.status_code == 404


def test_payload_put_get_round_trip_with_etag(client: TestClient) -> None:
    cid = "400"
    a = _create(client, cid, "Main")
    payload = {
        "_schema_version": 6,
        "_overlay": ["character.description"],
        "character": {"id": cid, "name": "X", "description": "hi"},
    }
    res = client.put(
        f"/flist/character/{cid}/sets/{a['id']}/payload", json=payload
    )
    assert res.status_code == 200
    etag = res.json()["etag"]
    assert isinstance(etag, str) and len(etag) == 64

    got = client.get(f"/flist/character/{cid}/sets/{a['id']}/payload").json()
    assert got["etag"] == etag
    assert got["payload"]["character"]["description"] == "hi"


def test_payload_if_match_mismatch_409(client: TestClient) -> None:
    cid = "401"
    a = _create(client, cid, "Main")
    payload = {
        "_schema_version": 6,
        "_overlay": [],
        "character": {"id": cid, "name": "X"},
    }
    first = client.put(
        f"/flist/character/{cid}/sets/{a['id']}/payload", json=payload
    ).json()["etag"]
    res = client.put(
        f"/flist/character/{cid}/sets/{a['id']}/payload",
        headers={"If-Match": "0" * 64},
        json=payload,
    )
    assert res.status_code == 409
    detail = res.json()["detail"]
    assert detail["detail"] == "etag_mismatch"
    assert detail["current_etag"] == first


def test_payload_seed_empty_vs_fork(client: TestClient) -> None:
    cid = "402"
    a = _create(client, cid, "Empty", seed="empty")
    # Populate then fork.
    client.put(
        f"/flist/character/{cid}/sets/{a['id']}/payload",
        json={
            "_schema_version": 6,
            "_overlay": [],
            "character": {"id": cid, "name": "Source"},
        },
    )
    res = client.post(
        f"/flist/character/{cid}/sets",
        json={"name": "Forked", "seed": {"fork": a["id"]}},
    )
    assert res.status_code == 201
    forked = res.json()["set"]
    got = client.get(
        f"/flist/character/{cid}/sets/{forked['id']}/payload"
    ).json()
    assert got["payload"]["character"]["name"] == "Source"


def test_seed_bad_shape_422(client: TestClient) -> None:
    cid = "403"
    res = client.post(
        f"/flist/character/{cid}/sets",
        json={"name": "X", "seed": "garbage"},
    )
    assert res.status_code == 422


def test_seed_fork_missing_source_404(client: TestClient) -> None:
    cid = "404"
    res = client.post(
        f"/flist/character/{cid}/sets",
        json={"name": "X", "seed": {"fork": "abcdef123456"}},
    )
    assert res.status_code == 404


def test_seed_live_without_live_409(client: TestClient) -> None:
    cid = "405"
    res = client.post(
        f"/flist/character/{cid}/sets",
        json={"name": "X", "seed": "live"},
    )
    assert res.status_code == 409


def test_rename_validation(client: TestClient) -> None:
    cid = "406"
    a = _create(client, cid, "A")
    res = client.patch(
        f"/flist/character/{cid}/sets/{a['id']}",
        json={"name": "   "},
    )
    assert res.status_code == 422


def test_activate_404_when_missing(client: TestClient) -> None:
    cid = "407"
    _create(client, cid, "A")
    res = client.post(
        f"/flist/character/{cid}/sets/abcd1234abcd/activate"
    )
    assert res.status_code == 404


def test_payload_get_404_when_missing(client: TestClient) -> None:
    cid = "408"
    res = client.get(f"/flist/character/{cid}/sets/abcd1234abcd/payload")
    assert res.status_code == 404


def test_get_sets_triggers_v5_migration(client: TestClient, tmp_path: Path) -> None:
    import character_archive

    cid = "409"
    target = character_archive.working_path(cid)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(
            {
                "_schema_version": 5,
                "_overlay": [],
                "character": {"id": cid, "name": "Probe"},
            }
        ),
        encoding="utf-8",
    )
    body = client.get(f"/flist/character/{cid}/sets").json()
    assert len(body["sets"]) == 1
    assert body["sets"][0]["name"] == "Main"
    assert body["active_set_id"] == body["sets"][0]["id"]
