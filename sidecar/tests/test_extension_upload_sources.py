"""What the extension can upload into F-list's edit form.

The extension asks the app for a character's Upload sources and fetches
the one the user picks as a zip, whose `character.json` it writes into
the page. The sources are the character's Workbench and its Backups.
Live is never one: it already is what the site shows.

Driven from outside, the way the extension drives it: the `/restore/*`
routes with the pairing token. The window's routes set the scene.
"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from sidecar_client import app_client

AMBER = "Mirela Thornquist"
CORVIN = "Ser Corvin Ashdown"
PNG = b"\x89PNG\r\n\x1a\n" + b"gallery" * 8


def _live(character_id: int, name: str, description: str) -> dict:
    return {
        "name": name,
        "character": {"id": character_id, "name": name, "description": description},
        "infotags": {"2": "Human"},
        "kinks": {"580": "fave"},
        "custom_kinks": {},
        "inlines": {},
        "images": [
            {"image_id": "5551001", "extension": "png", "description": "Map", "sort_order": 0}
        ],
        "fetched_at": 1000,
    }


@pytest.fixture
def paired(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import archive_images
    import archive_live
    import archive_registry
    import paths
    import restore as restore_svc
    import server

    importlib.reload(paths)
    importlib.reload(archive_registry)
    importlib.reload(restore_svc)

    for cid, name in (("42", AMBER), ("77", CORVIN)):
        archive_registry.register_character(cid, name)
        archive_live.write_live(cid, _live(int(cid), name, f"[b]{name}, as published.[/b]"))
        (archive_images.images_dir(cid) / "5551001.png").write_bytes(PNG)

    hs = restore_svc.begin_handshake()
    restore_svc.accept_handshake(hs["handshake_id"])
    window = app_client(server.app)
    # The headers extension 0.1.1 sends on every call.
    extension = app_client(
        server.app,
        headers={
            "X-Workbench-Auth": hs["token"],
            "X-Workbench-Extension-Version": "0.1.1",
        },
    )
    yield window, extension
    # The pairing lives in module state; leave the next test unpaired.
    restore_svc.revoke_token()


def _edit_workbench(window, character_id: str, description: str) -> None:
    """Write the character's Workbench the way the window does."""
    url = f"/flist/character/{character_id}/workbench/payload"
    current = window.get(url).json()
    payload = current["payload"]
    payload["character"]["description"] = description
    payload["_overlay"] = sorted({*payload.get("_overlay", []), "character.description"})
    res = window.put(url, json=payload, headers={"If-Match": current["etag"]})
    assert res.status_code == 200, res.text


def _back_up(window, character_id: str) -> str:
    """A Backup made in the window."""
    res = window.post(f"/flist/character/{character_id}/zip-backup")
    assert res.status_code == 200, res.text
    return res.json()["filename"]


def _sources(extension, name: str) -> list[dict]:
    res = extension.get("/restore/snapshots", params={"character": name})
    assert res.status_code == 200, res.text
    return res.json()


def _fetch(extension, name: str, source_id: str) -> dict:
    """Fetch an Upload source and read back what the extension writes
    into the form."""
    res = extension.get(f"/restore/snapshot/{source_id}", params={"character": name})
    assert res.status_code == 200, res.text
    with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
        return json.loads(zf.read("character.json"))


def test_live_is_not_an_upload_source(paired) -> None:
    window, extension = paired
    _edit_workbench(window, "42", "[b]Drafted in the Workbench.[/b]")
    _back_up(window, "42")

    kinds = [s["kind"] for s in _sources(extension, AMBER)]

    assert "live" not in kinds
    assert all(s["id"] != "live" for s in _sources(extension, AMBER))


def test_the_sources_are_the_workbench_then_the_backups_newest_first(paired) -> None:
    window, extension = paired
    _edit_workbench(window, "42", "[b]First draft.[/b]")
    older = _back_up(window, "42")
    _edit_workbench(window, "42", "[b]Second draft.[/b]")
    newer = _back_up(window, "42")

    sources = _sources(extension, AMBER)

    # Extension 0.1.1 finds the Workbench by its kind.
    assert [s["kind"] for s in sources] == ["set", "backup", "backup"]
    assert [s["id"] for s in sources[1:]] == [newer, older]


def test_a_character_without_a_workbench_offers_only_its_backups(paired) -> None:
    window, extension = paired
    # A Backup of a character never edited packs Live and makes no Workbench.
    taken = _back_up(window, "77")
    assert window.get(
        "/flist/character/77/workbench", params={"create": False}
    ).json()["workbench"] is None

    assert [s["id"] for s in _sources(extension, CORVIN)] == [taken]


def _by_kind(sources: list[dict], kind: str) -> list[dict]:
    return [s for s in sources if s["kind"] == kind]


def test_the_workbench_source_uploads_the_workbench(paired) -> None:
    window, extension = paired
    _edit_workbench(window, "42", "[b]Backed up draft.[/b]")
    _back_up(window, "42")
    _edit_workbench(window, "42", "[b]The draft as it is now.[/b]")
    (bench,) = _by_kind(_sources(extension, AMBER), "set")

    profile = _fetch(extension, AMBER, bench["id"])

    assert profile["character"]["description"] == "[b]The draft as it is now.[/b]"
    assert profile["kinks"] == {"580": "fave"}
    assert [i["filename"] for i in profile["images"]["list"]] == ["images/5551001.png"]


