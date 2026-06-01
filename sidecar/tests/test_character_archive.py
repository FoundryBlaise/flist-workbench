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


# ---- pool storage (Tier 6) -------------------------------------------


_PNG_HEADER = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def test_add_to_pool_dedupes_identical_bytes():
    cid = "501"
    sha_a = character_archive.add_to_pool(
        cid, _PNG_HEADER, "png", source="flist_pull"
    )
    sha_b = character_archive.add_to_pool(
        cid, _PNG_HEADER, "png", source="flist_pull"
    )
    assert sha_a == sha_b
    files = list(character_archive.pool_dir(cid).glob("*.png"))
    assert len(files) == 1


def test_add_to_pool_rejects_unsupported_extension():
    with pytest.raises(ValueError):
        character_archive.add_to_pool("502", b"\x00\x00", "bmp", source="user_upload")


def test_add_to_pool_normalises_jpeg_to_jpg():
    data = b"\xff\xd8\xff\xe0" + b"\x00" * 16
    sha = character_archive.add_to_pool(
        "503", data, "jpeg", source="user_upload"
    )
    manifest = character_archive.read_pool_manifest("503")
    assert manifest[sha]["extension"] == "jpg"
    assert (character_archive.pool_dir("503") / f"{sha}.jpg").exists()


def test_pool_manifest_does_not_carry_image_id():
    # v2 design: the pool is a sha-keyed forever archive. F-list
    # image_ids belong on `images/<image_id>.<ext>` files, not on pool
    # manifest entries.
    cid = "504"
    sha = character_archive.add_to_pool(
        cid, _PNG_HEADER, "png", source="flist_pull"
    )
    meta = character_archive.read_pool_manifest(cid)[sha]
    assert "image_id" not in meta
    assert meta["source"] == "flist_pull"


def test_list_pool_entries_skips_missing_files():
    cid = "505"
    sha = character_archive.add_to_pool(
        cid, _PNG_HEADER, "png", source="user_upload"
    )
    (character_archive.pool_dir(cid) / f"{sha}.png").unlink()
    assert character_archive.list_pool_entries(cid) == []


def test_remove_from_pool_drops_file_and_manifest():
    cid = "507"
    sha = character_archive.add_to_pool(
        cid, _PNG_HEADER, "png", source="user_upload"
    )
    ok = character_archive.remove_from_pool(cid, sha)
    assert ok is True
    assert character_archive.read_pool_manifest(cid) == {}
    assert not (character_archive.pool_dir(cid) / f"{sha}.png").exists()


def test_write_character_image_writes_to_both_images_and_pool():
    cid = "508"
    character_archive.write_character_image(cid, "30012128", "png", _PNG_HEADER)
    assert (character_archive.images_dir(cid) / "30012128.png").exists()
    # pool gets a sha-keyed copy too.
    pool_files = list(character_archive.pool_dir(cid).glob("*.png"))
    assert len(pool_files) == 1
    # The pool entry records the source as flist_pull.
    manifest = character_archive.read_pool_manifest(cid)
    assert next(iter(manifest.values()))["source"] == "flist_pull"


def test_materialise_pool_to_character_creates_local_id():
    cid = "509"
    sha = character_archive.add_to_pool(
        cid, _PNG_HEADER, "png", source="user_upload"
    )
    local_id = character_archive.materialise_pool_to_character(cid, sha)
    assert local_id is not None
    assert local_id.startswith("local-")
    assert local_id == f"local-{sha[:8]}"
    assert (character_archive.images_dir(cid) / f"{local_id}.png").exists()


def test_materialise_pool_is_idempotent_per_sha():
    cid = "510"
    sha = character_archive.add_to_pool(
        cid, _PNG_HEADER, "png", source="user_upload"
    )
    first = character_archive.materialise_pool_to_character(cid, sha)
    second = character_archive.materialise_pool_to_character(cid, sha)
    assert first == second
    files = list(character_archive.images_dir(cid).glob("local-*.png"))
    assert len(files) == 1


