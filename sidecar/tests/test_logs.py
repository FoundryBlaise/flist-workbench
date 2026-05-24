from pathlib import Path

import pytest

from logs import LogDirError, find_contacts, list_characters, list_partners, search_all_partners


@pytest.fixture
def fake_data(tmp_path: Path) -> Path:
    # Two characters; one has partners with idx pairs + a channel + the _ scratch file.
    char_a = tmp_path / "Aurora Frost" / "logs"
    char_a.mkdir(parents=True)
    (char_a / "Daemon Enariel").write_bytes(b"\x00" * 1024)
    (char_a / "Daemon Enariel.idx").write_bytes(b"\x00" * 16)
    (char_a / "#german ooc").write_bytes(b"\x00" * 512)
    (char_a / "#german ooc.idx").write_bytes(b"\x00" * 8)
    (char_a / "_").write_bytes(b"\x00" * 4)

    char_b = tmp_path / "Vanessa Arlington" / "logs"
    char_b.mkdir(parents=True)
    (char_b / "Bobbie Sue").write_bytes(b"\x00" * 256)
    (char_b / "Bobbie Sue.idx").write_bytes(b"")

    # A bogus hidden dir that should be ignored.
    (tmp_path / ".cache").mkdir()
    return tmp_path


def test_list_characters(fake_data: Path) -> None:
    chars = list_characters(root=fake_data)
    assert [c.name for c in chars] == ["Aurora Frost", "Vanessa Arlington"]
    # Both characters have a populated logs/ directory so mtime > 0.
    assert all(c.mtime > 0 for c in chars)


def test_list_partners_filters_idx_and_scratch(fake_data: Path) -> None:
    partners = list_partners("Aurora Frost", root=fake_data)
    names = [p.name for p in partners]
    assert names == ["#german ooc", "Daemon Enariel"]
    # Sizes are real file sizes.
    sizes = {p.name: p.bytes for p in partners}
    assert sizes["Daemon Enariel"] == 1024
    assert sizes["#german ooc"] == 512


def test_unknown_character(fake_data: Path) -> None:
    with pytest.raises(LogDirError):
        list_partners("Nobody Here", root=fake_data)


def test_search_all_partners_empty_query(fake_data: Path) -> None:
    result = search_all_partners("Aurora Frost", "", root=fake_data)
    assert result == {"character": "Aurora Frost", "query": "", "hits": []}


def test_search_all_partners_returns_per_partner_shape(fake_data: Path) -> None:
    # The fixture writes zeroed binary logs that parse to zero
    # messages, so there are no hits — but the structure must be
    # well-formed (the cross-partner UI binds against this shape).
    result = search_all_partners("Aurora Frost", "anything", root=fake_data)
    assert result["character"] == "Aurora Frost"
    assert result["query"] == "anything"
    assert "partners" in result


def test_find_contacts_empty_name(fake_data: Path) -> None:
    res = find_contacts("", root=fake_data)
    assert res == {"name": "", "dm": [], "channels": []}


def test_find_contacts_matches_dm_partner_case_insensitive(fake_data: Path) -> None:
    # Aurora Frost has a "Daemon Enariel" DM partner; query should
    # match regardless of case and exclude the named character itself
    # from results.
    res = find_contacts("DAEMON ENARIEL", root=fake_data)
    assert res["name"] == "DAEMON ENARIEL"
    chars = [d["character"] for d in res["dm"]]
    assert "Aurora Frost" in chars
    # Each DM entry carries partner + bytes for the renderer.
    aurora = next(d for d in res["dm"] if d["character"] == "Aurora Frost")
    assert aurora["partner"] == "Daemon Enariel"
    assert aurora["bytes"] == 1024


def test_find_contacts_skips_the_named_character(fake_data: Path) -> None:
    # Querying "Vanessa Arlington" must not list Vanessa-as-character
    # in the DM results (you don't have "contact" with yourself).
    res = find_contacts("Vanessa Arlington", root=fake_data)
    chars = [d["character"] for d in res["dm"]]
    assert "Vanessa Arlington" not in chars


def test_find_contacts_no_match(fake_data: Path) -> None:
    res = find_contacts("Nobody In Particular", root=fake_data)
    assert res["dm"] == []
    assert res["channels"] == []
