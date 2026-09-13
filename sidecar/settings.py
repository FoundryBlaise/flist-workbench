"""Persisted user settings — one tiny SQLite file on its own.

A simple key/value table — used today for the FCHAT data-dir override
(picked from the UI's Settings modal) and a natural home for future
single-user prefs. The env var `FCHAT_DATA_DIR` still wins when set so
the devcontainer + tests don't depend on UI state.

History: prior to the Snippets removal (2026-06-17) this module shared
the documents.db file. When documents.py died, settings moved into its
own settings.db. The first-launch migration in `connect()` copies any
pre-existing rows out of documents.db and then drops that file —
existing installs lose nothing.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import paths

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

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

# Scheduled backups (on-start check). Default 7 day interval, keep
# 10 newest scheduled backups per character. Both surfaced in the
# Settings panel under "Backups". Setting interval to 0 disables the
# auto-backup entirely without ripping out the wiring — handy for
# users who'd rather drive every backup themselves.
KEY_BACKUPS_SCHEDULED_INTERVAL_DAYS = "backups.scheduled_interval_days"
KEY_BACKUPS_SCHEDULED_KEEP_LAST_N = "backups.scheduled_keep_last_n"
BACKUPS_SCHEDULED_INTERVAL_DAYS_DEFAULT = 7
BACKUPS_SCHEDULED_KEEP_LAST_N_DEFAULT = 10

# Last-sweep telemetry persisted across launches. The Settings →
# Backups pane reads these to show "last ran at" + "next due" + the
# saved/skipped/failed counts. Manual trigger and the on-start hook
# both write these — manual trigger naturally resets the "next due"
# clock forward by 7 days because it updates last_started_at.
KEY_BACKUPS_LAST_SWEEP_STARTED_AT = "backups.last_sweep_started_at"
KEY_BACKUPS_LAST_SWEEP_FINISHED_AT = "backups.last_sweep_finished_at"
KEY_BACKUPS_LAST_SWEEP_WRITTEN = "backups.last_sweep_written"
KEY_BACKUPS_LAST_SWEEP_SKIPPED = "backups.last_sweep_skipped"
KEY_BACKUPS_LAST_SWEEP_FAILED = "backups.last_sweep_failed"
# Provenance of the last sweep: 'on_start' (sidecar boot) or 'manual'
# (user pressed Trigger scheduled backup now). Lets the UI clarify
# "ran on app launch" vs "you ran it from Settings".
KEY_BACKUPS_LAST_SWEEP_SOURCE = "backups.last_sweep_source"


def db_path(root: Path | None = None) -> Path:
    base = root or paths.user_data_dir()
    base.mkdir(parents=True, exist_ok=True)
    return base / "settings.db"


def connect(root: Path | None = None) -> sqlite3.Connection:
    # check_same_thread=False — FastAPI runs generator dependencies in
    # the anyio threadpool and may schedule dep setup, endpoint body,
    # and teardown on different worker threads. SQLite's same-thread
    # guard would then 500 every /settings call. Per-request open +
    # close means concurrent use of a single connection isn't a risk.
    base = root or paths.user_data_dir()
    target = db_path(base)
    _migrate_from_documents_db(base, target)
    conn = sqlite3.connect(target, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    _drop_retired_ai_keys(conn)
    return conn


# Keys that belonged to the in-app LLM features (RAG chat, the IC/OOC
# classifier, multi-query expansion). Workbench runs no language model
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
)

#: `rag.local_embed_model` existed only while both backends did. With
#: one backend the honest name is `rag.embed_model`; carry the value
#: over rather than silently resetting someone's model choice.
_RENAMED_KEYS = {"rag.local_embed_model": KEY_RAG_EMBED_MODEL}


def _drop_retired_ai_keys(conn: sqlite3.Connection) -> None:
    """Clean up settings rows left over from the removed AI features.

    Runs on every connect and is a no-op once done — a DELETE of rows
    that aren't there costs nothing, and this way an install that
    downgrades and upgrades again is still tidied.
    """
    try:
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
        conn.commit()
    except sqlite3.DatabaseError:
        # A settings cleanup must never stop the sidecar from starting.
        pass


def _migrate_from_documents_db(base: Path, target: Path) -> None:
    """One-shot import of the `settings` table out of the old shared
    `documents.db` into the new dedicated `settings.db`, then delete
    `documents.db` so the snippets feature leaves no trace on disk.

    Idempotent: once settings.db exists this is a no-op. Errors are
    swallowed because a corrupt or locked documents.db must not block
    the sidecar from starting up — worst case the user loses their
    FCHAT data-dir preference and re-picks it from Settings.
    """
    if target.exists():
        return
    legacy = base / "documents.db"
    if not legacy.exists():
        return
    try:
        src = sqlite3.connect(legacy)
        src.row_factory = sqlite3.Row
        try:
            rows = src.execute("SELECT key, value FROM settings").fetchall()
        except sqlite3.DatabaseError:
            rows = []
        src.close()
        if rows:
            dst = sqlite3.connect(target)
            dst.executescript(SCHEMA)
            dst.executemany(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                [(r["key"], r["value"]) for r in rows],
            )
            dst.commit()
            dst.close()
    except Exception:
        return
    finally:
        try:
            legacy.unlink()
        except OSError:
            pass
        for sidecar_file in ("documents.db-wal", "documents.db-shm"):
            try:
                (base / sidecar_file).unlink()
            except OSError:
                pass


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
