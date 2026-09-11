"""HTTP tests for /aliases CRUD + RAG scope expansion."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

import pytest
from fastapi.testclient import TestClient

import aliases as aliases_store
import labels as labels_store
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
            "name": "Daelan Envale",
            "primary_name": "Asmira",
        },
    )
    assert res.status_code == 201
    body = res.json()
    assert body["primary_name"] == "Asmira"
    assert sorted(body["group"]) == ["Asmira", "Daelan Envale"]

    listed = client.get("/aliases?char=MyChar").json()
    assert sorted(listed["groups"]["Asmira"]) == ["Asmira", "Daelan Envale"]


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
                    "chunk_id": "MyChar__Daelan_Envale__2026-01-01__IC#0",
                    "char_owner": "MyChar",
                    "partner": "Daelan Envale",
                    "date": "2026-01-01",
                    "label": "IC",
                    "subchunk": 0,
                    "ts_start": 1735689600,
                    "ts_end": 1735693200,
                    "speakers": ["Daelan Envale"],
                    "msg_count": 1,
                    "char_count": 12,
                    "text": "old-name line",
                    "prev_chunk_id": None,
                    "next_chunk_id": None,
                },
                {
                    "chunk_id": "MyChar__Asmira__2026-01-02__IC#0",
                    "char_owner": "MyChar",
                    "partner": "Asmira",
                    "date": "2026-01-02",
                    "label": "IC",
                    "subchunk": 0,
                    "ts_start": 1735776000,
                    "ts_end": 1735779600,
                    "speakers": ["Asmira"],
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


def _stub_embed(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_embed(texts: list[str], kind, settings, **_):
        return [[1.0, 0.0, 0.0, 0.0] for _ in texts]

    monkeypatch.setattr(rag_embed, "embed_texts", fake_embed)


def test_search_scope_expands_to_the_alias_group(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A search scoped to (MyChar, Asmira) must return BOTH the chunk
    indexed under "Asmira" and the chunk indexed under the pre-rename
    "Daelan Envale" once the rename is linked via /aliases.
    """
    from services import retrieval

    _seed_two_partner_chunks(tmp_path / "qdrant")
    _stub_embed(monkeypatch)
    scope = {"character": "MyChar", "partner": "Asmira"}

    # Without the link: only the partner-matching chunk is in scope.
    result = retrieval.search("what happened", scope=scope)
    assert {h.chunk_id for h in result.hits} == {
        "MyChar__Asmira__2026-01-02__IC#0"
    }

    # Link the rename, then search again: both chunks now in scope.
    client.post(
        "/aliases",
        json={
            "character": "MyChar",
            "name": "Daelan Envale",
            "primary_name": "Asmira",
        },
    )
    result = retrieval.search("what happened", scope=scope)
    assert {h.chunk_id for h in result.hits} == {
        "MyChar__Asmira__2026-01-02__IC#0",
        "MyChar__Daelan_Envale__2026-01-01__IC#0",
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
            "name": "Daelan Envale",
            "primary_name": "Asmira",
        },
    )

    # Override sent under the OLD name → row should land under the
    # NEW (primary) name in the DB.
    client.post(
        "/labels/override",
        json={
            "character": "MyChar",
            "partner": "Daelan Envale",
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
    assert row["partner"] == "Asmira"
