"""rag_lexical tests — real SQLite FTS5, no mocks."""

from __future__ import annotations

from pathlib import Path

import pytest

import rag_lexical
import rag_store


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin labels.db / qdrant / models / etc. under tmp_path so tests
    can't see one another's state or touch the user's real data dir."""
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))


def _mkchunk(cid: str, *, char="Ash", partner="Lia", text="hello world") -> dict:
    return {
        "chunk_id": cid,
        "char_owner": char,
        "partner": partner,
        "text": text,
    }


# ---- basic upsert + search --------------------------------------------


def test_upsert_then_search_finds_keyword() -> None:
    with rag_lexical.LexicalStore() as lex:
        lex.upsert_chunks(
            [
                _mkchunk("a", text="Amber bestellte einen Cocktail an der Bar."),
                _mkchunk("b", text="Spazieren gehen am Strand bei Sonnenuntergang."),
                _mkchunk("c", text="Diskussion über Politik und Wetter."),
            ]
        )
        hits = lex.search("Cocktail", limit=5)
    assert hits, "expected at least one hit for an exact keyword"
    assert hits[0].chunk_id == "a"


def test_search_orders_by_bm25_relevance() -> None:
    with rag_lexical.LexicalStore() as lex:
        lex.upsert_chunks(
            [
                _mkchunk("strong", text="Amber Amber Amber Cocktail Cocktail."),
                _mkchunk("weak", text="The bar had many drinks; once, a cocktail."),
            ]
        )
        hits = lex.search("Amber Cocktail", limit=5)
    cids = [h.chunk_id for h in hits]
    assert cids.index("strong") < cids.index("weak")


def test_search_or_fuses_tokens_for_recall() -> None:
    # OR-fusion should surface a chunk that only matches one of the
    # tokens — AND-mode would have dropped this.
    with rag_lexical.LexicalStore() as lex:
        lex.upsert_chunks(
            [
                _mkchunk("only_amber", text="Amber walked into the room."),
                _mkchunk("only_cocktail", text="The cocktail was strong."),
            ]
        )
        hits = lex.search("Amber Cocktail", limit=5)
    cids = {h.chunk_id for h in hits}
    assert cids == {"only_amber", "only_cocktail"}


def test_unicode61_folds_diacritics() -> None:
    # "Ophelia" should match a corpus that only has "Ophélia".
    with rag_lexical.LexicalStore() as lex:
        lex.upsert_chunks(
            [_mkchunk("o", text="Ophélia tanzte durch die Nacht.")]
        )
        hits = lex.search("Ophelia", limit=5)
    assert [h.chunk_id for h in hits] == ["o"]


# ---- scope filtering --------------------------------------------------


def test_search_filters_by_character_and_partner() -> None:
    with rag_lexical.LexicalStore() as lex:
        lex.upsert_chunks(
            [
                _mkchunk("ash_lia", char="Ash", partner="Lia", text="cocktail"),
                _mkchunk("ash_max", char="Ash", partner="Max", text="cocktail"),
                _mkchunk("bob_lia", char="Bob", partner="Lia", text="cocktail"),
            ]
        )
        hits = lex.search("cocktail", scope={"character": "Ash", "partner": "Lia"})
    assert [h.chunk_id for h in hits] == ["ash_lia"]


def test_search_supports_multi_partner_scope() -> None:
    with rag_lexical.LexicalStore() as lex:
        lex.upsert_chunks(
            [
                _mkchunk("a", char="Ash", partner="Lia", text="dragon"),
                _mkchunk("b", char="Ash", partner="Max", text="dragon"),
                _mkchunk("c", char="Ash", partner="Eli", text="dragon"),
            ]
        )
        hits = lex.search(
            "dragon", scope={"character": "Ash", "partners": ["Lia", "Eli"]}
        )
    assert {h.chunk_id for h in hits} == {"a", "c"}


# ---- mutation paths ---------------------------------------------------


