"""Partner aliases — link multiple F-Chat partner files as one conversation.

F-Chat 3.0 creates a new log file every time a roleplay partner renames
their character mid-conversation (e.g. "Daemon Enariel" → "Ashvalia").
The two files share zero name, so the sidebar shows them as unrelated
partners and the RAG index, labels store, and stats roll-ups treat them
as different conversations. This module lets users explicitly link
those files so the rest of the app can see the rename as one
continuous RP.

Data model — single table living in labels.db so we share the
"all-app-state-in-one-SQLite-file" convention:

    CREATE TABLE partner_aliases (
        character     TEXT NOT NULL,
        name          TEXT NOT NULL,       -- any name in the group
        primary_name  TEXT NOT NULL,       -- canonical name shown in UI
        created_at    REAL NOT NULL,
        PRIMARY KEY (character, name)
    )

Every name in an alias group has its own row (including the primary
itself), all pointing at the same `primary_name`. This makes "give me
all aliases of group X" a single indexed query and removes the awkward
"is this name itself the primary?" branch every caller would otherwise
need. add_alias creates the primary row on the fly if it doesn't exist
yet — callers don't have to prep state.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import labels as labels_store

SCHEMA = """
CREATE TABLE IF NOT EXISTS partner_aliases (
    character     TEXT NOT NULL,
    name          TEXT NOT NULL,
    primary_name  TEXT NOT NULL,
    created_at    REAL NOT NULL,
    PRIMARY KEY (character, name)
);
CREATE INDEX IF NOT EXISTS idx_aliases_primary
    ON partner_aliases(character, primary_name);
"""


def connect(root: Path | None = None) -> sqlite3.Connection:
    """Open the labels.db connection and ensure the alias table exists.

    Returns the same connection labels_store.connect() returns so a
    caller doing both labels + alias work in one request reuses one
    connection. Callers that don't need labels can just call this.
    """
    conn = labels_store.connect(root)
    conn.executescript(SCHEMA)
    return conn


# ---- read paths --------------------------------------------------------


def primary_for(conn: sqlite3.Connection, character: str, name: str) -> str:
    """Return the canonical name for `name`, or `name` itself if not aliased."""
    row = conn.execute(
        "SELECT primary_name FROM partner_aliases WHERE character = ? AND name = ?",
        (character, name),
    ).fetchone()
    if row is None:
        return name
    return row["primary_name"]


def all_names_for(
    conn: sqlite3.Connection, character: str, name: str
) -> list[str]:
    """Every name (primary + every alias) in the group containing `name`.

    If `name` isn't aliased, returns `[name]`. The result is sorted to
    keep query plans + cache lookups deterministic.
    """
    primary = primary_for(conn, character, name)
    rows = conn.execute(
        "SELECT name FROM partner_aliases "
        "WHERE character = ? AND primary_name = ?",
        (character, primary),
    ).fetchall()
    if not rows:
        # Not in any group → singleton.
        return [name]
    return sorted({r["name"] for r in rows})


def list_groups(
    conn: sqlite3.Connection, character: str
) -> dict[str, list[str]]:
    """Return {primary_name: [all names in group]} for one character.

    Used by the sidebar to render "Ashvalia (was: Daemon Enariel)"
    style entries. Empty dict when the character has no linked
    partners — caller just renders the flat partner list as before.
    """
    rows = conn.execute(
        "SELECT primary_name, name FROM partner_aliases WHERE character = ?",
        (character,),
    ).fetchall()
    groups: dict[str, list[str]] = {}
    for r in rows:
        groups.setdefault(r["primary_name"], []).append(r["name"])
    for k in groups:
        groups[k] = sorted(set(groups[k]))
    return groups


# ---- write paths -------------------------------------------------------


def add_alias(
    conn: sqlite3.Connection, character: str, name: str, primary_name: str
) -> None:
    """Make `name` an alias of `primary_name` for this character.

    Idempotent. Auto-creates the primary's self-row if missing, so
    callers don't have to manually seed it. If either name is already
    part of a different group, this call normalises both groups to use
    `primary_name` as the canonical root — handy when the user links
    A→B and later links A→C (both transitively become C).
    """
    if not name.strip() or not primary_name.strip():
        raise ValueError("alias and primary names must be non-empty")
    if name == primary_name:
        # Pointing a name at itself is meaningless — skip rather than
        # create the row, since add_alias is also called via
        # consolidate-groups paths.
        _ensure_primary_row(conn, character, primary_name)
        conn.commit()
        return

    now = time.time()
    # If either name already has a group, normalise: rewrite every row
    # pointing at the old primary to point at the new primary. This
    # keeps the alias graph a forest of stars (one primary per group)
    # rather than letting chains form.
    existing_primaries: set[str] = set()
    for n in (name, primary_name):
        row = conn.execute(
            "SELECT primary_name FROM partner_aliases "
            "WHERE character = ? AND name = ?",
            (character, n),
        ).fetchone()
        if row:
            existing_primaries.add(row["primary_name"])

    if existing_primaries:
        # Rewrite every row in any touched group to the new primary.
        for old in existing_primaries:
            if old == primary_name:
                continue
            conn.execute(
                "UPDATE partner_aliases SET primary_name = ?, created_at = ? "
                "WHERE character = ? AND primary_name = ?",
                (primary_name, now, character, old),
            )

    # Ensure both rows exist, both pointing at primary_name.
    _ensure_primary_row(conn, character, primary_name)
    conn.execute(
        "INSERT INTO partner_aliases (character, name, primary_name, created_at) "
        "VALUES (?, ?, ?, ?) "
        "ON CONFLICT(character, name) DO UPDATE SET "
        "    primary_name = excluded.primary_name, "
        "    created_at = excluded.created_at",
        (character, name, primary_name, now),
    )
    conn.commit()


def _ensure_primary_row(
    conn: sqlite3.Connection, character: str, primary_name: str
) -> None:
    """Self-link the primary so list_groups/all_names_for see it."""
    conn.execute(
        "INSERT OR IGNORE INTO partner_aliases "
        "(character, name, primary_name, created_at) VALUES (?, ?, ?, ?)",
        (character, primary_name, primary_name, time.time()),
    )


def remove_alias(
    conn: sqlite3.Connection, character: str, name: str
) -> bool:
    """Drop `name` from its alias group.

    If `name` was the primary of a group with other aliases, the
    surviving members are left dangling — caller's responsibility to
    decide whether to promote one to primary or wipe the rest. Returns
    True if a row was deleted, False if `name` wasn't aliased.
    """
    cur = conn.execute(
        "DELETE FROM partner_aliases WHERE character = ? AND name = ?",
        (character, name),
    )
    conn.commit()
    return cur.rowcount > 0


def unlink_group(
    conn: sqlite3.Connection, character: str, primary_name: str
) -> int:
    """Drop an entire alias group. Returns count of removed rows.

    Used by the "Unlink all" UI action when the user wants to undo a
    merge without picking which alias to keep.
    """
    cur = conn.execute(
        "DELETE FROM partner_aliases "
        "WHERE character = ? AND primary_name = ?",
        (character, primary_name),
    )
    conn.commit()
    return cur.rowcount
