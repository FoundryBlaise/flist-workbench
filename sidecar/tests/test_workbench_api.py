"""The Workbench REST surface: one editable copy per character, beside
its Live, made from Live when first needed (ADR 0001)."""

from __future__ import annotations

from pathlib import Path

import pytest
import archive_live
import archive_registry
import archive_workbench
from sidecar_client import app_client


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import archive_registry

    importlib.reload(archive_registry)
    from server import app

    return app_client(app)


def _seed(cid: str = "42") -> None:
    archive_registry.register_character(cid, "Lady Amber Blaise")
    archive_live.write_live(
        cid,
        {
            "character": {
                "id": int(cid),
                "name": "Lady Amber Blaise",
                "description": "[b]Published.[/b]",
                "custom_title": None,
            },
            "infotags": {},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
            "fetched_at": 1000,
        },
    )


def _edit(api, description: str, cid: str = "42") -> None:
    """Save an edit the way the window does: over the etag it read."""
    url = f"/flist/character/{cid}/workbench/payload"
    current = api.get(url).json()
    payload = current["payload"]
    payload["character"]["description"] = description
    payload["_overlay"] = ["character.description"]
    res = api.put(url, json=payload, headers={"If-Match": current["etag"]})
    assert res.status_code == 200, res.text


def _description(api, cid: str = "42") -> str:
    url = f"/flist/character/{cid}/workbench/payload?create=false"
    return api.get(url).json()["payload"]["character"]["description"]


def test_asking_for_the_workbench_creates_it_from_live(client) -> None:
    api = client
    _seed()

    body = api.get("/flist/character/42/workbench").json()

    assert body["workbench"]["name"] == "Workbench"
    assert body["workbench"]["updated_at"] >= body["workbench"]["created_at"]
    assert _description(api) == "[b]Published.[/b]"


def test_a_read_only_render_can_ask_without_creating_one(client) -> None:
    api = client
    _seed()

    body = api.get("/flist/character/42/workbench?create=false").json()
    assert body["workbench"] is None
    # Not the same nothing as "never pulled": the window offers the row
    # in this case and hides it in the other.
    assert body["reason"] == "not_created_yet"
    read = api.get("/flist/character/42/workbench/payload?create=false")
    assert read.status_code == 404


def test_a_character_never_pulled_has_nothing_to_seed_from(client) -> None:
    api = client
    archive_registry.register_character("99", "Ghost")

    body = api.get("/flist/character/99/workbench").json()
    assert body["workbench"] is None
    assert body["reason"] == "no_live"


def test_a_save_moves_the_workbench_last_changed(client) -> None:
    api = client
    _seed()
    first = api.get("/flist/character/42/workbench").json()["workbench"]
    meta = archive_workbench.workbench_dir("42") / "meta.json"
    meta.write_text('{"created_at": 10, "updated_at": 10}', encoding="utf-8")

    _edit(api, "edited")

    after = api.get("/flist/character/42/workbench?create=false").json()["workbench"]
    assert after["created_at"] == 10
    assert after["updated_at"] >= first["updated_at"] > 10


def test_loading_a_backup_replaces_the_bench_in_place(client) -> None:
    api = client
    _seed()
    _edit(api, "worth keeping")
    saved = api.post("/flist/character/42/zip-backup").json()
    filename = saved.get("filename") or saved["backup"]["filename"]
    _edit(api, "a mistake")

    body = api.post(
        "/flist/character/42/workbench/load-backup",
        json={"filename": filename},
    ).json()

    assert body["loaded"] == filename
    assert body["workbench"]["name"] == "Workbench"
    assert _description(api) == "worth keeping"


def test_loading_a_missing_backup_is_a_404(client) -> None:
    api = client
    _seed()
    api.get("/flist/character/42/workbench")

    res = api.post(
        "/flist/character/42/workbench/load-backup",
        json={"filename": "2026-01-01T000000Z.zip"},
    )
    assert res.status_code == 404


def test_preflight_reports_that_f_list_has_moved_on(client) -> None:
    """The warning the user asked for: this backup is older than the
    profile now on F-list, so loading it is a step backwards. Reported,
    not enforced — wanting it anyway is legitimate."""
    api = client
    _seed()
    _edit(api, "edited")
    saved = api.post("/flist/character/42/zip-backup").json()
    filename = saved.get("filename") or saved["backup"]["filename"]

    before = api.get(
        "/flist/character/42/workbench/load-backup/preflight",
        params={"filename": filename},
    ).json()
    assert before["live_diverged"] is False
    assert before["workbench_has_edits"] is True

    # A later pull from F-list: the backup now predates what is live.
    live = archive_live.read_live("42")
    live["fetched_at"] = int(before["backup_created_at"]) + 3600
    archive_live.write_live("42", live)

    after = api.get(
        "/flist/character/42/workbench/load-backup/preflight",
        params={"filename": filename},
    ).json()
    assert after["live_diverged"] is True


def test_preflight_on_an_unknown_backup_is_a_404(client) -> None:
    api = client
    _seed()
    res = api.get(
        "/flist/character/42/workbench/load-backup/preflight",
        params={"filename": "nope.zip"},
    )
    assert res.status_code == 404
