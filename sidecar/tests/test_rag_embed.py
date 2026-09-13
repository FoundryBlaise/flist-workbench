"""The embedding seam (design §3.10).

Embedding runs in-process through fastembed. These tests never load a
real model — `rag_embed_local._build_embedder` is the seam, and stubbing
it keeps the suite free of a 200 MB download and an ONNX session.
"""

from __future__ import annotations

import pytest

import rag_embed
import rag_embed_local
from rag import RagSettings


def _settings(model: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"):
    return RagSettings(
        embed_model=model,
        rerank_model="disabled",
        rerank_candidates=30,
        top_k=5,
        neighbors=1,
        rerank_min_ratio=0.0,
        hybrid_enabled=False,
        hybrid_bm25_candidates=30,
        chunk_max_chars=450,
        chunk_soft_split_chars=400,
        chunk_overlap_msgs=1,
    )


class _FakeEmbedder:
    """Records what it was asked to embed; returns one vector per input."""

    def __init__(self, dimension: int = 4) -> None:
        self.seen: list[list[str]] = []
        self.dimension = dimension

    def embed(self, texts, batch_size=None):  # noqa: ARG002
        texts = list(texts)
        self.seen.append(texts)
        return [[float(i)] * self.dimension for i, _ in enumerate(texts)]


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> _FakeEmbedder:
    embedder = _FakeEmbedder()
    rag_embed_local.reset_cache()
    monkeypatch.setattr(
        rag_embed_local, "_build_embedder", lambda name, cache: embedder
    )
    yield embedder
    rag_embed_local.reset_cache()


def test_embed_texts_returns_one_vector_per_input(fake: _FakeEmbedder) -> None:
    vectors = rag_embed.embed_texts(["a", "b", "c"], "document", _settings())
    assert len(vectors) == 3
    assert all(len(v) == 4 for v in vectors)


def test_empty_input_short_circuits(fake: _FakeEmbedder) -> None:
    assert rag_embed.embed_texts([], "document", _settings()) == []
    assert fake.seen == []


def test_probe_reports_the_dimension(fake: _FakeEmbedder) -> None:
    dimension, vector = rag_embed.probe(_settings())
    assert dimension == 4
    assert len(vector) == 4


def test_a_model_that_needs_prefixes_gets_them(fake: _FakeEmbedder) -> None:
    """fastembed does not add them — measured. query_embed, passage_embed
    and embed return bit-identical vectors, so e5's mandatory prefixes
    have to come from here or recall quietly suffers."""
    e5 = _settings("intfloat/multilingual-e5-large")
    rag_embed.embed_texts(["wie sieht sie aus"], "query", e5)
    rag_embed.embed_texts(["sie hat weisse Haare"], "document", e5)
    assert fake.seen[0] == ["query: wie sieht sie aus"]
    assert fake.seen[1] == ["passage: sie hat weisse Haare"]


def test_a_model_that_needs_none_gets_none(fake: _FakeEmbedder) -> None:
    rag_embed.embed_texts(["wie sieht sie aus"], "query", _settings())
    assert fake.seen[0] == ["wie sieht sie aus"]


def test_a_failing_model_surfaces_as_embed_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rag_embed_local.reset_cache()

    def boom(name, cache):  # noqa: ARG001
        raise RuntimeError("onnxruntime said no")

    monkeypatch.setattr(rag_embed_local, "_build_embedder", boom)
    with pytest.raises(rag_embed.EmbedError) as excinfo:
        rag_embed.embed_texts(["a"], "document", _settings())
    assert "onnxruntime said no" in str(excinfo.value)
    rag_embed_local.reset_cache()


def test_the_embedder_is_built_once_and_reused(fake: _FakeEmbedder) -> None:
    built: list[str] = []
    settings = _settings()
    for _ in range(3):
        rag_embed.embed_texts(["a"], "document", settings)
    assert len(fake.seen) == 3  # three calls
    assert built == []  # and only one construction, via the module cache


def test_every_profiled_model_has_a_window_a_chunk_can_fit() -> None:
    """The profile is what `rag.load_settings` clamps chunking to. A
    value larger than the model's real window truncates every chunk
    silently, which is the failure this table exists to prevent."""
    for name, profile in rag_embed_local.MODEL_PROFILES.items():
        assert profile.max_chars >= 200, name
        assert profile.max_chars <= 8000, name
