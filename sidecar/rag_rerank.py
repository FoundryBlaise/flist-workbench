"""Cross-encoder reranker — fastembed wrapper.

Why fastembed and not sentence-transformers / torch:
  fastembed runs the reranker through onnxruntime — no torch (~2 GB
  install), no CUDA detection, no GPU required. Reranking the top-30
  candidates against a query takes ~150–250 ms on a modern laptop CPU
  for the multilingual models we ship.

Why a module-level cache for the encoder:
  Constructing TextCrossEncoder deserialises the ONNX graph (~5–10 s
  the first time, ~1–2 s afterwards). Per-request init would dominate
  the chat latency budget. We hold one instance per model name and
  swap if the user changes their RAG settings.

Why first-use download is a UX concern:
  fastembed downloads the model on the first encoder construction —
  e.g. ~1.1 GB for jina-reranker-v2-base-multilingual. We download
  into ~/Documents/flist-workbench/models/ so cleanup is easy.
  Callers (the query endpoint) should surface a "downloading reranker"
  hint when `is_ready()` returns False so the chat panel doesn't look
  like it hung for a minute.

Skipping rerank:
  The settings string "disabled" (or empty) means "skip rerank entirely
  and return the vector-search top_k directly". The reranker is a real
  quality lift but optional on slow machines.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

import documents

DEFAULT_RERANK_MODEL = "jinaai/jina-reranker-v2-base-multilingual"
DEFAULT_RERANK_CANDIDATES = 30
DEFAULT_TOP_K = 5
DEFAULT_NEIGHBORS = 1
# Default 0.0 = preserve old behaviour for users who upgrade. The setting
# is most useful for "needle in haystack" questions where the reranker
# clearly singles out 1-2 chunks: dropping noisy candidates below
# top_score × ratio reduces the distractor surface the chat LLM has to
# anchor on (which is how the "Baal echo" hallucination class arises).
DEFAULT_RERANK_MIN_RATIO = 0.0
RERANK_DISABLED = "disabled"


def models_dir(root: Path | None = None) -> Path:
    base = root or documents.user_data_dir()
    base.mkdir(parents=True, exist_ok=True)
    target = base / "models"
    target.mkdir(parents=True, exist_ok=True)
    return target


@dataclass(slots=True)
class _CachedEncoder:
    model_name: str
    encoder: object  # fastembed.TextCrossEncoder, kept as object to avoid import-at-typecheck


_LOCK = threading.Lock()
_CACHED: _CachedEncoder | None = None


def is_disabled(model_name: str | None) -> bool:
    """Treat None, '' and 'disabled' as "skip rerank" so the renderer can
    surface a single 'disabled' value in settings and the query path
    doesn't need a separate boolean."""
    if not model_name:
        return True
    return model_name.strip().lower() == RERANK_DISABLED


def reset_cache() -> None:
    """Drop the cached encoder. Tests call this between cases to avoid
    cross-test contamination; production normally never does."""
    global _CACHED
    with _LOCK:
        _CACHED = None


def _build_encoder(model_name: str, cache_dir: Path):
    # Imported lazily so the test suite can monkeypatch _build_encoder
    # without ever touching fastembed (which downloads onnxruntime
    # registries on import).
    from fastembed.rerank.cross_encoder import TextCrossEncoder

    return TextCrossEncoder(model_name=model_name, cache_dir=str(cache_dir))


def get_encoder(model_name: str, *, cache_dir: Path | None = None):
    """Return a cached TextCrossEncoder for model_name, building lazily.

    Caller must check `is_disabled(model_name)` first — passing
    'disabled' here is a programmer error and raises ValueError.
    """
    if is_disabled(model_name):
        raise ValueError("reranker disabled; check is_disabled() before get_encoder()")
    with _LOCK:
        global _CACHED
        if _CACHED is not None and _CACHED.model_name == model_name:
            return _CACHED.encoder
        cache = cache_dir or models_dir()
        encoder = _build_encoder(model_name, cache)
        _CACHED = _CachedEncoder(model_name=model_name, encoder=encoder)
        return encoder


def rerank_hits(
    hits: list[dict],
    query: str,
    *,
    model_name: str | None,
    top_k: int = DEFAULT_TOP_K,
    min_ratio: float = DEFAULT_RERANK_MIN_RATIO,
    cache_dir: Path | None = None,
) -> list[dict]:
    """Re-score hits with the cross-encoder, return the top_k re-ranked.

    No-ops gracefully when rerank is disabled, when there are fewer
    hits than top_k (no point reranking 3 candidates to 5), or when the
    encoder raises — in the last case we log into the hit list as
    `rerank_skipped=True` for the caller to surface and fall back to
    vector order. The query path treats any rerank failure as non-fatal:
    bad rerank shouldn't kill the answer.

    `min_ratio` (0.0-1.0) optionally drops chunks scoring below
    top_score × ratio after the sort, before the top_k slice — collapses
    the 15-chunk worst case (top_k=5 × neighbors=±1) when the reranker
    clearly singles out only 1-2 relevant chunks. 0.0 disables.
    """
    if not hits:
        return []
    if is_disabled(model_name):
        return hits[:top_k]
    # Cheap path: when nothing would be re-ordered AND no threshold
    # filter is requested, skip the encoder entirely. Keeps the
    # common-case latency unchanged. With min_ratio > 0 we still need
    # scores even on small pools so the threshold has something to
    # filter against.
    if len(hits) <= top_k and min_ratio <= 0.0:
        return hits[:top_k]
    try:
        encoder = get_encoder(model_name, cache_dir=cache_dir)
        docs = [h["payload"]["text"] for h in hits]
        scores = list(encoder.rerank(query, docs))
    except Exception as exc:  # noqa: BLE001 — rerank must never crash chat
        for h in hits:
            h["rerank_error"] = str(exc)
        return hits[:top_k]
    for h, s in zip(hits, scores):
        h["rerank_score"] = float(s)
    hits.sort(key=lambda h: -float(h.get("rerank_score", 0.0)))
    if min_ratio > 0.0:
        top = float(hits[0].get("rerank_score", 0.0))
        # Skip the filter for non-positive top scores: some cross-encoders
        # emit raw logits in (-inf, +inf) where "× ratio" inverts meaning.
        # Sigmoid-shaped scores (jina v2, BGE) are always > 0 in practice.
        if top > 0.0:
            threshold = top * min_ratio
            hits = [h for h in hits if float(h.get("rerank_score", 0.0)) >= threshold]
    return hits[:top_k]
