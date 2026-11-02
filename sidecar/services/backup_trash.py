"""Backups in the Trash: `characters/<name>/trash/backups/`.

A character's Trash holds the images and Backups the user deletes.
Images lie at its top level (see `image_trash`); a deleted Backup goes
into the `backups/` folder inside it, with its user-set name kept in
that folder's index so a restore puts it back in the Backup list under
the same name. Cleared Labels belong to no character folder and wait in
the one shared place `label_trash` keeps.

Only the window deletes for good, by purging or emptying the Trash. No
MCP tool calls `purge_backups` or `empty`.
"""

from __future__ import annotations

import re
import threading
import time
from pathlib import Path
from typing import Any

import archive_backups
import archive_images
from services import image_trash, trash_ledger

FOLDER = "backups"
INDEX_FILENAME = "index.json"

_TRASH_SUFFIX_RE = re.compile(r"~\d+(?=\.zip$)")

_lock = threading.Lock()


def _dir(character_id: int | str) -> Path:
    p = image_trash.trash_dir(character_id) / FOLDER
    p.mkdir(parents=True, exist_ok=True)
    return p


def _read_index(character_id: int | str) -> dict[str, dict[str, Any]]:
    return trash_ledger.read_index(_dir(character_id) / INDEX_FILENAME)


def _write_index(character_id: int | str, index: dict[str, dict[str, Any]]) -> None:
    trash_ledger.write_index(_dir(character_id) / INDEX_FILENAME, index)


def _free_id(
    folder: Path, filename: str, sha: str, name: str | None, index: dict[str, dict[str, Any]]
) -> str:
    """Where in the Trash a Backup goes: under its own file name, unless
    the Trash already holds different bytes under that name. The same
    bytes share an entry, except when both carry different user-set
    names: then each name keeps its own entry."""
    stem = filename[: -len(".zip")]
    candidate, n = filename, 1
    while (folder / candidate).exists():
        if archive_images.file_sha256(folder / candidate) == sha:
            earlier = (index.get(candidate) or {}).get("name")
            if not (name and earlier and name != earlier):
                return candidate
        n += 1
        candidate = f"{stem}~{n}.zip"
    return candidate


def _list_filename(trash_id: str, filename: str) -> str | None:
    """The Backup list file name a restore starts from: the one the
    Backup had, else its trash id without the `~N` the Trash added."""
    for candidate in (filename, _TRASH_SUFFIX_RE.sub("", trash_id)):
        try:
            archive_backups.require_backup_filename(candidate)
        except ValueError:
            continue
        return candidate
    return None


def trash_backup(character_id: int | str, filename: str) -> dict[str, Any]:
    """Move one Backup into the Trash. Raises FileNotFoundError when the
    Backup list has no such file."""
    archive_backups.require_backup_filename(filename)
    src = archive_backups.backups_dir(character_id) / filename
    if not src.is_file():
        raise FileNotFoundError(filename)
    name = next(
        (
            row["name"]
            for row in archive_backups.list_zip_backups(character_id)
            if row["filename"] == filename
        ),
        None,
    )
    with _lock:
        folder = _dir(character_id)
        sha = archive_images.file_sha256(src)
        size = src.stat().st_size
        index = _read_index(character_id)
        trash_id = _free_id(folder, filename, sha, name, index)
        # The same bytes were trashed before: keep the name that entry
        # had when this copy comes without one.
        name = name or (index.get(trash_id) or {}).get("name")
        src.replace(folder / trash_id)
        entry = {
            "id": trash_id,
            "filename": filename,
            "name": name,
            "size": size,
            "sha256": sha,
            "deleted_at": int(time.time()),
            "deleted_by": trash_ledger.actor(),
        }
        index[trash_id] = entry
        _write_index(character_id, index)
    archive_backups.forget_backup_name(character_id, filename)
    return entry


def list_backups(character_id: int | str) -> list[dict[str, Any]]:
    """The Backups in the Trash, most recently deleted first. A file
    that got there without an index entry is still listed."""
    folder = _dir(character_id)
    index = _read_index(character_id)
    rows: list[dict[str, Any]] = []
    for path in folder.iterdir():
        if not path.is_file() or path.suffix.lower() != ".zip":
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        known = index.get(path.name) or {}
        rows.append(
            {
                "id": path.name,
                "filename": known.get("filename", path.name),
                "name": known.get("name"),
                "size": stat.st_size,
                "deleted_at": known.get("deleted_at", int(stat.st_mtime)),
                "deleted_by": known.get("deleted_by"),
            }
        )
    rows.sort(key=lambda r: r["deleted_at"], reverse=True)
    return rows


def restore_backups(character_id: int | str, ids: list[str]) -> dict[str, Any]:
    """Put trashed Backups back in the Backup list, under the file name
    and user-set name they had. When the list already holds the same
    bytes under that file name, the Trash copy is dropped; when it holds
    different bytes, both are kept: the restored Backup takes the next
    free `-N` file name, as a second Backup in the same second would.
    Only a Backup without any usable file name stays in the Trash, under
    `conflicts`."""
    restored: list[str] = []
    conflicts: list[str] = []
    with _lock:
        rows = {r["id"]: r for r in list_backups(character_id)}
        index = _read_index(character_id)
        folder = _dir(character_id)
        target_dir = archive_backups.backups_dir(character_id)
        found, not_found = trash_ledger.resolve_ids(ids, rows.get)
        for trash_id, row in found:
            src = folder / trash_id
            filename = _list_filename(trash_id, row["filename"])
            if filename is None:
                conflicts.append(trash_id)
                continue
            dest = target_dir / filename
            name = row["name"]
            if dest.exists() and archive_images.file_sha256(
                dest
            ) == archive_images.file_sha256(src):
                src.unlink()
                # The list's own name for these bytes wins over the
                # Trash's; neither is lost when only one has one.
                name = archive_backups.backup_name(character_id, filename) or name
            else:
                if dest.exists():
                    filename = archive_backups.free_backup_filename(character_id, filename)
                    dest = target_dir / filename
                src.replace(dest)
            index.pop(trash_id, None)
            if name:
                archive_backups.rename_zip_backup(character_id, filename, name)
            restored.append(filename)
        _write_index(character_id, index)
    return {"restored": restored, "not_found": not_found, "conflicts": conflicts}


def purge_backups(character_id: int | str, ids: list[str]) -> dict[str, Any]:
    """Delete trashed Backups for good. The window's call only."""
    def drop(trash_id: str, _row: dict[str, Any]) -> None:
        (folder / trash_id).unlink(missing_ok=True)
        index.pop(trash_id, None)

    with _lock:
        rows = {r["id"]: r for r in list_backups(character_id)}
        index = _read_index(character_id)
        folder = _dir(character_id)
        result = trash_ledger.purge(ids, rows.get, drop)
        _write_index(character_id, index)
    return result


def empty(character_id: int | str) -> int:
    """Delete every trashed Backup for good. The window's call only."""
    ids = [r["id"] for r in list_backups(character_id)]
    return len(purge_backups(character_id, ids)["purged"])
