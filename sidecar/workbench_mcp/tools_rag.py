"""Semantic search over the log index, and the index's own state (§3.10).

`search_logs_semantic` is the tool that makes "what did I tell her
about my sister" answerable. It returns chunks of the user's own logs;
the connected model reads them and answers. No language model runs in
Workbench — see the module docstring in `services/retrieval.py`.
"""

from __future__ import annotations

import time
from typing import Any

from ._context import ToolError, resolve_conversation, resolve_log_character
from ._registry import TAG_CORE, TAG_LOGS, tool


@tool(tags=TAG_LOGS, title="Search logs by meaning", read_only=True)
def search_logs_semantic(
    question: str,
    character: str | None = None,
    partner: str | None = None,
    top_k: int | None = None,
    neighbors: int | None = None,
    hybrid: bool | None = None,
) -> dict[str, Any]:
    """Find passages in the user's roleplay logs that are *about*
    something, rather than containing a particular word.

    Returns whole chunks with their text, date and speakers — read them
    and answer from what they say. Scope it with `character` and
    `partner` when the question is about one relationship; leave both
    out to search everything.

    Only messages with an IC/OOC verdict are in the index. If results
    look thin, check get_label_stats: unjudged messages are skipped at
    ingest time.
    """
    if not (question or "").strip():
        raise ToolError("validation_failed", "question is empty")

    import rag_embed
    from services import retrieval

    scope: dict[str, Any] | None = None
    if character:
        # Resolve to the on-disk spelling: the chunk payloads the index
        # was written with carry that one, so a differently-cased scope
        # would filter every hit away without saying why.
        if partner:
            conv = resolve_conversation(character, partner)
            scope = {"character": conv.character, "partner": conv.partner}
        else:
            scope = {"character": resolve_log_character(character)}
    elif partner:
        raise ToolError(
            "validation_failed",
            "partner needs a character too — log scoping is per (your "
            "character, their character) pair",
        )

    try:
        result = retrieval.search(
            question,
            scope=scope,
            top_k=top_k,
            neighbors=neighbors,
            hybrid=hybrid,
        )
    except retrieval.NoIndexError as exc:
        raise ToolError("no_index", str(exc)) from exc
    except rag_embed.EmbedError as exc:
        raise ToolError(
            "embedding_failed",
            f"The embedding model could not be used: {exc}. It runs "
            "inside Workbench and downloads itself on first use, so "
            "this is usually a download problem rather than a setting.",
        ) from exc

    payload = result.to_dict()
    payload["question"] = question
    if not payload["hits"]:
        payload["note"] = (
            "Nothing matched. Either this hasn't been ingested yet "
            "(get_rag_status shows what is indexed) or the wording is "
            "too far from how it was written."
        )
    return payload


@tool(tags=(TAG_CORE, TAG_LOGS), title="Index status", read_only=True)
def get_rag_status(check_embedding: bool = False) -> dict[str, Any]:
    """What the local search index currently holds, and the embedding
    model's state.

    An index is built per embedding model; switching models means the
    old chunks can't be searched with the new one, which is why
    `embed_model` is reported alongside the count. While an ingest
    runs, `busy` is true, `job` is that ingest and `chunk_count` is
    null: the Index can't be counted until it finishes.

    `embedding` names the configured model. With `check_embedding=true`
    the model is loaded and its `state` is `ready` (with `dimension`) or
    `failed` (with `error`: a code and a message). The first load
    downloads the model, so it can take a moment.
    """
    from services import index as index_service

    out = index_service.status()
    out["embedding"] = _embedding_state(check_embedding)
    if out["busy"]:
        out["note"] = (
            "A job is changing the Index right now (see `job`), so it "
            "can't be counted or searched. Poll get_job, or ask again "
            "when it has finished."
        )
    elif not out["chunk_count"]:
        out["note"] = "Nothing indexed yet — run ingest_logs."
    else:
        out["note"] = "Only messages with an IC/OOC verdict are indexed."
    return out


def _embedding_state(check: bool) -> dict[str, Any]:
    """The configured embedding model, loaded only when asked: embedding
    runs inside the app and the first load is a download, which a plain
    status read must not start."""
    import rag as rag_settings
    import rag_embed

    settings = rag_settings.load_settings()
    if not check:
        return {"model": settings.embed_model, "state": "not_checked"}
    started = time.monotonic()
    try:
        dimension, _vec = rag_embed.probe(settings, timeout=60.0)
    except rag_embed.EmbedError as exc:
        # A model that will not load is a state of the Index, not a
        # failure of this call: the rest of the status is still true.
        return {
            "model": settings.embed_model,
            "state": "failed",
            "error": {"code": "embedding_failed", "message": str(exc)},
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        }
    return {
        "model": settings.embed_model,
        "state": "ready",
        "dimension": dimension,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }
