"""Replacing the whole Workbench first keeps it as a Backup.

Restore, reset to Live and the MCP tool that loads a Backup each throw
away every edit in the Workbench at once. So each of them first saves
the Workbench as a Backup (source `workbench`, occasion
`before-restore`), always, and replaces nothing when that Backup cannot
be written (ADR 0003). Undoing any of them is then a Restore away.

Driven from outside: the window's routes and the MCP tools.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from mcp_helpers import call_tool, mcp_client
from sidecar_client import app_client

NAME = "Mira Vantelle"
CID = "42"
PUBLISHED = "[b]Published.[/b]"
EDITED = "[b]Halfway through a rewrite.[/b]"
PARKED = "[b]An older draft, parked.[/b]"


@pytest.fixture
def window(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import character_archive
    import paths
    import server

    importlib.reload(paths)
    importlib.reload(character_archive)

    character_archive.register_character(CID, NAME)
    character_archive.write_live(
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
    return app_client(server.app)


async def _edit_workbench(text: str) -> None:
    async with mcp_client("character") as session:
        await call_tool(session, "set_description", character=NAME, text=text)


def _workbench(window) -> dict[str, Any]:
    """The Workbench payload as the window reads it."""
    res = window.get(f"/flist/character/{CID}/workbench", params={"create": False})
    assert res.status_code == 200, res.text
    bench = res.json()["workbench"]
    assert bench is not None, res.json()
    res = window.get(f"/flist/character/{CID}/sets/{bench['id']}/payload")
    assert res.status_code == 200, res.text
    return res.json()["payload"]


def _backups(window) -> list[dict]:
    res = window.get(f"/flist/character/{CID}/zip-backups")
    assert res.status_code == 200, res.text
    return res.json()["backups"]


def _held(window, filename: str) -> dict[str, Any]:
    res = window.get(f"/flist/character/{CID}/zip-backups/{filename}/payload")
    assert res.status_code == 200, res.text
    return res.json()["payload"]


async def _parked_backup(window) -> str:
    """A Backup of an older draft, to Restore later. Returns its file name."""
    await _edit_workbench(PARKED)
    res = window.post(f"/flist/character/{CID}/zip-backup")
    assert res.status_code == 200, res.text

    return res.json()["filename"]


def _before_restore(window, previous: list[dict]) -> dict:
    """The one Backup made since `previous`, checked to be a
    before-restore Backup of the Workbench."""
    known = {b["filename"] for b in previous}
    [made] = [b for b in _backups(window) if b["filename"] not in known]
    assert (made["source"], made["occasion"]) == ("workbench", "before-restore")
    return made


# ---- Restore -----------------------------------------------------------


async def test_a_restore_keeps_the_workbench_it_replaces(window) -> None:
    parked = await _parked_backup(window)
    await _edit_workbench(EDITED)
    previous_workbench = _workbench(window)
    previous_backups = _backups(window)

    res = window.post(
        f"/flist/character/{CID}/workbench/load-backup", json={"filename": parked}
    )
    assert res.status_code == 200, res.text

    made = _before_restore(window, previous_backups)
    assert _held(window, made["filename"]) == previous_workbench
    assert _workbench(window)["character"]["description"] == PARKED


# ---- the MCP tool that loads a Backup ----------------------------------


async def test_loading_a_backup_over_mcp_keeps_the_workbench_it_replaces(
    window,
) -> None:
    parked = await _parked_backup(window)
    await _edit_workbench(EDITED)
    previous_workbench = _workbench(window)
    previous_backups = _backups(window)

    async with mcp_client("character") as session:
        result, body = await call_tool(
            session,
            "load_backup_into_workbench",
            character=NAME,
            backup=parked,
            confirm=True,
        )
    assert not result.isError, body

    made = _before_restore(window, previous_backups)
    assert body["kept_as"] == made["filename"]
    assert _held(window, made["filename"]) == previous_workbench
    assert _workbench(window)["character"]["description"] == PARKED
