"""Persisted user settings, sharing the documents.db file.

A simple key/value table — used today for the FCHAT data-dir override
(picked from the UI's Settings modal) and a natural home for future
single-user prefs. The env var `FCHAT_DATA_DIR` still wins when set so
the devcontainer + tests don't depend on UI state.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import documents

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

# Keys we know about. Untyped here intentionally — keeps the table
# trivial; the API layer is where shape validation happens.
KEY_FCHAT_DATA_DIR = "fchat_data_dir"

# Labels / classifier settings (see sidecar/labels.py for defaults +
# resolver). Stored as strings; numeric/JSON parsing is the consumer's
# job. The system_prompt key holds the entire classifier system prompt
# so users can tune it without touching code.
KEY_LABELS_THRESHOLD_CHARS = "labels.threshold_chars"
KEY_LABELS_LLM_ENDPOINT = "labels.llm_endpoint"
KEY_LABELS_LLM_MODEL = "labels.llm_model"
KEY_LABELS_LLM_API_KEY = "labels.llm_api_key"
KEY_LABELS_SYSTEM_PROMPT = "labels.system_prompt"


def connect(root: Path | None = None) -> sqlite3.Connection:
    # Reuse documents.connect so we share the same DB file. It already
    # creates the documents/revisions/drafts schema; we add ours on top.
    conn = documents.connect(root)
    conn.executescript(SCHEMA)
    return conn


def get(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row is not None else None


def set_value(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    conn.commit()


def clear(conn: sqlite3.Connection, key: str) -> None:
    conn.execute("DELETE FROM settings WHERE key = ?", (key,))
    conn.commit()


def all_settings(conn: sqlite3.Connection) -> dict[str, str]:
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    return {r["key"]: r["value"] for r in rows}
