"""One place that runs a semantic search over the log index.

Lifted out of the deleted `/rag/query` SSE handler, which was the only
caller that knew how to assemble a search: expand a partner scope into
its alias group, open the lexical store when hybrid retrieval is on,
backfill it if it is empty, run the pipeline, close everything. The MCP
`search_logs_semantic` tool needs exactly that, so it lives here rather
than in a route.

No language model is involved — the caller hands the chunks to whatever
model the user connected.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import aliases as aliases_store
import rag as rag_settings
import rag_lexical
import rag_query
import rag_store
from refusals import KeywordBackfillFailed, NoIndex
from services import index as index_service


class NoIndexError(NoIndex, RuntimeError):
    """The vector index has not been built yet."""


@dataclass(frozen=True)
class SearchHit:
    chunk_id: str
    character: str
    partner: str
    date: str
    label: str
    speakers: list[str]
    text: str
    #: The fused (RRF) score: what the order before reranking rests on.
    score: float
    message_count: int
    ts_start: int
    ts_end: int
    #: 1-based place after fusing the dense and keyword halves.
    fused_rank: int
    #: 1-based place in each half; None when that half did not find it
    #: (always None for `lexical_rank` when hybrid search is off).
    dense_rank: int | None
    lexical_rank: int | None
    #: The cross-encoder's score; None when reranking did not run.
    rerank_score: float | None
    #: The chunks right before and after this one in its Log, in time
    #: order: context for reading the hit, not matches themselves.
    context: dict[str, list[dict[str, Any]]]

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "chunk_id": self.chunk_id,
            "character": self.character,
            "partner": self.partner,
            "date": self.date,
            "label": self.label,
            "speakers": self.speakers,
            "text": self.text,
            "score": round(self.score, 4),
            "fused_rank": self.fused_rank,
            "dense_rank": self.dense_rank,
            "lexical_rank": self.lexical_rank,
            "message_count": self.message_count,
            "ts_start": self.ts_start,
            "ts_end": self.ts_end,
            "context": self.context,
        }
        # Present exactly when reranking ran, so its absence is the
        # answer rather than a null to interpret.
        if self.rerank_score is not None:
            out["rerank_score"] = round(self.rerank_score, 4)
        return out


@dataclass(frozen=True)
class SearchResult:
    hits: list[SearchHit]
    embed_model: str
    rerank_model: str | None
    rerank_applied: bool
    hybrid_applied: bool
    scope: dict[str, Any] | None
    #: More matches rank below the last one returned.
    has_more: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "hits": [h.to_dict() for h in self.hits],
            "retrieval": {
                "embed_model": self.embed_model,
                "rerank_model": self.rerank_model,
                "rerank_applied": self.rerank_applied,
                "hybrid_applied": self.hybrid_applied,
                "scope": self.scope,
            },
        }


def expand_scope(scope: dict[str, Any] | None) -> dict[str, Any] | None:
    """Widen a single-partner scope to that partner's alias group.

    A conversation that continued after a rename is indexed under both
    names, so a search scoped to "Asmira" must also reach chunks
    stored under the pre-rename "Daelan Envale". Character-only and
    cross-character scopes don't filter by partner, so they pass
    through untouched.
    """
    if not scope:
        return scope
    if not (scope.get("character") and scope.get("partner")):
        return scope
    if scope.get("partners"):
        return scope
    conn = aliases_store.connect()
    try:
        group = aliases_store.all_names_for(
            conn, scope["character"], scope["partner"]
        )
    finally:
        conn.close()
    if len(group) <= 1:
        return scope
    # Swap the single-partner filter for a multi-partner one;
    # rag_store._scope_to_filter understands both shapes.
    return {"character": scope["character"], "partners": group}


def search(
    question: str,
    *,
    scope: dict[str, Any] | None = None,
    top_k: int | None = None,
    neighbors: int | None = None,
    hybrid: bool | None = None,
    offset: int = 0,
) -> SearchResult:
    """Retrieve the log chunks most relevant to `question`.

    `top_k`, `neighbors` and `hybrid` override the saved settings for
    this one call; None means "use what is configured". `offset` skips
    that many of the best matches, for the next page. Raises
    `NoIndexError` when nothing has been ingested, `IndexBusy` while an
    ingest holds the Index, `rag_embed.EmbedError` when the
    embedding endpoint is unreachable, and `KeywordBackfillFailed` when
    a hybrid search cannot fill an empty keyword half of the Index.
    """
    rag_set = rag_settings.load_settings()
    resolved_scope = expand_scope(scope)

    # Clamp overrides the same way the settings loader does — a caller
    # shouldn't be able to ask for what saved settings cannot hold.
    effective_top_k = max(1, min(50, int(top_k if top_k is not None else rag_set.top_k)))
    effective_neighbors = max(
        0, min(5, int(neighbors if neighbors is not None else rag_set.neighbors))
    )
    use_hybrid = rag_set.hybrid_enabled if hybrid is None else bool(hybrid)

    # The vector store opens once at a time; an ingest keeps it open.
    index_service.ensure_idle()
    with rag_store.RagStore() as store:
        if not store.collection_exists():
            raise NoIndexError(
                "Nothing is indexed yet. Run ingest_logs first — and note "
                "that only messages labelled IC or OOC are indexed, so "
                "the classification flow may need to run before that."
            )

        # Open the lexical store only when hybrid is on; skipping the
        # connect avoids a labels.db handle on the common dense path.
        lex: rag_lexical.LexicalStore | None = None
        if use_hybrid:
            lex = rag_lexical.LexicalStore()
        try:
            if lex is not None:
                _backfill_if_empty(store, lex)
            result = rag_query.run_query(
                question,
                scope=resolved_scope,
                store=store,
                rag_set=rag_set,
                rerank_model=rag_set.rerank_model,
                rerank_candidates=rag_set.rerank_candidates,
                top_k=effective_top_k,
                neighbors=effective_neighbors,
                rerank_min_ratio=rag_set.rerank_min_ratio,
                lex=lex,
                hybrid_bm25_candidates=rag_set.hybrid_bm25_candidates,
                offset=offset,
            )
        finally:
            if lex is not None:
                lex.close()

        hits = [_to_hit(h) for h in result.hits]

    return SearchResult(
        hits=hits,
        embed_model=result.embed_model,
        rerank_model=result.rerank_model,
        rerank_applied=result.rerank_applied,
        hybrid_applied=result.hybrid_applied,
        scope=resolved_scope,
        has_more=result.has_more,
    )


def _backfill_if_empty(store: rag_store.RagStore, lex: rag_lexical.LexicalStore) -> None:
    """Fill an empty keyword half of the Index from the vector half.

    Someone who turns hybrid search on after an earlier ingest has an
    empty keyword half while the vector half holds thousands of chunks;
    copying the payloads takes seconds and avoids "I turned it on and
    got no hits". A copy that fails is reported, so a hybrid search
    never quietly answers from one half: a keyword write the database
    refuses, and a vector half that cannot be read (the embedded Qdrant
    raises no one error type for that)."""
    try:
        if lex.count() > 0 or store.count() == 0:
            return
        rag_lexical.backfill_from_qdrant(store, lex)
    except Exception as exc:  # noqa: BLE001 — reported, never swallowed
        raise KeywordBackfillFailed(
            "Hybrid search needs the keyword half of the Index, which is "
            f"empty and could not be filled from the vector half: {exc}. "
            "Search with hybrid off, or rebuild the lexical index in "
            "Settings once the cause is fixed."
        ) from exc


def _to_hit(raw: dict[str, Any]) -> SearchHit:
    payload = raw.get("payload") or {}
    return SearchHit(
        chunk_id=str(payload.get("chunk_id") or ""),
        character=str(payload.get("char_owner") or ""),
        partner=str(payload.get("partner") or ""),
        date=str(payload.get("date") or ""),
        label=str(payload.get("label") or ""),
        speakers=list(payload.get("speakers") or []),
        text=str(payload.get("text") or ""),
        score=float(raw.get("fused_score") or 0.0),
        message_count=int(payload.get("msg_count") or 0),
        ts_start=int(payload.get("ts_start") or 0),
        ts_end=int(payload.get("ts_end") or 0),
        fused_rank=int(raw.get("fused_rank") or 0),
        dense_rank=raw.get("dense_rank"),
        lexical_rank=raw.get("lexical_rank"),
        rerank_score=raw.get("rerank_score"),
        context={
            side: [_to_context(c) for c in chunks]
            for side, chunks in (raw.get("context") or {}).items()
        }
        or {"before": [], "after": []},
    )


def _to_context(raw: dict[str, Any]) -> dict[str, Any]:
    """A neighbouring chunk: what it says and when, without the hit's
    ranks (it was not ranked) or the conversation (the hit's own)."""
    payload = raw.get("payload") or {}
    return {
        "chunk_id": str(payload.get("chunk_id") or ""),
        "date": str(payload.get("date") or ""),
        "speakers": list(payload.get("speakers") or []),
        "text": str(payload.get("text") or ""),
        "message_count": int(payload.get("msg_count") or 0),
        "ts_start": int(payload.get("ts_start") or 0),
        "ts_end": int(payload.get("ts_end") or 0),
    }
