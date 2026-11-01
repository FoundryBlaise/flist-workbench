"""Backups in the Trash: `characters/<name>/trash/backups/`.

The Trash is one place for everything the user deletes. Images lie at
its top level (see `image_trash`); a deleted Backup goes into the
`backups/` folder inside it, with its user-set name kept in that
folder's index so a restore puts it back in the Backup list under the
same name.

Only the window deletes for good, by purging or emptying the Trash. No
MCP tool calls `purge_backups` or `empty`.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import character_archive
from services import image_trash, trash_ledger

FOLDER = "backups"
INDEX_FILENAME = "index.json"

_lock = threading.Lock()


def _dir(character_id: int | str) -> Path:
    p = image_trash.trash_dir(character_id) / FOLDER
    p.mkdir(parents=True, exist_ok=True)
    return p


def _read_index(character_id: int | str) -> dict[str, dict[str, Any]]:
    return trash_ledger.read_index(_dir(character_id) / INDEX_FILENAME)


def _write_index(character_id: int | str, index: dict[str, dict[str, Any]]) -> None:
    trash_ledger.write_index(_dir(character_id) / INDEX_FILENAME, index)


def _free_id(folder: Path, filename: str, sha: str) -> str:
    """Where in the Trash a Backup goes: under its own file name, unless
    the Trash already holds different bytes under that name."""
    stem = filename[: -len(".zip")]
    candidate, n = filename, 1
    while (folder / candidate).exists():
        if character_archive.file_sha256(folder / candidate) == sha:
            return candidate
        n += 1
        candidate = f"{stem}~{n}.zip"
    return candidate


def trash_backup(character_id: int | str, filename: str) -> dict[str, Any]:
    """Move one Backup into the Trash. Raises FileNotFoundError when the
    Backup list has no such file."""
    character_archive.require_backup_filename(filename)
    src = character_archive.backups_dir(character_id) / filename
    if not src.is_file():
        raise FileNotFoundError(filename)
    name = next(
        (
            row["name"]
            for row in character_archive.list_zip_backups(character_id)
            if row["filename"] == filename
        ),
        None,
    )
    with _lock:
        folder = _dir(character_id)
        sha = character_archive.file_sha256(src)
        size = src.stat().st_size
        trash_id = _free_id(folder, filename, sha)
        index = _read_index(character_id)
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
    character_archive.forget_backup_name(character_id, filename)
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
    and user-set name they had. When the list already holds different
    bytes under that file name, the Backup stays in the Trash."""
    restored: list[str] = []
    conflicts: list[str] = []
    with _lock:
        rows = {r["id"]: r for r in list_backups(character_id)}
        index = _read_index(character_id)
        folder = _dir(character_id)
        target_dir = character_archive.backups_dir(character_id)
        found, not_found = trash_ledger.resolve_ids(ids, rows.get)
        for trash_id, row in found:
            src = folder / trash_id
            filename = row["filename"]
            try:
                character_archive.require_backup_filename(filename)
            except ValueError:
                filename = trash_id
            dest = target_dir / filename
            if dest.exists():
                if character_archive.file_sha256(dest) != character_archive.file_sha256(src):
                    conflicts.append(trash_id)
                    continue
                src.unlink()
            else:
                src.replace(dest)
            index.pop(trash_id, None)
            if row["name"]:
                character_archive.rename_zip_backup(character_id, filename, row["name"])
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
