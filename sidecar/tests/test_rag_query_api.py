"""Search + RAG settings API tests.

`/rag/query` and its SSE stream are gone — searching happens through
`services.retrieval` (and the MCP `search_logs_semantic` tool that
wraps it), so the retrieval assertions call the service directly.
Embedding and reranking are stubbed so the suite stays fast and never
downloads a model.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import labels as labels_store
import rag_embed
import rag_rerank
import rag_store


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    rag_rerank.reset_cache()
    # CRITICAL: stub the rerank encoder so no test accidentally
    # triggers a ~1 GB fastembed model download. Score by document
    # length — same heuristic as test_rag_rerank's fake.
    class _FakeEncoder:
        def rerank(self, query: str, docs):
            return [float(len(d)) for d in docs]

    monkeypatch.setattr(rag_rerank, "_build_encoder", lambda *_a, **_k: _FakeEncoder())
    from server import app

    return TestClient(app)


def _parse_sse(body: bytes) -> list[tuple[str, dict | str]]:
    """Split an SSE byte stream into [(event, parsed-data), ...]."""
    out: list[tuple[str, dict | str]] = []
    for block in body.decode("utf-8").split("\n\n"):
        if not block.strip():
            continue
        event: str | None = None
        data_lines: list[str] = []
        for line in block.split("\n"):
            if line.startswith("event:"):
                event = line[len("event:") :].strip()
            elif line.startswith("data:"):
                data_lines.append(line[len("data:") :].strip())
        if event is None:
            continue
        data = "\n".join(data_lines)
        try:
            parsed: dict | str = json.loads(data)
        except json.JSONDecodeError:
            parsed = data
        out.append((event, parsed))
    return out


def _seed_chunk(tmp_path: Path) -> None:
    """One IC chunk in a fresh embedded Qdrant + matching manifest."""
    with rag_store.RagStore(path=tmp_path / "qdrant") as store:
        store.ensure_collection(vector_size=4)
        store.upsert_chunks(
            [
                {
                    "chunk_id": "C__P__2026-01-01__IC#0",
                    "char_owner": "C",
                    "partner": "P",
                    "date": "2026-01-01",
                    "label": "IC",
                    "subchunk": 0,
                    "ts_start": 1735689600,
                    "ts_end": 1735693200,
                    "speakers": ["C", "P"],
                    "msg_count": 1,
                    "char_count": 6,
                    "text": "hello world",
                    "prev_chunk_id": None,
                    "next_chunk_id": None,
                }
            ],
            [[1.0, 0.0, 0.0, 0.0]],
        )
    rag_store.write_manifest(embed_model="m", embed_dimension=4)


def _stub_embed(
    monkeypatch: pytest.MonkeyPatch,
    *,
    embed_error: Exception | None = None,
) -> None:
    def fake_embed_texts(texts, kind, settings, **_):  # noqa: ARG001
        if embed_error:
            raise embed_error
        return [[1.0, 0.0, 0.0, 0.0] for _ in texts]

    monkeypatch.setattr(rag_embed, "embed_texts", fake_embed_texts)


# ---- retrieval ---------------------------------------------------------


def test_search_returns_the_chunk_with_its_text(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The connected model answers from the chunk text, so the text has
    to survive all the way out — the old citation payload stripped it."""
    from services import retrieval

    _seed_chunk(tmp_path)
    _stub_embed(monkeypatch)

    result = retrieval.search("what happened")
    assert [h.chunk_id for h in result.hits] == ["C__P__2026-01-01__IC#0"]
    hit = result.hits[0]
    assert hit.text == "hello world"
    assert hit.character == "C"
    assert hit.partner == "P"
    assert hit.date == "2026-01-01"
    assert hit.label == "IC"
    # The configured embedding model, not the one recorded in the
    # manifest — the caller wants to know what embedded the query.
    assert result.embed_model


