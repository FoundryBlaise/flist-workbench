"""A save is atomic: a crash leaves the old file or the new one.

Every file the sidecar writes first goes to a temp file of its own in
the same folder, is flushed to disk, and then takes the old file's
place in one step. Power lost at any moment before that step leaves
the old file whole; what is left of the temp file is scratch that
every reader passes over.

Driven from outside through the window's routes. The crash is staged
at the operating system: the moment the temp file is on disk, the
"power goes out" (the flush to disk raises).
"""

from __future__ import annotations

import hashlib
import importlib
import os
import threading
from pathlib import Path
from typing import Any, Callable

import pytest
from sidecar_client import app_client

NAME = "Wren Ashdown"
CID = "42"
BASE = f"/flist/character/{CID}"
PAYLOAD = f"{BASE}/workbench/payload"
BACKUPS = f"{BASE}/zip-backups"
IMAGES = f"{BASE}/images"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
OTHER_PNG = b"\x89PNG\r\n\x1a\n" + b"\x7f" * 32


class PowerLost(OSError):
    """The machine went down right after the temp file reached the disk."""


@pytest.fixture
def sidecar(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)

    import character_archive
    import paths
    import server

    importlib.reload(paths)
    importlib.reload(character_archive)

    character_archive.register_character(CID, NAME)
    character_archive.write_live(
        CID,
        {
            "character": {"id": 42, "name": NAME, "description": "[b]Published.[/b]"},
            "infotags": {},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
            "fetched_at": 1000,
        },
    )
    api = app_client(server.app, raise_server_exceptions=False)
    # A Workbench with an edit, one Backup with a name, one image.
    read = api.get(PAYLOAD).json()
    api.put(PAYLOAD, json=_edited("Before."), headers={"If-Match": read["etag"]}).raise_for_status()
    api.post(f"{BASE}/zip-backup").raise_for_status()
    first = api.get(BACKUPS).json()["backups"][0]["filename"]
    api.patch(f"{BACKUPS}/{first}", json={"name": "Before"}).raise_for_status()
    api.post(IMAGES, content=PNG).raise_for_status()
    return api, tmp_path


def _edited(description: str) -> dict[str, Any]:
    return {
        "_schema_version": 6,
        "_overlay": ["character.description"],
        "character": {"id": 42, "name": NAME, "description": description},
    }


def _reads(api) -> dict[str, Any]:
    """What the window sees of the character."""
    return {url: api.get(url).json() for url in (PAYLOAD, BACKUPS, IMAGES, f"{BASE}/live")}


def _files(root: Path) -> dict[str, str]:
    """Every file under `root` but scratch, by content."""
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in root.rglob("*")
        if p.is_file() and not p.name.endswith(".tmp")
    }


def _save_workbench(api) -> Any:
    etag = api.get(PAYLOAD).json()["etag"]
    return api.put(PAYLOAD, json=_edited("Lost."), headers={"If-Match": etag})


def _make_backup(api) -> Any:
    return api.post(f"{BASE}/zip-backup")


def _name_backup(api) -> Any:
    first = api.get(BACKUPS).json()["backups"][0]["filename"]
    return api.patch(f"{BACKUPS}/{first}", json={"name": "Lost"})


def _upload_image(api) -> Any:
    return api.post(IMAGES, content=OTHER_PNG)


WRITERS: dict[str, Callable[[Any], Any]] = {
    "Workbench save": _save_workbench,
    "new Backup": _make_backup,
    "Backup name": _name_backup,
    "image upload": _upload_image,
}


@pytest.mark.parametrize("write", WRITERS.values(), ids=WRITERS.keys())
def test_power_lost_after_the_temp_file_is_written_leaves_the_previous_files(
    sidecar, monkeypatch: pytest.MonkeyPatch, write: Callable[[Any], Any]
) -> None:
    api, data_dir = sidecar
    before_reads = _reads(api)
    before_files = _files(data_dir)
    crashes: list[str] = []
    real_fsync = os.fsync

    def power_lost(fd: int) -> None:
        real_fsync(fd)
        crashes.append("crash")
        raise PowerLost("power lost")

    with monkeypatch.context() as m:
        m.setattr(os, "fsync", power_lost)
        res = write(api)

    assert crashes, f"the write never flushed its temp file to disk ({res.status_code})"
    assert res.status_code == 500
    assert _files(data_dir) == before_files
    assert _reads(api) == before_reads


def test_leftover_temp_files_are_ignored_by_every_reader(sidecar) -> None:
    """What an interrupted write leaves behind, a temp file beside the
    real one holding all or part of the new bytes, is never read as the
    file, listed as a Backup or an image, or counted as the user's."""
    api, data_dir = sidecar
    before = _reads(api)
    for path in [p for p in data_dir.rglob("*") if p.is_file()]:
        data = path.read_bytes()
        (path.parent / f"{path.name}.k3j9x0ab.tmp").write_bytes(data)
        (path.parent / f"{path.name}.tmp").write_bytes(data[: len(data) // 2])

    assert _reads(api) == before
    assert api.post(f"{BASE}/images/repair").status_code == 200
    assert _reads(api) == before
    assert _save_workbench(api).status_code == 200


def test_two_backups_made_at_once_both_exist(sidecar) -> None:
    """Backups are named for the second they are made in. Several made
    in the same second each get a name of their own; none replaces
    another."""
    api, _ = sidecar
    already = len(api.get(BACKUPS).json()["backups"])
    count = 6
    start = threading.Barrier(count)
    results: list[Any] = [None] * count

    def back_up(i: int) -> None:
        start.wait()
        results[i] = api.post(f"{BASE}/zip-backup")

    threads = [threading.Thread(target=back_up, args=(i,)) for i in range(count)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert [r.status_code for r in results] == [200] * count, [r.text for r in results]
    made = {r.json()["filename"] for r in results}
    assert len(made) == count
    listed = {row["filename"] for row in api.get(BACKUPS).json()["backups"]}
    assert made <= listed
    assert len(listed) == already + count
