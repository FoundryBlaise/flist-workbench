"""rag_query tests — uses real embedded Qdrant + fake embedder + fake reranker."""

from __future__ import annotations

from pathlib import Path

import pytest

import rag as rag_settings
import rag_embed
import rag_query
import rag_rerank
import rag_store


# ---- fixtures ----------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path) -> rag_store.RagStore:
    s = rag_store.RagStore(path=tmp_path / "qdrant")
    yield s
    s.close()


@pytest.fixture
def rag_set() -> rag_settings.RagSettings:
    return rag_settings.RagSettings(
        embed_endpoint="http://test/v1",
        embed_model="test-embed",
        embed_api_key="",
        embed_query_prefix="",
        embed_document_prefix="",
        chat_endpoint="http://chat.test/v1",
        chat_model="chat-model",
        chat_api_key="",
        chat_system_prompt="test system",
        rerank_model="disabled",
        rerank_candidates=30,
        top_k=5,
        neighbors=1,
        rerank_min_ratio=0.0,
        hybrid_enabled=False,
        hybrid_bm25_candidates=30,
        multiquery_enabled=False,
        multiquery_variants=3,
        chat_num_ctx=0,
        chunk_max_chars=5000,
        chunk_soft_split_chars=4000,
        chunk_overlap_msgs=1,
    )


@pytest.fixture(autouse=True)
def reset_rerank_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    rag_rerank.reset_cache()
    yield
    rag_rerank.reset_cache()


def _stub_embedding(
    monkeypatch: pytest.MonkeyPatch, *, vector: list[float] | None = None
) -> None:
    def fake_embed_texts(texts, kind, settings, **_):  # noqa: ARG001
        return [(vector or [1.0, 0.0, 0.0])[:] for _ in texts]

    monkeypatch.setattr(rag_embed, "embed_texts", fake_embed_texts)


def _stub_rerank(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, list[str]]]:
    calls: list[tuple[str, list[str]]] = []

    class _Encoder:
        def rerank(self, query: str, docs):
            docs = list(docs)
            calls.append((query, docs))
            # Score by length of doc text; longer = higher.
            return [float(len(d)) for d in docs]

    monkeypatch.setattr(rag_rerank, "_build_encoder", lambda *_a, **_k: _Encoder())
    return calls


def _seed_chunks(store: rag_store.RagStore, chunks_and_vectors: list[tuple[dict, list[float]]]) -> None:
    store.ensure_collection(vector_size=len(chunks_and_vectors[0][1]))
    store.upsert_chunks(
        [c for c, _v in chunks_and_vectors],
        [v for _c, v in chunks_and_vectors],
    )


def _mkchunk(
    chunk_id: str,
    *,
    text: str = "hello",
    character: str = "C",
    partner: str = "P",
    date: str = "2026-01-01",
    label: str = "IC",
    subchunk: int = 0,
    ts_start: int = 0,
    ts_end: int = 100,
    prev_chunk_id: str | None = None,
    next_chunk_id: str | None = None,
) -> dict:
    return {
        "chunk_id": chunk_id,
        "char_owner": character,
        "partner": partner,
        "date": date,
        "label": label,
        "subchunk": subchunk,
        "ts_start": ts_start,
        "ts_end": ts_end,
        "speakers": [character],
        "msg_count": 1,
        "char_count": len(text),
        "text": text,
        "prev_chunk_id": prev_chunk_id,
        "next_chunk_id": next_chunk_id,
    }


# ---- run_query ---------------------------------------------------------