def test_remove_character_image_deletes_from_images_only():
    cid = "512"
    character_archive.write_character_image(cid, "999", "png", _PNG_HEADER)
    pool_files_before = list(character_archive.pool_dir(cid).glob("*.png"))
    assert len(pool_files_before) == 1
    ok = character_archive.remove_character_image(cid, "999")
    assert ok is True
    assert not (character_archive.images_dir(cid) / "999.png").exists()
    # Pool keeps the bytes — that's the whole point of the forever archive.
    assert list(character_archive.pool_dir(cid).glob("*.png")) == pool_files_before


def test_sync_character_images_to_flist_prunes_removed_ids():
    cid = "513"
    character_archive.write_character_image(cid, "111", "png", _PNG_HEADER)
    character_archive.write_character_image(cid, "222", "png", _PNG_HEADER + b"\x01")
    # User also added a pool-only image; this must NOT be pruned by an
    # F-list mirror sync.
    sha = character_archive.add_to_pool(
        cid, _PNG_HEADER + b"\x02", "png", source="user_upload"
    )
    character_archive.materialise_pool_to_character(cid, sha)
    removed = character_archive.sync_character_images_to_flist(cid, ["111"])
    assert removed == ["222"]
    assert (character_archive.images_dir(cid) / "111.png").exists()
    assert not (character_archive.images_dir(cid) / "222.png").exists()
    # local-* synthetic id survives the sync.
    assert (character_archive.images_dir(cid) / f"local-{sha[:8]}.png").exists()


def test_list_character_images_excludes_pool():
    cid = "514"
    character_archive.write_character_image(cid, "333", "png", _PNG_HEADER)
    # add_to_pool alone (without write_character_image) shouldn't show up
    # in the character image list — pool ≠ images/.
    character_archive.add_to_pool(
        cid, _PNG_HEADER + b"\xff", "png", source="user_upload"
    )
    rows = character_archive.list_character_images(cid)
    assert [r["image_id"] for r in rows] == ["333"]
    assert rows[0]["extension"] == "png"


def test_migrate_working_v3_drops_sha_only_images():
    cid = "515"
    target = character_archive.working_path(cid)
    target.parent.mkdir(parents=True, exist_ok=True)
    import json as _json
    target.write_text(
        _json.dumps(
            {
                "_schema_version": 3,
                "_overlay": [],
                "images": [
                    {"sha256": "abc", "description": "first"},
                ],
                "character": {"id": "1", "name": "X"},
            }
        ),
        encoding="utf-8",
    )
    out = character_archive.read_working(cid)
    assert out is not None
    # v3 → v4 strips the sha-only images array; caller re-seeds from Live.
    assert "images" not in out
    assert out["_schema_version"] == character_archive.WORKING_SCHEMA_VERSION
    # And the migrated shape gets persisted so external tools / the next
    # read see v4 directly — the on-disk file is no longer v3.
    on_disk = _json.loads(target.read_text(encoding="utf-8"))
    assert on_disk["_schema_version"] == character_archive.WORKING_SCHEMA_VERSION
    assert "images" not in on_disk


def test_normalise_image_ext_jpeg_to_jpg():
    # Pinned because the pull cache check depends on this normalisation
    # to match what write_character_image stores. If F-list ever returns
    # "jpeg" the pull must hit the cache for an existing .jpg file.
    assert character_archive.normalise_image_ext("jpeg") == "jpg"
    assert character_archive.normalise_image_ext("JPEG") == "jpg"
    assert character_archive.normalise_image_ext(".png") == "png"


def test_read_working_refuses_future_schema_version():
    """A working.json written by a newer build must be refused, not
    silently mis-interpreted. The renderer falls back to seed-from-Live
    on None, so the file stays intact for a future re-open with the
    matching version (QA feedback BLOCK #4)."""
    cid = "510"
    target = character_archive.working_path(cid)
    target.parent.mkdir(parents=True, exist_ok=True)
    import json as _json

    target.write_text(
        _json.dumps(
            {
                "_schema_version": character_archive.WORKING_SCHEMA_VERSION + 1,
                "_overlay": [],
                "character": {"id": "1", "name": "X"},
            }
        ),
        encoding="utf-8",
    )
    assert character_archive.read_working(cid) is None
    # File stays on disk untouched — no quarantine for a future-version
    # file; we want it readable again after upgrade.
    assert target.exists()


