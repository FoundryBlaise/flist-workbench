"""The bookkeeping every part of the Trash shares.

Images (`image_trash`), Backups (`backup_trash`) and cleared Labels
(`label_trash`) each keep their own files, but they note who deleted
an entry the same way, keep an index file the same way, and answer a
restore or purge by id the same way: every id once, in the order
given, with the ids the Trash does not hold reported under
`not_found` instead of failing the rest.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Iterable, TypeVar

T = TypeVar("T")


def actor() -> str:
    """Who is deleting: 'ui' for the window, 'mcp' for a tool call. The
    Trash listing names it."""
    from services import events

    origin = events.current_origin()
    return "mcp" if origin.startswith("mcp") else origin.split(":", 1)[0]


def read_index(path: Path) -> dict[str, dict[str, Any]]:
    """An index file's entries by trash id; empty when the file is
    missing or unreadable, so the files on disk still list."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_index(path: Path, index: dict[str, dict[str, Any]]) -> None:
    """Replace an index file in one step, so a crash leaves the old one."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def resolve_ids(
    ids: Iterable[object], lookup: Callable[[str], T | None]
) -> tuple[list[tuple[str, T]], list[str]]:
    """Each id once, in the order given, paired with what `lookup` finds
    for it; the ids it finds nothing for come back as `not_found`."""
    found: list[tuple[str, T]] = []
    not_found: list[str] = []
    for trash_id in dict.fromkeys(str(i) for i in ids):
        value = lookup(trash_id)
        if value is None:
            not_found.append(trash_id)
        else:
            found.append((trash_id, value))
    return found, not_found


def purge(
    ids: Iterable[object],
    lookup: Callable[[str], T | None],
    drop: Callable[[str, T], None],
) -> dict[str, list[str]]:
    """Delete the entries `ids` name for good, through `drop`. Returns
    `{purged, not_found}`."""
    found, not_found = resolve_ids(ids, lookup)
    for trash_id, value in found:
        drop(trash_id, value)
    return {"purged": [trash_id for trash_id, _ in found], "not_found": not_found}
