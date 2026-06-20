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

# Labels / classifier settings (see sidecar/labels.py for defaults +
# resolver). Stored as strings; numeric/JSON parsing is the consumer's
# job. The system_prompt key holds the entire classifier system prompt
# so users can tune it without touching code.
KEY_LABELS_THRESHOLD_CHARS = "labels.threshold_chars"
KEY_LABELS_LLM_ENDPOINT = "labels.llm_endpoint"
KEY_LABELS_LLM_MODEL = "labels.llm_model"
KEY_LABELS_LLM_API_KEY = "labels.llm_api_key"
KEY_LABELS_SYSTEM_PROMPT = "labels.system_prompt"
# How many surrounding messages to attach as KONTEXT VORHER / NACHHER
# to each classify call. Higher = better disambiguation, lower = fits
# tighter on smaller-VRAM cards (8GB local models hit context limits
# easily). Defaults to 3 each per RAG_DESIGN.md.
KEY_LABELS_CONTEXT_BEFORE = "labels.context_before"
KEY_LABELS_CONTEXT_AFTER = "labels.context_after"

# RAG / embedding settings. Endpoint defaults to the labels endpoint
# (most users run one LM Studio with both a chat model and an embedding
# model loaded). Prefixes only matter for nomic-* models; default empty.
KEY_RAG_EMBED_ENDPOINT = "rag.embed_endpoint"
KEY_RAG_EMBED_MODEL = "rag.embed_model"
KEY_RAG_EMBED_API_KEY = "rag.embed_api_key"
KEY_RAG_EMBED_QUERY_PREFIX = "rag.embed_query_prefix"
KEY_RAG_EMBED_DOCUMENT_PREFIX = "rag.embed_document_prefix"

# RAG chat / query-time settings. chat_endpoint defaults to the labels
# endpoint (LM Studio often hosts both chat and embedding side-by-side
# at the same port); chat_model defaults to the labels model. The
# system prompt is user-editable; empty string falls back to the
# DEFAULT_SYSTEM_PROMPT in rag_query.
KEY_RAG_CHAT_ENDPOINT = "rag.chat_endpoint"
KEY_RAG_CHAT_MODEL = "rag.chat_model"
KEY_RAG_CHAT_API_KEY = "rag.chat_api_key"
KEY_RAG_CHAT_SYSTEM_PROMPT = "rag.chat_system_prompt"
# Retrieval / rerank tunables. Stored as strings; numeric coercion in
# the loader, with clamping for safety.
KEY_RAG_RERANK_MODEL = "rag.rerank_model"
KEY_RAG_RERANK_CANDIDATES = "rag.rerank_candidates"
KEY_RAG_TOP_K = "rag.top_k"
KEY_RAG_NEIGHBORS = "rag.neighbors"
# Quality tunables surfaced under "Retrieval" / "Quality" in the chat
# settings pane. All default to off / 0 so upgrading is a no-op for
# existing users — they opt in once they validate behaviour.
KEY_RAG_RERANK_MIN_RATIO = "rag.rerank_min_ratio"
KEY_RAG_HYBRID_ENABLED = "rag.hybrid_enabled"
KEY_RAG_HYBRID_BM25_CANDIDATES = "rag.hybrid_bm25_candidates"
KEY_RAG_MULTIQUERY_ENABLED = "rag.multiquery_enabled"
KEY_RAG_MULTIQUERY_VARIANTS = "rag.multiquery_variants"
# Ollama-specific: forwarded as options.num_ctx in the chat payload.
# LM Studio sets context at model load time and ignores this field.
KEY_RAG_CHAT_NUM_CTX = "rag.chat_num_ctx"
# Per-query keep_alive sent to the embed endpoint when embedding a chat
# question. Empty string ("") suppresses the field — Ollama then keeps
# the model resident for its default ~5 minutes. A short value like
# "30s" lets bge-m3 drop quickly on VRAM-tight setups so it doesn't
# thrash against the chat model. Free-text so users can write Ollama's
# duration grammar verbatim ("30s" / "1m" / "0").
KEY_RAG_CHAT_EMBED_KEEP_ALIVE = "rag.chat_embed_keep_alive"

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
    return conn


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
