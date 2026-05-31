"""Per-user document (a.k.a. "snippet") storage with append-only
revision history and a single-level folder tree.

Four tables, two storage layers:

  - `documents(id, name, folder_id, scratch, created_at, updated_at)` —
    doc metadata. `folder_id` is nullable; NULL means "at root". The
    `scratch` flag marks the always-present Scratch document.
  - `folders(id, name, created_at)` — single-level container. Folders
    cannot contain folders. Deleting a folder relocates its snippets to
    the root (NULL folder_id).
  - `revisions(id, doc_id, bbcode, inlines_json, created_at)` — explicit
    saves. Append-only, linear: "restore an old revision" writes a NEW
    revision at HEAD with the old content, so history is never destroyed.
  - `drafts(doc_id PRIMARY KEY, bbcode, inlines_json, updated_at)` —
    crash-safety. One slot per doc, overwrites itself on autosave.

Migration policy (2026-05-31): the v2 schema is a clean break — when
SQLite reports user_version < 2, the documents/revisions/drafts tables
are dropped and re-created from scratch. Internally the data model is
still called "documents" / "doc" to bound rename churn; the
user-facing UI rebrands them as "Snippets".
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    scratch INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id);
CREATE TABLE IF NOT EXISTS revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    bbcode TEXT NOT NULL,
    inlines_json TEXT NOT NULL DEFAULT '{}',
    char_count INTEGER NOT NULL,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_doc ON revisions(doc_id, created_at DESC);
CREATE TABLE IF NOT EXISTS drafts (
    doc_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    bbcode TEXT NOT NULL,
    inlines_json TEXT NOT NULL DEFAULT '{}',
    updated_at REAL NOT NULL
);
"""

SCRATCH_NAME = "Scratch"

# Seed the empty Scratch doc with a sample so first-launch users land
# on something that shows off the renderer instead of a blank pane.
# Mirrors the SAMPLE_BBCODE constant in renderer/src/state.ts.
SCRATCH_SEED = (
    "[heading]F-list Workbench[/heading]\n"
    "[i]Type BBCode here, watch it render on the right.[/i]\n\n"
    "[hr]\n\n"
    "[b]Try:[/b]\n"
    "[indent][b]Bold[/b], [i]italic[/i], [u]underline[/u], [s]strike[/s].[/indent]\n"
    "[indent]Coloured text in [color=red]red[/color], [color=blue]blue[/color], [color=green]green[/color].[/indent]\n"
    "[indent]Inline character icons: [icon]CharacterName[/icon] — replace with any public F-list character name.[/indent]\n"
    "[indent]Emote icons: [eicon]smirk[/eicon] [eicon]wink[/eicon][/indent]\n"
    "[indent]A link: [url=https://www.f-list.net]F-list[/url][/indent]\n\n"
    "[collapse=Click to expand][center]Hidden content.[/center][/collapse]"
)


class DocumentError(Exception):
    pass


@dataclass(slots=True, frozen=True)
class Folder:
    id: int
    name: str
    created_at: float


@dataclass(slots=True, frozen=True)
class Document:
    id: int
    name: str
    folder_id: int | None
    scratch: bool
    created_at: float
    updated_at: float
    latest_revision_id: int | None
    latest_char_count: int | None
    latest_created_at: float | None
    has_draft: bool


@dataclass(slots=True, frozen=True)
class Revision:
    id: int
    doc_id: int
    bbcode: str
    inlines: dict[str, Any]
    char_count: int
    created_at: float


def user_data_dir() -> Path:
    override = os.environ.get("FLIST_WORKBENCH_DATA_DIR")
    if override:
        return Path(override)
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "flist-workbench"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "flist-workbench"
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "flist-workbench"


def db_path(root: Path | None = None) -> Path:
    base = root or user_data_dir()
    base.mkdir(parents=True, exist_ok=True)
    return base / "documents.db"


