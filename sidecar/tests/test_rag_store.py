"""rag_store tests — uses a real embedded QdrantClient in a tmp dir.

We don't mock qdrant-client because the wrapper's value is "does the
embedded path actually round-trip?" — and qdrant-client's local mode is
fast (single ms per operation in-process).
"""

from __future__ import annotations

from pathlib import Path

import pytest

import rag_store


@pytest.fixture
def store(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> rag_store.RagStore:
    # Pin user data dir so manifest writes go to the tmp path.
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    s = rag_store.RagStore(path=tmp_path / "qdrant")
    yield s
    s.close()


def _mkchunk(
    chunk_id: str,
    *,
    character: str = "C",
    partner: str = "P",
    date: str = "2026-01-01",
    label: str = "IC",
    subchunk: int = 0,
    ts_start: int = 0,
    ts_end: int = 100,
    text: str = "hello world",
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


def test_ensure_collection_creates_and_is_idempotent(store: rag_store.RagStore) -> None:
    assert not store.collection_exists()
    store.ensure_collection(vector_size=4)
    assert store.collection_exists()
    # Calling again with same size is a no-op, no raise.
    store.ensure_collection(vector_size=4)


def test_ensure_collection_raises_on_dim_mismatch(store: rag_store.RagStore) -> None:
    store.ensure_collection(vector_size=4)
    with pytest.raises(rag_store.DimensionMismatchError) as exc:
        store.ensure_collection(vector_size=8)
    assert exc.value.expected == 8
    assert exc.value.actual == 4


def test_recreate_collection_wipes_and_resizes(store: rag_store.RagStore) -> None:
    store.ensure_collection(vector_size=4)
    store.upsert_chunks([_mkchunk("a")], [[0.1, 0.2, 0.3, 0.4]])
    assert store.count() == 1
    store.recreate_collection(vector_size=8)
    assert store.count() == 0
    # Old dimensions gone, new ones accepted.
    store.upsert_chunks([_mkchunk("b")], [[0.0] * 8])
    assert store.count() == 1


def test_upsert_and_count_total(store: rag_store.RagStore) -> None:
    store.ensure_collection(vector_size=3)
    store.upsert_chunks(
        [_mkchunk("a"), _mkchunk("b", partner="Other")],
        [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
    )
    assert store.count() == 2


def test_count_with_scope(store: rag_store.RagStore) -> None:
    store.ensure_collection(vector_size=3)
    store.upsert_chunks(
        [
            _mkchunk("a", partner="Alpha"),
            _mkchunk("b", partner="Beta"),
            _mkchunk("c", character="Other", partner="Alpha"),
        ],
        [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
    )
    assert store.count({"character": "C"}) == 2
    assert store.count({"character": "C", "partner": "Alpha"}) == 1
    assert store.count({"character": "C", "partners": ["Alpha", "Beta"]}) == 2


def test_upsert_is_idempotent(store: rag_store.RagStore) -> None:
    store.ensure_collection(vector_size=3)
    store.upsert_chunks([_mkchunk("a", text="v1")], [[1.0, 0.0, 0.0]])
    store.upsert_chunks([_mkchunk("a", text="v2")], [[0.0, 1.0, 0.0]])
    assert store.count() == 1
    fetched = store.fetch_by_chunk_ids({"a"})
    assert fetched["a"]["payload"]["text"] == "v2"


def test_upsert_length_mismatch_raises(store: rag_store.RagStore) -> None:
    store.ensure_collection(vector_size=3)
    with pytest.raises(ValueError, match="length mismatch"):
        store.upsert_chunks([_mkchunk("a"), _mkchunk("b")], [[1.0, 0.0, 0.0]])


def test_existing_chunk_ids_scoped(store: rag_store.RagStore) -> None:
    store.ensure_collection(vector_size=3)
    store.upsert_chunks(
        [
            _mkchunk("a", partner="P1"),
            _mkchunk("b", partner="P2"),
            _mkchunk("c", partner="P1"),
        ],
        [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
    )
    all_ids = store.existing_chunk_ids()
    assert all_ids == {"a", "b", "c"}
    scoped = store.existing_chunk_ids({"character": "C", "partner": "P1"})
    assert scoped == {"a", "c"}


def test_existing_chunk_ids_empty_when_no_collection(store: rag_store.RagStore) -> None:
    assert store.existing_chunk_ids() == set()


def test_search_returns_closest(store: rag_store.RagStore) -> None:
    store.ensure_collection(vector_size=3)
    store.upsert_chunks(
        [_mkchunk("close"), _mkchunk("far")],
        [[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
    )
    hits = store.search([0.99, 0.01, 0.0], limit=2)
    assert hits[0]["payload"]["chunk_id"] == "close"
    assert hits[0]["score"] > hits[1]["score"]


def test_search_with_scope(store: rag_store.RagStore) -> None:
    store.ensure_collection(vector_size=3)
    store.upsert_chunks(
        [
            _mkchunk("ax", partner="A"),
            _mkchunk("bx", partner="B"),
        ],
        [[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
    )
    hits = store.search([1.0, 0.0, 0.0], scope={"character": "C", "partner": "A"}, limit=5)
    assert {h["payload"]["chunk_id"] for h in hits} == {"ax"}


def test_fetch_by_chunk_ids(store: rag_store.RagStore) -> None:
    store.ensure_collection(vector_size=3)
    store.upsert_chunks(
        [_mkchunk("a", text="aaa"), _mkchunk("b", text="bbb")],
        [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
    )
    got = store.fetch_by_chunk_ids({"a", "missing"})
    assert "a" in got
    assert got["a"]["payload"]["text"] == "aaa"
    assert "missing" not in got


def test_fetch_by_chunk_ids_empty_returns_empty(store: rag_store.RagStore) -> None:
    store.ensure_collection(vector_size=3)
    assert store.fetch_by_chunk_ids(set()) == {}


def test_delete_scope_removes_only_matching(store: rag_store.RagStore) -> None:
    store.ensure_collection(vector_size=3)
    store.upsert_chunks(
        [
            _mkchunk("a", partner="P1"),
            _mkchunk("b", partner="P2"),
        ],
        [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
    )
    deleted = store.delete_scope({"character": "C", "partner": "P1"})
    assert deleted == 1
    assert store.existing_chunk_ids() == {"b"}


def test_delete_scope_no_collection_returns_zero(store: rag_store.RagStore) -> None:
    assert store.delete_scope({"character": "C"}) == 0


# -- manifest -----------------------------------------------------------


def test_manifest_round_trip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    blank = rag_store.read_manifest()
    assert blank.embed_model is None
    assert blank.embed_dimension is None
    assert blank.last_ingest_at is None

    rag_store.write_manifest(embed_model="nomic-embed", embed_dimension=768)
    got = rag_store.read_manifest()
    assert got.embed_model == "nomic-embed"
    assert got.embed_dimension == 768
    assert got.last_ingest_at is not None


def test_manifest_clear(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    rag_store.write_manifest(embed_model="m", embed_dimension=4)
    rag_store.clear_manifest()
    blank = rag_store.read_manifest()
    assert blank.embed_model is None
    assert blank.embed_dimension is None


def test_cid_to_uuid_is_deterministic() -> None:
    a = rag_store.cid_to_uuid("foo__bar__2026-01-01__IC#0")
    b = rag_store.cid_to_uuid("foo__bar__2026-01-01__IC#0")
    assert a == b
    assert rag_store.cid_to_uuid("foo__bar__2026-01-01__IC#1") != a
