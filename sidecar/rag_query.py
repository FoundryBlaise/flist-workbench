"""Query-time retrieval pipeline — port of Chat_RAG/query.py.

Pipeline:

  query string
    -> embed via rag_embed (the one inference server Workbench uses)
    -> top-N from Qdrant via rag_store (filtered by scope)
    -> optional BM25 fusion via rag_lexical
    -> rerank via rag_rerank (local cross-encoder, optional)
    -> ±M neighbours attached inside each hit via prev_chunk_id / next_chunk_id
    -> return the chunks

No language model is involved. The chunks go out through the MCP tool
`search_logs_semantic`; the model the user connected reads them and
answers. Pure-Python and synchronous, so it stays testable.

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
import rag_lexical
import rag_rerank
import rag_store


@dataclass(slots=True)
class QueryResult:
    """Bundles the retrieval output for the SSE endpoint.

    `hits` are the matches, most relevant first, each carrying its
    full text, its ranks (`fused_rank`, `fused_score`, `dense_rank`,
    `lexical_rank`, `rerank_score` when reranking ran) and its
    neighbouring chunks under `context`. The MCP `search_logs_semantic`
    tool serialises them for the connected model to read and answer
    from — Workbench itself never calls a language model.
    """

    hits: list[dict]
    embed_model: str
    rerank_model: str | None
    rerank_applied: bool
    hybrid_applied: bool = False
    hybrid_lexical_hits: int = 0
    #: More matches rank below the last one returned (`offset` + `top_k`).
    has_more: bool = False


def expand_with_neighbors(
    store: rag_store.RagStore, hits: list[dict], *, hops: int
) -> list[dict]:
    """Attach up to `hops` chunks before and after each hit, inside it.

    The hits keep their relevance order. Each gets a `context` of
    `{"before": [...], "after": [...]}`, both in time order, followed
    along the prev/next pointers. A neighbour is attached once, to the
    best-ranked hit that reaches it, and the walk stops at a chunk that
    is a hit of its own, so no text comes back twice.

    `hops=0` attaches nothing.
    """
    for h in hits:
        h["context"] = {"before": [], "after": []}
    taken = {(h.get("payload") or {}).get("chunk_id") for h in hits}
    # (hit, side, pointer field, next chunk_id), in hit order so the
    # better hit claims a shared neighbour first.
    walks = [
        (h, side, field, (h.get("payload") or {}).get(field))
        for h in hits
        for side, field in (("before", "prev_chunk_id"), ("after", "next_chunk_id"))
    ]
    for _ in range(max(0, hops)):
        needed = {cid for *_rest, cid in walks if cid and cid not in taken}
        if not needed:
            break
        fetched = store.fetch_by_chunk_ids(needed)
        next_walks = []
        for h, side, field, cid in walks:
            point = fetched.get(cid) if cid not in taken else None
            if point is None:
                continue
            taken.add(cid)
            if side == "before":
                h["context"]["before"].insert(0, point)
            else:
                h["context"]["after"].append(point)
            next_walks.append((h, side, field, point["payload"].get(field)))
        walks = next_walks
    return hits


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


def _best_ranks(ranked_lists: list[list[str]]) -> dict[str, int]:
    """Each chunk_id's best 1-based rank across `ranked_lists`."""
    ranks: dict[str, int] = {}
    for ranked in ranked_lists:
        for rank, cid in enumerate(ranked, start=1):
            if cid and rank < ranks.get(cid, rank + 1):
                ranks[cid] = rank
    return ranks


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
            # No vector similarity: the fused score ranks it.
            "score": 0.0,
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
    cache_dir: Path | None = None,
    offset: int = 0,
) -> QueryResult:
    """Retrieve the log chunks most relevant to `question`.

    No language model is involved: dense retrieval, optional BM25
    fusion, optional local cross-encoder rerank, neighbour expansion.
    The caller (the MCP retrieval tool) hands the chunks to whatever
    model the user has connected.

    `lex` — a LexicalStore instance — enables BM25 hybrid retrieval
    fused via RRF.

    `offset` skips that many of the best matches: a later page of the
    same search, with the same `top_k`. One match more than the page is
    ranked to tell whether another page follows (`has_more`).
    """
    rerank_disabled = rag_rerank.is_disabled(rerank_model)
    ranked_n = max(0, offset) + top_k + 1
    retrieve_n = ranked_n if rerank_disabled else max(rerank_candidates, ranked_n)

    # 1. Dense retrieval.
    variants = [question]

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
    #    A single dense list fuses too: the order is the vector order,
    #    and every hit gets a score on the same scale, so a hit only the
    #    keyword half found is never reported as scoring zero.
    lexical_cids = [h.chunk_id for h in lexical_hits] if hybrid_applied else []
    fused = _rrf_fuse([*dense_rank_lists, lexical_cids])
    dense_ranks = _best_ranks(dense_rank_lists)
    lexical_ranks = _best_ranks([lexical_cids])

    ordered_hits: list[dict] = []
    for cid, fused_score in fused:
        h = hits_by_cid.get(cid)
        if h is None:
            continue
        ordered_hits.append(h)
        h["fused_rank"] = len(ordered_hits)
        h["fused_score"] = fused_score
        h["dense_rank"] = dense_ranks.get(cid)
        h["lexical_rank"] = lexical_ranks.get(cid)

    # 4. Rerank + min-ratio filter (unchanged from the single-variant
    #    path). When rerank is disabled we still cap at top_k so the
    #    chat context doesn't balloon.
    #    Whether to rerank depends on the page size only, so every page
    #    of one search is cut from the same ranking.
    if not rerank_disabled and len(ordered_hits) > top_k:
        hits = rag_rerank.rerank_hits(
            ordered_hits,
            question,
            model_name=rerank_model,
            top_k=top_k,
            keep=ranked_n,
            min_ratio=rerank_min_ratio,
            cache_dir=cache_dir,
        )
        # The reranker can decline (nothing to reorder) or fail; only a
        # score on the hits says it ran.
        rerank_applied = any("rerank_score" in h for h in hits)
    else:
        hits = ordered_hits[:ranked_n]
        rerank_applied = False

    start = max(0, offset)
    has_more = len(hits) > start + top_k
    hits = expand_with_neighbors(store, hits[start : start + top_k], hops=neighbors)

    return QueryResult(
        hits=hits,
        embed_model=rag_set.embed_model,
        rerank_model=None if rerank_disabled else rerank_model,
        rerank_applied=rerank_applied,
        hybrid_applied=hybrid_applied,
        hybrid_lexical_hits=len(lexical_hits),
        has_more=has_more,
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
