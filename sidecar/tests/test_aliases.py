"""partner_aliases — DB layer tests.

No mocking; uses a real SQLite file in tmp_path. The module shares
labels.db so we also verify the schema doesn't collide with the
labels/rag_meta tables already in that file.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import aliases
import labels as labels_store


@pytest.fixture
def conn(tmp_path: Path) -> "object":
    c = aliases.connect(root=tmp_path)
    yield c
    c.close()


# ---- read paths --------------------------------------------------------


def test_primary_for_unaliased_name_returns_itself(conn) -> None:
    assert aliases.primary_for(conn, "MyChar", "Unknown") == "Unknown"


def test_all_names_for_unaliased_returns_singleton(conn) -> None:
    assert aliases.all_names_for(conn, "MyChar", "Solo") == ["Solo"]


def test_list_groups_empty_when_no_aliases(conn) -> None:
    assert aliases.list_groups(conn, "MyChar") == {}


# ---- write + read round-trip ------------------------------------------


def test_add_alias_creates_group_and_self_link(conn) -> None:
    aliases.add_alias(conn, "MyChar", "Daemon Enariel", "Ashvalia")
    assert aliases.primary_for(conn, "MyChar", "Daemon Enariel") == "Ashvalia"
    assert aliases.primary_for(conn, "MyChar", "Ashvalia") == "Ashvalia"
    names = aliases.all_names_for(conn, "MyChar", "Daemon Enariel")
    assert sorted(names) == ["Ashvalia", "Daemon Enariel"]


def test_all_names_for_works_from_either_member(conn) -> None:
    aliases.add_alias(conn, "C", "OldName", "NewName")
    from_alias = aliases.all_names_for(conn, "C", "OldName")
    from_primary = aliases.all_names_for(conn, "C", "NewName")
    assert sorted(from_alias) == sorted(from_primary) == ["NewName", "OldName"]


def test_add_alias_is_idempotent(conn) -> None:
    aliases.add_alias(conn, "C", "A", "B")
    aliases.add_alias(conn, "C", "A", "B")  # second call no-op
    assert aliases.all_names_for(conn, "C", "A") == ["A", "B"]


def test_add_alias_rejects_blank_names(conn) -> None:
    with pytest.raises(ValueError):
        aliases.add_alias(conn, "C", "", "B")
    with pytest.raises(ValueError):
        aliases.add_alias(conn, "C", "A", "  ")


def test_add_alias_self_link_is_noop_but_creates_primary_row(conn) -> None:
    aliases.add_alias(conn, "C", "Self", "Self")
    # The group is just the primary; not an "aliased" partner per the
    # external contract, but the row exists so other queries can find it.
    assert aliases.primary_for(conn, "C", "Self") == "Self"


def test_add_alias_normalises_chains_to_one_primary(conn) -> None:
    # Link A → B, then later C → A. The user thinks "A and C are the
    # same"; after the second call A and C should both report C as
    # primary (the new explicit choice), and B should follow too —
    # otherwise we'd build a chain that breaks the single-query
    # "all names in group" guarantee.
    aliases.add_alias(conn, "C", "A", "B")
    aliases.add_alias(conn, "C", "A", "C-canonical")
    primaries = {
        n: aliases.primary_for(conn, "C", n) for n in ("A", "B", "C-canonical")
    }
    # All three end up in the same group rooted at C-canonical.
    assert set(primaries.values()) == {"C-canonical"}
    assert sorted(aliases.all_names_for(conn, "C", "A")) == [
        "A",
        "B",
        "C-canonical",
    ]


def test_list_groups_buckets_by_primary(conn) -> None:
    aliases.add_alias(conn, "C", "A1", "Alpha")
    aliases.add_alias(conn, "C", "A2", "Alpha")
    aliases.add_alias(conn, "C", "B1", "Beta")
    groups = aliases.list_groups(conn, "C")
    assert sorted(groups["Alpha"]) == ["A1", "A2", "Alpha"]
    assert sorted(groups["Beta"]) == ["B1", "Beta"]


def test_aliases_scoped_per_character(conn) -> None:
    # Same alias name in two characters' contexts must not bleed.
    aliases.add_alias(conn, "Char1", "Foo", "Bar")
    aliases.add_alias(conn, "Char2", "Foo", "Quux")
    assert aliases.primary_for(conn, "Char1", "Foo") == "Bar"
    assert aliases.primary_for(conn, "Char2", "Foo") == "Quux"


# ---- delete -----------------------------------------------------------


def test_remove_alias_drops_one_row(conn) -> None:
    aliases.add_alias(conn, "C", "Old", "New")
    assert aliases.remove_alias(conn, "C", "Old") is True
    assert aliases.primary_for(conn, "C", "Old") == "Old"
    # The primary's self-row is left intact unless explicitly unlinked.
    assert aliases.primary_for(conn, "C", "New") == "New"


def test_remove_alias_returns_false_for_unknown(conn) -> None:
    assert aliases.remove_alias(conn, "C", "never-was") is False


def test_unlink_group_drops_every_row(conn) -> None:
    aliases.add_alias(conn, "C", "A", "Prim")
    aliases.add_alias(conn, "C", "B", "Prim")
    aliases.add_alias(conn, "C", "C", "Prim")
    deleted = aliases.unlink_group(conn, "C", "Prim")
    # 4 rows: A, B, C, Prim itself.
    assert deleted == 4
    assert aliases.list_groups(conn, "C") == {}


# ---- coexistence with labels.db schema --------------------------------


def test_aliases_and_labels_coexist_in_one_db(conn, tmp_path: Path) -> None:
    """Sanity: aliases shares labels.db, so opening one connection that
    runs both schemas must leave both tables readable.
    """
    aliases.add_alias(conn, "C", "Old", "New")
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
    rows = conn.execute("SELECT COUNT(*) AS n FROM partner_aliases").fetchone()["n"]
    lab = conn.execute("SELECT COUNT(*) AS n FROM labels").fetchone()["n"]
    assert rows >= 2  # alias row + auto-created primary row
    assert lab == 1


# ---- alias-aware label queries ----------------------------------------


def test_labels_for_partner_with_aliases_returns_union(conn) -> None:
    """labels_for_partner pools rows across every name in the alias
    group when the caller supplies partner_aliases."""
    # Two labels under the old name, one under the new — both rows
    # belong to the same logical conversation post-rename.
    labels_store.upsert_label(
        conn, hash="h_old_1", character="C", partner="Daemon Enariel",
        ts=1, speaker="X", label="IC", source="llm",
    )
    labels_store.upsert_label(
        conn, hash="h_old_2", character="C", partner="Daemon Enariel",
        ts=2, speaker="X", label="OOC", source="llm",
    )
    labels_store.upsert_label(
        conn, hash="h_new_1", character="C", partner="Ashvalia",
        ts=3, speaker="X", label="IC", source="manual",
    )

    aliases.add_alias(conn, "C", "Daemon Enariel", "Ashvalia")
    group = aliases.all_names_for(conn, "C", "Ashvalia")

    # Without aliases: only Ashvalia's row (single-partner behaviour).
    flat = labels_store.labels_for_partner(conn, "C", "Ashvalia")
    assert set(flat) == {"h_new_1"}

    # With aliases: union across both names.
    merged = labels_store.labels_for_partner(
        conn, "C", "Ashvalia", partner_aliases=group
    )
    assert set(merged) == {"h_old_1", "h_old_2", "h_new_1"}


def test_delete_labels_for_partner_with_aliases_clears_group(conn) -> None:
    labels_store.upsert_label(
        conn, hash="h1", character="C", partner="Daemon Enariel",
        ts=1, speaker="X", label="IC", source="llm",
    )
    labels_store.upsert_label(
        conn, hash="h2", character="C", partner="Ashvalia",
        ts=2, speaker="X", label="OOC", source="llm",
    )
    # Unrelated conversation that must survive.
    labels_store.upsert_label(
        conn, hash="h3", character="C", partner="Other",
        ts=3, speaker="X", label="IC", source="llm",
    )

    aliases.add_alias(conn, "C", "Daemon Enariel", "Ashvalia")
    group = aliases.all_names_for(conn, "C", "Ashvalia")
    deleted = labels_store.delete_labels_for_partner(
        conn, "C", "Ashvalia", partner_aliases=group
    )
    assert deleted == 2
    surviving = conn.execute("SELECT hash FROM labels").fetchall()
    assert {r["hash"] for r in surviving} == {"h3"}
