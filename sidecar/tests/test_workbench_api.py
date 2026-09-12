"""The workbench REST surface (one editable copy per character).

Working sets were a user-facing concept — create, name, keep several,
pick an active one — and testers could not explain what one was, how it
related to "From F-list", or why backups were a third thing beside both.
The concept stays on disk and leaves the vocabulary: one bench per
character, always there, seeded from Live when first needed.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import character_archive

    importlib.reload(character_archive)
    from server import app

    return TestClient(app), character_archive


def _seed(archive, cid: str = "42") -> None:
    archive.register_character(cid, "Lady Amber Blaise")
    archive.write_live(
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


def _edit(archive, cid: str, set_id: str, description: str) -> None:
    archive.write_set_payload(
        cid,
        set_id,
        {
            "_schema_version": archive.WORKING_SCHEMA_VERSION,
            "_overlay": ["character.description"],
            "character": {
                "id": cid,
                "name": "Lady Amber Blaise",
                "description": description,
            },
        },
        expected_etag=None,
    )


def test_asking_for_the_workbench_creates_it_from_live(client) -> None:
    api, archive = client
    _seed(archive)

    body = api.get("/flist/character/42/workbench").json()
    assert body["workbench"]["name"] == archive.WORKBENCH_SET_NAME
    assert body["active_set_id"] == body["workbench"]["id"]
    assert len(archive.list_sets("42")) == 1


def test_a_read_only_render_can_ask_without_creating_one(client) -> None:
    api, archive = client
    _seed(archive)

    body = api.get("/flist/character/42/workbench?create=false").json()
    assert body["workbench"] is None
    assert archive.list_sets("42") == []


def test_a_character_never_pulled_has_nothing_to_seed_from(client) -> None:
    api, archive = client
    archive.register_character("99", "Ghost")

    body = api.get("/flist/character/99/workbench").json()
    assert body["workbench"] is None
    assert body["reason"] == "no_live"


def test_loading_a_backup_replaces_the_bench_in_place(client) -> None:
    api, archive = client
    _seed(archive)
    bench = archive.resolve_workbench("42")
    _edit(archive, "42", bench.id, "worth keeping")
    saved = api.post("/flist/character/42/zip-backup").json()
    filename = saved.get("filename") or saved["backup"]["filename"]
    _edit(archive, "42", bench.id, "a mistake")

    body = api.post(
        "/flist/character/42/workbench/load-backup",
        json={"filename": filename},
    ).json()

    assert body["loaded"] == filename
    assert body["backed_up_first"] is None
    assert len(archive.list_sets("42")) == 1, "must not add a second draft"
    payload = archive.read_set_payload("42", bench.id)
    assert payload["character"]["description"] == "worth keeping"


def test_backing_up_first_is_the_users_third_button(client) -> None:
    """Cancel / load / back up and load. The safety net is offered, never
    imposed — which is the point: the decision is the user's."""
    api, archive = client
    _seed(archive)
    bench = archive.resolve_workbench("42")
    _edit(archive, "42", bench.id, "first state")
    saved = api.post("/flist/character/42/zip-backup").json()
    filename = saved.get("filename") or saved["backup"]["filename"]
    _edit(archive, "42", bench.id, "about to be replaced")

    body = api.post(
        "/flist/character/42/workbench/load-backup",
        json={"filename": filename, "back_up_first": True},
    ).json()

    assert body["backed_up_first"] is not None
    rescued = body["backed_up_first"]["filename"]
    assert rescued != filename
    with zipfile.ZipFile(
        archive.backups_dir("42") / rescued, "r"
    ) as zf:
        stored: dict[str, Any] = json.loads(zf.read("working.json").decode("utf-8"))
    assert stored["character"]["description"] == "about to be replaced"


def test_loading_a_missing_backup_is_a_404(client) -> None:
    api, archive = client
    _seed(archive)
    archive.resolve_workbench("42")

    res = api.post(
        "/flist/character/42/workbench/load-backup",
        json={"filename": "2026-01-01T000000Z.zip"},
    )
    assert res.status_code == 404


def test_preflight_reports_that_f_list_has_moved_on(client) -> None:
    """The warning the user asked for: this backup is older than the
    profile now on F-list, so loading it is a step backwards. Reported,
    not enforced — wanting it anyway is legitimate."""
    api, archive = client
    _seed(archive)
    bench = archive.resolve_workbench("42")
    _edit(archive, "42", bench.id, "edited")
    saved = api.post("/flist/character/42/zip-backup").json()
    filename = saved.get("filename") or saved["backup"]["filename"]

    before = api.get(
        "/flist/character/42/workbench/load-backup/preflight",
        params={"filename": filename},
    ).json()
    assert before["live_diverged"] is False
    assert before["workbench_has_edits"] is True

    # A later pull from F-list: the backup now predates what is live.
    live = archive.read_live("42")
    live["fetched_at"] = int(before["backup_created_at"]) + 3600
    archive.write_live("42", live)

    after = api.get(
        "/flist/character/42/workbench/load-backup/preflight",
        params={"filename": filename},
    ).json()
    assert after["live_diverged"] is True


def test_preflight_on_an_unknown_backup_is_a_404(client) -> None:
    api, archive = client
    _seed(archive)
    res = api.get(
        "/flist/character/42/workbench/load-backup/preflight",
        params={"filename": "nope.zip"},
    )
    assert res.status_code == 404
