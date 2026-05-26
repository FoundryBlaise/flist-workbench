"""RAG settings (embedding endpoint, model, prefixes).

Storage and loader mirror labels.load_settings. Empty strings stored in
the settings table fall back to the defaults defined here, which is how
"Reset to default" is implemented from the UI.

The embedding endpoint defaults to the labels LLM endpoint because the
typical setup is one LM Studio (or one OpenAI account) hosting both a
chat model and an embedding model side by side; settings.py keeps them
as separate keys so a user with split infra can override either.

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
import rag_rerank
import settings as settings_store

DEFAULT_EMBED_ENDPOINT = labels_store.DEFAULT_LLM_ENDPOINT
# bge-m3 is multilingual out of the box, doesn't need the nomic
# search_query/search_document prefixes (defaults below stay empty),
# and recovers significantly better recall on German + mixed-language
# corpora than nomic-embed-text. Slightly larger model (~568 MB vs
# ~137 MB), still comfortable for any modern desktop. "text-embedding-
# bge-m3" is the model id LM Studio exposes for BAAI/bge-m3 — other
# inference servers may need a different name; user can override in
# Settings → RAG.
DEFAULT_EMBED_MODEL = "text-embedding-bge-m3"
DEFAULT_EMBED_API_KEY = ""
DEFAULT_EMBED_QUERY_PREFIX = ""
DEFAULT_EMBED_DOCUMENT_PREFIX = ""

# Chat side defaults shadow the labels LLM settings — the typical user
# runs one inference server hosting one chat model + one embedding
# model. Splitting the keys lets a power user point chat at a bigger
# remote model while keeping classification local.
DEFAULT_CHAT_ENDPOINT = labels_store.DEFAULT_LLM_ENDPOINT
DEFAULT_CHAT_MODEL = labels_store.DEFAULT_LLM_MODEL
DEFAULT_CHAT_API_KEY = ""
# Default English; users can override per-language in Settings. We
# import the prompt body lazily in load_settings to avoid a hard
# import cycle (rag_query imports rag).
DEFAULT_CHAT_SYSTEM_PROMPT = ""  # empty → load_settings substitutes rag_query.DEFAULT_SYSTEM_PROMPT

DEFAULT_RERANK_MODEL = rag_rerank.DEFAULT_RERANK_MODEL
DEFAULT_RERANK_CANDIDATES = rag_rerank.DEFAULT_RERANK_CANDIDATES
DEFAULT_TOP_K = rag_rerank.DEFAULT_TOP_K
DEFAULT_NEIGHBORS = rag_rerank.DEFAULT_NEIGHBORS
DEFAULT_RERANK_MIN_RATIO = rag_rerank.DEFAULT_RERANK_MIN_RATIO

# Quality / fusion knobs. Off by default; users enable per-need after
# validating against their own corpus.
DEFAULT_HYBRID_ENABLED = False
DEFAULT_HYBRID_BM25_CANDIDATES = 30
DEFAULT_MULTIQUERY_ENABLED = False
DEFAULT_MULTIQUERY_VARIANTS = 3
# Default 8192: Ollama's own per-request default is only 2048, which
# silently truncates retrieved context on most chat queries — RAG hits
# easily exceed 2k tokens once neighbour expansion is on. 8192 fits
# comfortably in any modern local model and prevents that footgun. Set
# to 0 to suppress the field entirely (LM Studio ignores it either way).
DEFAULT_CHAT_NUM_CTX = 8192
# Default "30s": tell Ollama to keep bge-m3 (or whichever embed model)
# resident only briefly after embedding a chat question. Without this,
# a single chat query loads the embed model and pins it for ~5 minutes
# of VRAM, which thrashes against the chat model on tight cards. Empty
# string disables the override and lets Ollama use its own default;
# LM Studio and other servers ignore unknown fields either way.
DEFAULT_CHAT_EMBED_KEEP_ALIVE = "30s"

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
    chat_endpoint: str
    chat_model: str
    chat_api_key: str
    chat_system_prompt: str
    rerank_model: str
    rerank_candidates: int
    top_k: int
    neighbors: int
    rerank_min_ratio: float
    hybrid_enabled: bool
    hybrid_bm25_candidates: int
    multiquery_enabled: bool
    multiquery_variants: int
    chat_num_ctx: int
    chat_embed_keep_alive: str
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
        endpoint = (
            settings_store.get(conn, settings_store.KEY_RAG_EMBED_ENDPOINT)
            or DEFAULT_EMBED_ENDPOINT
        )
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

        chat_endpoint = (
            settings_store.get(conn, settings_store.KEY_RAG_CHAT_ENDPOINT)
            or DEFAULT_CHAT_ENDPOINT
        )
        chat_model = (
            settings_store.get(conn, settings_store.KEY_RAG_CHAT_MODEL)
            or DEFAULT_CHAT_MODEL
        )
        chat_api_key = (
            settings_store.get(conn, settings_store.KEY_RAG_CHAT_API_KEY)
            or DEFAULT_CHAT_API_KEY
        )
        # The default system prompt body lives in rag_query (one place,
        # alongside the build_context format it expects). Importing
        # here would be a cycle; do it lazily inside the function.
        chat_prompt = settings_store.get(conn, settings_store.KEY_RAG_CHAT_SYSTEM_PROMPT)
        if not chat_prompt:
            from rag_query import DEFAULT_SYSTEM_PROMPT  # noqa: PLC0415 — lazy to break cycle

            chat_prompt = DEFAULT_SYSTEM_PROMPT

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
        multiquery_enabled = _coerce_bool(
            settings_store.get(conn, settings_store.KEY_RAG_MULTIQUERY_ENABLED),
            DEFAULT_MULTIQUERY_ENABLED,
        )
        multiquery_variants = _coerce_int(
            settings_store.get(conn, settings_store.KEY_RAG_MULTIQUERY_VARIANTS),
            DEFAULT_MULTIQUERY_VARIANTS,
            lo=2,
            hi=5,
        )
        chat_num_ctx = _coerce_int(
            settings_store.get(conn, settings_store.KEY_RAG_CHAT_NUM_CTX),
            DEFAULT_CHAT_NUM_CTX,
            lo=0,
            # 131072 is a reasonable upper bound — covers Llama 3.1 128k
            # and any local model the user could plausibly load. Anything
            # larger is almost certainly a typo.
            hi=131072,
        )
        # Treat a stored None as "use the default", but a stored empty
        # string as "user explicitly cleared it — suppress the field".
        keep_alive_raw = settings_store.get(
            conn, settings_store.KEY_RAG_CHAT_EMBED_KEEP_ALIVE
        )
        chat_embed_keep_alive = (
            DEFAULT_CHAT_EMBED_KEEP_ALIVE if keep_alive_raw is None else keep_alive_raw
        )
        chunk_max = _coerce_int(
            settings_store.get(conn, settings_store.KEY_RAG_CHUNK_MAX_CHARS),
            DEFAULT_CHUNK_MAX_CHARS,
            lo=500,
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
        return RagSettings(
            embed_endpoint=endpoint,
            embed_model=model,
            embed_api_key=api_key,
            embed_query_prefix=q_prefix,
            embed_document_prefix=d_prefix,
            chat_endpoint=chat_endpoint,
            chat_model=chat_model,
            chat_api_key=chat_api_key,
            chat_system_prompt=chat_prompt,
            rerank_model=rerank_model,
            rerank_candidates=rerank_candidates,
            top_k=top_k,
            neighbors=neighbors,
            rerank_min_ratio=rerank_min_ratio,
            hybrid_enabled=hybrid_enabled,
            hybrid_bm25_candidates=hybrid_bm25_candidates,
            multiquery_enabled=multiquery_enabled,
            multiquery_variants=multiquery_variants,
            chat_num_ctx=chat_num_ctx,
            chat_embed_keep_alive=chat_embed_keep_alive,
            chunk_max_chars=chunk_max,
            chunk_soft_split_chars=chunk_soft,
            chunk_overlap_msgs=chunk_overlap,
        )
    finally:
        if own_conn:
            conn.close()