def test_upsert_is_idempotent_on_chunk_id() -> None:
    with rag_lexical.LexicalStore() as lex:
        lex.upsert_chunks([_mkchunk("dup", text="version one")])
        lex.upsert_chunks([_mkchunk("dup", text="version two")])
        assert lex.count() == 1
        hits = lex.search("version", limit=5)
    assert len(hits) == 1


def test_delete_scope_removes_only_matching_rows() -> None:
    with rag_lexical.LexicalStore() as lex:
        lex.upsert_chunks(
            [
                _mkchunk("ash_lia", char="Ash", partner="Lia", text="x"),
                _mkchunk("ash_max", char="Ash", partner="Max", text="x"),
            ]
        )
        removed = lex.delete_scope({"character": "Ash", "partner": "Lia"})
    assert removed == 1
    with rag_lexical.LexicalStore() as lex:
        assert lex.count() == 1
        assert lex.count({"character": "Ash", "partner": "Lia"}) == 0


def test_wipe_drops_everything() -> None:
    with rag_lexical.LexicalStore() as lex:
        lex.upsert_chunks([_mkchunk("a"), _mkchunk("b")])
        assert lex.count() == 2
        lex.wipe()
        assert lex.count() == 0
        # Table is recreated and usable.
        lex.upsert_chunks([_mkchunk("c", text="cocktail")])
        assert lex.search("cocktail", limit=5)


# ---- sanitiser ---------------------------------------------------------


def test_punctuation_only_query_returns_no_hits() -> None:
    with rag_lexical.LexicalStore() as lex:
        lex.upsert_chunks([_mkchunk("a")])
        assert lex.search("???", limit=5) == []
        assert lex.search("", limit=5) == []


def test_query_with_fts5_operator_chars_does_not_raise() -> None:
    # User types "AND" or "+name" — sanitiser should not let those reach
    # FTS5 as operators or syntax errors.
    with rag_lexical.LexicalStore() as lex:
        lex.upsert_chunks([_mkchunk("a", text="something Amber")])
        # None of these should raise; "Amber" should still hit.
        for q in ('Amber AND OR NOT', 'Amber NEAR(bar 3)', '"Amber" OR -bad'):
            hits = lex.search(q, limit=5)
            assert any(h.chunk_id == "a" for h in hits), q


# ---- backfill from qdrant ---------------------------------------------


def test_backfill_from_qdrant_rebuilds_lexical_index(tmp_path: Path) -> None:
    # Seed a real RagStore with two chunks, then backfill.
    with rag_store.RagStore(path=tmp_path / "qdrant") as store:
        store.ensure_collection(vector_size=4)
        chunks = [
            {
                "chunk_id": "x",
                "char_owner": "Ash",
                "partner": "Lia",
                "date": "2025-01-01",
                "label": "IC",
                "subchunk": 0,
                "ts_start": 0.0,
                "ts_end": 0.0,
                "speakers": ["Ash"],
                "msg_count": 1,
                "char_count": 10,
                "text": "Pharaonen aus Ägypten regieren das Land.",
                "prev_chunk_id": None,
                "next_chunk_id": None,
            },
            {
                "chunk_id": "y",
                "char_owner": "Ash",
                "partner": "Lia",
                "date": "2025-01-02",
                "label": "IC",
                "subchunk": 0,
                "ts_start": 1.0,
                "ts_end": 1.0,
                "speakers": ["Lia"],
                "msg_count": 1,
                "char_count": 10,
                "text": "Diskussion über Cocktails an der Karaoke-Bar.",
                "prev_chunk_id": None,
                "next_chunk_id": None,
            },
        ]
        vectors = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0]]
        store.upsert_chunks(chunks, vectors)

        with rag_lexical.LexicalStore() as lex:
            assert lex.count() == 0
            written = rag_lexical.backfill_from_qdrant(store, lex)
        assert written == 2
        with rag_lexical.LexicalStore() as lex:
            assert lex.count() == 2
            hits = lex.search("Pharaonen", limit=5)
            assert [h.chunk_id for h in hits] == ["x"]
            hits = lex.search("Cocktails", limit=5)
            assert [h.chunk_id for h in hits] == ["y"]
