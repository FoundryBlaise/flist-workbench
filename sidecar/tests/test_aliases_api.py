"""HTTP tests for /aliases CRUD + RAG scope expansion."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

import pytest
from fastapi.testclient import TestClient

import aliases as aliases_store
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
    # Same rerank stub used by the rag_query_api suite — no fastembed
    # downloads at test time.
    class _FakeEncoder:
        def rerank(self, query: str, docs):
            return [float(len(d)) for d in docs]

    monkeypatch.setattr(rag_rerank, "_build_encoder", lambda *_a, **_k: _FakeEncoder())
    from server import app

    return TestClient(app)


# ---- CRUD --------------------------------------------------------------


def test_aliases_get_empty_for_fresh_install(client: TestClient) -> None:
    res = client.get("/aliases?char=MyChar").json()
    assert res == {"character": "MyChar", "groups": {}}


def test_aliases_post_then_get_round_trip(client: TestClient) -> None:
    res = client.post(
        "/aliases",
        json={
            "character": "MyChar",
            "name": "Daemon Enariel",
            "primary_name": "Ashvalia",
        },
    )
    assert res.status_code == 201
    body = res.json()
    assert body["primary_name"] == "Ashvalia"
    assert sorted(body["group"]) == ["Ashvalia", "Daemon Enariel"]

    listed = client.get("/aliases?char=MyChar").json()
    assert sorted(listed["groups"]["Ashvalia"]) == ["Ashvalia", "Daemon Enariel"]


def test_aliases_post_is_idempotent(client: TestClient) -> None:
    client.post(
        "/aliases",
        json={
            "character": "C",
            "name": "OldName",
            "primary_name": "NewName",
        },
    )
    res = client.post(
        "/aliases",
        json={
            "character": "C",
            "name": "OldName",
            "primary_name": "NewName",
        },
    )
    assert res.status_code == 201
    listed = client.get("/aliases?char=C").json()
    assert sorted(listed["groups"]["NewName"]) == ["NewName", "OldName"]


def test_aliases_delete_drops_single_name(client: TestClient) -> None:
    client.post(
        "/aliases",
        json={"character": "C", "name": "A", "primary_name": "B"},
    )
    res = client.delete("/aliases?char=C&name=A").json()
    assert res["removed"] is True
    listed = client.get("/aliases?char=C").json()
    # B's self-row survives because remove_alias only drops one name.
    assert listed["groups"] == {"B": ["B"]}


def test_aliases_delete_group_drops_all(client: TestClient) -> None:
    client.post(
        "/aliases", json={"character": "C", "name": "A1", "primary_name": "Pri"}
    )
    client.post(
        "/aliases", json={"character": "C", "name": "A2", "primary_name": "Pri"}
    )
    res = client.delete("/aliases/group?char=C&primary=Pri").json()
    assert res["deleted"] == 3  # A1 + A2 + Pri self-row
    assert client.get("/aliases?char=C").json()["groups"] == {}


# ---- RAG scope expansion ----------------------------------------------


def _seed_two_partner_chunks(qdrant_path: Path) -> None:
    """One chunk under each name — verifies that a query scoped to the
    primary surfaces the alias-named chunk via scope expansion."""
    with rag_store.RagStore(path=qdrant_path) as store:
        store.ensure_collection(vector_size=4)
        store.upsert_chunks(
            [
                {
                    "chunk_id": "MyChar__Daemon_Enariel__2026-01-01__IC#0",
                    "char_owner": "MyChar",
                    "partner": "Daemon Enariel",
                    "date": "2026-01-01",
                    "label": "IC",
                    "subchunk": 0,
                    "ts_start": 1735689600,
                    "ts_end": 1735693200,
                    "speakers": ["Daemon Enariel"],
                    "msg_count": 1,
                    "char_count": 12,
                    "text": "old-name line",
                    "prev_chunk_id": None,
                    "next_chunk_id": None,
                },
                {
                    "chunk_id": "MyChar__Ashvalia__2026-01-02__IC#0",
                    "char_owner": "MyChar",
                    "partner": "Ashvalia",
                    "date": "2026-01-02",
                    "label": "IC",
                    "subchunk": 0,
                    "ts_start": 1735776000,
                    "ts_end": 1735779600,
                    "speakers": ["Ashvalia"],
                    "msg_count": 1,
                    "char_count": 14,
                    "text": "new-name line",
                    "prev_chunk_id": None,
                    "next_chunk_id": None,
                },
            ],
            [[1.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0]],
        )
    rag_store.write_manifest(embed_model="m", embed_dimension=4)


def _stub_chat_and_embed(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_embed(texts: list[str], kind, settings, **_):
        return [[1.0, 0.0, 0.0, 0.0] for _ in texts]

    def fake_stream(*a, **k):
        yield "ok"

    monkeypatch.setattr(rag_embed, "embed_texts", fake_embed)
    monkeypatch.setattr(rag_chat, "stream_chat", fake_stream)


def _parse_sse(body: bytes) -> list[tuple[str, dict | str]]:
    import json as _json

    out: list[tuple[str, dict | str]] = []
    for block in body.decode("utf-8").split("\n\n"):
        if not block.strip():
            continue
        event = None
        data_lines = []
        for line in block.split("\n"):
            if line.startswith("event:"):
                event = line[len("event:") :].strip()
            elif line.startswith("data:"):
                data_lines.append(line[len("data:") :].strip())
        if event is None:
            continue
        raw = "\n".join(data_lines)
        try:
            out.append((event, _json.loads(raw)))
        except Exception:
            out.append((event, raw))
    return out


def test_rag_query_scope_expansion_to_alias_group(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A query scoped to (MyChar, Ashvalia) must return BOTH the chunk
    indexed under "Ashvalia" and the chunk indexed under "Daemon
    Enariel" once the rename is linked via /aliases.
    """
    _seed_two_partner_chunks(tmp_path / "qdrant")
    _stub_chat_and_embed(monkeypatch)

    # Without the link: only the partner-matching chunk is returned.
    with client.stream(
        "POST",
        "/rag/query",
        json={
            "question": "what happened",
            "scope": {"character": "MyChar", "partner": "Ashvalia"},
        },
    ) as resp:
        events = _parse_sse(b"".join(resp.iter_bytes()))
    done = next(d for e, d in events if e == "done")
    chunk_ids = {c["chunk_id"] for c in done["citations"]}
    assert chunk_ids == {"MyChar__Ashvalia__2026-01-02__IC#0"}

    # Link the rename, then re-query: both chunks now in scope.
    client.post(
        "/aliases",
        json={
            "character": "MyChar",
            "name": "Daemon Enariel",
            "primary_name": "Ashvalia",
        },
    )
    with client.stream(
        "POST",
        "/rag/query",
        json={
            "question": "what happened",
            "scope": {"character": "MyChar", "partner": "Ashvalia"},
        },
    ) as resp:
        events = _parse_sse(b"".join(resp.iter_bytes()))
    done = next(d for e, d in events if e == "done")
    chunk_ids = {c["chunk_id"] for c in done["citations"]}
    assert chunk_ids == {
        "MyChar__Ashvalia__2026-01-02__IC#0",
        "MyChar__Daemon_Enariel__2026-01-01__IC#0",
    }


# ---- override normalization -------------------------------------------


def test_override_normalises_partner_to_primary(
    client: TestClient, tmp_path: Path
) -> None:
    """Manual override under the alias name writes the row under the
    primary, so subsequent reads via the merged conversation see it
    without needing a SQL migration."""
    # Pre-link the rename.
    client.post(
        "/aliases",
        json={
            "character": "MyChar",
            "name": "Daemon Enariel",
            "primary_name": "Ashvalia",
        },
    )

    # Override sent under the OLD name → row should land under the
    # NEW (primary) name in the DB.
    client.post(
        "/labels/override",
        json={
            "character": "MyChar",
            "partner": "Daemon Enariel",
            "hash": "ffffffffffffffff",
            "ts": 1,
            "speaker": "X",
            "label": "OOC",
        },
    )

    labels_conn = labels_store.connect()
    try:
        row = labels_conn.execute(
            "SELECT partner FROM labels WHERE hash = ?",
            ("ffffffffffffffff",),
        ).fetchone()
    finally:
        labels_conn.close()
    assert row["partner"] == "Ashvalia"
