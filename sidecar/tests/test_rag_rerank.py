"""rag_rerank tests — fastembed is mocked at _build_encoder.

No real model download happens here; we verify the wrapper's policy
(skip-when-disabled, skip-when-fewer-than-top_k, sort-by-score,
swallow-and-fallback on error, encoder cache reuse).
"""

from __future__ import annotations

from typing import Any

import pytest

import rag_rerank


class _FakeEncoder:
    """Deterministic stand-in for TextCrossEncoder.

    Score = +1 for each query-word found in the document, scaled by
    document index so we can predict the ranking. Tracks call_count so
    we can assert the encoder cache reused the instance.
    """

    instances: list["_FakeEncoder"] = []

    def __init__(self, model_name: str, cache_dir: Any) -> None:
        self.model_name = model_name
        self.cache_dir = cache_dir
        self.calls: list[tuple[str, list[str]]] = []
        _FakeEncoder.instances.append(self)

    def rerank(self, query: str, documents) -> list[float]:
        docs = list(documents)
        self.calls.append((query, docs))
        words = set(query.lower().split())
        out: list[float] = []
        for i, d in enumerate(docs):
            overlap = sum(1 for w in words if w in d.lower())
            # Penalise later docs slightly so non-zero scores still
            # diverge — keeps the sort assertion meaningful when all
            # docs contain every word.
            out.append(float(overlap) - 0.01 * i)
        return out


@pytest.fixture(autouse=True)
def reset_encoder_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    rag_rerank.reset_cache()
    _FakeEncoder.instances.clear()
    monkeypatch.setattr(rag_rerank, "_build_encoder", _FakeEncoder)
    yield
    rag_rerank.reset_cache()
    _FakeEncoder.instances.clear()


def _hit(chunk_id: str, text: str) -> dict:
    return {
        "id": chunk_id,
        "score": 0.5,
        "payload": {"chunk_id": chunk_id, "text": text},
    }


# ---- is_disabled --------------------------------------------------------


@pytest.mark.parametrize("value", [None, "", "disabled", " DISABLED ", "Disabled"])
def test_is_disabled_treats_blanks_and_disabled_token_as_off(value: str | None) -> None:
    assert rag_rerank.is_disabled(value) is True


def test_is_disabled_falsey_for_real_models() -> None:
    assert rag_rerank.is_disabled("jinaai/jina-reranker-v2-base-multilingual") is False


# ---- rerank_hits policy -------------------------------------------------


def test_rerank_skips_when_model_disabled() -> None:
    hits = [_hit(str(i), "anything") for i in range(10)]
    out = rag_rerank.rerank_hits(hits, "query", model_name="disabled", top_k=3)
    assert [h["payload"]["chunk_id"] for h in out] == ["0", "1", "2"]
    # No reranker constructed because we short-circuited.
    assert _FakeEncoder.instances == []


def test_rerank_skips_when_fewer_hits_than_top_k() -> None:
    hits = [_hit("a", "x"), _hit("b", "y")]
    out = rag_rerank.rerank_hits(hits, "q", model_name="some-model", top_k=5)
    assert out == hits
    assert _FakeEncoder.instances == []


def test_rerank_sorts_by_score_and_truncates() -> None:
    hits = [
        _hit("hit0", "alpha"),
        _hit("hit1", "alpha beta"),  # 2 word overlap with query
        _hit("hit2", "alpha"),
        _hit("hit3", "alpha beta gamma"),  # 3 word overlap
        _hit("hit4", "alpha"),
    ]
    out = rag_rerank.rerank_hits(
        hits, "alpha beta gamma", model_name="some-model", top_k=2
    )
    chunk_ids = [h["payload"]["chunk_id"] for h in out]
    # hit3 has the highest overlap (3 words), then hit1 (2 words).
    assert chunk_ids[0] == "hit3"
    assert chunk_ids[1] == "hit1"
    # rerank_score landed on every input hit, even the ones that got
    # truncated below top_k — useful if the caller wants to log raw
    # scores. Verify on a hit that stayed in.
    assert all("rerank_score" in h for h in hits)


def test_rerank_empty_input_returns_empty() -> None:
    assert rag_rerank.rerank_hits([], "q", model_name="some-model", top_k=5) == []


def test_rerank_swallows_encoder_errors_and_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _BoomEncoder:
        def __init__(self, *_: Any, **__: Any) -> None:
            pass

        def rerank(self, *_: Any, **__: Any) -> list[float]:
            raise RuntimeError("ONNX session failed")

    monkeypatch.setattr(rag_rerank, "_build_encoder", lambda *_a, **_k: _BoomEncoder())
    hits = [_hit(str(i), f"doc {i}") for i in range(8)]
    out = rag_rerank.rerank_hits(hits, "query", model_name="m", top_k=3)
    assert [h["payload"]["chunk_id"] for h in out] == ["0", "1", "2"]
    # Failure marker propagated so the chat panel can log "rerank
    # failed; vector order returned".
    assert all(h.get("rerank_error") for h in hits)


# ---- encoder cache reuse ------------------------------------------------


def test_get_encoder_caches_per_model(tmp_path) -> None:
    e1 = rag_rerank.get_encoder("model-a", cache_dir=tmp_path)
    e2 = rag_rerank.get_encoder("model-a", cache_dir=tmp_path)
    assert e1 is e2  # cache hit
    assert len(_FakeEncoder.instances) == 1


def test_get_encoder_swaps_on_model_change(tmp_path) -> None:
    a = rag_rerank.get_encoder("model-a", cache_dir=tmp_path)
    b = rag_rerank.get_encoder("model-b", cache_dir=tmp_path)
    assert a is not b
    assert len(_FakeEncoder.instances) == 2


def test_get_encoder_raises_when_disabled() -> None:
    with pytest.raises(ValueError, match="reranker disabled"):
        rag_rerank.get_encoder("disabled")
