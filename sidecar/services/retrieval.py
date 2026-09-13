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
import rag_embed
import rag_lexical
import rag_query
import rag_store


class NoIndexError(RuntimeError):
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
    score: float
    message_count: int
    ts_start: int
    ts_end: int
    expanded: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "chunk_id": self.chunk_id,
            "character": self.character,
            "partner": self.partner,
            "date": self.date,
            "label": self.label,
            "speakers": self.speakers,
            "text": self.text,
            "score": round(self.score, 4),
            "message_count": self.message_count,
            "ts_start": self.ts_start,
            "ts_end": self.ts_end,
            # True when the chunk was pulled in as a neighbour of a
            # match rather than matching itself — useful context, but
            # not evidence the search found it.
            "expanded": self.expanded,
        }


@dataclass(frozen=True)
class SearchResult:
    hits: list[SearchHit]
    embed_model: str
    rerank_model: str | None
    rerank_applied: bool
    hybrid_applied: bool
    scope: dict[str, Any] | None

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
) -> SearchResult:
    """Retrieve the log chunks most relevant to `question`.

    `top_k`, `neighbors` and `hybrid` override the saved settings for
    this one call; None means "use what is configured". Raises
    `NoIndexError` when nothing has been ingested, and
    `rag_embed.EmbedError` when the embedding endpoint is unreachable.
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
            # Backfill safety net: someone who enables hybrid after an
            # existing ingest has an empty FTS5 table while Qdrant holds
            # thousands of chunks. Rebuilding from payloads takes
            # seconds and avoids the "I turned it on and got no hits"
            # surprise.
            try:
                if lex.count() == 0 and store.count() > 0:
                    rag_lexical.backfill_from_qdrant(store, lex)
            except Exception:  # noqa: BLE001 — backfill is best-effort
                pass
        try:
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
    )


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
        score=float(raw.get("score") or 0.0),
        message_count=int(payload.get("msg_count") or 0),
        ts_start=int(payload.get("ts_start") or 0),
        ts_end=int(payload.get("ts_end") or 0),
        # `expand_with_neighbors` marks the chunks it pulled in on
        # the payload, not the hit envelope.
        expanded=bool(payload.get("expanded")),
    )