def test_search_scope_narrows_to_one_partner(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from services import retrieval

    _seed_chunk(tmp_path)
    _stub_embed(monkeypatch)

    assert retrieval.search(
        "q", scope={"character": "C", "partner": "P"}
    ).hits
    assert not retrieval.search(
        "q", scope={"character": "C", "partner": "Nobody"}
    ).hits


def test_search_without_an_index_says_so(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from services import retrieval

    _stub_embed(monkeypatch)
    with pytest.raises(retrieval.NoIndexError) as exc:
        retrieval.search("anything")
    assert "ingest_logs" in str(exc.value)


def test_search_surfaces_an_unreachable_embedding_endpoint(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from services import retrieval

    _seed_chunk(tmp_path)
    _stub_embed(monkeypatch, embed_error=rag_embed.EmbedError("connection refused"))
    with pytest.raises(rag_embed.EmbedError):
        retrieval.search("anything")


def test_search_top_k_override_is_clamped(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from services import retrieval

    _seed_chunk(tmp_path)
    _stub_embed(monkeypatch)
    # Absurd top_k must not raise; it is clamped like the saved setting.
    assert len(retrieval.search("q", top_k=9999).hits) == 1


# ---- settings PUT + GET extended fields --------------------------------


def test_settings_put_persists_retrieval_fields(client: TestClient) -> None:
    res = client.put(
        "/settings",
        json={
            "rag": {
                "rerank_model": "disabled",
                "rerank_candidates": 50,
                "top_k": 8,
                "neighbors": 2,
            }
        },
    ).json()
    rag = res["rag"]
    assert rag["rerank_model"] == "disabled"
    assert rag["rerank_candidates"] == 50
    assert rag["top_k"] == 8
    assert rag["neighbors"] == 2


def test_settings_no_longer_carries_chat_fields(client: TestClient) -> None:
    """Workbench runs no language model; a chat endpoint in Settings
    would be a control with nothing behind it."""
    rag = client.get("/settings").json()["rag"]
    for gone in (
        "chat_endpoint",
        "chat_model",
        "chat_api_key",
        "chat_system_prompt",
        "chat_num_ctx",
        "multiquery_enabled",
        "multiquery_variants",
    ):
        assert gone not in rag, gone
        assert gone not in rag["defaults"], gone
    labels = client.get("/settings").json()["labels"]
    for gone in ("llm_endpoint", "llm_model", "llm_api_key", "system_prompt"):
        assert gone not in labels, gone


def test_settings_clamps_runaway_top_k(client: TestClient) -> None:
    res = client.put("/settings", json={"rag": {"top_k": 9999}}).json()
    assert res["rag"]["top_k"] == 50  # capped at 50


def test_settings_persists_chunk_settings(client: TestClient) -> None:
    res = client.put(
        "/settings",
        json={
            "rag": {
                "chunk_max_chars": 3000,
                "chunk_soft_split_chars": 2400,
                "chunk_overlap_msgs": 2,
            }
        },
    ).json()
    # Stored as asked, then reported clamped to the embedding model's
    # window — the model truncates past it without saying so.
    import rag as rag_settings

    cap = rag_settings.rag_embed_local.profile_for(
        rag_settings.DEFAULT_EMBED_MODEL
    ).max_chars
    assert res["rag"]["chunk_max_chars"] == min(3000, cap)
    assert res["rag"]["chunk_soft_split_chars"] < res["rag"]["chunk_max_chars"]
    assert res["rag"]["chunk_overlap_msgs"] == 2


def test_settings_clamps_chunk_settings(client: TestClient) -> None:
    res = client.put(
        "/settings",
        json={
            "rag": {
                "chunk_max_chars": 999999,  # clamped to 20000
                "chunk_overlap_msgs": 99,  # clamped to 5
            }
        },
    ).json()
    import rag as rag_settings

    cap = rag_settings.rag_embed_local.profile_for(
        rag_settings.DEFAULT_EMBED_MODEL
    ).max_chars
    assert res["rag"]["chunk_max_chars"] == cap
    assert res["rag"]["chunk_overlap_msgs"] == 5


def test_settings_soft_split_respects_current_max(client: TestClient) -> None:
    # Set max to 1500, then try to set soft_split to 5000 — should clamp
    # below max so the chunker's split logic always has headroom.
    client.put("/settings", json={"rag": {"chunk_max_chars": 1500}})
    res = client.put(
        "/settings", json={"rag": {"chunk_soft_split_chars": 5000}}
    ).json()
    assert res["rag"]["chunk_soft_split_chars"] <= 1400  # max - 100


def test_rag_wipe_clears_collection_and_manifest(
    client: TestClient, tmp_path: Path
) -> None:
    # Seed a collection + manifest, then hit /rag/wipe.
    with rag_store.RagStore(path=tmp_path / "qdrant") as store:
        store.ensure_collection(vector_size=4)
        store.upsert_chunks(
            [
                {
                    "chunk_id": "C__P__2026-01-01__IC#0",
                    "char_owner": "C",
                    "partner": "P",
                    "date": "2026-01-01",
                    "label": "IC",
                    "subchunk": 0,
                    "ts_start": 0,
                    "ts_end": 1,
                    "speakers": ["C"],
                    "msg_count": 1,
                    "char_count": 5,
                    "text": "hello",
                    "prev_chunk_id": None,
                    "next_chunk_id": None,
                }
            ],
            [[1.0, 0.0, 0.0, 0.0]],
        )
    rag_store.write_manifest(embed_model="m", embed_dimension=4)

    res = client.post("/rag/wipe").json()
    assert res == {"wiped": True}

    # Status should report a fresh slate.
    status = client.get("/rag/status").json()
    assert status["embed_model"] is None
    assert status["embed_dimension"] is None
    assert status["chunk_count"] == 0


def test_settings_exposes_chunk_defaults(client: TestClient) -> None:
    res = client.get("/settings").json()
    import rag as rag_settings

    d = res["rag"]["defaults"]
    assert d["chunk_max_chars"] == rag_settings.DEFAULT_CHUNK_MAX_CHARS
    assert d["chunk_soft_split_chars"] == rag_settings.DEFAULT_CHUNK_SOFT_SPLIT_CHARS
    assert d["chunk_overlap_msgs"] == rag_settings.DEFAULT_CHUNK_OVERLAP_MSGS


# ---- labels.connect side-effect: rag_meta lives in same DB --------------


def test_no_collision_with_labels_db(client: TestClient, tmp_path: Path) -> None:
    """Sanity: writing rag_meta and labels into the same SQLite file
    leaves both readable. The manifest test in test_rag_store covers
    the manifest itself; this one guards against an unintended schema
    interaction (e.g. UNIQUE on a shared key).
    """
    rag_store.write_manifest(embed_model="m", embed_dimension=8)
    conn = labels_store.connect()
    try:
        labels_store.upsert_label(
            conn,
            hash="aaaaaaaaaaaaaaaa",
            character="C",
            partner="P",
            ts=1,
            speaker="X",
            label="IC",
            source="mcp",
        )
        labels = conn.execute("SELECT COUNT(*) AS n FROM labels").fetchone()["n"]
        meta = conn.execute("SELECT COUNT(*) AS n FROM rag_meta").fetchone()["n"]
    finally:
        conn.close()
    assert labels == 1
    assert meta >= 2  # embed_model + embed_dimension + last_ingest_at
