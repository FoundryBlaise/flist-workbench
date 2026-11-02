"""Each character is moved once to one Workbench on disk (ADR 0001).

Older versions kept several drafts per character under `sets/<id>/`
(`payload.json` + `meta.json`) with an `active_set.json` pointer, a JSON
copy of Live per Pull under `snapshots/` (earlier still loose in
`backups/` as `<unix>.json`), and before all of that one `working.json`.
The window showed one of the drafts as the Workbench: the active one,
else the most recently changed, else a fresh copy of Live.

At startup every character folder is moved to the one shape:

1. The draft the window showed becomes `workbench/`, its payload copied
   byte for byte. A `workbench/` that is already there stays as it is:
   an earlier, interrupted run wrote it, and the window may have saved
   over it since. A character without drafts gets no Workbench here;
   the first read makes it from Live, as before.
2. Every old file goes, verbatim and under its old path, into one Backup
   (source `workbench`, occasion `migration`). The zip is written beside
   its final name, read back and compared byte for byte with the files
   on disk, and only then given its Backup name.
3. Only then are the old files removed.
4. `layout.json` is written last. A folder holding it is never touched
   again; one without it goes through these steps again on the next
   run, which is safe at every step above. That includes a `workbench/`
   the earlier run already wrote: step 1 keeps it rather than choosing
   a draft again (see `migrate_folder`).

Anything that fails leaves the old files in place and the folder
without its marker, so the next start tries again. Pool files from
v0.0.3 archives (`pool/`) are not touched.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import zipfile
from pathlib import Path
from typing import Any

import backup_origin
import character_archive

LAYOUT_FILENAME = "layout.json"
#: 1 was the layout with several drafts; 2 is one Workbench.
LAYOUT_VERSION = 2

_SETS = "sets"
_POINTER = "active_set.json"
_OLD_PULL_COPIES = "snapshots"
_SET_ID_RE = re.compile(r"^[0-9a-f]{12}$")
_OLD_PULL_COPY_RE = re.compile(r"^\d+(?:-\d+)?\.json$")
#: The single working copy before drafts, its atomic-write and backup
#: siblings, and copies an earlier version set aside as unreadable.
_LEGACY_WORKING_RE = re.compile(r"^working\.(json(\.tmp|\.corrupt-\d+)?|bak)$")


class BackupNotVerified(RuntimeError):
    """The migration Backup did not read back as the files it holds."""


def migrate_all() -> int:
    """Move every character folder that has not been moved yet. Returns
    how many were moved. Never raises: a folder that fails keeps its old
    files and is tried again next start."""
    moved = 0
    root = character_archive.root()
    for folder in sorted(root.iterdir()):
        if not folder.is_dir() or folder.name.startswith("_"):
            continue
        try:
            if migrate_folder(folder):
                moved += 1
        except Exception as exc:  # noqa: BLE001 - one folder never stops the rest
            print(
                f"[migration] {folder.name} keeps its old files and is "
                f"tried again next start: {exc}",
                file=sys.stderr,
                flush=True,
            )
    return moved


def is_migrated(folder: Path) -> bool:
    try:
        raw = json.loads((folder / LAYOUT_FILENAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(raw, dict) and raw.get("version") == LAYOUT_VERSION


def migrate_folder(folder: Path) -> bool:
    """Move one character folder; False when it already was."""
    if is_migrated(folder):
        return False
    bench = folder / character_archive.WORKBENCH_DIRNAME
    # A `workbench/` already here is kept, never replaced by the draft
    # chosen again. Only an earlier run that stopped before writing
    # `layout.json` leaves one beside old files, and the sidecar served
    # it from then on: the window, or a model, may have saved edits into
    # it that no draft and no Backup holds. Choosing again would lose
    # them; the drafts are still all kept in the Backup below.
    if not (bench / character_archive.WORKBENCH_PAYLOAD_FILENAME).exists():
        chosen = _draft_the_window_showed(folder)
        if chosen is not None:
            _write_workbench(bench, *chosen)
    old = _old_files(folder)
    if old:
        if _covering_backup(folder, old) is None:
            _write_migration_backup(folder, old)
        _remove(folder, old)
    _write_bytes(
        folder / LAYOUT_FILENAME,
        json.dumps({"version": LAYOUT_VERSION}).encode("utf-8"),
    )
    return True


# ---- what the window showed ------------------------------------------------


def _draft(folder: Path, set_id: str) -> tuple[bytes, dict[str, int]] | None:
    """A draft's payload bytes and its dates, or None when it is not a
    readable draft."""
    here = folder / _SETS / set_id
    try:
        meta = json.loads((here / "meta.json").read_text(encoding="utf-8"))
        raw = (here / "payload.json").read_bytes()
        payload = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(meta, dict) or not isinstance(payload, dict):
        return None
    created, updated = meta.get("created_at"), meta.get("updated_at")
    if not isinstance(created, int) or not isinstance(updated, int):
        return None
    return raw, {"created_at": created, "updated_at": updated}


def _draft_the_window_showed(folder: Path) -> tuple[bytes, dict[str, int]] | None:
    """The active draft, else the most recently changed one."""
    try:
        pointer = json.loads((folder / _POINTER).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pointer = None
    active = pointer.get("active_set_id") if isinstance(pointer, dict) else None
    if isinstance(active, str) and _SET_ID_RE.fullmatch(active):
        found = _draft(folder, active)
        if found is not None:
            return found
    sets = folder / _SETS
    drafts = []
    if sets.is_dir():
        for entry in sets.iterdir():
            if entry.is_dir() and _SET_ID_RE.fullmatch(entry.name):
                found = _draft(folder, entry.name)
                if found is not None:
                    drafts.append((-found[1]["updated_at"], entry.name, found))
    if not drafts:
        return None
    return min(drafts)[2]


def _write_workbench(bench: Path, payload: bytes, dates: dict[str, int]) -> None:
    bench.mkdir(parents=True, exist_ok=True)
    _write_bytes(bench / character_archive.WORKBENCH_PAYLOAD_FILENAME, payload)
    _write_bytes(
        bench / character_archive.WORKBENCH_META_FILENAME,
        json.dumps(dates).encode("utf-8"),
    )


# ---- the old files and their Backup ----------------------------------------


def _old_files(folder: Path) -> list[Path]:
    """Every file of the old layouts still in the folder."""
    out: list[Path] = []
    for name in (_SETS, _OLD_PULL_COPIES):
        tree = folder / name
        if tree.is_dir():
            out.extend(p for p in sorted(tree.rglob("*")) if p.is_file())
    pointer = folder / _POINTER
    if pointer.is_file():
        out.append(pointer)
    out.extend(
        p for p in sorted(folder.iterdir())
        if p.is_file() and _LEGACY_WORKING_RE.fullmatch(p.name)
    )
    loose = folder / "backups"
    if loose.is_dir():
        out.extend(
            p for p in sorted(loose.iterdir())
            if p.is_file() and _OLD_PULL_COPY_RE.fullmatch(p.name)
        )
    return out


def _member(folder: Path, path: Path) -> str:
    return path.relative_to(folder).as_posix()


def _holds(zip_path: Path, folder: Path, old: list[Path]) -> bool:
    """Whether the zip holds every old file, byte for byte, under its
    path in the folder."""
    try:
        with zipfile.ZipFile(zip_path) as zf:
            if zf.testzip() is not None:
                return False
            names = set(zf.namelist())
            for path in old:
                name = _member(folder, path)
                if name not in names or zf.read(name) != path.read_bytes():
                    return False
    except (OSError, zipfile.BadZipFile, KeyError):
        return False
    return True


def _covering_backup(folder: Path, old: list[Path]) -> Path | None:
    """A migration Backup an interrupted earlier run already wrote that
    holds every old file left, so a second one is not needed."""
    backups = folder / "backups"
    if not backups.is_dir():
        return None
    for entry in sorted(backups.glob("*.zip"), reverse=True):
        try:
            with zipfile.ZipFile(entry) as zf:
                meta = json.loads(zf.read("backup-meta.json").decode("utf-8"))
        except (OSError, ValueError, KeyError, zipfile.BadZipFile):
            continue
        if not isinstance(meta, dict) or meta.get("occasion") != backup_origin.MIGRATION:
            continue
        if _holds(entry, folder, old):
            return entry
    return None


def _write_migration_backup(folder: Path, old: list[Path]) -> Path:
    """Pack the old files into a new Backup, verified before it gets its
    Backup name. Raises when it cannot be written or read back."""
    backups = folder / "backups"
    backups.mkdir(parents=True, exist_ok=True)
    target = character_archive.free_backup_path(backups)
    scratch = target.with_name(target.name + ".tmp")
    meta: dict[str, Any] = {
        **backup_origin.meta(backup_origin.WORKBENCH, backup_origin.MIGRATION),
        "created_at": int(time.time()),
        "note": "Files an earlier version of the app kept, under their old paths.",
    }
    try:
        with zipfile.ZipFile(scratch, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for path in old:
                zf.writestr(_member(folder, path), path.read_bytes())
            zf.writestr("backup-meta.json", json.dumps(meta, indent=2))
        if not _holds(scratch, folder, old):
            raise BackupNotVerified(f"{scratch.name} does not hold the old files")
        os.replace(scratch, target)
    finally:
        if scratch.exists():
            scratch.unlink()
    return target


def _remove(folder: Path, old: list[Path]) -> None:
    for path in old:
        path.unlink()
    for name in (_SETS, _OLD_PULL_COPIES):
        tree = folder / name
        if tree.is_dir():
            # Bottom-up, and only folders left empty: anything that is
            # not an old file stays.
            for here in sorted(tree.rglob("*"), key=lambda p: len(p.parts), reverse=True):
                if here.is_dir() and not any(here.iterdir()):
                    here.rmdir()
            if not any(tree.iterdir()):
                tree.rmdir()


def _write_bytes(path: Path, data: bytes) -> None:
    scratch = path.with_name(path.name + ".tmp")
    scratch.write_bytes(data)
    os.replace(scratch, path)
