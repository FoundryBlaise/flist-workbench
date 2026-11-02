"""Semantic search over the log index, and the index's own state (§3.10).

`search_logs_semantic` is the tool that makes "what did I tell her
about my sister" answerable. It returns chunks of the user's own logs;
the connected model reads them and answers. No language model runs in
Workbench — see the module docstring in `services/retrieval.py`.
"""

from __future__ import annotations

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
def get_rag_status() -> dict[str, Any]:
    """What the local search index currently holds.

    An index is built per embedding model; switching models means the
    old chunks can't be searched with the new one, which is why
    `embed_model` is reported alongside the count. While an ingest
    runs, `busy` is true, `job` is that ingest and `chunk_count` is
    null: the Index can't be counted until it finishes.
    """
    from services import index as index_service

    out = index_service.status()
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
