"""Every Backup says what it holds and why it was made.

A Backup holds either the Live or the Workbench of its moment and
records which (`source`), and why it was taken (`occasion`). A manual
Backup parks the Workbench; Back up all and the Backup taken before an
Upload keep Live, so what was on F-list is always recoverable.

Driven from outside: the window's routes, the MCP tools and the
extension's routes, with F-list faked at the HTTP seam.
"""

from __future__ import annotations

import io
import json
import time
import zipfile
from pathlib import Path

import pytest

from mcp_helpers import call_tool, mcp_client
from sidecar_client import app_client

NAME = "Lady Amber Blaise"
CID = "42"
PUBLISHED = "[b]Published.[/b]"
ON_FLIST = "[b]On F-list.[/b]"
EDITED = "[b]Work in progress.[/b]"
ON_THE_FORM = "[b]What the edit form held before the Upload.[/b]"

#: What the extension reads off F-list's edit form just before an
#: Upload, in the page's field names.
FORM_STATE = {
    "meta": {"extractedAt": "2026-10-30T12:00:00.000Z", "source": "extension"},
    "character": {"id": "42", "name": NAME, "description": ON_THE_FORM},
    "settings": {"public": True},
    "infotags": {},
    "kinks": {},
    "customKinks": [],
}


@pytest.fixture
def app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import archive_live
    import archive_registry
    import paths
    import restore as restore_svc
    import server

    importlib.reload(paths)
    importlib.reload(archive_registry)
    importlib.reload(restore_svc)

    archive_registry.register_character(CID, NAME)
    archive_live.write_live(
        CID,
        {
            "name": NAME,
            "character": {"id": 42, "name": NAME, "description": PUBLISHED},
            "infotags": {},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
            "fetched_at": 1000,
        },
    )
    hs = restore_svc.begin_handshake()
    restore_svc.accept_handshake(hs["handshake_id"])
    window = app_client(server.app)
    extension = app_client(server.app, headers={"X-Workbench-Auth": hs["token"]})
    yield window, extension
    restore_svc.revoke_token()


@pytest.fixture
def fake_flist(httpx_mock):  # noqa: ANN001, ANN201
    """Signed in; F-list has the character with another description."""
    import flist_api

    flist_api.ticket_store().set(
        flist_api.Ticket(
            account="amber-account",
            value="test-ticket",
            password="test-password",
            acquired_at=time.monotonic(),
        ),
        characters=[{"id": 42, "name": NAME}],
    )
    httpx_mock.add_response(
        url=flist_api.CHARACTER_DATA_URL,
        method="POST",
        json={
            "error": "",
            "id": 42,
            "name": NAME,
            "description": ON_FLIST,
            "infotags": {},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
        },
        is_reusable=True,
    )
    httpx_mock.add_response(
        url=flist_api.avatar_url(NAME),
        method="GET",
        content=b"\x89PNG\r\n\x1a\n" + b"avatar" * 8,
        is_optional=True,
        is_reusable=True,
    )
    yield httpx_mock
    flist_api.ticket_store().clear()


async def _edit_workbench(text: str = EDITED) -> None:
    async with mcp_client("character") as session:
        await call_tool(session, "set_description", character=NAME, text=text)


def _manual_backup(window) -> None:
    res = window.post(f"/flist/character/{CID}/zip-backup")
    assert res.status_code == 200, res.text
    assert res.json()["saved"] is True, res.json()


def _back_up_all(window) -> None:
    with window.stream("POST", "/flist/backup-all") as res:
        body = "".join(res.iter_text())
    assert "event: done" in body, body


def _upload_starts(extension) -> None:
    """The extension's first step of an Upload: back up the form."""
    res = extension.post(
        "/restore/snapshot/fresh", json={"character": NAME, "payload": FORM_STATE}
    )
    assert res.status_code == 200, res.text


def _backups(window) -> list[dict]:
    res = window.get(f"/flist/character/{CID}/zip-backups")
    assert res.status_code == 200, res.text
    return res.json()["backups"]


def _origin(entry: dict) -> tuple[str, str | None]:
    return entry["source"], entry["occasion"]


def _held_description(window, filename: str) -> str:
    res = window.get(f"/flist/character/{CID}/zip-backups/{filename}/payload")
    assert res.status_code == 200, res.text
    return res.json()["payload"]["character"]["description"]


# ---- manual Backup: the Workbench --------------------------------------


async def test_a_manual_backup_from_the_window_holds_the_workbench(app) -> None:
    window, _ = app
    await _edit_workbench()

    _manual_backup(window)

    [entry] = _backups(window)
    assert _origin(entry) == ("workbench", "manual")
    assert _held_description(window, entry["filename"]) == EDITED


