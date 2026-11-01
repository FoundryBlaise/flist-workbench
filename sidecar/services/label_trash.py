"""Cleared Labels in the Trash.

Clearing Labels, from the window or over MCP, takes away hours of
labelling in one call. So before any Labels are cleared they are
written to the Trash as one entry, which the window's Trash view lists
under the character and Restore puts back.

An entry keeps each Label by message hash and verdict, with the rest of
its row for the current labels table. A Label belongs to the message,
not to a character (ADR 0004), so the entries live in one place,
`<userdata>/trash/labels/`, and not in a character folder: a character
that has Logs but no Workbench still gets its cleared Labels kept.
Which character's Trash shows an entry follows from the Log character
it was cleared for, matched by name like the character list does.

Only the window deletes for good, by purging or emptying the Trash. No
MCP tool calls `purge` or `empty`.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

import character_archive
import labels as labels_store
import paths
from services import trash_ledger

FOLDER = "labels"

_ID_RE = re.compile(r"^[0-9]+-[0-9a-f]{12}$")

_lock = threading.Lock()


def _dir() -> Path:
    p = paths.user_data_dir() / "trash" / FOLDER
    p.mkdir(parents=True, exist_ok=True)
    return p


def _same_name(a: str | None, b: str | None) -> bool:
    return bool(a and b) and a.strip().lower() == b.strip().lower()


def workbench_character_name(character_id: int | str) -> str | None:
    """The name of a Workbench character, which is the name its Logs are
    kept under."""
    entry = character_archive.load_registry().get(str(character_id)) or {}
    if entry.get("name"):
        return str(entry["name"])
    for row in character_archive.list_archived_characters():
        if str(row.get("id")) == str(character_id):
            return str(row.get("name") or "") or None
    return None


def _write_entry(character: str, partner: str | None, rows: list[dict]) -> dict[str, Any]:
    now = int(time.time())
    digest = hashlib.sha256(
        json.dumps([character, partner, sorted(r["hash"] for r in rows)]).encode("utf-8")
    ).hexdigest()
    folder = _dir()
    trash_id = f"{now}-{digest[:12]}"
    n = 0
    while (folder / f"{trash_id}.json").exists():
        n += 1
        trash_id = f"{now + n}-{digest[:12]}"
    entry = {
        "id": trash_id,
        "character": character,
        "partner": partner,
        "count": len(rows),
        "deleted_at": now,
        "deleted_by": trash_ledger.actor(),
        "labels": rows,
    }
    p = folder / f"{trash_id}.json"
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(entry, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)
    return _summary(entry)


def _summary(entry: dict[str, Any]) -> dict[str, Any]:
    return {k: entry.get(k) for k in ("id", "character", "partner", "count", "deleted_at", "deleted_by")}


def _read(trash_id: str) -> dict[str, Any] | None:
    if not _ID_RE.fullmatch(trash_id):
        return None
    try:
        data = json.loads((_dir() / f"{trash_id}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("labels"), list) else None


def _owned(trash_id: str, character: str) -> dict[str, Any] | None:
    """The entry `trash_id` names, if it is in `character`'s Trash."""
    entry = _read(trash_id)
    if entry is None or not _same_name(entry.get("character"), character):
        return None
    return entry


def _clear_rows(
    conn: sqlite3.Connection, character: str, partner: str | None, rows: list[dict]
) -> dict[str, Any]:
    """Trash `rows`, then delete exactly those Labels. The copy is on
    disk before anything is deleted."""
    if not rows:
        return {"deleted": 0, "trash_id": None}
    with _lock:
        entry = _write_entry(character, partner, rows)
    deleted = labels_store.delete_labels_by_hash(
        conn, [r["hash"] for r in rows], character=character, partner=partner
    )
    return {"deleted": deleted, "trash_id": entry["id"]}


def clear(
    conn: sqlite3.Connection,
    character: str,
    partner: str | None = None,
    *,
    partner_aliases: list[str] | None = None,
) -> dict[str, Any]:
    """Clear the Labels of one conversation, or of every conversation of
    `character` when `partner` is None, keeping them in the Trash as one
    entry. Returns `{deleted, trash_id}`; `trash_id` is None when there
    was nothing to clear."""
    rows = labels_store.label_rows(
        conn, character, partner, partner_aliases=partner_aliases
    )
    return _clear_rows(conn, character, partner, rows)


def clear_all(conn: sqlite3.Connection) -> dict[str, Any]:
    """Clear every Label there is: one Trash entry per character, so
    each character's Trash view shows and restores its own."""
    by_character: dict[str, list[dict]] = {}
    for row in labels_store.label_rows(conn):
        by_character.setdefault(row["character"], []).append(row)
    deleted = 0
    trash_ids: list[str] = []
    for character, rows in by_character.items():
        res = _clear_rows(conn, character, None, rows)
        deleted += res["deleted"]
        trash_ids.append(res["trash_id"])
    return {"deleted": deleted, "trash_ids": trash_ids}


def list_labels(character: str) -> list[dict[str, Any]]:
    """The cleared Labels in `character`'s Trash, most recently cleared
    first: who cleared them, the scope (`partner` None means every
    conversation) and how many Labels each entry holds."""
    rows: list[dict[str, Any]] = []
    for path in _dir().glob("*.json"):
        entry = _read(path.stem)
        if entry and _same_name(entry.get("character"), character):
            rows.append(_summary(entry))
    rows.sort(key=lambda r: (r["deleted_at"] or 0, r["id"]), reverse=True)
    return rows


def restore(character: str, ids: list[str]) -> dict[str, Any]:
    """Put cleared Labels back. A message labelled again since the clear
    keeps its newer Label and is reported under `skipped`. The entry
    leaves the Trash."""
    restored: list[dict[str, Any]] = []
    with _lock:
        found, not_found = trash_ledger.resolve_ids(ids, lambda i: _owned(i, character))
        conn = labels_store.connect()
        try:
            for trash_id, entry in found:
                count, skipped = labels_store.restore_labels(conn, entry["labels"])
                (_dir() / f"{trash_id}.json").unlink(missing_ok=True)
                restored.append({"id": trash_id, "restored": count, "skipped": skipped})
        finally:
            conn.close()
    return {"restored": restored, "not_found": not_found}


def purge(character: str, ids: list[str]) -> dict[str, Any]:
    """Delete cleared Labels for good. The window's call only."""
    with _lock:
        return trash_ledger.purge(
            ids,
            lambda i: _owned(i, character),
            lambda trash_id, _entry: (_dir() / f"{trash_id}.json").unlink(missing_ok=True),
        )


def empty(character: str) -> int:
    """Delete every cleared-Labels entry in `character`'s Trash for good.
    The window's call only."""
    return len(purge(character, [r["id"] for r in list_labels(character)])["purged"])
