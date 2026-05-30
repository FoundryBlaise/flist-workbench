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


def test_compute_pull_status_never_pulled():
    s = character_archive.compute_pull_status("404")
    assert s["status"] == "never_pulled"
    assert s["missing_image_ids"] == []
    assert s["expected"] == 0


def test_compute_pull_status_complete():
    cid = "100"
    character_archive.write_live(cid, {
        "name": "Test", "fetched_at": 100,
        "images": [{"image_id": "a1", "extension": "png"},
                   {"image_id": "b2", "extension": "jpg"}],
    })
    # Drop both image files into images_dir to simulate a successful pull
    (character_archive.images_dir(cid) / "a1.png").write_bytes(b"\x89PNG\x00")
    (character_archive.images_dir(cid) / "b2.jpg").write_bytes(b"\xff\xd8\xff\xe0")
    character_archive.write_pull_state(
        cid,
        [{"image_id": "a1", "extension": "png"},
         {"image_id": "b2", "extension": "jpg"}],
        started_at=100,
        finished_at=150,
    )
    s = character_archive.compute_pull_status(cid)
    assert s["status"] == "complete"
    assert s["missing_image_ids"] == []
    assert s["expected"] == 2
    assert s["present"] == 2
    assert s["last_attempt_ts"] == 150


def test_compute_pull_status_interrupted_mid_pull():
    # Pull crashed mid-loop: manifest written with finished_at=None and
    # only some images on disk. Renderer should see "interrupted" so the
    # user can resume.
    cid = "200"
    character_archive.write_live(cid, {"name": "Test", "fetched_at": 100, "images": []})
    (character_archive.images_dir(cid) / "a1.png").write_bytes(b"\x89PNG\x00")
    character_archive.write_pull_state(
        cid,
        [{"image_id": "a1", "extension": "png"},
         {"image_id": "b2", "extension": "jpg"},
         {"image_id": "c3", "extension": "png"}],
        started_at=100,
        finished_at=None,
    )
    s = character_archive.compute_pull_status(cid)
    assert s["status"] == "interrupted"
    assert len(s["missing_image_ids"]) == 2
    assert s["present"] == 1
    assert s["expected"] == 3


def test_compute_pull_status_partial_after_failures():
    # Pull ran to completion but some images failed mid-loop. Loop sealed
    # the manifest with finished_at, but disk is short two images.
    cid = "300"
    character_archive.write_live(cid, {"name": "Test", "fetched_at": 100, "images": []})
    (character_archive.images_dir(cid) / "a1.png").write_bytes(b"\x89PNG\x00")
    character_archive.write_pull_state(
        cid,
        [{"image_id": "a1", "extension": "png"},
         {"image_id": "b2", "extension": "jpg"}],
        started_at=100,
        finished_at=120,
    )
    s = character_archive.compute_pull_status(cid)
    assert s["status"] == "partial"
    assert len(s["missing_image_ids"]) == 1
    assert s["missing_image_ids"][0]["image_id"] == "b2"


def test_compute_pull_status_legacy_archive_no_manifest():
    # Archives created before pull_state.json shipped — derive from
    # live.json.images vs disk so users still get the "incomplete" surface.
    cid = "400"
    character_archive.write_live(cid, {
        "name": "Test", "fetched_at": 100,
        "images": [{"image_id": "a1", "extension": "png"},
                   {"image_id": "b2", "extension": "jpg"}],
    })
    (character_archive.images_dir(cid) / "a1.png").write_bytes(b"\x89PNG\x00")
    s = character_archive.compute_pull_status(cid)
    assert s["status"] == "partial"
    assert len(s["missing_image_ids"]) == 1


def test_compute_pull_status_legacy_archive_complete():
    cid = "500"
    character_archive.write_live(cid, {
        "name": "Test", "fetched_at": 100,
        "images": [{"image_id": "a1", "extension": "png"}],
    })
    (character_archive.images_dir(cid) / "a1.png").write_bytes(b"\x89PNG\x00")
    s = character_archive.compute_pull_status(cid)
    assert s["status"] == "complete"


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