def connect(root: Path | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path(root))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    _migrate(conn)
    conn.executescript(SCHEMA)
    _ensure_scratch(conn)
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """Wipe-and-rebuild on a schema break. v2 (2026-05-31) introduces
    folders + folder_id on documents; the rebrand from "Documents" to
    "Snippets" was an opportunity to drop the old data, so this
    migration discards everything < v2 rather than carrying it forward.
    """
    current = int(conn.execute("PRAGMA user_version").fetchone()[0])
    if current >= SCHEMA_VERSION:
        return
    conn.executescript(
        """
        DROP TABLE IF EXISTS drafts;
        DROP TABLE IF EXISTS revisions;
        DROP TABLE IF EXISTS documents;
        DROP TABLE IF EXISTS folders;
        """
    )
    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    conn.commit()


def _ensure_scratch(conn: sqlite3.Connection) -> None:
    row = conn.execute("SELECT id FROM documents WHERE scratch = 1 LIMIT 1").fetchone()
    if row is not None:
        return
    now = time.time()
    cur = conn.execute(
        "INSERT INTO documents (name, scratch, created_at, updated_at) VALUES (?, 1, ?, ?)",
        (SCRATCH_NAME, now, now),
    )
    conn.execute(
        "INSERT INTO revisions (doc_id, bbcode, inlines_json, char_count, created_at) VALUES (?, ?, '{}', ?, ?)",
        (cur.lastrowid, SCRATCH_SEED, len(SCRATCH_SEED), now),
    )
    conn.commit()


