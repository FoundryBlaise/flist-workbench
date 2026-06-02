"""Tier 7 Step 3 — snapshot endpoint tests."""
from __future__ import annotations

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


def _create_set(client: TestClient, cid: str, name: str = "Main") -> dict:
    return client.post(
        f"/flist/character/{cid}/sets",
        json={"name": name, "seed": "empty"},
    ).json()["set"]


def _put_payload(client: TestClient, cid: str, set_id: str, description: str) -> None:
    client.put(
        f"/flist/character/{cid}/sets/{set_id}/payload",
        json={
            "_schema_version": 6,
            "_overlay": ["character.description"],
            "character": {"id": cid, "name": "X", "description": description},
        },
    )


def test_snapshot_create_and_list(client: TestClient) -> None:
    cid = "500"
    s = _create_set(client, cid)
    _put_payload(client, cid, s["id"], "v1")
    res = client.post(
        f"/flist/character/{cid}/sets/{s['id']}/snapshots",
        json={"name": "S1"},
    )
    assert res.status_code == 201
    snap = res.json()["snapshot"]
    assert snap["name"] == "S1"
    # The set's meta now reflects the snapshot count.
    listing = client.get(f"/flist/character/{cid}/sets").json()
    matching = [x for x in listing["sets"] if x["id"] == s["id"]][0]
    assert matching["snapshotCount"] == 1


def test_snapshot_rename_and_delete(client: TestClient) -> None:
    cid = "501"
    s = _create_set(client, cid)
    _put_payload(client, cid, s["id"], "x")
    snap = client.post(
        f"/flist/character/{cid}/sets/{s['id']}/snapshots",
        json={"name": "old"},
    ).json()["snapshot"]
    res = client.patch(
        f"/flist/character/{cid}/sets/{s['id']}/snapshots/{snap['id']}",
        json={"name": "renamed"},
    )
    assert res.status_code == 200
    assert res.json()["snapshot"]["name"] == "renamed"
    res = client.delete(
        f"/flist/character/{cid}/sets/{s['id']}/snapshots/{snap['id']}"
    )
    assert res.status_code == 200
    assert res.json()["deleted"] is True


def test_snapshot_get_returns_frozen_payload(client: TestClient) -> None:
    cid = "502"
    s = _create_set(client, cid)
    _put_payload(client, cid, s["id"], "frozen")
    snap = client.post(
        f"/flist/character/{cid}/sets/{s['id']}/snapshots",
        json={"name": "f"},
    ).json()["snapshot"]
    _put_payload(client, cid, s["id"], "moved-on")
    res = client.get(
        f"/flist/character/{cid}/sets/{s['id']}/snapshots/{snap['id']}"
    )
    assert res.status_code == 200
    body = res.json()
    assert body["snapshot"]["name"] == "f"
    assert body["payload"]["character"]["description"] == "frozen"


def test_snapshot_revert_creates_safety(client: TestClient) -> None:
    cid = "503"
    s = _create_set(client, cid)
    _put_payload(client, cid, s["id"], "A")
    snap = client.post(
        f"/flist/character/{cid}/sets/{s['id']}/snapshots",
        json={"name": "S1"},
    ).json()["snapshot"]
    _put_payload(client, cid, s["id"], "B")
    res = client.post(
        f"/flist/character/{cid}/sets/{s['id']}/snapshots/{snap['id']}/revert"
    )
    assert res.status_code == 200
    body = res.json()
    safety_id = body["safety_snapshot_id"]
    assert safety_id and safety_id != snap["id"]

    # Current payload is back to "A".
    current = client.get(
        f"/flist/character/{cid}/sets/{s['id']}/payload"
    ).json()
    assert current["payload"]["character"]["description"] == "A"

    # Safety snapshot captures "B" — the state immediately before revert.
    safety_payload = client.get(
        f"/flist/character/{cid}/sets/{s['id']}/snapshots/{safety_id}"
    ).json()
    assert safety_payload["payload"]["character"]["description"] == "B"
    assert safety_payload["snapshot"]["name"].startswith("Auto-safety @ ")

    # And the snapshot list now has BOTH S1 + the auto-safety.
    listing = client.get(f"/flist/character/{cid}/sets").json()
    matching = [x for x in listing["sets"] if x["id"] == s["id"]][0]
    assert matching["snapshotCount"] == 2


def test_snapshot_revert_unknown_returns_404(client: TestClient) -> None:
    cid = "504"
    s = _create_set(client, cid)
    _put_payload(client, cid, s["id"], "x")
    res = client.post(
        f"/flist/character/{cid}/sets/{s['id']}/snapshots/abcd1234abcd/revert"
    )
    assert res.status_code == 404


def test_snapshot_create_on_empty_set_404(client: TestClient) -> None:
    cid = "505"
    # No set at all.
    res = client.post(
        f"/flist/character/{cid}/sets/abcd1234abcd/snapshots",
        json={"name": "x"},
    )
    assert res.status_code == 404


def test_snapshot_rename_404_when_missing(client: TestClient) -> None:
    cid = "506"
    s = _create_set(client, cid)
    _put_payload(client, cid, s["id"], "x")
    res = client.patch(
        f"/flist/character/{cid}/sets/{s['id']}/snapshots/abcd1234abcd",
        json={"name": "x"},
    )
    assert res.status_code == 404


def test_snapshot_delete_idempotent(client: TestClient) -> None:
    cid = "507"
    s = _create_set(client, cid)
    _put_payload(client, cid, s["id"], "x")
    snap = client.post(
        f"/flist/character/{cid}/sets/{s['id']}/snapshots",
        json={"name": "x"},
    ).json()["snapshot"]
    first = client.delete(
        f"/flist/character/{cid}/sets/{s['id']}/snapshots/{snap['id']}"
    ).json()
    second = client.delete(
        f"/flist/character/{cid}/sets/{s['id']}/snapshots/{snap['id']}"
    ).json()
    assert first["deleted"] is True
    assert second["deleted"] is False
