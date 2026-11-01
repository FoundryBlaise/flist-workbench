"""Deleting a Backup moves it to the Trash.

A character's Trash holds the images and Backups the user deletes. A deleted Backup keeps its bytes and its user-set name
there, and restoring it puts it back in the Backup list under that
name. Only the window empties the Trash; no MCP tool can.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sidecar_client import app_client

from mcp_helpers import call_tool, mcp_client
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


@pytest.mark.invariant_exempt(
    "nothing_vanishes",
    reason="a human emptying the Trash is the one deletion the rule allows",
)
def test_only_the_window_deletes_a_trashed_backup_for_good(client, workbench) -> None:  # noqa: F811
    first = workbench.save_zip_backup(CID, force=True)["filename"]
    client.delete(f"{BACKUPS}/{first}")
    second = workbench.save_zip_backup(CID, force=True)["filename"]
    client.delete(f"{BACKUPS}/{second}")
    ids = {b["filename"]: b["id"] for b in trashed(client)}

    purged = client.post(f"{TRASH}/backups/purge", json={"ids": [ids[first]]}).json()

    assert purged["purged"] == [ids[first]]
    assert [b["filename"] for b in trashed(client)] == [second]

    emptied = client.delete(TRASH).json()

    assert emptied["purged"] == 1
    assert trashed(client) == []
    assert listed(client) == {}


async def test_no_mcp_tool_can_empty_the_trash_or_delete_from_it(
    client, backup, workbench  # noqa: F811
) -> None:
    client.delete(f"{BACKUPS}/{backup['filename']}")

    async with mcp_client() as session:
        names = {t.name for t in (await session.list_tools()).tools}
        _, listed_over_mcp = await call_tool(
            session, "list_trash", character="Lady Amber Blaise"
        )

    destructive = ("purge", "empty", "delete", "remove", "wipe", "clear")
    assert not [
        n
        for n in names
        if ("trash" in n or "backup" in n) and any(word in n for word in destructive)
    ], names
    assert [b["name"] for b in listed_over_mcp["backups"]] == ["Before the big rewrite"]
    assert [b["filename"] for b in trashed(client)] == [backup["filename"]]


def test_a_restore_onto_a_different_backup_under_the_same_name_keeps_both(
    client, backup, workbench  # noqa: F811
) -> None:
    filename = backup["filename"]
    original = Path(backup["path"]).read_bytes()
    client.delete(f"{BACKUPS}/{filename}")
    newer = workbench.backups_dir(CID) / filename
    newer.write_bytes(b"another Backup that took the same file name")
    [entry] = trashed(client)

    res = client.post(f"{TRASH}/backups/restore", json={"ids": [entry["id"]]}).json()

    [restored_as] = res["restored"]
    assert restored_as != filename
    assert res["not_found"] == [] and res["conflicts"] == []
    assert newer.read_bytes() == b"another Backup that took the same file name"
    assert listed(client) == {filename: None, restored_as: "Before the big rewrite"}
    assert client.get(f"{BACKUPS}/{restored_as}/download").content == original
    assert trashed(client) == []


def test_trashing_the_same_bytes_again_keeps_the_name_the_earlier_entry_had(
    client, backup, workbench  # noqa: F811
) -> None:
    filename = backup["filename"]
    original = Path(backup["path"]).read_bytes()
    client.delete(f"{BACKUPS}/{filename}")
    # The very same Backup turns up in the list again, without its name
    # (copied back by hand, say), and is deleted too.
    (workbench.backups_dir(CID) / filename).write_bytes(original)
    client.delete(f"{BACKUPS}/{filename}")

    [entry] = trashed(client)
    assert entry["name"] == "Before the big rewrite"
    client.post(f"{TRASH}/backups/restore", json={"ids": [entry["id"]]})
    assert listed(client) == {filename: "Before the big rewrite"}


def test_trashing_the_same_bytes_under_another_name_keeps_both_names(
    client, backup, workbench  # noqa: F811
) -> None:
    filename = backup["filename"]
    original = Path(backup["path"]).read_bytes()
    client.delete(f"{BACKUPS}/{filename}")
    (workbench.backups_dir(CID) / filename).write_bytes(original)
    workbench.rename_zip_backup(CID, filename, "After the big rewrite")
    client.delete(f"{BACKUPS}/{filename}")

    assert sorted(r["name"] for r in trashed(client)) == [
        "After the big rewrite",
        "Before the big rewrite",
    ]


def test_two_deleted_backups_under_one_file_name_are_both_kept(
    client, backup, workbench  # noqa: F811
) -> None:
    filename = backup["filename"]
    client.delete(f"{BACKUPS}/{filename}")
    (workbench.backups_dir(CID) / filename).write_bytes(b"a second Backup, same file name")

    client.delete(f"{BACKUPS}/{filename}")

    rows = trashed(client)
    assert [r["filename"] for r in rows] == [filename, filename]
    assert len({r["id"] for r in rows}) == 2
