"""HTTP-level tests for the assistant draft endpoints.

Covers the opt-in gate (feature_disabled when flag is off), the full
append → accept → delete cycle through FastAPI, and the etag-mismatch
shape that mirrors the working-copy PUT.

The mapping list is faked by writing a cache file directly so the
sidecar's fetch_mapping_list returns it from disk without hitting the
network.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient


MAPPING_LIST: dict[str, Any] = {
    "infotags": {
        "49": {
            "id": 49,
            "name": "Language preferences",
            "type": "list",
            "list": [
                {"id": 21, "name": "English"},
                {"id": 22, "name": "German"},
            ],
        }
    },
    "kinks": [{"id": 100, "name": "k100"}],
}


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    import importlib
    import sys

    for mod in (
        "paths",
        "character_archive",
        "ai_draft",
        "ai_draft_validate",
        "ai_tools_atomic",
        "settings",
        "server",
    ):
        if mod in sys.modules:
            importlib.reload(sys.modules[mod])
    import character_archive

    cache = character_archive.cache_root() / "mapping-list.json"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(MAPPING_LIST), encoding="utf-8")
    from server import app

    return TestClient(app)


def _enable_feature(client: TestClient) -> None:
    """Flip the master toggle on via direct settings write."""
    import settings as settings_store

    conn = settings_store.connect()
    try:
        settings_store.set_value(conn, settings_store.KEY_AI_ASSISTANT_ENABLED, "true")
    finally:
        conn.close()


def _seed_character(character_id: str = "42") -> None:
    import character_archive

    working = {
        "_schema_version": character_archive.WORKING_SCHEMA_VERSION,
        "_overlay": [],
        "character": {
            "id": int(character_id),
            "name": "Test",
            "description": "Hello [b]world[/b].",
        },
        "infotags": {"49": "21"},
        "settings": {"public": True},
        "kinks": {"100": "yes"},
        "custom_kinks": {},
        "_custom_kinks_order": [],
        "images": [],
    }
    character_archive.write_working(character_id, working)


def test_get_refuses_when_feature_disabled(client: TestClient) -> None:
    res = client.get("/flist/character/42/ai-draft")
    assert res.status_code == 403
    assert res.json()["detail"] == "feature_disabled"


def test_get_when_no_draft_returns_404(client: TestClient) -> None:
    _enable_feature(client)
    res = client.get("/flist/character/42/ai-draft")
    assert res.status_code == 404
    assert res.json()["detail"] == "no_draft"


def test_append_then_get(client: TestClient) -> None:
    _enable_feature(client)
    _seed_character()
    res = client.post(
        "/flist/character/42/ai-draft/edits",
        json={
            "edits": [
                {
                    "tool": "set_infotag",
                    "field_path": "infotags.49",
                    "new_value": "German",
                    "rationale": "user asked",
                }
            ]
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["draft"]["edits"][0]["new_value"] == "22"

    get_res = client.get("/flist/character/42/ai-draft")
    assert get_res.status_code == 200
    assert get_res.json()["draft"]["edits"][0]["status"] == "pending"


def test_append_with_no_working_copy_returns_409(client: TestClient) -> None:
    _enable_feature(client)
    res = client.post(
        "/flist/character/42/ai-draft/edits",
        json={
            "edits": [
                {
                    "tool": "replace_description",
                    "field_path": "character.description",
                    "new_value": "anything",
                    "rationale": "x",
                }
            ]
        },
    )
    assert res.status_code == 409
    assert res.json()["detail"]["detail"] == "no_working_copy"


def test_accept_returns_etag_and_drops_draft(client: TestClient) -> None:
    _enable_feature(client)
    _seed_character()
    import character_archive

    initial_etag = character_archive.working_etag("42")
    append_res = client.post(
        "/flist/character/42/ai-draft/edits",
        json={
            "edits": [
                {
                    "tool": "set_infotag",
                    "field_path": "infotags.49",
                    "new_value": "German",
                    "rationale": "x",
                }
            ]
        },
    )
    edit_id = append_res.json()["accepted_edit_ids"][0]
    accept = client.post(
        "/flist/character/42/ai-draft/accept",
        headers={"If-Match": initial_etag},
        json={"edit_ids": [edit_id]},
    )
    assert accept.status_code == 200, accept.text
    body = accept.json()
    assert body["draft"] is None
    assert body["new_etag"] != initial_etag


def test_accept_with_wrong_etag_409(client: TestClient) -> None:
    _enable_feature(client)
    _seed_character()
    append = client.post(
        "/flist/character/42/ai-draft/edits",
        json={
            "edits": [
                {
                    "tool": "set_infotag",
                    "field_path": "infotags.49",
                    "new_value": "German",
                    "rationale": "x",
                }
            ]
        },
    )
    edit_id = append.json()["accepted_edit_ids"][0]
    res = client.post(
        "/flist/character/42/ai-draft/accept",
        headers={"If-Match": "deadbeef"},
        json={"edit_ids": [edit_id]},
    )
    assert res.status_code == 409
    assert res.json()["detail"]["detail"] == "etag_mismatch"


def test_reject_prunes_edits(client: TestClient) -> None:
    _enable_feature(client)
    _seed_character()
    append = client.post(
        "/flist/character/42/ai-draft/edits",
        json={
            "edits": [
                {
                    "tool": "set_infotag",
                    "field_path": "infotags.49",
                    "new_value": "German",
                    "rationale": "1",
                },
                {
                    "tool": "replace_description",
                    "field_path": "character.description",
                    "new_value": "Rewritten",
                    "rationale": "2",
                },
            ]
        },
    )
    [first, second] = append.json()["accepted_edit_ids"]
    res = client.post(
        "/flist/character/42/ai-draft/reject",
        json={"edit_ids": [first]},
    )
    assert res.status_code == 200
    draft = res.json()["draft"]
    assert draft is not None
    remaining = [e["id"] for e in draft["edits"]]
    assert first not in remaining
    assert second in remaining


def test_delete_draft_idempotent(client: TestClient) -> None:
    _enable_feature(client)
    res = client.delete("/flist/character/42/ai-draft")
    assert res.status_code == 200
    assert res.json()["deleted"] is False


def test_tools_atomic_endpoint(client: TestClient) -> None:
    _enable_feature(client)
    res = client.get("/assistant/tools/atomic")
    assert res.status_code == 200
    names = {t["name"] for t in res.json()["tools"]}
    assert "set_infotag" in names
    assert "set_standard_kink" in names
    assert "add_image_to_gallery" in names
    assert "remove_image_from_gallery" in names
    # No byte-deleting tool — gallery-only per user decision 2026-06-19.
    assert "delete_image_bytes" not in names
