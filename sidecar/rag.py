"""RAG settings (embedding endpoint, model, prefixes).

Storage and loader mirror labels.load_settings. Empty strings stored in
the settings table fall back to the defaults defined here, which is how
"Reset to default" is implemented from the UI.

Embedding runs in-process by default (`rag_embed_local`, ONNX through
fastembed) so a fresh install needs no inference server at all — attach
an MCP client, ingest, ask. Setting `rag.embed_backend` to "endpoint"
switches back to an OpenAI-compatible server for anyone who would
rather spend a GPU on it. Either way no chat model and no classifier
runs here; that is the connected MCP client's job.

Prefixes are a quirk of the nomic-* family — those models require
"search_document: " on indexed text and "search_query: " on queries to
hit their advertised recall. Other embedding models ignore the prefix
(BGE, e5, Gemini, Voyage, etc.) so we default both to empty.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

import chunker
import labels as labels_store
import rag_embed_local
import rag_rerank
import settings as settings_store

# LM Studio's default port. It is the primary MCP client too, so a
# user following the Settings → MCP instructions already has it here.
DEFAULT_EMBED_ENDPOINT = "http://localhost:1234/v1"
# bge-m3 is multilingual out of the box, doesn't need the nomic
# search_query/search_document prefixes (defaults below stay empty),
# and recovers significantly better recall on German + mixed-language
# corpora than nomic-embed-text. Slightly larger model (~568 MB vs
# ~137 MB), still comfortable for any modern desktop. "text-embedding-
# bge-m3" is the model id LM Studio exposes for BAAI/bge-m3 — other
# inference servers may need a different name; user can override in
# Settings → RAG.
DEFAULT_EMBED_MODEL = "text-embedding-bge-m3"

# "local" runs the model inside the sidecar; "endpoint" posts to an
# OpenAI-compatible server. Local is the default because it is the only
# one that works with no setup, which is the whole point of driving the
# app over MCP.
BACKEND_LOCAL = "local"
BACKEND_ENDPOINT = "endpoint"
DEFAULT_EMBED_BACKEND = BACKEND_LOCAL
DEFAULT_LOCAL_EMBED_MODEL = rag_embed_local.DEFAULT_LOCAL_EMBED_MODEL
DEFAULT_EMBED_API_KEY = ""
DEFAULT_EMBED_QUERY_PREFIX = ""
DEFAULT_EMBED_DOCUMENT_PREFIX = ""

DEFAULT_RERANK_MODEL = rag_rerank.DEFAULT_RERANK_MODEL
DEFAULT_RERANK_CANDIDATES = rag_rerank.DEFAULT_RERANK_CANDIDATES
DEFAULT_TOP_K = rag_rerank.DEFAULT_TOP_K
DEFAULT_NEIGHBORS = rag_rerank.DEFAULT_NEIGHBORS
DEFAULT_RERANK_MIN_RATIO = rag_rerank.DEFAULT_RERANK_MIN_RATIO

# Quality / fusion knobs. Off by default; users enable per-need after
# validating against their own corpus.
DEFAULT_HYBRID_ENABLED = False
DEFAULT_HYBRID_BM25_CANDIDATES = 30
# Default "30s": tell Ollama to keep bge-m3 (or whichever embed model)
# resident only briefly after embedding a query. Without this, a single
# search loads the embed model and pins it for ~5 minutes of VRAM,
# which thrashes against whatever the user has loaded for their MCP
# client. Empty string disables the override and lets Ollama use its
# own default; LM Studio and other servers ignore unknown fields.
DEFAULT_EMBED_KEEP_ALIVE = "30s"

DEFAULT_CHUNK_MAX_CHARS = chunker.DEFAULT_MAX_CHUNK_CHARS
DEFAULT_CHUNK_SOFT_SPLIT_CHARS = chunker.DEFAULT_SOFT_SPLIT_CHARS
DEFAULT_CHUNK_OVERLAP_MSGS = chunker.DEFAULT_OVERLAP_MSGS


@dataclass(slots=True, frozen=True)
class RagSettings:
    embed_endpoint: str
    embed_model: str
    embed_api_key: str
    embed_query_prefix: str
    embed_document_prefix: str
    rerank_model: str
    rerank_candidates: int
    top_k: int
    neighbors: int
    rerank_min_ratio: float
    hybrid_enabled: bool
    hybrid_bm25_candidates: int
    embed_keep_alive: str
    chunk_max_chars: int
    chunk_soft_split_chars: int
    chunk_overlap_msgs: int
    # Last and defaulted so a hand-built RagSettings still describes the
    # endpoint backend, which is what every caller meant before the local
    # one existed. `load_settings` always passes it explicitly.
    embed_backend: str = BACKEND_ENDPOINT


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
        endpoint = (
            settings_store.get(conn, settings_store.KEY_RAG_EMBED_ENDPOINT)
            or DEFAULT_EMBED_ENDPOINT
        )
        backend = (
            settings_store.get(conn, settings_store.KEY_RAG_EMBED_BACKEND)
            or DEFAULT_EMBED_BACKEND
        ).strip().lower()
        if backend not in (BACKEND_LOCAL, BACKEND_ENDPOINT):
            backend = DEFAULT_EMBED_BACKEND
        # The two backends name models differently — "text-embedding-
        # bge-m3" is an LM Studio id, "jinaai/..." is a fastembed one —
        # so the fallback depends on which side we are on. A user who
        # set a model explicitly keeps it either way.
        if backend == BACKEND_LOCAL:
            model = (
                settings_store.get(conn, settings_store.KEY_RAG_LOCAL_EMBED_MODEL)
                or DEFAULT_LOCAL_EMBED_MODEL
            )
        else:
            model = (
                settings_store.get(conn, settings_store.KEY_RAG_EMBED_MODEL)
                or DEFAULT_EMBED_MODEL
            )
        api_key = (
            settings_store.get(conn, settings_store.KEY_RAG_EMBED_API_KEY)
            or DEFAULT_EMBED_API_KEY
        )
        # Prefixes are special: an explicit empty string is the default
        # AND a valid stored value. Either way we get "" here, so the
        # `or DEFAULT_*` short-circuit doesn't accidentally re-introduce
        # a nomic prefix the user just cleared.
        q_prefix = settings_store.get(conn, settings_store.KEY_RAG_EMBED_QUERY_PREFIX)
        if q_prefix is None:
            q_prefix = DEFAULT_EMBED_QUERY_PREFIX
        d_prefix = settings_store.get(conn, settings_store.KEY_RAG_EMBED_DOCUMENT_PREFIX)
        if d_prefix is None:
            d_prefix = DEFAULT_EMBED_DOCUMENT_PREFIX

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
        # Treat a stored None as "use the default", but a stored empty
        # string as "user explicitly cleared it — suppress the field".
        keep_alive_raw = settings_store.get(
            conn, settings_store.KEY_RAG_EMBED_KEEP_ALIVE
        )
        embed_keep_alive = (
            DEFAULT_EMBED_KEEP_ALIVE if keep_alive_raw is None else keep_alive_raw
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
        if backend == BACKEND_LOCAL:
            # Local models have short token windows and truncate without
            # complaining: two texts sharing a long head embed to the
            # same vector, the tail simply gone. Chunking is clamped to
            # what the chosen model can actually read so the user never
            # has to know the number — the alternative is a setting whose
            # wrong value costs recall with no symptom.
            cap = rag_embed_local.profile_for(model).max_chars
            chunk_max = min(chunk_max, cap)
            chunk_soft = min(chunk_soft, max(200, chunk_max - 50))

        return RagSettings(
            embed_backend=backend,
            embed_endpoint=endpoint,
            embed_model=model,
            embed_api_key=api_key,
            embed_query_prefix=q_prefix,
            embed_document_prefix=d_prefix,
            rerank_model=rerank_model,
            rerank_candidates=rerank_candidates,
            top_k=top_k,
            neighbors=neighbors,
            rerank_min_ratio=rerank_min_ratio,
            hybrid_enabled=hybrid_enabled,
            hybrid_bm25_candidates=hybrid_bm25_candidates,
            embed_keep_alive=embed_keep_alive,
            chunk_max_chars=chunk_max,
            chunk_soft_split_chars=chunk_soft,
            chunk_overlap_msgs=chunk_overlap,
        )
    finally:
        if own_conn:
            conn.close()