async def test_a_manual_backup_over_mcp_holds_the_workbench(app) -> None:
    window, _ = app
    await _edit_workbench()

    async with mcp_client("character") as session:
        _, made = await call_tool(session, "create_backup", character=NAME)
        _, listed = await call_tool(session, "list_backups", character=NAME)

    assert _origin(made) == ("workbench", "manual")
    [entry] = listed["backups"]
    assert _origin(entry) == ("workbench", "manual")
    assert _held_description(window, entry["filename"]) == EDITED


def test_a_manual_backup_of_a_workbench_never_edited_holds_what_live_seeds_it_with(
    app,
) -> None:
    window, _ = app

    _manual_backup(window)

    [entry] = _backups(window)
    assert _origin(entry) == ("workbench", "manual")
    assert _held_description(window, entry["filename"]) == PUBLISHED


# ---- Back up all: Live -------------------------------------------------


async def test_back_up_all_from_the_window_holds_live(app, fake_flist) -> None:
    window, _ = app
    await _edit_workbench()

    _back_up_all(window)

    [entry] = _backups(window)
    assert _origin(entry) == ("live", "backup-all")
    assert _held_description(window, entry["filename"]) == ON_FLIST


async def test_back_up_all_over_mcp_holds_live(app, fake_flist) -> None:
    window, _ = app
    await _edit_workbench()

    async with mcp_client("character") as session:
        await call_tool(session, "backup_all_characters")

    [entry] = _backups(window)
    assert _origin(entry) == ("live", "backup-all")
    assert _held_description(window, entry["filename"]) == ON_FLIST


async def test_a_manual_backup_in_between_does_not_make_back_up_all_keep_live_twice(
    app, fake_flist
) -> None:
    window, _ = app
    _back_up_all(window)
    await _edit_workbench()
    _manual_backup(window)

    _back_up_all(window)

    origins = sorted(_origin(b) for b in _backups(window))
    assert origins == [("live", "backup-all"), ("workbench", "manual")]


# ---- the Backup before an Upload: Live ---------------------------------


def test_the_backup_before_an_upload_holds_live(app) -> None:
    window, extension = app

    _upload_starts(extension)

    [entry] = _backups(window)
    assert _origin(entry) == ("live", "before-upload")
    assert _held_description(window, entry["filename"]) == ON_THE_FORM


# ---- the Backup before a Restore: the Workbench ------------------------


async def test_backing_up_before_a_restore_keeps_the_workbench(app) -> None:
    window, _ = app
    _manual_backup(window)
    [parked] = _backups(window)
    await _edit_workbench()

    res = window.post(
        f"/flist/character/{CID}/workbench/load-backup",
        json={"filename": parked["filename"], "back_up_first": True},
    )
    assert res.status_code == 200, res.text

    taken = res.json()["backed_up_first"]["filename"]
    [entry] = [b for b in _backups(window) if b["filename"] == taken]
    assert _origin(entry) == ("workbench", "before-restore")
    assert _held_description(window, taken) == EDITED


# ---- older Backups -----------------------------------------------------


def _older_backup(filename: str, meta: dict | None) -> None:
    import archive_backups

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("character.json", "{}")
        if meta is not None:
            zf.writestr("backup-meta.json", json.dumps(meta))
    target = archive_backups.backups_dir(CID)
    target.mkdir(parents=True, exist_ok=True)
    (target / filename).write_bytes(buf.getvalue())


def test_older_backups_are_listed_as_source_unknown(app) -> None:
    window, _ = app
    _older_backup("2026-06-01T120000Z.zip", {"kind": "manual_single"})
    _older_backup("2026-05-01T120000Z.zip", None)

    listed = {b["filename"]: b for b in _backups(window)}

    assert _origin(listed["2026-06-01T120000Z.zip"]) == ("unknown", None)
    assert _origin(listed["2026-05-01T120000Z.zip"]) == ("unknown", None)
    assert listed["2026-06-01T120000Z.zip"]["kind"] == "manual_single"


# ---- the extension still sorts by kind ---------------------------------


async def test_the_extension_still_sorts_backups_by_their_kind(
    app, fake_flist
) -> None:
    """Extension 0.1.1 buckets its Backup list on `backup_kind` and
    leaves out a Backup whose kind it does not know."""
    window, extension = app
    _manual_backup(window)
    _back_up_all(window)
    _upload_starts(extension)

    res = extension.get("/restore/snapshots", params={"character": NAME})
    assert res.status_code == 200, res.text

    backups = [e for e in res.json() if e["kind"] not in ("live", "set")]
    kinds = sorted((e["kind"], e["backup_kind"]) for e in backups)
    assert kinds == [
        ("backup", "manual_bulk"),
        ("backup", "manual_single"),
        ("pre-restore", "pre_upload"),
    ]