def test_a_backup_source_uploads_that_backup(paired) -> None:
    window, extension = paired
    _edit_workbench(window, "42", "[b]Older draft.[/b]")
    older = _back_up(window, "42")
    _edit_workbench(window, "42", "[b]Newer draft.[/b]")
    newer = _back_up(window, "42")
    _edit_workbench(window, "42", "[b]The draft as it is now.[/b]")

    assert _fetch(extension, AMBER, older)["character"]["description"] == "[b]Older draft.[/b]"
    assert _fetch(extension, AMBER, newer)["character"]["description"] == "[b]Newer draft.[/b]"


def test_live_cannot_be_fetched_as_an_upload_source(paired) -> None:
    _window, extension = paired

    res = extension.get("/restore/snapshot/live", params={"character": AMBER})

    assert res.status_code == 404


def test_another_characters_sources_can_be_uploaded(paired) -> None:
    """One profile as the template for another: on Mirela's edit page
    the extension lists and fetches Corvin's sources by his name."""
    window, extension = paired
    _edit_workbench(window, "42", "[b]Mirela's draft.[/b]")
    _edit_workbench(window, "77", "[b]Corvin's older draft.[/b]")
    backup = _back_up(window, "77")
    _edit_workbench(window, "77", "[b]Corvin's draft.[/b]")
    (bench,) = _by_kind(_sources(extension, CORVIN), "set")

    assert _fetch(extension, CORVIN, bench["id"])["character"]["description"] == (
        "[b]Corvin's draft.[/b]"
    )
    assert _fetch(extension, CORVIN, backup)["character"]["description"] == (
        "[b]Corvin's older draft.[/b]"
    )


def test_a_request_shaped_like_extension_0_1_1_gets_the_fields_it_reads(paired) -> None:
    window, extension = paired
    _edit_workbench(window, "42", "[b]Drafted in the Workbench.[/b]")
    _back_up(window, "42")

    res = extension.get("/restore/snapshots", params={"character": AMBER})

    assert res.status_code == 200
    bench, backup = res.json()
    assert set(bench) == {"id", "kind", "label", "created_at", "image_count", "upload_refused"}
    assert set(backup) == {
        "id", "kind", "label", "created_at", "image_count",
        "backup_kind", "name", "upload_refused",
    }
    assert bench["kind"] == "set"
    assert bench["image_count"] == 1
    assert bench["upload_refused"] is None
    assert backup["kind"] == "backup"
    assert backup["backup_kind"] == "manual_single"
    # 0.1.1 echoes the id back as a path segment.
    for source in (bench, backup):
        res = extension.get(
            f"/restore/snapshot/{source['id']}", params={"character": AMBER}
        )
        assert res.status_code == 200
        assert res.headers["content-type"] == "application/zip"


def test_the_workbench_source_names_the_one_workbench(paired) -> None:
    window, extension = paired
    _edit_workbench(window, "42", "[b]Drafted in the Workbench.[/b]")

    (bench,) = _by_kind(_sources(extension, AMBER), "set")

    assert bench["id"] == "workbench"
    assert bench["label"] == "Workbench (your edits)"


def test_the_workbench_is_fetched_under_its_own_id_only(paired) -> None:
    """Earlier versions named the Workbench entry `set:<id>`. The
    extension fetches the id the list gives it, which is `workbench`;
    an id naming a draft of an older version is no source."""
    window, extension = paired
    _edit_workbench(window, "42", "[b]Drafted in the Workbench.[/b]")

    res = extension.get("/restore/snapshot/set:aaaaaaaaaaaa", params={"character": AMBER})

    assert res.status_code == 404
    assert [s["id"] for s in _by_kind(_sources(extension, AMBER), "set")] == ["workbench"]


def test_an_upload_from_a_backup_file_on_disk_still_works(paired, monkeypatch) -> None:
    """The extension opens a Backup file from disk itself; the app only
    sees the two calls around the Upload: the form kept as a Backup
    first, then word that the user pressed Save on f-list.net."""
    import time

    from services import pull as pull_service

    pulled: list[str] = []

    async def fake_pull(name: str):
        pulled.append(name)
        return
        yield  # an async generator, like the real one

    monkeypatch.setattr(pull_service, "run", fake_pull)
    _window, extension = paired
    form = {
        "character": {"id": "42", "name": AMBER, "description": "[b]On the page.[/b]"},
        "settings": {},
        "infotags": {},
        "kinks": {},
        "customKinks": [],
    }

    kept = extension.post("/restore/snapshot/fresh", json={"character": AMBER, "payload": form})
    saved = extension.post("/restore/saved", json={"character": AMBER, "delay_seconds": 0})

    assert kept.status_code == 200 and kept.json()["ok"] is True
    (backup,) = _by_kind(_sources(extension, AMBER), "pre-restore")
    assert backup["id"] == kept.json()["snapshot_id"]
    assert saved.status_code == 200 and saved.json()["scheduled"] is True
    deadline = time.monotonic() + 2.0
    while not pulled and time.monotonic() < deadline:
        time.sleep(0.02)
    assert pulled == [AMBER]
