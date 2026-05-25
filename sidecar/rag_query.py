"""Query-time retrieval pipeline — port of Chat_RAG/query.py.

Pipeline:

  query string
    -> embed via rag_embed (LM Studio)
    -> top-N from Qdrant via rag_store (filtered by scope)
    -> rerank via rag_rerank (cross-encoder, optional)
    -> ±M neighbor expansion via prev_chunk_id / next_chunk_id
    -> build context blocks
    -> return {hits, llm_messages}

The function is pure-Python and synchronous — the SSE endpoint in
server.py wraps it. Splitting query-pipeline from streaming-output
keeps the pipeline testable without a real LLM in the loop.

Scope shape matches rag_store._scope_to_filter:
    None                                  — all chunks (cross-RP)
    {character: X}                        — every chunk for character X
    {character: X, partner: Y}            — one conversation
    {character: X, partners: [Y, Z]}      — multiple partners merged
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import rag as rag_settings
import rag_embed
import rag_rerank
import rag_store


@dataclass(slots=True)
class QueryResult:
    """Bundles the retrieval output for the SSE endpoint.

    `hits` are the post-expansion ordered chunks (the same list that
    fed the LLM context). The endpoint serialises a slim subset of
    each as a citation in the final `done` event.

    `messages` is the OpenAI-compatible {role, content} list ready to
    pass to /v1/chat/completions. The system prompt is included so the
    streaming client doesn't have to reconstruct it.
    """

    hits: list[dict]
    messages: list[dict]
    embed_model: str
    rerank_model: str | None
    rerank_applied: bool


def build_context(hits: list[dict]) -> str:
    """Concatenate hit payloads into source blocks for the LLM context.

    Mirrors Chat_RAG/query.py.build_context — each block carries date,
    partner, speakers and chunk_id so the model can cite back to a
    specific source the renderer knows how to deep-link to.
    """
    blocks: list[str] = []
    for i, hit in enumerate(hits, 1):
        p = hit.get("payload") or {}
        speakers = ", ".join(p.get("speakers", []) or [])
        tag = " (expanded context)" if p.get("expanded") else ""
        block = (
            f"=== Source {i}{tag} | date: {p.get('date')} | "
            f"partner: {p.get('partner')} | speakers: {speakers} | "
            f"id: {p.get('chunk_id')} ===\n"
            f"{p.get('text', '')}"
        )
        blocks.append(block)
    return "\n\n".join(blocks)


def expand_with_neighbors(
    store: rag_store.RagStore, hits: list[dict], *, hops: int
) -> list[dict]:
    """Pull `hops` chunks before and after each hit via prev/next pointers.

    Returns hits + expanded chunks, ordered chronologically per
    conversation. Expanded chunks have `expanded=True` set in their
    payload for downstream awareness.

    `hops=0` skips expansion (the chat panel exposes /neighbors 0 for
    users who want raw retrieval to debug recall).
    """
    if hops <= 0 or not hits:
        return hits
    have: dict[str, dict] = {}
    for h in hits:
        cid = (h.get("payload") or {}).get("chunk_id")
        if cid:
            have[cid] = h
    frontier = set(have)
    for _ in range(hops):
        needed: set[str] = set()
        for cid in frontier:
            payload = (have[cid].get("payload") or {})
            for nb_field in ("prev_chunk_id", "next_chunk_id"):
                nb = payload.get(nb_field)
                if nb and nb not in have:
                    needed.add(nb)
        if not needed:
            break
        fetched = store.fetch_by_chunk_ids(needed)
        for cid, point in fetched.items():
            point["payload"]["expanded"] = True
            # Score absent on neighbor hits — surface as 0 so callers
            # don't crash on KeyError when sorting / rendering.
            point.setdefault("score", 0.0)
            have[cid] = point
        frontier = set(fetched)
    return sorted(
        have.values(),
        key=lambda h: (
            (h.get("payload") or {}).get("char_owner", ""),
            (h.get("payload") or {}).get("partner", ""),
            (h.get("payload") or {}).get("ts_start", 0),
            (h.get("payload") or {}).get("subchunk", 0),
        ),
    )


DEFAULT_SYSTEM_PROMPT = (
    "You are an assistant answering questions about the user's saved "
    "roleplay logs. You receive context chunks retrieved from those logs; "
    "each chunk has a date, partner character, speakers, and chunk id.\n\n"
    "Rules:\n"
    "- Answer based on the provided context only.\n"
    "- If the answer is not in the context, say so directly "
    '("I can\'t find that in the logs.").\n'
    "- Quote with the date when relevant "
    '(e.g. "On 2025-03-15, Olivia said: ...").\n'
    "- Stay concrete and close to the source — do not invent details.\n"
    "- Respond in the language of the question."
)


def run_query(
    question: str,
    *,
    scope: dict | None,
    store: rag_store.RagStore,
    rag_set: rag_settings.RagSettings,
    rerank_model: str | None,
    rerank_candidates: int = rag_rerank.DEFAULT_RERANK_CANDIDATES,
    top_k: int = rag_rerank.DEFAULT_TOP_K,
    neighbors: int = rag_rerank.DEFAULT_NEIGHBORS,
    system_prompt: str = DEFAULT_SYSTEM_PROMPT,
    cache_dir: Path | None = None,
) -> QueryResult:
    """Execute one retrieval round and return the data needed to stream
    an LLM answer. Does not call the LLM — the caller streams it.
    """
    qvec = rag_embed.embed_texts([question], "query", rag_set)[0]
    # When reranking we retrieve a larger candidate pool and trim down.
    # When disabled we just retrieve top_k directly to save Qdrant work.
    rerank_disabled = rag_rerank.is_disabled(rerank_model)
    retrieve_n = top_k if rerank_disabled else max(rerank_candidates, top_k)
    hits = store.search(qvec, scope=scope, limit=retrieve_n)
    rerank_applied = False
    if not rerank_disabled and len(hits) > top_k:
        hits = rag_rerank.rerank_hits(
            hits, question, model_name=rerank_model, top_k=top_k, cache_dir=cache_dir
        )
        rerank_applied = True
    else:
        hits = hits[:top_k]
    hits = expand_with_neighbors(store, hits, hops=neighbors)

    if hits:
        context = build_context(hits)
        user_msg = f"CONTEXT:\n{context}\n\nQUESTION: {question}"
    else:
        # No hits — still call the LLM so the renderer gets a
        # streamed "I can't find anything" reply rather than a silent
        # empty response.
        user_msg = (
            f"QUESTION: {question}\n\n"
            "(no relevant context was retrieved from the logs)"
        )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_msg},
    ]
    return QueryResult(
        hits=hits,
        messages=messages,
        embed_model=rag_set.embed_model,
        rerank_model=None if rerank_disabled else rerank_model,
        rerank_applied=rerank_applied,
    )


def citation_payload(hits: list[dict]) -> list[dict]:
    """Slim hit list shape sent to the renderer in the final SSE event.

    The chat panel uses these to render clickable citations that jump
    the log viewer to a specific message range. Strip fields the UI
    doesn't need (full text, payload internals) to keep the event
    small — even 5 expanded hits with full text would be tens of KB.
    """
    out: list[dict] = []
    for h in hits:
        p = h.get("payload") or {}
        out.append(
            {
                "chunk_id": p.get("chunk_id"),
                "char_owner": p.get("char_owner"),
                "partner": p.get("partner"),
                "date": p.get("date"),
                "label": p.get("label"),
                "ts_start": p.get("ts_start"),
                "ts_end": p.get("ts_end"),
                "speakers": p.get("speakers") or [],
                "score": float(h.get("score", 0.0)),
                "rerank_score": h.get("rerank_score"),
                "expanded": bool(p.get("expanded")),
            }
        )
    return out
