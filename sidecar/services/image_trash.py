"""The pool's wastebasket: `characters/<name>/trash/`.

Deleting an image used to unlink it, and the confirm dialog was the
only thing between a slip and lost bytes. Now a delete moves the file
here, and it can be put back until the user empties the trash. The
window and MCP's `trash_images` delete through the same function,
`delete_images`, whether the image is in the gallery or only in the
pool.

Only the window can delete for good. A model can move files in and
take them out again, never make them vanish; the user wants to be the
one who confirms a cleanup.

The trash is not part of the profile: backups read `images/` only, so
nothing in here is carried along, and pulls and gallery repair never
look in it.
"""

from __future__ import annotations

import re
import threading
import time
from pathlib import Path
from typing import Any

import archive_images
import archive_registry
from services import trash_ledger

TRASH_DIRNAME = "trash"
INDEX_FILENAME = "index.json"

# Same shape as an image in the pool: `<image_id>.<ext>`.
_FILE_RE = re.compile(r"^([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)$")

#: Taken inside the character's lock (`archive_registry.character_lock`),
#: which every public function here holds first.
_lock = threading.Lock()


def trash_dir(character_id: int | str) -> Path:
    p = archive_registry.character_dir(character_id) / TRASH_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def _index_path(character_id: int | str) -> Path:
    return trash_dir(character_id) / INDEX_FILENAME


def _read_index(character_id: int | str) -> dict[str, dict[str, Any]]:
    return trash_ledger.read_index(_index_path(character_id))


def _write_index(character_id: int | str, index: dict[str, dict[str, Any]]) -> None:
    trash_ledger.write_index(_index_path(character_id), index)


def _files(directory: Path) -> dict[str, Path]:
    """image_id -> file for every image-shaped file in `directory`."""
    out: dict[str, Path] = {}
    if not directory.exists():
        return out
    for entry in directory.iterdir():
        if not entry.is_file():
            continue
        m = _FILE_RE.fullmatch(entry.name)
        if m and m.group(2).lower() != "json":
            out[m.group(1)] = entry
    return out


def _announce(character_id: int | str) -> None:
    from services import events

    events.publish(events.IMAGES_CHANGED, character_id=str(character_id))


def _image_id_of(trash_id: str, index: dict[str, dict[str, Any]]) -> str:
    """The pool id a trashed file had. Its trash id unless the Trash
    holds another file under that image id too."""
    return str((index.get(trash_id) or {}).get("image_id") or trash_id)


def _sha_of(path: Path, trash_id: str, index: dict[str, dict[str, Any]]) -> str | None:
    known = (index.get(trash_id) or {}).get("sha256")
    if isinstance(known, str) and known:
        return known
    try:
        return archive_images.file_sha256(path)
    except OSError:
        return None


def _trash_locked(
    character_id: int | str,
    src: Path,
    image_id: str,
    index: dict[str, dict[str, Any]],
    meta: dict[str, Any],
) -> dict[str, Any]:
    """Move one pool file into the Trash. Caller holds `_lock` and
    writes the index.

    An image id does not always name one picture: a Pull can replace
    the bytes under an id, so two different files may be trashed under
    the same id over time. Both stay. Only a copy with the very same
    bytes is dropped, because the newer delete holds them too."""
    target_dir = trash_dir(character_id)
    sha = archive_images.file_sha256(src)
    size = src.stat().st_size
    for trash_id, path in _files(target_dir).items():
        if _image_id_of(trash_id, index) == image_id and _sha_of(path, trash_id, index) == sha:
            path.unlink(missing_ok=True)
            index.pop(trash_id, None)
    taken = _files(target_dir)
    trash_id = image_id
    for width in (8, 16, 64):
        if trash_id not in taken:
            break
        trash_id = f"{image_id}-{sha[:width]}"
    dest = target_dir / f"{trash_id}{src.suffix.lower()}"
    src.replace(dest)
    entry = {
        "trash_id": trash_id,
        "image_id": image_id,
        "extension": dest.suffix.lstrip(".").lower(),
        "deleted_at": int(time.time()),
        "deleted_by": trash_ledger.actor(),
        "size": size,
        "sha256": sha,
        "source_name": (meta.get(sha) or {}).get("source_name"),
    }
    index[trash_id] = entry
    return entry


@archive_registry.under_character_lock
def trash_images(character_id: int | str, image_ids: list[str]) -> dict[str, Any]:
    """Move pool files into the trash. Ids not in the pool come back
    under `not_found` rather than failing the rest."""
    from services import image_import

    meta = image_import.read_meta(character_id)
    trashed: list[dict[str, Any]] = []
    with _lock:
        pool = _files(archive_images.images_dir(character_id))
        index = _read_index(character_id)
        found, not_found = trash_ledger.resolve_ids(image_ids, pool.get)
        for image_id, src in found:
            trashed.append(_trash_locked(character_id, src, image_id, index, meta))
        if trashed:
            _write_index(character_id, index)
    if trashed:
        _announce(character_id)
    return {"trashed": trashed, "not_found": not_found}


