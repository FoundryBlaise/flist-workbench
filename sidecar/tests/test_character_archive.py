"""Character-archive store tests.

Covers the parts of `character_archive` that are easy to get wrong in
ways that would hurt real users:

- avatar_path_for must never raise on Unicode names (F-list allows
  them); we hash-fallback when the lowercased name leaves the
  safe-name alphabet.
- image_path / inline_path must reject path-traversal payloads in the
  F-list-supplied filename parts.
- save_backup / list_backups must round-trip a snapshot.
"""
from __future__ import annotations

from pathlib import Path

import pytest

import character_archive


@pytest.fixture(autouse=True)
def isolated_userdata(tmp_path, monkeypatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    yield


def test_avatar_path_ascii_uses_slug():
    p = character_archive.avatar_path_for("Lady Amber Blaise")
    assert p.name == "lady_amber_blaise.png"


def test_avatar_path_unicode_hashes_instead_of_raising():
    # F-list permits Unicode names; the old code raised ValueError
    # and the /flist/avatar/{name} endpoint translated that to a 400.
    p = character_archive.avatar_path_for("Café Noir")
    assert p.suffix == ".png"
    # 40-char hex sha1 → 40-char stem.
    assert len(p.stem) == 40
    assert all(c in "0123456789abcdef" for c in p.stem)


def test_avatar_path_unicode_is_case_insensitive():
    # Matches merge_roster's lowercase keying so two cased variants
    # of the same name land on the same avatar file.
    a = character_archive.avatar_path_for("Café Noir")
    b = character_archive.avatar_path_for("café noir")
    assert a == b


def test_image_path_rejects_path_traversal():
    with pytest.raises(ValueError):
        character_archive.image_path("123", "../etc", "png")
    with pytest.raises(ValueError):
        character_archive.image_path("123", "foo/bar", "png")
    with pytest.raises(ValueError):
        character_archive.image_path("123", "ok", "png/../etc")


def test_image_path_safe_stays_under_images_dir():
    p = character_archive.image_path("12345", "30012128", "png")
    # Resolve relative to the character's images dir — if the safe
    # check ever lets a traversal through, relative_to raises.
    p.relative_to(character_archive.images_dir("12345"))


def test_inline_path_rejects_unsafe_basename():
    with pytest.raises(ValueError):
        character_archive.inline_path("123", "..")
    with pytest.raises(ValueError):
        character_archive.inline_path("123", "foo/bar.png")


def test_save_backup_round_trip(tmp_path):
    character_archive.write_live("9999", {"name": "Test", "fetched_at": 100})
    snap = character_archive.save_backup("9999")
    assert snap["filename"].endswith(".json")
    listed = character_archive.list_backups("9999")
    assert len(listed) == 1
    assert listed[0]["filename"] == snap["filename"]
    payload = character_archive.read_backup("9999", snap["filename"])
    assert payload is not None
    assert payload["name"] == "Test"


def test_read_backup_rejects_invalid_filename():
    # Filenames not matching the on-disk regex are refused so a
    # hostile caller can't path-traverse out of backups/.
    assert character_archive.read_backup("123", "../../../etc/passwd") is None
    assert character_archive.read_backup("123", "foo.txt") is None


def test_merge_roster_keeps_case_only_distinct_ids():
    # F-list permits two characters whose names differ only in case.
    # Old lowercased-name keying silently collapsed them into one row
    # with the wrong id surviving. With id-keying both rows persist.
    rows = character_archive.merge_roster(
        [{"name": "Foo", "id": 1}, {"name": "foo", "id": 2}],
        [],
    )
    assert len(rows) == 2
    ids = sorted(r["id"] for r in rows)
    assert ids == [1, 2]
    assert all(r["on_account"] for r in rows)


def test_merge_roster_same_id_dedupes_across_sources():
    # An account char and an archive entry that share an id are the same
    # character — they must merge, not duplicate.
    character_archive.write_live("42", {"name": "Bar", "fetched_at": 0})
    rows = character_archive.merge_roster(
        [{"name": "Bar", "id": "42"}],
        [],
    )
    assert len(rows) == 1
    assert rows[0]["on_account"] is True
    assert rows[0]["has_archive"] is True


def test_merge_roster_log_attaches_to_id_row_by_name():
    # A log directory's only signal is the lowercased name; it should
    # attach to the matching id-keyed row, not spawn a duplicate.
    rows = character_archive.merge_roster(
        [{"name": "Baz", "id": 7}],
        ["baz"],
    )
    assert len(rows) == 1
    assert rows[0]["id"] == 7
    assert rows[0]["on_account"] is True
    assert rows[0]["has_logs"] is True
