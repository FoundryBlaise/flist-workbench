"""Persisted user settings — one tiny SQLite file on its own.

A simple key/value table — used today for the FCHAT data-dir override
(picked from the UI's Settings modal) and a natural home for future
single-user prefs. The env var `FCHAT_DATA_DIR` still wins when set so
the devcontainer + tests don't depend on UI state.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import paths
import sqlite_db

# Keys we know about. Untyped here intentionally — keeps the table
# trivial; the API layer is where shape validation happens.
KEY_FCHAT_DATA_DIR = "fchat_data_dir"

# Labels settings (see sidecar/labels.py for defaults + resolver).
# Only the rule threshold survives: a message shorter than this many
# characters is OOC without asking anyone. Everything the rules cannot
# settle now goes to the connected MCP client, so the classifier's
# endpoint / model / prompt / context keys are gone.
KEY_LABELS_THRESHOLD_CHARS = "labels.threshold_chars"

# RAG / embedding settings. Endpoint defaults to the labels endpoint
# (most users run one LM Studio with both a chat model and an embedding
# model loaded). Prefixes only matter for nomic-* models; default empty.
#: A fastembed model id, always "org/name". Values without a slash are
#: leftovers from the removed endpoint backend and are ignored on read.
KEY_RAG_EMBED_MODEL = "rag.embed_model"

# Retrieval / rerank tunables. Stored as strings; numeric coercion in
# the loader, with clamping for safety.
KEY_RAG_RERANK_MODEL = "rag.rerank_model"
KEY_RAG_RERANK_CANDIDATES = "rag.rerank_candidates"
KEY_RAG_TOP_K = "rag.top_k"
KEY_RAG_NEIGHBORS = "rag.neighbors"
# Quality tunables surfaced under "Retrieval" in the settings pane.
# All default to off / 0 so upgrading is a no-op for existing users —
# they opt in once they validate behaviour.
KEY_RAG_RERANK_MIN_RATIO = "rag.rerank_min_ratio"
KEY_RAG_HYBRID_ENABLED = "rag.hybrid_enabled"
KEY_RAG_HYBRID_BM25_CANDIDATES = "rag.hybrid_bm25_candidates"
# Per-query keep_alive sent to the embed endpoint. Empty string ("")
# suppresses the field — Ollama then keeps the model resident for its
# default ~5 minutes. A short value like "30s" lets bge-m3 drop quickly
# on VRAM-tight setups. Free-text so users can write Ollama's duration
# grammar verbatim ("30s" / "1m" / "0").

# Chunking tunables. Changing any of these requires a re-ingest with
# wipe for existing data — chunk_ids encode the subchunk index, so
# old chunks survive in Qdrant alongside new ones otherwise. The
# Settings UI surfaces this caveat near the inputs.
KEY_RAG_CHUNK_MAX_CHARS = "rag.chunk_max_chars"
KEY_RAG_CHUNK_SOFT_SPLIT_CHARS = "rag.chunk_soft_split_chars"
KEY_RAG_CHUNK_OVERLAP_MSGS = "rag.chunk_overlap_msgs"

# Folders the MCP `import_image` tool may read from, as a JSON list of
# absolute paths. Set only from Settings → Security: a tool call that
# could widen its own reach would make the allow-list pointless.
KEY_IMAGE_IMPORT_ROOTS = "images.import_roots"

def db_path(root: Path | None = None) -> Path:
    base = root or paths.user_data_dir()
    base.mkdir(parents=True, exist_ok=True)
    return base / "settings.db"


def connect(root: Path | None = None) -> sqlite3.Connection:
    """Open settings.db, migrated to the latest version (see sqlite_db)."""
    return sqlite_db.connect(db_path(root), MIGRATIONS)


# Released migration steps never change; a schema change, or another
# key to retire, is a new step at the end of MIGRATIONS.

_create_table = sqlite_db.statements(
    """
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )
    """
)


# Keys of removed features: mostly the in-app LLM features (RAG chat,
# the IC/OOC classifier, multi-query expansion), plus scheduled backups. Workbench runs no language model
# of its own any more — the connected MCP client brings one — so these
# rows are dead weight that would otherwise sit in every existing
# install's settings.db forever, including an API key the user can no
# longer see or clear from the UI.
RETIRED_KEYS = (
    "labels.llm_endpoint",
    "labels.llm_model",
    "labels.llm_api_key",
    "labels.system_prompt",
    "labels.context_before",
    "labels.context_after",
    "rag.chat_endpoint",
    "rag.chat_model",
    "rag.chat_api_key",
    "rag.chat_system_prompt",
    "rag.chat_num_ctx",
    "rag.multiquery_enabled",
    "rag.multiquery_variants",
    # The embedding endpoint is gone: embedding runs in-process, so
    # there is no server to address, no key to send it, no prefix to
    # guess and nothing to keep warm in someone else's VRAM.
    "rag.embed_backend",
    "rag.embed_endpoint",
    "rag.embed_api_key",
    "rag.embed_query_prefix",
    "rag.embed_document_prefix",
    "rag.embed_keep_alive",
    "rag.chat_embed_keep_alive",
    # Scheduled backups are gone: nothing runs on a timer, and no
    # Backups are pruned, so their interval, retention and last-run
    # rows have no reader.
    "backups.scheduled_interval_days",
    "backups.scheduled_keep_last_n",
    "backups.last_sweep_started_at",
    "backups.last_sweep_finished_at",
    "backups.last_sweep_written",
    "backups.last_sweep_skipped",
    "backups.last_sweep_failed",
    "backups.last_sweep_source",
)

#: `rag.local_embed_model` existed only while both backends did. With
#: one backend the honest name is `rag.embed_model`; carry the value
#: over rather than silently resetting someone's model choice.
_RENAMED_KEYS = {"rag.local_embed_model": KEY_RAG_EMBED_MODEL}


def _drop_retired_keys(conn: sqlite3.Connection) -> None:
    """Clean up settings rows left over from removed features."""
    for old, new in _RENAMED_KEYS.items():
        row = conn.execute(
            "SELECT value FROM settings WHERE key = ?", (old,)
        ).fetchone()
        if row is None:
            continue
        # Don't clobber a value already written under the new name.
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            (new, row["value"]),
        )
        conn.execute("DELETE FROM settings WHERE key = ?", (old,))
    placeholders = ",".join("?" * len(RETIRED_KEYS))
    conn.execute(
        f"DELETE FROM settings WHERE key IN ({placeholders})", RETIRED_KEYS
    )


MIGRATIONS: tuple[sqlite_db.Migration, ...] = (
    _create_table,
    _drop_retired_keys,
)

#: The `user_version` of a settings.db that has every migration.
SCHEMA_VERSION = len(MIGRATIONS)


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
