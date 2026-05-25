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

# Chunking tunables. Changing any of these requires a re-ingest with
# wipe for existing data — chunk_ids encode the subchunk index, so
# old chunks survive in Qdrant alongside new ones otherwise. The
# Settings UI surfaces this caveat near the inputs.
KEY_RAG_CHUNK_MAX_CHARS = "rag.chunk_max_chars"
KEY_RAG_CHUNK_SOFT_SPLIT_CHARS = "rag.chunk_soft_split_chars"
KEY_RAG_CHUNK_OVERLAP_MSGS = "rag.chunk_overlap_msgs"


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