def _doc_from_row(row: sqlite3.Row) -> Document:
    return Document(
        id=row["id"],
        name=row["name"],
        folder_id=row["folder_id"],
        scratch=bool(row["scratch"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        latest_revision_id=row["latest_revision_id"],
        latest_char_count=row["latest_char_count"],
        latest_created_at=row["latest_created_at"],
        has_draft=bool(row["has_draft"]),
    )


_LIST_QUERY = """
SELECT
    d.id,
    d.name,
    d.folder_id,
    d.scratch,
    d.created_at,
    d.updated_at,
    r.id AS latest_revision_id,
    r.char_count AS latest_char_count,
    r.created_at AS latest_created_at,
    (drafts.doc_id IS NOT NULL) AS has_draft
FROM documents d
LEFT JOIN revisions r ON r.id = (
    SELECT id FROM revisions WHERE doc_id = d.id ORDER BY created_at DESC, id DESC LIMIT 1
)
LEFT JOIN drafts ON drafts.doc_id = d.id
"""


def list_documents(conn: sqlite3.Connection) -> list[Document]:
    rows = conn.execute(_LIST_QUERY + " ORDER BY d.scratch DESC, d.updated_at DESC").fetchall()
    return [_doc_from_row(r) for r in rows]


def get_document(conn: sqlite3.Connection, doc_id: int) -> Document:
    row = conn.execute(_LIST_QUERY + " WHERE d.id = ?", (doc_id,)).fetchone()
    if row is None:
        raise DocumentError(f"document not found: {doc_id}")
    return _doc_from_row(row)


def create_document(
    conn: sqlite3.Connection,
    name: str,
    *,
    bbcode: str = "",
    inlines: dict[str, Any] | None = None,
    folder_id: int | None = None,
) -> Document:
    name = name.strip()
    if not name:
        raise DocumentError("name must not be blank")
    if folder_id is not None:
        # Validate the folder exists so callers get a 400 rather than
        # a silent NULL when the id is stale.
        row = conn.execute("SELECT id FROM folders WHERE id = ?", (folder_id,)).fetchone()
        if row is None:
            raise DocumentError(f"folder not found: {folder_id}")
    now = time.time()
    cur = conn.execute(
        "INSERT INTO documents (name, folder_id, scratch, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
        (name, folder_id, now, now),
    )
    doc_id = int(cur.lastrowid)
    conn.execute(
        "INSERT INTO revisions (doc_id, bbcode, inlines_json, char_count, created_at) VALUES (?, ?, ?, ?, ?)",
        (doc_id, bbcode, json.dumps(inlines or {}), len(bbcode), now),
    )
    conn.commit()
    return get_document(conn, doc_id)


def duplicate_document(conn: sqlite3.Connection, source_id: int, new_name: str) -> Document:
    source = get_document(conn, source_id)
    rev = current_content(conn, source_id)
    return create_document(
        conn,
        new_name,
        bbcode=rev.bbcode,
        inlines=rev.inlines,
        folder_id=source.folder_id,
    )


def move_document(
    conn: sqlite3.Connection, doc_id: int, folder_id: int | None
) -> Document:
    """Move a document into a folder, or back to the root with folder_id=None."""
    doc = get_document(conn, doc_id)
    if doc.scratch and folder_id is not None:
        # The Scratch document is the always-there empty-state landing
        # surface — keeping it at the root means an unfiltered first
        # impression always greets users with something to render.
        raise DocumentError("the Scratch document stays at the root")
    if folder_id is not None:
        row = conn.execute("SELECT id FROM folders WHERE id = ?", (folder_id,)).fetchone()
        if row is None:
            raise DocumentError(f"folder not found: {folder_id}")
    conn.execute(
        "UPDATE documents SET folder_id = ?, updated_at = ? WHERE id = ?",
        (folder_id, time.time(), doc_id),
    )
    conn.commit()
    return get_document(conn, doc_id)


# ---- folders --------------------------------------------------------


def list_folders(conn: sqlite3.Connection) -> list[Folder]:
    rows = conn.execute(
        "SELECT id, name, created_at FROM folders ORDER BY name COLLATE NOCASE"
    ).fetchall()
    return [Folder(id=r["id"], name=r["name"], created_at=r["created_at"]) for r in rows]


def create_folder(conn: sqlite3.Connection, name: str) -> Folder:
    name = name.strip()
    if not name:
        raise DocumentError("folder name must not be blank")
    now = time.time()
    cur = conn.execute(
        "INSERT INTO folders (name, created_at) VALUES (?, ?)",
        (name, now),
    )
    return Folder(id=int(cur.lastrowid), name=name, created_at=now)


def rename_folder(conn: sqlite3.Connection, folder_id: int, new_name: str) -> Folder:
    new_name = new_name.strip()
    if not new_name:
        raise DocumentError("folder name must not be blank")
    cur = conn.execute(
        "UPDATE folders SET name = ? WHERE id = ?",
        (new_name, folder_id),
    )
    if cur.rowcount == 0:
        raise DocumentError(f"folder not found: {folder_id}")
    conn.commit()
    row = conn.execute(
        "SELECT id, name, created_at FROM folders WHERE id = ?", (folder_id,)
    ).fetchone()
    return Folder(id=row["id"], name=row["name"], created_at=row["created_at"])


def delete_folder(conn: sqlite3.Connection, folder_id: int) -> None:
    """Delete a folder. Snippets inside relocate to the root
    (ON DELETE SET NULL on the FK)."""
    cur = conn.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
    if cur.rowcount == 0:
        raise DocumentError(f"folder not found: {folder_id}")
    conn.commit()


def rename_document(conn: sqlite3.Connection, doc_id: int, new_name: str) -> Document:
    doc = get_document(conn, doc_id)
    if doc.scratch:
        raise DocumentError("the Scratch document cannot be renamed")
    new_name = new_name.strip()
    if not new_name:
        raise DocumentError("name must not be blank")
    conn.execute(
        "UPDATE documents SET name = ?, updated_at = ? WHERE id = ?",
        (new_name, time.time(), doc_id),
    )
    conn.commit()
    return get_document(conn, doc_id)


def delete_document(conn: sqlite3.Connection, doc_id: int) -> None:
    doc = get_document(conn, doc_id)
    if doc.scratch:
        raise DocumentError("the Scratch document cannot be deleted")
    conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    conn.commit()


def list_revisions(conn: sqlite3.Connection, doc_id: int) -> list[Revision]:
    get_document(conn, doc_id)  # raises if missing
    rows = conn.execute(
        "SELECT id, doc_id, bbcode, inlines_json, char_count, created_at "
        "FROM revisions WHERE doc_id = ? ORDER BY created_at DESC, id DESC",
        (doc_id,),
    ).fetchall()
    return [
        Revision(
            id=r["id"],
            doc_id=r["doc_id"],
            bbcode=r["bbcode"],
            inlines=json.loads(r["inlines_json"]),
            char_count=r["char_count"],
            created_at=r["created_at"],
        )
        for r in rows
    ]


def get_revision(conn: sqlite3.Connection, doc_id: int, rev_id: int) -> Revision:
    row = conn.execute(
        "SELECT id, doc_id, bbcode, inlines_json, char_count, created_at "
        "FROM revisions WHERE id = ? AND doc_id = ?",
        (rev_id, doc_id),
    ).fetchone()
    if row is None:
        raise DocumentError(f"revision not found: {rev_id}")
    return Revision(
        id=row["id"],
        doc_id=row["doc_id"],
        bbcode=row["bbcode"],
        inlines=json.loads(row["inlines_json"]),
        char_count=row["char_count"],
        created_at=row["created_at"],
    )


def save_revision(
    conn: sqlite3.Connection,
    doc_id: int,
    bbcode: str,
    inlines: dict[str, Any] | None = None,
) -> Revision:
    """Explicit Save → new revision at HEAD, clears the draft slot."""
    get_document(conn, doc_id)
    now = time.time()
    cur = conn.execute(
        "INSERT INTO revisions (doc_id, bbcode, inlines_json, char_count, created_at) VALUES (?, ?, ?, ?, ?)",
        (doc_id, bbcode, json.dumps(inlines or {}), len(bbcode), now),
    )
    conn.execute("UPDATE documents SET updated_at = ? WHERE id = ?", (now, doc_id))
    conn.execute("DELETE FROM drafts WHERE doc_id = ?", (doc_id,))
    conn.commit()
    return get_revision(conn, doc_id, int(cur.lastrowid))


def save_draft(
    conn: sqlite3.Connection,
    doc_id: int,
    bbcode: str,
    inlines: dict[str, Any] | None = None,
) -> None:
    """Overwrite the single draft slot for this doc — crash-safety only."""
    get_document(conn, doc_id)
    now = time.time()
    conn.execute(
        "INSERT INTO drafts (doc_id, bbcode, inlines_json, updated_at) "
        "VALUES (?, ?, ?, ?) "
        "ON CONFLICT(doc_id) DO UPDATE SET "
        "bbcode = excluded.bbcode, inlines_json = excluded.inlines_json, updated_at = excluded.updated_at",
        (doc_id, bbcode, json.dumps(inlines or {}), now),
    )
    conn.commit()


def discard_draft(conn: sqlite3.Connection, doc_id: int) -> None:
    conn.execute("DELETE FROM drafts WHERE doc_id = ?", (doc_id,))
    conn.commit()


def current_content(conn: sqlite3.Connection, doc_id: int) -> Revision:
    """Return whichever is newer: latest revision, or current draft.

    A draft that exists is always newer than the latest revision by
    definition (revisions clear the draft slot). Renderer uses this on
    doc open so unsaved edits survive a relaunch.
    """
    doc = get_document(conn, doc_id)
    draft = conn.execute(
        "SELECT bbcode, inlines_json, updated_at FROM drafts WHERE doc_id = ?",
        (doc_id,),
    ).fetchone()
    if draft is not None:
        return Revision(
            id=0,
            doc_id=doc_id,
            bbcode=draft["bbcode"],
            inlines=json.loads(draft["inlines_json"]),
            char_count=len(draft["bbcode"]),
            created_at=draft["updated_at"],
        )
    if doc.latest_revision_id is None:
        # Shouldn't happen — create_document always writes the first
        # revision. Be defensive in case anyone hand-edits the DB.
        return Revision(id=0, doc_id=doc_id, bbcode="", inlines={}, char_count=0, created_at=doc.updated_at)
    return get_revision(conn, doc_id, doc.latest_revision_id)
