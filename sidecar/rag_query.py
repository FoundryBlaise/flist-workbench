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

from dataclasses import dataclass, field
from pathlib import Path

import rag as rag_settings
import rag_embed
import rag_lexical
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
    # Empty when hybrid/multi-query are disabled; the SSE endpoint uses
    # these to optionally emit a "expanded" / "hybrid" status event so
    # the chat panel can show the user what happened.
    hybrid_applied: bool = False
    hybrid_lexical_hits: int = 0
    query_variants: list[str] = field(default_factory=list)


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
    "roleplay logs. You receive numbered source chunks retrieved from "
    "those logs; each chunk has a date, partner character, speakers, "
    "and chunk id.\n\n"
    "Rules — follow strictly:\n"
    # Language rule first. Local instruction-tuned models latch onto
    # whichever language appears earliest in the system prompt; a German
    # question got an English answer when this rule landed last.
    "- Respond in the language of the question.\n"
    "- Answer EXCLUSIVELY from the provided sources. Do not use general "
    "training knowledge or guess.\n"
    "- Cite the source id [Source N] after every factual claim.\n"
    "- If the answer is not in the sources, reply with exactly: "
    '"I can\'t find that in the logs." (or in German: '
    '"Diese Information ist nicht in den Logs enthalten.")\n'
    "- Never repeat a proper noun from the question (a name, place, "
    "object) as your answer unless that exact noun appears in a source. "
    "If the question names something not present in the sources, treat "
    "it as missing and say so.\n"
    "- Quote the date when relevant "
    '(e.g. "On 2025-03-15, Tauriel said: ...").\n'
    "- Stay concrete and close to the source — do not invent details."
)


RRF_K = 60
"""Reciprocal Rank Fusion constant. The standard value across published
implementations (Elastic, Vespa, the original Cormack et al. paper).
Larger K flattens the contribution of rank position; 60 is the sweet
spot that prefers top-of-list hits without ignoring tail."""


def _rrf_fuse(
    ranked_lists: list[list[str]], *, k: int = RRF_K
) -> list[tuple[str, float]]:
    """Reciprocal Rank Fusion.

    For each chunk_id, sum 1 / (k + rank) across the lists it appears
    in. Returns (chunk_id, score) sorted high-to-low. Parameter-free,
    no score normalisation needed — that's the whole point of RRF, the
    dense and BM25 score scales never have to be reconciled.
    """
    scores: dict[str, float] = {}
    for ranked in ranked_lists:
        for rank, cid in enumerate(ranked):
            if not cid:
                continue
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda x: -x[1])


