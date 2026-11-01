"""Deleting a Backup moves it to the Trash.

The Trash is one place for everything the user deletes: images and
Backups alike. A deleted Backup keeps its bytes and its user-set name
there, and restoring it puts it back in the Backup list under that
name. Only the window empties the Trash; no MCP tool can.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sidecar_client import app_client

from mcp_helpers import mcp_client
from test_mcp_edit import workbench  # noqa: F401

CID = "42"
BACKUPS = f"/flist/character/{CID}/zip-backups"
TRASH = f"/flist/character/{CID}/trash"


@pytest.fixture
def backup(workbench) -> dict:  # noqa: F811
    """A Backup the user named, on disk before the test starts."""
    saved = workbench.save_zip_backup(CID, force=True)
    workbench.rename_zip_backup(CID, saved["filename"], "Before the big rewrite")
    return saved


@pytest.fixture
def client(workbench) -> TestClient:  # noqa: F811
    import server

    with app_client(server.app) as c:
        yield c


def listed(client: TestClient) -> dict[str, str | None]:
    return {b["filename"]: b["name"] for b in client.get(BACKUPS).json()["backups"]}


def trashed(client: TestClient) -> list[dict]:
    return client.get(TRASH).json()["backups"]


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def files_under(folder: Path) -> dict[str, Path]:
    return {sha(p.read_bytes()): p for p in folder.rglob("*") if p.is_file()}


def test_a_deleted_backup_goes_to_the_trash_and_comes_back_under_its_name(
    client, backup, workbench  # noqa: F811
) -> None:
    filename = backup["filename"]
    original = Path(backup["path"]).read_bytes()

    res = client.delete(f"{BACKUPS}/{filename}")

    assert res.status_code == 204
    assert filename not in listed(client)
    [entry] = trashed(client)
    assert entry["filename"] == filename
    assert entry["name"] == "Before the big rewrite"
    assert entry["deleted_by"] == "ui"
    assert entry["size"] == len(original)
    trash = workbench.character_dir(CID) / "trash"
    assert sha(original) in files_under(trash)

    restored = client.post(f"{TRASH}/backups/restore", json={"ids": [entry["id"]]})

    assert restored.status_code == 200
    assert restored.json()["restored"] == [filename]
    assert listed(client) == {filename: "Before the big rewrite"}
    assert trashed(client) == []
    download = client.get(f"{BACKUPS}/{filename}/download")
    assert download.content == original
