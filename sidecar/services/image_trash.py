"""The pool's wastebasket: `characters/<name>/trash/`.

Deleting an image used to unlink it, and the confirm dialog was the
only thing between a slip and lost bytes. Now a delete — from the
window or from `remove_image(delete_file=true)` over MCP — moves the
file here, and it can be put back until the user empties the trash.

Only the window can delete for good. A model can move files in and
take them out again, never make them vanish; the user wants to be the
one who confirms a cleanup.

The trash is not part of the profile: backups read `images/` only, so
nothing in here is carried along, and pulls and gallery repair never
look in it.
"""

from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Any

import character_archive

TRASH_DIRNAME = "trash"
INDEX_FILENAME = "index.json"

# Same shape as an image in the pool: `<image_id>.<ext>`.
_FILE_RE = re.compile(r"^([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)$")

_lock = threading.Lock()


def trash_dir(character_id: int | str) -> Path:
    p = character_archive.character_dir(character_id) / TRASH_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def _index_path(character_id: int | str) -> Path:
    return trash_dir(character_id) / INDEX_FILENAME


def _read_index(character_id: int | str) -> dict[str, dict[str, Any]]:
    try:
        data = json.loads(_index_path(character_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_index(character_id: int | str, index: dict[str, dict[str, Any]]) -> None:
    p = _index_path(character_id)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


def _files(directory: Path) -> dict[str, Path]:
    """image_id -> file for every image-shaped file in `directory`."""
    out: dict[str, Path] = {}
    if not directory.exists():
        return out
    for entry in directory.iterdir():
        if not entry.is_file():
            continue
        m = _FILE_RE.match(entry.name)
        if m and m.group(2).lower() != "json":
            out[m.group(1)] = entry
    return out


def _actor() -> str:
    """'ui' for the window, 'mcp' for a tool call — who to name in the
    trash listing."""
    from services import events

    origin = events.current_origin()
    return "mcp" if origin.startswith("mcp") else origin.split(":", 1)[0]


def _announce(character_id: int | str) -> None:
    from services import events

    events.publish(events.IMAGES_CHANGED, character_id=str(character_id))


def trash_images(character_id: int | str, image_ids: list[str]) -> dict[str, Any]:
    """Move pool files into the trash. Ids not in the pool come back
    under `not_found` rather than failing the rest."""
    from services import image_import

    meta = image_import.read_meta(character_id)
    trashed: list[dict[str, Any]] = []
    not_found: list[str] = []
    with _lock:
        pool = _files(character_archive.images_dir(character_id))
        index = _read_index(character_id)
        target_dir = trash_dir(character_id)
        for image_id in dict.fromkeys(str(i) for i in image_ids):
            src = pool.get(image_id)
            if src is None:
                not_found.append(image_id)
                continue
            sha = character_archive.file_sha256(src)
            size = src.stat().st_size
            dest = target_dir / src.name
            # An image id names its bytes, so an older copy under the
            # same name is the same picture; the newer delete wins.
            for old in target_dir.glob(f"{image_id}.*"):
                if old.name != INDEX_FILENAME:
                    old.unlink(missing_ok=True)
            src.replace(dest)
            entry = {
                "image_id": image_id,
                "extension": dest.suffix.lstrip(".").lower(),
                "deleted_at": int(time.time()),
                "deleted_by": _actor(),
                "size": size,
                "sha256": sha,
                "source_name": (meta.get(sha) or {}).get("source_name"),
            }
            index[image_id] = entry
            trashed.append(entry)
        if trashed:
            _write_index(character_id, index)
    if trashed:
        _announce(character_id)
    return {"trashed": trashed, "not_found": not_found}


def list_trash(character_id: int | str) -> list[dict[str, Any]]:
    """What is in the trash, most recently deleted first. A file that
    got there without an index entry is still listed, with what can be
    read off the disk."""
    files = _files(trash_dir(character_id))
    index = _read_index(character_id)
    rows: list[dict[str, Any]] = []
    for image_id, path in files.items():
        try:
            stat = path.stat()
        except OSError:
            continue
        known = index.get(image_id) or {}
        rows.append(
            {
                "image_id": image_id,
                "extension": path.suffix.lstrip(".").lower(),
                "filename": path.name,
                "size": stat.st_size,
                "deleted_at": known.get("deleted_at", int(stat.st_mtime)),
                "deleted_by": known.get("deleted_by"),
                "source_name": known.get("source_name"),
            }
        )
    rows.sort(key=lambda r: r["deleted_at"], reverse=True)
    return rows


def restore_images(character_id: int | str, image_ids: list[str]) -> dict[str, Any]:
    """Put trashed files back into the pool — not onto the profile. When
    the pool already holds the same bytes (a pull fetched the picture
    again, say), the trash entry is simply dropped: no duplicate."""
    restored: list[dict[str, Any]] = []
    not_found: list[str] = []
    conflicts: list[str] = []
    with _lock:
        files = _files(trash_dir(character_id))
        index = _read_index(character_id)
        pool_dir = character_archive.images_dir(character_id)
        for image_id in dict.fromkeys(str(i) for i in image_ids):
            src = files.get(image_id)
            if src is None:
                not_found.append(image_id)
                continue
            sha = character_archive.file_sha256(src)
            existing = character_archive.find_image_with_sha(character_id, sha)
            if existing is not None:
                src.unlink(missing_ok=True)
                index.pop(image_id, None)
                restored.append(
                    {"image_id": existing.stem, "deduplicated": True, "from": image_id}
                )
                continue
            dest = pool_dir / src.name
            if dest.exists():
                # Same name, different bytes: keep both rather than
                # overwrite what the pool has now.
                conflicts.append(image_id)
                continue
            src.replace(dest)
            index.pop(image_id, None)
            restored.append({"image_id": image_id, "deduplicated": False, "from": image_id})
        _write_index(character_id, index)
    if restored:
        _announce(character_id)
    return {"restored": restored, "not_found": not_found, "conflicts": conflicts}


def purge_images(character_id: int | str, image_ids: list[str]) -> dict[str, Any]:
    """Delete trashed files for good. The window's call only."""
    purged: list[str] = []
    not_found: list[str] = []
    with _lock:
        files = _files(trash_dir(character_id))
        index = _read_index(character_id)
        for image_id in dict.fromkeys(str(i) for i in image_ids):
            path = files.get(image_id)
            if path is None:
                not_found.append(image_id)
                continue
            path.unlink(missing_ok=True)
            index.pop(image_id, None)
            purged.append(image_id)
        _write_index(character_id, index)
    return {"purged": purged, "not_found": not_found}


def empty_trash(character_id: int | str) -> int:
    """Delete everything in the trash for good. The window's call only."""
    files = _files(trash_dir(character_id))
    return len(purge_images(character_id, list(files))["purged"])
