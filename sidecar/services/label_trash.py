"""Cleared Labels in the Trash.

Clearing Labels, from the window or over MCP, takes away hours of
labelling in one call. So before any Labels are cleared they are
written to the Trash as one entry, which the window's Trash view lists
under the character and Restore puts back.

An entry keeps each Label by message hash and verdict, with the rest of
its row for the current labels table. Entries written before the labels
table dropped its character and partner columns still carry both on
every row; putting them back ignores them. A Label belongs to the message,
not to a character (ADR 0004), so the entries live in one place,
`<userdata>/trash/labels/`, and not in a character folder: a character
that has Logs but no Workbench still gets its cleared Labels kept.
Settings → Labels lists every entry, whoever it was cleared for; a
character's Trash view shows the ones whose Log character matches its
name, matched like the character list does.

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

import archive_registry
import atomic_write
import labels as labels_store
import logs as log_store
import paths
from services import trash_ledger

FOLDER = "labels"

_ID_RE = re.compile(r"^[0-9]+-[0-9a-f]{12}$")

_lock = threading.Lock()


def _dir() -> Path:
    p = paths.user_data_dir() / "trash" / FOLDER
    p.mkdir(parents=True, exist_ok=True)
    return p


def _write_entry(
    character: str | None, partner: str | None, rows: list[dict]
) -> dict[str, Any]:
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
    atomic_write.write_json(folder / f"{trash_id}.json", entry, ensure_ascii=False)
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


def _owned(trash_id: str, character: str | None) -> dict[str, Any] | None:
    """The entry `trash_id` names, if it is in `character`'s Trash, or
    in the Trash at all when `character` is None."""
    entry = _read(trash_id)
    if entry is None or (
        character is not None
        and not archive_registry.same_character_name(entry.get("character"), character)
    ):
        return None
    return entry


def _clear_rows(
    conn: sqlite3.Connection, character: str | None, partner: str | None, rows: list[dict]
) -> dict[str, Any]:
    """Trash `rows`, then delete exactly those Labels. The copy is on
    disk before anything is deleted."""
    if not rows:
        return {"deleted": 0, "trash_id": None}
    with _lock:
        entry = _write_entry(character, partner, rows)
    deleted = labels_store.delete_labels_by_hash(conn, [r["hash"] for r in rows])
    return {"deleted": deleted, "trash_id": entry["id"]}


def clear(
    character: str, partner: str | None = None, *, keep_manual: bool = False
) -> dict[str, Any]:
    """Clear the Labels of one conversation, under every name of the
    partner's alias group, or of every conversation of `character` when
    `partner` is None, keeping them in the Trash as one entry. The one
    clear the window and MCP both call; with `keep_manual` the Labels
    the user set by hand stay as they are and out of the Trash (MCP
    never takes those). Returns `{deleted, trash_id, kept}`, `kept`
    being the hashes of the manual Labels left alone; `trash_id` is
    None when there was nothing to clear."""
    messages = _log_messages(character, partner)
    conn = labels_store.connect()
    try:
        rows = labels_store.label_rows(conn, messages)
        kept = [r["hash"] for r in rows if r["source"] == "manual"] if keep_manual else []
        if kept:
            rows = [r for r in rows if r["source"] != "manual"]
        return _clear_rows(conn, character, partner, rows) | {"kept": kept}
    finally:
        conn.close()


def _log_messages(character: str, partner: str | None) -> list[dict]:
    """The messages whose Labels clearing takes away: those of one
    conversation's Log, its whole alias group, or of every Log of
    `character`. A Label belongs to the message (ADR 0004), so a Label
    whose message is in none of these Logs is left alone. No Log means
    nothing to clear."""
    if partner is not None:
        try:
            return list(log_store.read_messages(character, partner))
        except log_store.LogNotFound:
            return []
    try:
        return [m for _, msgs in log_store.read_conversations(character) for m in msgs]
    except log_store.LogNotFound:
        return []


def clear_all() -> dict[str, Any]:
    """Clear every Label there is: one Trash entry per character whose
    Logs hold the messages, so each character's Trash view shows and
    restores its own. A message in several characters' Logs goes into
    the first one's entry, in the order the Logs list the characters.
    Labels of messages in no Log go into one entry of their own, with
    no character, which Settings → Labels lists."""
    conn = labels_store.connect()
    try:
        rows = labels_store.label_rows(conn)
        owners = _log_characters_by_hash() if rows else {}
        by_character: dict[str | None, list[dict]] = {}
        for row in rows:
            by_character.setdefault(owners.get(row["hash"]), []).append(row)
        deleted = 0
        trash_ids: list[str] = []
        for character, rows in by_character.items():
            res = _clear_rows(conn, character, None, rows)
            deleted += res["deleted"]
            trash_ids.append(res["trash_id"])
        return {"deleted": deleted, "trash_ids": trash_ids}
    finally:
        conn.close()


def _log_characters_by_hash() -> dict[str, str]:
    """Which character's Logs hold each message, by message hash: the
    first character, in the order the Logs list them, for a message in
    several."""
    try:
        characters = log_store.list_characters()
    except log_store.LogDirError:
        return {}
    owners: dict[str, str] = {}
    for entry in characters:
        for msg in _log_messages(entry.name, None):
            owners.setdefault(labels_store.msg_hash(msg), entry.name)
    return owners


def list_labels(character: str | None) -> list[dict[str, Any]]:
    """The cleared Labels in `character`'s Trash, or every entry when
    `character` is None, most recently cleared first: who cleared them,
    the scope (`partner` None means every conversation) and how many
    Labels each entry holds."""
    rows: list[dict[str, Any]] = []
    for path in _dir().glob("*.json"):
        entry = _owned(path.stem, character)
        if entry:
            rows.append(_summary(entry))
    rows.sort(key=lambda r: (r["deleted_at"] or 0, r["id"]), reverse=True)
    return rows


def restore(character: str | None, ids: list[str]) -> dict[str, Any]:
    """Put cleared Labels back: entries in `character`'s Trash, or any
    entry when `character` is None. A message labelled again since the
    clear keeps its newer Label and is reported under `skipped`. The
    entry leaves the Trash."""
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


def purge(character: str | None, ids: list[str]) -> dict[str, Any]:
    """Delete cleared Labels for good, from `character`'s Trash or, when
    None, from anywhere in it. The window's call only."""
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
