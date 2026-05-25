"""SSE endpoint tests for /rag/query.

Pipeline is heavily mocked: probe/embed/rerank/chat are all stubbed so
the test runs in <1 s and asserts the SSE wire format, error stages,
and citation payload shape.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

import pytest
from fastapi.testclient import TestClient

import labels as labels_store
import rag_chat
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


def _stub_pipeline(
    monkeypatch: pytest.MonkeyPatch,
    *,
    chat_chunks: Iterable[str] = ("Hello", " world"),
    chat_error: Exception | None = None,
    embed_error: Exception | None = None,
) -> None:
    def fake_embed_texts(texts, kind, settings, **_):  # noqa: ARG001
        if embed_error:
            raise embed_error
        return [[1.0, 0.0, 0.0, 0.0] for _ in texts]

    monkeypatch.setattr(rag_embed, "embed_texts", fake_embed_texts)

    def fake_stream_chat(*args, **kwargs):  # noqa: ARG001
        if chat_error:
            raise chat_error
        for c in chat_chunks:
            yield c

    monkeypatch.setattr(rag_chat, "stream_chat", fake_stream_chat)


# ---- happy path --------------------------------------------------------


def test_query_streams_tokens_and_done(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_chunk(tmp_path)
    _stub_pipeline(monkeypatch, chat_chunks=["Hi ", "there"])

    with client.stream(
        "POST", "/rag/query", json={"question": "what happened?"}
    ) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        events = _parse_sse(b"".join(resp.iter_bytes()))

    names = [e for e, _ in events]
    # Order: retrieved → token...token → done. No error events.
    assert names[0] == "retrieved"
    assert names[-1] == "done"
    assert "error" not in names
    tokens = [d.get("content") for e, d in events if e == "token"]
    assert tokens == ["Hi ", "there"]
    done = events[-1][1]
    assert isinstance(done, dict)
    assert "citations" in done
    cites = done["citations"]
    assert len(cites) == 1
    assert cites[0]["chunk_id"] == "C__P__2026-01-01__IC#0"
    assert cites[0]["ts_start"] == 1735689600


def test_query_scope_filter_narrows_hits(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Two chunks in different partners — scope must trim out one.
    with rag_store.RagStore(path=tmp_path / "qdrant") as store:
        store.ensure_collection(vector_size=4)
        store.upsert_chunks(
            [
                {
                    "chunk_id": "C__A__2026-01-01__IC#0",
                    "char_owner": "C",
                    "partner": "A",
                    "date": "2026-01-01",
                    "label": "IC",
                    "subchunk": 0,
                    "ts_start": 1,
                    "ts_end": 2,
                    "speakers": ["A"],
                    "msg_count": 1,
                    "char_count": 1,
                    "text": "alpha",
                    "prev_chunk_id": None,
                    "next_chunk_id": None,
                },
                {
                    "chunk_id": "C__B__2026-01-01__IC#0",
                    "char_owner": "C",
                    "partner": "B",
                    "date": "2026-01-01",
                    "label": "IC",
                    "subchunk": 0,
                    "ts_start": 1,
                    "ts_end": 2,
                    "speakers": ["B"],
                    "msg_count": 1,
                    "char_count": 1,
                    "text": "beta",
                    "prev_chunk_id": None,
                    "next_chunk_id": None,
                },
            ],
            [[1.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0]],
        )
    rag_store.write_manifest(embed_model="m", embed_dimension=4)
    _stub_pipeline(monkeypatch, chat_chunks=["x"])

    with client.stream(
        "POST",
        "/rag/query",
        json={
            "question": "q",
            "scope": {"character": "C", "partner": "A"},
        },
    ) as resp:
        events = _parse_sse(b"".join(resp.iter_bytes()))
    done = next(d for e, d in events if e == "done")
    cites = done["citations"]
    assert {c["chunk_id"] for c in cites} == {"C__A__2026-01-01__IC#0"}


# ---- failure modes -----------------------------------------------------


def test_query_emits_error_when_no_index(client: TestClient) -> None:
    with client.stream(
        "POST", "/rag/query", json={"question": "anything"}
    ) as resp:
        events = _parse_sse(b"".join(resp.iter_bytes()))
    # First (and only) event is a retrieval-stage error.
    assert len(events) == 1
    event, payload = events[0]
    assert event == "error"
    assert payload["stage"] == "retrieval"
    assert "no RAG index" in payload["message"]


def test_query_emits_error_on_embed_failure(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_chunk(tmp_path)
    _stub_pipeline(monkeypatch, embed_error=rag_embed.EmbedError("HTTP 404"))

    with client.stream(
        "POST", "/rag/query", json={"question": "q"}
    ) as resp:
        events = _parse_sse(b"".join(resp.iter_bytes()))
    # Stop at the first error event.
    errors = [(e, d) for e, d in events if e == "error"]
    assert errors
    assert errors[0][1]["stage"] == "embed"


def test_query_emits_error_on_chat_failure(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_chunk(tmp_path)
    _stub_pipeline(monkeypatch, chat_error=rag_chat.ChatError("model OOM"))

    with client.stream(
        "POST", "/rag/query", json={"question": "q"}
    ) as resp:
        events = _parse_sse(b"".join(resp.iter_bytes()))
    # `retrieved` lands first (retrieval succeeded), then the chat error.
    names = [e for e, _ in events]
    assert names[0] == "retrieved"
    errs = [(e, d) for e, d in events if e == "error"]
    assert errs
    assert errs[0][1]["stage"] == "chat"
    assert "model OOM" in errs[0][1]["message"]


def test_query_per_request_top_k_override(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Seed a couple of chunks; top_k=1 must return exactly one citation.
    with rag_store.RagStore(path=tmp_path / "qdrant") as store:
        store.ensure_collection(vector_size=4)
        store.upsert_chunks(
            [
                {
                    "chunk_id": f"C__P__2026-01-01__IC#{i}",
                    "char_owner": "C",
                    "partner": "P",
                    "date": "2026-01-01",
                    "label": "IC",
                    "subchunk": i,
                    "ts_start": i,
                    "ts_end": i + 1,
                    "speakers": ["C"],
                    "msg_count": 1,
                    "char_count": 5,
                    "text": f"chunk {i}",
                    "prev_chunk_id": None,
                    "next_chunk_id": None,
                }
                for i in range(3)
            ],
            [[1.0 - 0.1 * i, 0.0, 0.0, 0.0] for i in range(3)],
        )
    rag_store.write_manifest(embed_model="m", embed_dimension=4)
    _stub_pipeline(monkeypatch, chat_chunks=["x"])

    with client.stream(
        "POST",
        "/rag/query",
        json={"question": "q", "top_k": 1, "neighbors": 0},
    ) as resp:
        events = _parse_sse(b"".join(resp.iter_bytes()))
    done = next(d for e, d in events if e == "done")
    assert len(done["citations"]) == 1


# ---- settings PUT + GET extended fields --------------------------------


def test_settings_put_persists_rag_chat_fields(client: TestClient) -> None:
    res = client.put(
        "/settings",
        json={
            "rag": {
                "chat_endpoint": "http://chat.test/v1",
                "chat_model": "gpt-test",
                "chat_api_key": "sk-x",
                "chat_system_prompt": "answer briefly",
                "rerank_model": "disabled",
                "rerank_candidates": 50,
                "top_k": 8,
                "neighbors": 2,
            }
        },
    ).json()
    rag = res["rag"]
    assert rag["chat_endpoint"] == "http://chat.test/v1"
    assert rag["chat_model"] == "gpt-test"
    assert rag["chat_api_key"] == "sk-x"
    assert rag["chat_system_prompt"] == "answer briefly"
    assert rag["rerank_model"] == "disabled"
    assert rag["rerank_candidates"] == 50
    assert rag["top_k"] == 8
    assert rag["neighbors"] == 2


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
    assert res["rag"]["chunk_max_chars"] == 3000
    assert res["rag"]["chunk_soft_split_chars"] == 2400
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
    assert res["rag"]["chunk_max_chars"] == 20000
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


def test_settings_default_chat_prompt_is_english(client: TestClient) -> None:
    res = client.get("/settings").json()
    # The default lives in rag_query — we can't import directly here
    # without circular ugliness, so check a phrase that's stable.
    assert "saved\nroleplay logs" in res["rag"]["defaults"]["chat_system_prompt"] or (
        "based on the provided context"
        in res["rag"]["defaults"]["chat_system_prompt"].lower()
    )


def test_settings_chat_prompt_falls_back_to_default_when_empty(
    client: TestClient,
) -> None:
    # Save a custom prompt then clear it; the reload must surface the default.
    client.put("/settings", json={"rag": {"chat_system_prompt": "custom"}})
    res = client.put("/settings", json={"rag": {"chat_system_prompt": ""}}).json()
    assert res["rag"]["chat_system_prompt"] != "custom"
    assert (
        "based on the provided context"
        in res["rag"]["chat_system_prompt"].lower()
    )


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
            source="llm",
        )
        labels = conn.execute("SELECT COUNT(*) AS n FROM labels").fetchone()["n"]
        meta = conn.execute("SELECT COUNT(*) AS n FROM rag_meta").fetchone()["n"]
    finally:
        conn.close()
    assert labels == 1
    assert meta >= 2  # embed_model + embed_dimension + last_ingest_at
