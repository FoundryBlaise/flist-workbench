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

import labels as labels_store
import settings as settings_store

DEFAULT_EMBED_ENDPOINT = labels_store.DEFAULT_LLM_ENDPOINT
DEFAULT_EMBED_MODEL = "nomic-ai/nomic-embed-text-v1.5"
DEFAULT_EMBED_API_KEY = ""
DEFAULT_EMBED_QUERY_PREFIX = ""
DEFAULT_EMBED_DOCUMENT_PREFIX = ""


@dataclass(slots=True, frozen=True)
class RagSettings:
    embed_endpoint: str
    embed_model: str
    embed_api_key: str
    embed_query_prefix: str
    embed_document_prefix: str


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
        return RagSettings(
            embed_endpoint=endpoint,
            embed_model=model,
            embed_api_key=api_key,
            embed_query_prefix=q_prefix,
            embed_document_prefix=d_prefix,
        )
    finally:
        if own_conn:
            conn.close()