def test_run_query_returns_hits_and_messages(
    store: rag_store.RagStore,
    rag_set: rag_settings.RagSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_embedding(monkeypatch, vector=[1.0, 0.0, 0.0])
    _seed_chunks(
        store,
        [
            (_mkchunk("a", text="closest"), [1.0, 0.0, 0.0]),
            (_mkchunk("b", text="middle"), [0.5, 0.5, 0.0]),
            (_mkchunk("c", text="far"), [0.0, 0.0, 1.0]),
        ],
    )
    result = rag_query.run_query(
        "what happened?",
        scope=None,
        store=store,
        rag_set=rag_set,
        rerank_model="disabled",
        top_k=2,
        neighbors=0,
    )
    chunk_ids = [(h.get("payload") or {}).get("chunk_id") for h in result.hits]
    assert chunk_ids[0] == "a"
    assert len(result.hits) == 2
    assert result.rerank_applied is False
    # System + user messages, in that order.
    assert [m["role"] for m in result.messages] == ["system", "user"]
    # Citation context blocks landed in the user message body.
    assert "Source 1" in result.messages[-1]["content"]
    assert "closest" in result.messages[-1]["content"]


def test_run_query_applies_rerank_when_enabled(
    store: rag_store.RagStore,
    rag_set: rag_settings.RagSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_embedding(monkeypatch, vector=[1.0, 0.0, 0.0])
    calls = _stub_rerank(monkeypatch)
    _seed_chunks(
        store,
        [
            (_mkchunk("short", text="x"), [1.0, 0.0, 0.0]),
            (_mkchunk("mid", text="xx" * 50), [0.9, 0.1, 0.0]),
            (_mkchunk("long", text="x" * 500), [0.8, 0.2, 0.0]),
        ],
    )
    result = rag_query.run_query(
        "anything",
        scope=None,
        store=store,
        rag_set=rag_set,
        rerank_model="test-rerank",
        rerank_candidates=3,
        top_k=2,
        neighbors=0,
    )
    # Rerank stub scores by len(text); longest wins despite vector order.
    chunk_ids = [(h.get("payload") or {}).get("chunk_id") for h in result.hits]
    assert chunk_ids == ["long", "mid"]
    assert result.rerank_applied is True
    assert len(calls) == 1  # one rerank call for one query


def test_run_query_skips_rerank_when_fewer_hits_than_top_k(
    store: rag_store.RagStore,
    rag_set: rag_settings.RagSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_embedding(monkeypatch, vector=[1.0, 0.0, 0.0])
    calls = _stub_rerank(monkeypatch)
    _seed_chunks(
        store,
        [
            (_mkchunk("a"), [1.0, 0.0, 0.0]),
            (_mkchunk("b"), [0.0, 1.0, 0.0]),
        ],
    )
    result = rag_query.run_query(
        "q",
        scope=None,
        store=store,
        rag_set=rag_set,
        rerank_model="test-rerank",
        top_k=5,
        neighbors=0,
    )
    assert result.rerank_applied is False
    assert calls == []  # encoder never asked to rerank


def test_run_query_neighbors_expand(
    store: rag_store.RagStore,
    rag_set: rag_settings.RagSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_embedding(monkeypatch, vector=[1.0, 0.0, 0.0])
    _seed_chunks(
        store,
        [
            (_mkchunk("a", ts_start=0, ts_end=10, next_chunk_id="b"), [1.0, 0.0, 0.0]),
            (
                _mkchunk(
                    "b",
                    ts_start=20,
                    ts_end=30,
                    prev_chunk_id="a",
                    next_chunk_id="c",
                ),
                [0.5, 0.5, 0.0],
            ),
            (_mkchunk("c", ts_start=40, ts_end=50, prev_chunk_id="b"), [0.0, 1.0, 0.0]),
        ],
    )
    result = rag_query.run_query(
        "q",
        scope=None,
        store=store,
        rag_set=rag_set,
        rerank_model="disabled",
        top_k=1,
        neighbors=1,
    )
    # Hit on "a"; neighbors pull "b". c is two hops away and skipped.
    ids = sorted((h.get("payload") or {}).get("chunk_id") for h in result.hits)
    assert ids == ["a", "b"]
    # The expanded chunk carries the marker so the renderer can style it.
    expanded = [
        h for h in result.hits if (h.get("payload") or {}).get("chunk_id") == "b"
    ]
    assert expanded and (expanded[0].get("payload") or {}).get("expanded") is True


def test_run_query_handles_empty_hits(
    store: rag_store.RagStore,
    rag_set: rag_settings.RagSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_embedding(monkeypatch, vector=[1.0, 0.0, 0.0])
    # Collection exists but contains nothing.
    store.ensure_collection(vector_size=3)
    result = rag_query.run_query(
        "is there anything?",
        scope=None,
        store=store,
        rag_set=rag_set,
        rerank_model="disabled",
        top_k=5,
        neighbors=0,
    )
    assert result.hits == []
    assert "no relevant context" in result.messages[-1]["content"]


def test_run_query_scope_filter_narrows_hits(
    store: rag_store.RagStore,
    rag_set: rag_settings.RagSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_embedding(monkeypatch, vector=[1.0, 0.0, 0.0])
    _seed_chunks(
        store,
        [
            (_mkchunk("ax", partner="A"), [1.0, 0.0, 0.0]),
            (_mkchunk("bx", partner="B"), [1.0, 0.0, 0.0]),
        ],
    )
    result = rag_query.run_query(
        "q",
        scope={"character": "C", "partner": "A"},
        store=store,
        rag_set=rag_set,
        rerank_model="disabled",
        top_k=5,
        neighbors=0,
    )
    ids = {(h.get("payload") or {}).get("chunk_id") for h in result.hits}
    assert ids == {"ax"}


# ---- citation_payload --------------------------------------------------


def test_citation_payload_strips_text_and_keeps_navigation_fields() -> None:
    hits = [
        {
            "id": "uuid-1",
            "score": 0.87,
            "rerank_score": 1.23,
            "payload": {
                "chunk_id": "C__P__2026-01-01__IC#0",
                "char_owner": "C",
                "partner": "P",
                "date": "2026-01-01",
                "label": "IC",
                "ts_start": 0,
                "ts_end": 100,
                "speakers": ["C", "P"],
                "text": "x" * 1000,
                "expanded": False,
            },
        }
    ]
    cites = rag_query.citation_payload(hits)
    assert cites[0]["chunk_id"] == "C__P__2026-01-01__IC#0"
    assert cites[0]["ts_start"] == 0
    assert cites[0]["ts_end"] == 100
    assert cites[0]["score"] == pytest.approx(0.87)
    assert cites[0]["rerank_score"] == pytest.approx(1.23)
    assert cites[0]["speakers"] == ["C", "P"]
    assert "text" not in cites[0]  # trimmed


# ---- hybrid retrieval (BM25 fused with dense via RRF) ------------------


class _FakeLexicalStore:
    """Stand-in for rag_lexical.LexicalStore — returns canned BM25 hits
    keyed by chunk_id. Avoids touching SQLite from rag_query tests."""

    def __init__(self, hits_by_query: dict[str, list[str]]) -> None:
        self._hits = hits_by_query
        self.search_calls: list[tuple[str, dict | None]] = []

    def search(self, query: str, *, scope=None, limit: int = 30):
        self.search_calls.append((query, scope))
        from rag_lexical import LexicalHit
        return [
            LexicalHit(chunk_id=cid, bm25_score=10.0 - i)
            for i, cid in enumerate(self._hits.get(query, [])[:limit])
        ]


def test_run_query_hybrid_pulls_lexical_only_chunk_into_pool(
    store: rag_store.RagStore,
    rag_set: rag_settings.RagSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Dense surfaces "a" only; lexical surfaces "lex_only" — which
    # exists in Qdrant but the dense vector misses. Hybrid+RRF should
    # include both so the chat context sees the lexical chunk too.
    _stub_embedding(monkeypatch, vector=[1.0, 0.0, 0.0])
    _seed_chunks(
        store,
        [
            (_mkchunk("a", text="aligned"), [1.0, 0.0, 0.0]),
            (_mkchunk("lex_only", text="exact-name chunk"), [0.0, 0.0, 1.0]),
            (_mkchunk("c", text="orthogonal"), [0.0, 1.0, 0.0]),
        ],
    )
    lex = _FakeLexicalStore({"who is amber?": ["lex_only"]})
    result = rag_query.run_query(
        "who is amber?",
        scope=None,
        store=store,
        rag_set=rag_set,
        rerank_model="disabled",
        top_k=3,
        neighbors=0,
        lex=lex,
        hybrid_bm25_candidates=10,
    )
    cids = {(h.get("payload") or {}).get("chunk_id") for h in result.hits}
    assert "lex_only" in cids
    assert "a" in cids
    assert result.hybrid_applied is True
    assert result.hybrid_lexical_hits == 1
    # Lexical search should have been called with the original question.
    assert lex.search_calls == [("who is amber?", None)]


def test_run_query_without_lex_skips_lexical_search(
    store: rag_store.RagStore,
    rag_set: rag_settings.RagSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_embedding(monkeypatch, vector=[1.0, 0.0, 0.0])
    _seed_chunks(store, [(_mkchunk("a"), [1.0, 0.0, 0.0])])
    result = rag_query.run_query(
        "q",
        scope=None,
        store=store,
        rag_set=rag_set,
        rerank_model="disabled",
        top_k=5,
        neighbors=0,
    )
    assert result.hybrid_applied is False
    assert result.hybrid_lexical_hits == 0


# ---- multi-query expansion ---------------------------------------------


def test_run_query_multiquery_unions_variants_by_chunk_id(
    store: rag_store.RagStore,
    rag_set: rag_settings.RagSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Each variant gets a different dense vector — set up the embedder
    # to map each query string to the vector that lands it on a
    # specific chunk. Then the union must cover both chunks.
    by_query = {
        "ophelia?": [1.0, 0.0, 0.0],     # hits "ophelia_chunk"
        "ophelia who?": [0.0, 1.0, 0.0], # hits "variant_chunk"
    }

    def fake_embed(texts, kind, settings, **_):  # noqa: ARG001
        return [by_query.get(t, [0.0, 0.0, 1.0]) for t in texts]

    monkeypatch.setattr(rag_embed, "embed_texts", fake_embed)
    _seed_chunks(
        store,
        [
            (_mkchunk("ophelia_chunk", text="Ophelia at the ball"), [1.0, 0.0, 0.0]),
            (_mkchunk("variant_chunk", text="Whoever Ophelia is"), [0.0, 1.0, 0.0]),
        ],
    )
    result = rag_query.run_query(
        "ophelia?",
        scope=None,
        store=store,
        rag_set=rag_set,
        rerank_model="disabled",
        top_k=5,
        neighbors=0,
        query_variants=["ophelia who?"],
    )
    cids = {(h.get("payload") or {}).get("chunk_id") for h in result.hits}
    assert cids == {"ophelia_chunk", "variant_chunk"}
    assert result.query_variants == ["ophelia who?"]


def test_run_query_multiquery_dedupes_against_original(
    store: rag_store.RagStore,
    rag_set: rag_settings.RagSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A variant identical to the original (after normalisation) must
    # not add a second retrieval round.
    embed_calls: list[str] = []

    def fake_embed(texts, kind, settings, **_):  # noqa: ARG001
        embed_calls.extend(texts)
        return [[1.0, 0.0, 0.0]] * len(texts)

    monkeypatch.setattr(rag_embed, "embed_texts", fake_embed)
    _seed_chunks(store, [(_mkchunk("a"), [1.0, 0.0, 0.0])])
    rag_query.run_query(
        "Wer ist Amber?",
        scope=None,
        store=store,
        rag_set=rag_set,
        rerank_model="disabled",
        top_k=3,
        neighbors=0,
        query_variants=["Wer ist Amber?", "Beschreibe Amber"],
    )
    # Exact-dup variant collapsed; only the original + the second
    # variant got embedded.
    assert embed_calls == ["Wer ist Amber?", "Beschreibe Amber"]
