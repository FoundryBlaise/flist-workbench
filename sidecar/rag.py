"""RAG settings (embedding model, retrieval knobs, chunking).

Storage and loader mirror labels.load_settings. Empty strings stored in
the settings table fall back to the defaults defined here, which is how
"Reset to default" is implemented from the UI.

Embedding runs in-process (`rag_embed_local`, ONNX through fastembed),
so a fresh install needs no inference server and no configuration —
attach an MCP client, ingest, ask. No chat model and no classifier runs
here either; that is the connected MCP client's job.

Model-specific query/document prefixes used to be settings. They are
not any more: `rag_embed_local` keeps them per model, because a wrong
prefix costs recall with nothing to see for it and no user should be
asked to guess.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

import chunker
import labels as labels_store
import rag_embed_local
import rag_rerank
import settings as settings_store

#: A fastembed model id. Multilingual and small; see rag_embed_local
#: for why this one and not one of the larger candidates.
DEFAULT_EMBED_MODEL = rag_embed_local.DEFAULT_LOCAL_EMBED_MODEL

DEFAULT_RERANK_MODEL = rag_rerank.DEFAULT_RERANK_MODEL
DEFAULT_RERANK_CANDIDATES = rag_rerank.DEFAULT_RERANK_CANDIDATES
DEFAULT_TOP_K = rag_rerank.DEFAULT_TOP_K
DEFAULT_NEIGHBORS = rag_rerank.DEFAULT_NEIGHBORS
DEFAULT_RERANK_MIN_RATIO = rag_rerank.DEFAULT_RERANK_MIN_RATIO

# Quality / fusion knobs. Off by default; users enable per-need after
# validating against their own corpus.
DEFAULT_HYBRID_ENABLED = False
DEFAULT_HYBRID_BM25_CANDIDATES = 30
DEFAULT_CHUNK_MAX_CHARS = chunker.DEFAULT_MAX_CHUNK_CHARS
DEFAULT_CHUNK_SOFT_SPLIT_CHARS = chunker.DEFAULT_SOFT_SPLIT_CHARS
DEFAULT_CHUNK_OVERLAP_MSGS = chunker.DEFAULT_OVERLAP_MSGS


@dataclass(slots=True, frozen=True)
class RagSettings:
    embed_model: str
    rerank_model: str
    rerank_candidates: int
    top_k: int
    neighbors: int
    rerank_min_ratio: float
    hybrid_enabled: bool
    hybrid_bm25_candidates: int
    chunk_max_chars: int
    chunk_soft_split_chars: int
    chunk_overlap_msgs: int


def _coerce_int(raw: str | None, default: int, *, lo: int, hi: int) -> int:
    if not raw:
        return default
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def _coerce_float(raw: str | None, default: float, *, lo: float, hi: float) -> float:
    if raw is None or raw == "":
        return default
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def _coerce_bool(raw: str | None, default: bool) -> bool:
    # Stored as "1" / "0" strings (settings table is TEXT-only).
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def load_settings(conn: sqlite3.Connection | None = None) -> RagSettings:
    own_conn = False
    if conn is None:
        conn = settings_store.connect()
        own_conn = True
    try:
        # Installs that predate the local backend still hold an
        # inference-server model id here — "text-embedding-bge-m3",
        # "bge-m3". fastembed cannot load those, and inheriting one
        # would fail at ingest time with a puzzling message. Every
        # fastembed id is "org/name", so anything without a slash is a
        # leftover and gets ignored in favour of the default.
        stored = settings_store.get(conn, settings_store.KEY_RAG_EMBED_MODEL)
        if stored and "/" not in stored:
            stored = None
        model = stored or DEFAULT_EMBED_MODEL

        rerank_model = (
            settings_store.get(conn, settings_store.KEY_RAG_RERANK_MODEL)
            or DEFAULT_RERANK_MODEL
        )
        rerank_candidates = _coerce_int(
            settings_store.get(conn, settings_store.KEY_RAG_RERANK_CANDIDATES),
            DEFAULT_RERANK_CANDIDATES,
            lo=1,
            hi=200,
        )
        top_k = _coerce_int(
            settings_store.get(conn, settings_store.KEY_RAG_TOP_K),
            DEFAULT_TOP_K,
            lo=1,
            hi=50,
        )
        neighbors = _coerce_int(
            settings_store.get(conn, settings_store.KEY_RAG_NEIGHBORS),
            DEFAULT_NEIGHBORS,
            lo=0,
            hi=5,
        )
        rerank_min_ratio = _coerce_float(
            settings_store.get(conn, settings_store.KEY_RAG_RERANK_MIN_RATIO),
            DEFAULT_RERANK_MIN_RATIO,
            lo=0.0,
            hi=1.0,
        )
        hybrid_enabled = _coerce_bool(
            settings_store.get(conn, settings_store.KEY_RAG_HYBRID_ENABLED),
            DEFAULT_HYBRID_ENABLED,
        )
        hybrid_bm25_candidates = _coerce_int(
            settings_store.get(conn, settings_store.KEY_RAG_HYBRID_BM25_CANDIDATES),
            DEFAULT_HYBRID_BM25_CANDIDATES,
            lo=1,
            hi=200,
        )
        chunk_max = _coerce_int(
            settings_store.get(conn, settings_store.KEY_RAG_CHUNK_MAX_CHARS),
            DEFAULT_CHUNK_MAX_CHARS,
            lo=200,
            hi=20000,
        )
        chunk_soft = _coerce_int(
            settings_store.get(conn, settings_store.KEY_RAG_CHUNK_SOFT_SPLIT_CHARS),
            DEFAULT_CHUNK_SOFT_SPLIT_CHARS,
            lo=400,
            # soft_split must stay below max — clamp at max-100 so the
            # split logic always has room to land before the hard cap.
            hi=max(500, chunk_max - 100),
        )
        chunk_overlap = _coerce_int(
            settings_store.get(conn, settings_store.KEY_RAG_CHUNK_OVERLAP_MSGS),
            DEFAULT_CHUNK_OVERLAP_MSGS,
            lo=0,
            hi=5,
        )
        # The embedding model truncates past its token window without
        # complaining: two texts sharing a long head embed to the same
        # vector, the tail simply gone. Chunking follows the model so the
        # user never has to know the number — the alternative is a
        # setting whose wrong value costs recall with no symptom.
        cap = rag_embed_local.profile_for(model).max_chars
        chunk_max = min(chunk_max, cap)
        chunk_soft = min(chunk_soft, max(200, chunk_max - 50))

        return RagSettings(
            embed_model=model,
            rerank_model=rerank_model,
            rerank_candidates=rerank_candidates,
            top_k=top_k,
            neighbors=neighbors,
            rerank_min_ratio=rerank_min_ratio,
            hybrid_enabled=hybrid_enabled,
            hybrid_bm25_candidates=hybrid_bm25_candidates,
            chunk_max_chars=chunk_max,
            chunk_soft_split_chars=chunk_soft,
            chunk_overlap_msgs=chunk_overlap,
        )
    finally:
        if own_conn:
            conn.close()