@archive_registry.under_character_lock
def delete_images(character_id: int | str, image_ids: list[str]) -> dict[str, Any]:
    """Delete images: take any still in the Workbench's gallery off it,
    then move their files into the Trash.

    One route for an image on the profile and one only in the pool, so
    the window and a model deleting the same picture do the same thing,
    and no gallery is left pointing at a file in the Trash. A character
    without a Workbench has no gallery to change. Besides what
    `trash_images` answers: `off_gallery`, the ids taken off the
    gallery, and `etag`, the Workbench's new etag (None when the gallery
    was left alone)."""
    import archive_workbench
    from services import payload_ops

    ids = list(dict.fromkeys(str(i) for i in image_ids))
    wanted = set(ids)
    off_gallery: list[str] = []
    etag: str | None = None
    bench = archive_workbench.read_workbench(character_id)
    if bench is not None:
        # Read first so an image only in the pool leaves the Workbench
        # untouched: an edit writes, and a write tells the window the
        # Workbench changed.
        off_gallery = [
            r["image_id"] for r in payload_ops.gallery(bench.payload) if r["image_id"] in wanted
        ]
    if off_gallery:

        def mutate(payload: dict[str, Any]) -> payload_ops.EditResult:
            rows = payload_ops.gallery(payload)
            remaining = [r for r in rows if r["image_id"] not in wanted]
            return payload_ops.EditResult(
                etag="", changed=payload_ops.set_gallery(payload, remaining)
            )

        etag = payload_ops.edit(str(character_id), mutate).etag
    result = trash_images(character_id, ids)
    return {**result, "off_gallery": off_gallery, "etag": etag}


@archive_registry.under_character_lock
def trash_pool_file(character_id: int | str, path: Path) -> dict[str, Any] | None:
    """Move one particular file out of `images/` into the Trash: the
    old file a Pull replaces, a stale copy gallery repair drops. None
    when there is no such image file."""
    from services import image_import

    m = _FILE_RE.fullmatch(path.name)
    if m is None or path.parent != archive_images.images_dir(character_id):
        return None
    meta = image_import.read_meta(character_id)
    with _lock:
        if not path.is_file():
            return None
        index = _read_index(character_id)
        entry = _trash_locked(character_id, path, m.group(1), index, meta)
        _write_index(character_id, index)
    _announce(character_id)
    return entry


def list_trash(character_id: int | str) -> list[dict[str, Any]]:
    """What is in the trash, most recently deleted first. A file that
    got there without an index entry is still listed, with what can be
    read off the disk. `trash_id` names the entry for restore and
    purge; it is the image id unless the Trash holds several files
    under that id."""
    files = _files(trash_dir(character_id))
    index = _read_index(character_id)
    rows: list[dict[str, Any]] = []
    for trash_id, path in files.items():
        try:
            stat = path.stat()
        except OSError:
            continue
        known = index.get(trash_id) or {}
        rows.append(
            {
                "trash_id": trash_id,
                "image_id": _image_id_of(trash_id, index),
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


@archive_registry.under_character_lock
def restore_images(character_id: int | str, trash_ids: list[str]) -> dict[str, Any]:
    """Put trashed files back into the pool — not onto the profile. When
    the pool already holds the same bytes (a pull fetched the picture
    again, say), the trash entry is simply dropped: no duplicate. When
    the pool holds a different picture under the same image id (a Pull
    replaced it), both are kept: the restored one comes back under
    `local-<sha8>`, the name the pool gives a picture only this machine
    has."""
    restored: list[dict[str, Any]] = []
    conflicts: list[str] = []
    with _lock:
        files = _files(trash_dir(character_id))
        index = _read_index(character_id)
        pool_dir = archive_images.images_dir(character_id)
        found, not_found = trash_ledger.resolve_ids(trash_ids, files.get)
        for trash_id, src in found:
            sha = archive_images.file_sha256(src)
            existing = archive_images.find_image_with_sha(character_id, sha)
            if existing is not None:
                src.unlink(missing_ok=True)
                index.pop(trash_id, None)
                restored.append(
                    {"image_id": existing.stem, "deduplicated": True, "from": trash_id}
                )
                continue
            image_id = _image_id_of(trash_id, index)
            if image_id in _files(pool_dir):
                image_id = f"local-{sha[:8]}"
            dest = pool_dir / f"{image_id}{src.suffix.lower()}"
            if image_id in _files(pool_dir):
                # Even that name holds other bytes: leave the file here
                # rather than overwrite what the pool has now.
                conflicts.append(trash_id)
                continue
            src.replace(dest)
            index.pop(trash_id, None)
            restored.append({"image_id": image_id, "deduplicated": False, "from": trash_id})
        _write_index(character_id, index)
    if restored:
        _announce(character_id)
    return {"restored": restored, "not_found": not_found, "conflicts": conflicts}


@archive_registry.under_character_lock
def purge_images(character_id: int | str, trash_ids: list[str]) -> dict[str, Any]:
    """Delete trashed files for good. The window's call only."""
    def drop(trash_id: str, path: Path) -> None:
        path.unlink(missing_ok=True)
        index.pop(trash_id, None)

    with _lock:
        files = _files(trash_dir(character_id))
        index = _read_index(character_id)
        result = trash_ledger.purge(trash_ids, files.get, drop)
        _write_index(character_id, index)
    if result["purged"]:
        _announce(character_id)
    return result


@archive_registry.under_character_lock
def empty_trash(character_id: int | str) -> int:
    """Delete everything in the trash for good. The window's call only."""
    files = _files(trash_dir(character_id))
    return len(purge_images(character_id, list(files))["purged"])
