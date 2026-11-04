"""Search results come back in relevance order with honest scores.

A hit says where it ranked after fusion, where the dense and the
keyword half ranked it, and the rerank score when reranking ran. A hit
only the keyword half found still scores above zero. Neighbouring
chunks ride inside the hit they border instead of re-sorting the
results by time.

Searches go through `services.retrieval`, the one place the MCP tool
calls. Embedding and reranking are stubbed: the query always embeds to
[1, 0, 0], and the stub reranker prefers longer text.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sidecar_client import app_client

import rag_embed
import rag_lexical
import rag_rerank
import rag_store

CHAR = "Ilse Varga"
PARTNER = "Corin Hale"
OTHER_PARTNER = "Mara Quill"


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    rag_rerank.reset_cache()

    class _LongerIsBetter:
        def rerank(self, query: str, docs):  # noqa: ARG002
            return [float(len(d)) for d in docs]

    monkeypatch.setattr(
        rag_rerank, "_build_encoder", lambda *_a, **_k: _LongerIsBetter()
    )

    def fake_embed_texts(texts, kind, settings, **_):  # noqa: ARG001
        return [[1.0, 0.0, 0.0] for _ in texts]

    monkeypatch.setattr(rag_embed, "embed_texts", fake_embed_texts)
    from server import app

    yield app_client(app)
    rag_rerank.reset_cache()


def _rerank(client: TestClient, model: str) -> None:
    res = client.put("/settings", json={"rag": {"rerank_model": model}})
    assert res.status_code == 200, res.text


def _chunk(
    chunk_id: str,
    text: str,
    *,
    partner: str = PARTNER,
    ts: int = 0,
    prev_chunk_id: str | None = None,
    next_chunk_id: str | None = None,
) -> dict:
    return {
        "chunk_id": chunk_id,
        "char_owner": CHAR,
        "partner": partner,
        "date": "2026-03-14",
        "label": "IC",
        "subchunk": 0,
        "ts_start": ts,
        "ts_end": ts + 5,
        "speakers": [CHAR, partner],
        "msg_count": 1,
        "char_count": len(text),
        "text": text,
        "prev_chunk_id": prev_chunk_id,
        "next_chunk_id": next_chunk_id,
    }


def _index(tmp_path: Path, chunks: list[tuple[dict, list[float]]]) -> None:
    """Write the chunks to both halves of the Index, as ingest does."""
    with rag_store.RagStore(path=tmp_path / "qdrant") as store:
        store.ensure_collection(vector_size=3)
        store.upsert_chunks([c for c, _v in chunks], [v for _c, v in chunks])
    rag_store.write_manifest(embed_model="m", embed_dimension=3)
    with rag_lexical.LexicalStore() as lex:
        lex.upsert_chunks([c for c, _v in chunks])


def _keyword_and_dense_fixture(tmp_path: Path) -> None:
    """Dense order d1 d2 d3 d4 (kw is orthogonal to the query); the
    keyword half finds d2 first and kw second.

    RRF with k=60 over ranks counted from 0:
      d2  1/61 + 1/60 = 0.0331   both halves
      d1  1/60        = 0.0167   dense only
      kw  1/61        = 0.0164   keyword only
      d3  1/62        = 0.0161
    """
    _index(
        tmp_path,
        [
            (_chunk("d1", "The tavern was quiet that evening."), [1.0, 0.0, 0.0]),
            (_chunk("d2", "Amber, amber."), [0.9, 0.1, 0.0]),
            (_chunk("d3", "Rain drummed on the roof."), [0.8, 0.2, 0.0]),
            (_chunk("d4", "A long walk home."), [0.7, 0.3, 0.0]),
            (
                _chunk(
                    "kw",
                    "She wore amber beads to the market and talked for hours "
                    "with the weaver about the coming winter.",
                ),
                [0.0, 0.0, 1.0],
            ),
        ],
    )


def test_hits_come_back_in_fused_order_with_their_ranks_and_scores(
    client: TestClient, tmp_path: Path
) -> None:
    from services import retrieval

    _rerank(client, "disabled")
    _keyword_and_dense_fixture(tmp_path)

    result = retrieval.search("amber", top_k=3, neighbors=0, hybrid=True)
    hits = result.to_dict()["hits"]

    assert [h["chunk_id"] for h in hits] == ["d2", "d1", "kw"]
    assert [
        (h["fused_rank"], h["dense_rank"], h["lexical_rank"]) for h in hits
    ] == [(1, 2, 1), (2, 1, None), (3, None, 2)]
    assert [h["score"] for h in hits] == [0.0331, 0.0167, 0.0164]


def test_a_scoped_search_keeps_keyword_hits_from_other_partners_out(
    client: TestClient, tmp_path: Path
) -> None:
    """The keyword half honours the scope too, not just the dense half."""
    from services import retrieval

    _rerank(client, "disabled")
    _index(
        tmp_path,
        [
            (_chunk("here", "The tavern was quiet."), [1.0, 0.0, 0.0]),
            (
                _chunk("elsewhere", "Amber, amber.", partner=OTHER_PARTNER),
                [0.0, 0.0, 1.0],
            ),
        ],
    )

    scoped = retrieval.search(
        "amber",
        scope={"character": CHAR, "partner": PARTNER},
        neighbors=0,
        hybrid=True,
    )
    everywhere = retrieval.search("amber", neighbors=0, hybrid=True)

    assert [h.chunk_id for h in scoped.hits] == ["here"]
    assert "elsewhere" in [h.chunk_id for h in everywhere.hits]


def _conversation_fixture(tmp_path: Path) -> None:
    """One conversation: `early` opens it; `before`, `best`, `after` are
    a run of chunks later the same day. The query lands on `best`
    first and on `early` second, so a time sort would put `early` (and
    `before`) ahead of the best hit."""
    _index(
        tmp_path,
        [
            (_chunk("early", "They met at the gate.", ts=0), [0.9, 0.1, 0.0]),
            (
                _chunk("before", "The fire burned low.", ts=100, next_chunk_id="best"),
                [0.0, 1.0, 0.0],
            ),
            (
                _chunk(
                    "best",
                    "She told him about her sister.",
                    ts=200,
                    prev_chunk_id="before",
                    next_chunk_id="after",
                ),
                [1.0, 0.0, 0.0],
            ),
            (
                _chunk("after", "He said nothing for a while.", ts=300, prev_chunk_id="best"),
                [0.0, 0.0, 1.0],
            ),
        ],
    )


def test_neighbours_ride_inside_the_hit_they_border(
    client: TestClient, tmp_path: Path
) -> None:
    from services import retrieval

    _rerank(client, "disabled")
    _conversation_fixture(tmp_path)

    result = retrieval.search("her sister", top_k=2, neighbors=1, hybrid=False)
    hits = result.to_dict()["hits"]

    # The best hit is still first; neighbours are not hits of their own.
    assert [h["chunk_id"] for h in hits] == ["best", "early"]
    context = hits[0]["context"]
    assert [(c["chunk_id"], c["text"]) for c in context["before"]] == [
        ("before", "The fire burned low.")
    ]
    assert [(c["chunk_id"], c["text"]) for c in context["after"]] == [
        ("after", "He said nothing for a while.")
    ]
    assert hits[1]["context"] == {"before": [], "after": []}


def test_a_reranked_search_reports_the_rerank_score_and_keeps_the_fused_rank(
    client: TestClient, tmp_path: Path
) -> None:
    from services import retrieval

    _rerank(client, "test/reranker")
    _keyword_and_dense_fixture(tmp_path)

    result = retrieval.search("amber", top_k=2, neighbors=0, hybrid=False)
    body = result.to_dict()
    hits = body["hits"]

    assert body["retrieval"]["rerank_applied"] is True
    # The stub reranker prefers longer text: kw, then d1.
    assert [(h["chunk_id"], h["fused_rank"]) for h in hits] == [("kw", 5), ("d1", 1)]
    assert [h["rerank_score"] for h in hits] == [
        float(len(h["text"])) for h in hits
    ]


def test_without_reranking_no_hit_carries_a_rerank_score(
    client: TestClient, tmp_path: Path
) -> None:
    from services import retrieval

    _rerank(client, "disabled")
    _keyword_and_dense_fixture(tmp_path)

    body = retrieval.search("amber", top_k=2, neighbors=0, hybrid=False).to_dict()

    assert body["retrieval"]["rerank_applied"] is False
    assert body["hits"]
    assert not any("rerank_score" in h for h in body["hits"])


def test_a_reranker_that_fails_leaves_the_fused_order_and_no_rerank_score(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from services import retrieval

    class _Broken:
        def rerank(self, query: str, docs):  # noqa: ARG002
            raise RuntimeError("model file is damaged")

    monkeypatch.setattr(rag_rerank, "_build_encoder", lambda *_a, **_k: _Broken())
    _rerank(client, "test/reranker")
    _keyword_and_dense_fixture(tmp_path)

    body = retrieval.search("amber", top_k=2, neighbors=0, hybrid=False).to_dict()

    assert body["retrieval"]["rerank_applied"] is False
    assert [h["chunk_id"] for h in body["hits"]] == ["d1", "d2"]
    assert not any("rerank_score" in h for h in body["hits"])