def _hydrate_lexical_only(
    store: rag_store.RagStore, hits: dict[str, dict], cids: list[str]
) -> None:
    """Fill the `hits` map with Qdrant payloads for chunk_ids that came
    from lexical search but never appeared in the dense pool.

    Lexical-only hits enter the pipeline with just a chunk_id + bm25
    score; the chat context needs the full payload (text, speakers,
    dates, prev/next pointers). One batched retrieve handles all of
    them at once.
    """
    missing = [cid for cid in cids if cid not in hits]
    if not missing:
        return
    fetched = store.fetch_by_chunk_ids(set(missing))
    for cid, point in fetched.items():
        hits[cid] = {
            "id": point["id"],
            "score": 0.0,  # no vector similarity — RRF score is what matters
            "payload": point["payload"],
        }


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
    rerank_min_ratio: float = rag_rerank.DEFAULT_RERANK_MIN_RATIO,
    lex: rag_lexical.LexicalStore | None = None,
    hybrid_bm25_candidates: int = rag_settings.DEFAULT_HYBRID_BM25_CANDIDATES,
    query_variants: list[str] | None = None,
    system_prompt: str = DEFAULT_SYSTEM_PROMPT,
    cache_dir: Path | None = None,
) -> QueryResult:
    """Execute one retrieval round and return the data needed to stream
    an LLM answer. Does not call the LLM — the caller streams it.

    Optional retrieval extensions (callers wire from saved settings):
      lex                  — LexicalStore instance enables BM25 hybrid
                             retrieval fused via RRF
      query_variants       — extra paraphrases of `question` to embed
                             alongside it (multi-query expansion); the
                             original question is always included first
    """
    rerank_disabled = rag_rerank.is_disabled(rerank_model)
    retrieve_n = top_k if rerank_disabled else max(rerank_candidates, top_k)

    # 1. Dense retrieval — one round per query variant. Multi-query
    #    callers pre-compute paraphrases; without it we just have one
    #    question.
    variants = [question]
    if query_variants:
        for v in query_variants:
            if v and v.strip() and v not in variants:
                variants.append(v)

    hits_by_cid: dict[str, dict] = {}
    dense_rank_lists: list[list[str]] = []
    for q in variants:
        qvec = rag_embed.embed_texts([q], "query", rag_set)[0]
        round_hits = store.search(qvec, scope=scope, limit=retrieve_n)
        round_cids: list[str] = []
        for h in round_hits:
            cid = (h.get("payload") or {}).get("chunk_id")
            if not cid:
                continue
            round_cids.append(cid)
            prev = hits_by_cid.get(cid)
            # Keep the highest-scoring instance — multi-query unions by
            # chunk_id, picking the variant the chunk matched best.
            if prev is None or float(h.get("score", 0.0)) > float(prev.get("score", 0.0)):
                hits_by_cid[cid] = h
        dense_rank_lists.append(round_cids)

    # 2. Lexical retrieval (optional). Recall booster for exact-string
    #    questions (proper nouns, items, dates) where dense embeddings
    #    blur the answer chunk into the noise floor.
    lexical_hits: list[rag_lexical.LexicalHit] = []
    hybrid_applied = False
    if lex is not None:
        try:
            lexical_hits = lex.search(
                question, scope=scope, limit=hybrid_bm25_candidates
            )
        except Exception:  # noqa: BLE001 — lexical must never crash chat
            lexical_hits = []
        hybrid_applied = bool(lexical_hits)
        if lexical_hits:
            lexical_cids = [h.chunk_id for h in lexical_hits]
            _hydrate_lexical_only(store, hits_by_cid, lexical_cids)

    # 3. Fuse — RRF over (each dense variant, lexical). Only the IDs
    #    actually present in hits_by_cid (post-hydrate) are eligible;
    #    rank lists referencing missing IDs are skipped harmlessly.
    if hybrid_applied:
        fused = _rrf_fuse(
            [*dense_rank_lists, [h.chunk_id for h in lexical_hits]]
        )
    elif len(variants) > 1:
        # Multi-query without hybrid: still fuse the variant lists so a
        # chunk that ranked #20 for the original but #2 for a variant
        # outranks a chunk that only the original found.
        fused = _rrf_fuse(dense_rank_lists)
    else:
        # Single dense round → preserve vector order directly.
        fused = [
            (cid, float(h.get("score", 0.0)))
            for cid, h in sorted(
                hits_by_cid.items(),
                key=lambda kv: -float(kv[1].get("score", 0.0)),
            )
        ]

    ordered_hits: list[dict] = []
    for cid, _rrf in fused:
        h = hits_by_cid.get(cid)
        if h is None:
            continue
        ordered_hits.append(h)

    # 4. Rerank + min-ratio filter (unchanged from the single-variant
    #    path). When rerank is disabled we still cap at top_k so the
    #    chat context doesn't balloon.
    if not rerank_disabled and len(ordered_hits) > top_k:
        hits = rag_rerank.rerank_hits(
            ordered_hits,
            question,
            model_name=rerank_model,
            top_k=top_k,
            min_ratio=rerank_min_ratio,
            cache_dir=cache_dir,
        )
        rerank_applied = True
    else:
        hits = ordered_hits[:top_k]
        rerank_applied = False

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
        hybrid_applied=hybrid_applied,
        hybrid_lexical_hits=len(lexical_hits),
        # Drop the original from the variants reported back — the UI
        # cares about the *extra* queries we generated, not the input.
        query_variants=variants[1:],
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
