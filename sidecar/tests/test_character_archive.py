"""Character-archive store tests.

Covers the parts of `character_archive` that are easy to get wrong in
ways that would hurt real users:

- avatar_path_for must never raise on Unicode names (F-list allows
  them); we hash-fallback when the lowercased name leaves the
  safe-name alphabet.
- image_path / inline_path must reject path-traversal payloads in the
  F-list-supplied filename parts.
- save_snapshot / list_snapshots must round-trip a JSON checkpoint.
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


def test_save_snapshot_round_trip(tmp_path):
    character_archive.write_live("9999", {"name": "Test", "fetched_at": 100})
    snap = character_archive.save_snapshot("9999")
    assert snap["filename"].endswith(".json")
    listed = character_archive.list_snapshots("9999")
    assert len(listed) == 1
    assert listed[0]["filename"] == snap["filename"]
    payload = character_archive.read_snapshot("9999", snap["filename"])
    assert payload is not None
    assert payload["name"] == "Test"


def test_read_snapshot_rejects_invalid_filename():
    # Filenames not matching the on-disk regex are refused so a
    # hostile caller can't path-traverse out of backups/.
    assert character_archive.read_snapshot("123", "../../../etc/passwd") is None
    assert character_archive.read_snapshot("123", "foo.txt") is None


def test_save_snapshot_if_changed_skips_when_only_fetched_at_changed():
    cid = "8888"
    character_archive.write_live(cid, {"description": "v1", "fetched_at": 100})
    first = character_archive.save_snapshot_if_changed(cid)
    assert first["saved"] is True
    character_archive.write_live(cid, {"description": "v1", "fetched_at": 200})
    second = character_archive.save_snapshot_if_changed(cid)
    assert second == {"saved": False, "reason": "unchanged"}
    assert len(character_archive.list_snapshots(cid)) == 1


def test_save_snapshot_if_changed_writes_when_content_differs():
    cid = "8889"
    character_archive.write_live(cid, {"description": "v1", "fetched_at": 100})
    character_archive.save_snapshot_if_changed(cid)
    character_archive.write_live(cid, {"description": "v2", "fetched_at": 200})
    second = character_archive.save_snapshot_if_changed(cid)
    assert second["saved"] is True
    third = character_archive.save_snapshot_if_changed(cid)
    assert third == {"saved": False, "reason": "unchanged"}
    assert len(character_archive.list_snapshots(cid)) == 2


def test_save_snapshot_if_changed_no_live():
    assert character_archive.save_snapshot_if_changed("nope") == {
        "saved": False,
        "reason": "no_live",
    }


def test_snapshots_dir_migrates_legacy_backups(tmp_path):
    """Pre-rename archives stored JSON snapshots under `backups/`. The
    first call to `snapshots_dir` for such an archive must move the
    JSON files into the new `snapshots/` location so the dedup check
    and the renderer's history view keep working without the user
    losing their checkpoint history."""
    cid = "6666"
    char_root = character_archive.character_dir(cid)
    legacy = char_root / "backups"
    legacy.mkdir(parents=True, exist_ok=True)
    (legacy / "100.json").write_text('{"name": "legacy-100"}', encoding="utf-8")
    (legacy / "200.json").write_text('{"name": "legacy-200"}', encoding="utf-8")
    # Sanity: no `snapshots/` yet.
    assert not (char_root / "snapshots").exists()

    rows = character_archive.list_snapshots(cid)
    filenames = sorted(r["filename"] for r in rows)
    assert filenames == ["100.json", "200.json"]
    # Legacy dir is now empty (JSON files moved); kept on disk in case
    # the user wants to inspect it.
    assert not list((char_root / "backups").glob("*.json"))


def test_save_zip_backup_dedups_unchanged_live(tmp_path):
    cid = "5555"
    character_archive.write_live(
        cid,
        {
            "character": {"id": int(cid), "name": "Z", "description": "v1"},
            "images": [],
            "kinks": {},
            "fetched_at": 100,
        },
    )
    first = character_archive.save_zip_backup(cid)
    assert first["saved"] is True
    assert first["filename"].endswith(".zip")
    # Same content → unchanged.
    second = character_archive.save_zip_backup(cid)
    assert second == {"saved": False, "reason": "unchanged"}


def test_save_zip_backup_writes_when_content_differs(tmp_path):
    cid = "5556"
    character_archive.write_live(
        cid,
        {
            "character": {"id": int(cid), "name": "Z", "description": "v1"},
            "images": [],
            "kinks": {},
            "fetched_at": 100,
        },
    )
    character_archive.save_zip_backup(cid)
    character_archive.write_live(
        cid,
        {
            "character": {"id": int(cid), "name": "Z", "description": "v2"},
            "images": [],
            "kinks": {},
            "fetched_at": 200,
        },
    )
    second = character_archive.save_zip_backup(cid)
    assert second["saved"] is True
    third = character_archive.save_zip_backup(cid)
    assert third == {"saved": False, "reason": "unchanged"}
    assert len(character_archive.list_zip_backups(cid)) == 2


def test_save_zip_backup_force_bypasses_dedup(tmp_path):
    cid = "5557"
    character_archive.write_live(
        cid,
        {
            "character": {"id": int(cid), "name": "Z", "description": "v1"},
            "images": [],
            "kinks": {},
            "fetched_at": 100,
        },
    )
    character_archive.save_zip_backup(cid)
    # Without force this would dedup.
    second = character_archive.save_zip_backup(cid, force=True)
    assert second["saved"] is True
    assert len(character_archive.list_zip_backups(cid)) == 2


def test_save_zip_backup_no_live(tmp_path):
    assert character_archive.save_zip_backup("nope") == {
        "saved": False,
        "reason": "no_live",
    }


def test_list_zip_backups_orders_same_second_writes_newest_first(tmp_path):
    """Two ZIP backups in the same second get the `-N` suffix counter.
    The sort key has to put the highest N at the top so the dedup
    check (`latest_zip_backup_content_hash`) compares against the
    *truly* most-recent ZIP. Lex order alone would surface the
    no-suffix file (the oldest) because `.` > `-` in ASCII."""
    cid = "5558"
    character_archive.write_live(
        cid,
        {
            "character": {"id": int(cid), "name": "Z", "description": "a"},
            "images": [],
            "kinks": {},
            "fetched_at": 100,
        },
    )
    character_archive.save_zip_backup(cid)
    character_archive.save_zip_backup(cid, force=True)
    character_archive.save_zip_backup(cid, force=True)
    rows = character_archive.list_zip_backups(cid)
    # Highest-suffix first.
    assert rows[0]["filename"].endswith("-2.zip")
    assert rows[1]["filename"].endswith("-1.zip")
    # And the no-suffix one is the oldest → last.
    assert "-" not in rows[2]["filename"].rsplit(".zip", 1)[0].split("Z", 1)[1]


def test_list_snapshots_orders_same_second_writes_newest_first():
    """Same-epoch collisions are broken by the `-N` suffix counter. The
    dedup check in `save_snapshot_if_changed` depends on `list_snapshots`
    surfacing the most-recently-written row first even when several
    backups share an epoch."""
    cid = "7777"
    character_archive.write_live(cid, {"description": "a", "fetched_at": 100})
    character_archive.save_snapshot(cid)
    character_archive.write_live(cid, {"description": "b", "fetched_at": 100})
    character_archive.save_snapshot(cid)
    character_archive.write_live(cid, {"description": "c", "fetched_at": 100})
    character_archive.save_snapshot(cid)
    rows = character_archive.list_snapshots(cid)
    assert rows[0]["filename"].endswith("-2.json")
    assert rows[1]["filename"].endswith("-1.json")
    # The third row is the no-suffix one written first.
    assert "-" not in rows[2]["filename"].rsplit(".json", 1)[0]


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


def test_merge_roster_dedupes_int_account_id_vs_str_archive_id():
    # F-list's /flist/characters returns id as int (new_character_list);
    # the archive's registry stores id as str. Without normalisation the
    # same character renders twice — once under "On your F-list account"
    # and once under "Logs only".
    character_archive.write_live("99", {"name": "Quux", "fetched_at": 0})
    rows = character_archive.merge_roster(
        [{"name": "Quux", "id": 99}],
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


# ---- image storage (v5 unified store) --------------------------------


_PNG_HEADER = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
_JPG_HEADER = b"\xff\xd8\xff\xe0" + b"\x00" * 16


def test_write_character_image_lands_in_images_only():
    cid = "508"
    character_archive.write_character_image(cid, "30012128", "png", _PNG_HEADER)
    assert (character_archive.images_dir(cid) / "30012128.png").exists()
    # v5: no parallel pool/ store, ever.
    assert not (character_archive.character_dir(cid) / "pool").exists()


def test_write_character_image_normalises_jpeg_to_jpg():
    # Pinned because the pull cache check probes the canonical "jpg"
    # extension; if write_character_image stored ".jpeg" the cache would
    # miss for an existing file.
    cid = "508a"
    character_archive.write_character_image(cid, "99", "jpeg", _JPG_HEADER)
    assert (character_archive.images_dir(cid) / "99.jpg").exists()


def test_add_uploaded_image_creates_local_id():
    cid = "509"
    row = character_archive.add_uploaded_image(cid, _PNG_HEADER)
    assert row is not None
    assert row["image_id"].startswith("local-")
    assert row["extension"] == "png"
    assert (character_archive.images_dir(cid) / f"{row['image_id']}.png").exists()


def test_add_uploaded_image_is_idempotent_on_identical_bytes():
    cid = "510"
    a = character_archive.add_uploaded_image(cid, _PNG_HEADER)
    b = character_archive.add_uploaded_image(cid, _PNG_HEADER)
    assert a is not None and b is not None
    assert a["image_id"] == b["image_id"]
    files = list(character_archive.images_dir(cid).glob("local-*.png"))
    assert len(files) == 1


def test_add_uploaded_image_rejects_non_image_bytes():
    cid = "511"
    row = character_archive.add_uploaded_image(cid, b"not an image")
    assert row is None
    assert not character_archive.images_dir(cid).exists() or not any(
        character_archive.images_dir(cid).iterdir()
    )


def test_remove_character_image_is_permanent():
    cid = "512"
    character_archive.write_character_image(cid, "999", "png", _PNG_HEADER)
    ok = character_archive.remove_character_image(cid, "999")
    assert ok is True
    # v5: no fallback store; the bytes are gone for good once delete fires.
    assert not (character_archive.images_dir(cid) / "999.png").exists()
    assert not (character_archive.character_dir(cid) / "pool").exists()


def test_list_character_images_includes_added_at():
    cid = "514"
    character_archive.write_character_image(cid, "333", "png", _PNG_HEADER)
    rows = character_archive.list_character_images(cid)
    assert len(rows) == 1
    assert rows[0]["image_id"] == "333"
    assert rows[0]["extension"] == "png"
    assert isinstance(rows[0]["added_at"], int)


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
    # v3 → v5 strips the sha-only images array; caller re-seeds from Live.
    assert "images" not in out
    assert out["_schema_version"] == character_archive.WORKING_SCHEMA_VERSION
    on_disk = _json.loads(target.read_text(encoding="utf-8"))
    assert on_disk["_schema_version"] == character_archive.WORKING_SCHEMA_VERSION
    assert "images" not in on_disk


def test_migrate_v4_pool_promotes_orphan_to_local():
    """A v4 pool/<sha>.<ext> with no manifest history is bytes the user
    cared about — it must land in images/local-<sha8>.<ext> when v5
    migration runs."""
    import hashlib
    cid = "516"
    cdir = character_archive.character_dir(cid)
    pool_d = cdir / "pool"
    pool_d.mkdir()
    sha = hashlib.sha256(_PNG_HEADER).hexdigest()
    (pool_d / f"{sha}.png").write_bytes(_PNG_HEADER)
    # No manifest entry — exercises the orphan-files fallback.
    promoted = character_archive.migrate_v4_pool_to_images(cid)
    assert promoted == 1
    assert not pool_d.exists()
    assert (
        character_archive.images_dir(cid) / f"local-{sha[:8]}.png"
    ).exists()


def test_migrate_v4_pool_skips_already_preserved_bytes():
    """If a pool sha's image_ids[] already names a file on disk under
    images/, the bytes are already preserved — migration must not mint
    a redundant local-<sha8> copy."""
    import hashlib, json as _json
    cid = "517"
    cdir = character_archive.character_dir(cid)
    images_d = character_archive.images_dir(cid)
    pool_d = cdir / "pool"
    pool_d.mkdir()
    sha = hashlib.sha256(_PNG_HEADER).hexdigest()
    (images_d / "42.png").write_bytes(_PNG_HEADER)
    (pool_d / f"{sha}.png").write_bytes(_PNG_HEADER)
    (pool_d / "manifest.json").write_text(
        _json.dumps(
            {
                sha: {
                    "extension": "png",
                    "source": "flist_pull",
                    "added_at": 1,
                    "size": len(_PNG_HEADER),
                    "image_ids": ["42"],
                }
            }
        )
    )
    character_archive.migrate_v4_pool_to_images(cid)
    assert not pool_d.exists()
    # Only the original 42.png — no redundant local-<sha8>.png.
    files = sorted(p.name for p in images_d.iterdir())
    assert files == ["42.png"]


def test_migrate_v4_pool_uses_first_free_image_id():
    """When the pool entry has image_ids[] and none of those files are
    on disk, migration adopts the first id rather than minting a
    synthetic — preserves identity across the v5 upgrade."""
    import hashlib, json as _json
    cid = "518"
    cdir = character_archive.character_dir(cid)
    pool_d = cdir / "pool"
    pool_d.mkdir()
    bytes_ = _PNG_HEADER + b"unique"
    sha = hashlib.sha256(bytes_).hexdigest()
    (pool_d / f"{sha}.png").write_bytes(bytes_)
    (pool_d / "manifest.json").write_text(
        _json.dumps(
            {
                sha: {
                    "extension": "png",
                    "source": "user_upload",
                    "added_at": 1,
                    "size": len(bytes_),
                    "image_ids": ["7777"],
                }
            }
        )
    )
    promoted = character_archive.migrate_v4_pool_to_images(cid)
    assert promoted == 1
    assert (character_archive.images_dir(cid) / "7777.png").exists()


def test_migrate_v4_pool_is_idempotent_when_already_v5():
    cid = "519"
    # No pool/ dir at all — migration should be a no-op.
    promoted = character_archive.migrate_v4_pool_to_images(cid)
    assert promoted == 0


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




# ---- name-keyed folder registry ----------------------------------------


def _make_id_folder(cid: str, name: str):
    """Helper: create a legacy <id>/ character folder with live.json."""
    import json as _json
    d = character_archive.root() / cid
    d.mkdir(parents=True, exist_ok=True)
    (d / "live.json").write_text(_json.dumps({"id": int(cid), "name": name}), encoding="utf-8")
    (d / "images").mkdir(parents=True, exist_ok=True)
    (d / "images" / "demo.png").write_bytes(b"png")
    return d


def _reset_registry_state():
    """Force the next load_registry() to re-run migration."""
    character_archive._REGISTRY_MIGRATED = False
    character_archive._invalidate_registry_cache()


def test_slug_for_filesystem_safe_name_passthrough():
    assert character_archive._slug_for("Spielwiesending") == "Spielwiesending"
    assert character_archive._slug_for("Cleo Thouvenin") == "Cleo Thouvenin"
    assert character_archive._slug_for("a.b-c_d") == "a.b-c_d"


def test_slug_for_unicode_or_illegal_falls_back_to_hash():
    s1 = character_archive._slug_for("Café Noir")
    s2 = character_archive._slug_for("a/b<c>d")
    s3 = character_archive._slug_for("CON")
    for s in (s1, s2, s3):
        assert s.startswith("c_")
        assert len(s) == 18  # "c_" + 16 hex


def test_slug_strips_leading_trailing_whitespace():
    # " leading-space " → "leading-space" after strip, which is fs-safe.
    assert character_archive._slug_for(" leading-space ") == "leading-space"


def test_slug_is_stable_for_same_lowercased_name():
    # Lowercase normalization keeps "Café Noir" and "café noir" colliding —
    # F-list character names are case-insensitive unique anyway.
    assert character_archive._slug_for("Café Noir") == character_archive._slug_for("café noir")


def test_migration_renames_numeric_folders_to_name_slugs(tmp_path):
    _reset_registry_state()
    _make_id_folder("5070222", "Spielwiesending")
    _make_id_folder("4076218", "Cleo Thouvenin")
    _make_id_folder("999", "Café Noir")

    reg = character_archive.load_registry()
    assert reg["5070222"] == {"name": "Spielwiesending", "folder": "Spielwiesending"}
    assert reg["4076218"] == {"name": "Cleo Thouvenin", "folder": "Cleo Thouvenin"}
    assert reg["999"]["folder"].startswith("c_")

    root = character_archive.root()
    folders = sorted(p.name for p in root.iterdir() if p.is_dir())
    assert "5070222" not in folders
    assert "Spielwiesending" in folders
    assert "Cleo Thouvenin" in folders


def test_character_dir_resolves_via_registry(tmp_path):
    _reset_registry_state()
    _make_id_folder("5070222", "Spielwiesending")
    character_archive.load_registry()  # trigger migration

    p = character_archive.character_dir("5070222")
    assert p.name == "Spielwiesending"
    # Image bytes survived the rename.
    assert (p / "images" / "demo.png").exists()


def test_character_dir_falls_back_to_id_when_not_in_registry(tmp_path):
    _reset_registry_state()
    p = character_archive.character_dir("999999")
    assert p.name == "999999"


def test_migration_is_idempotent(tmp_path):
    _reset_registry_state()
    _make_id_folder("5070222", "Spielwiesending")
    reg1 = character_archive.load_registry()
    _reset_registry_state()
    reg2 = character_archive.load_registry()
    assert reg1 == reg2


def test_migration_handles_collision(tmp_path):
    _reset_registry_state()
    # Pre-create a folder that would collide with the migration target.
    blocker = character_archive.root() / "Spielwiesending"
    blocker.mkdir(parents=True, exist_ok=True)
    (blocker / "marker").write_text("untouched", encoding="utf-8")
    _make_id_folder("5070222", "Spielwiesending")

    reg = character_archive.load_registry()
    # Registry should record the legacy id-named folder, not clobber.
    assert reg["5070222"]["folder"] == "5070222"
    assert (blocker / "marker").read_text(encoding="utf-8") == "untouched"


def test_write_live_renames_folder_on_name_change(tmp_path):
    _reset_registry_state()
    _make_id_folder("5070222", "OldName")
    character_archive.load_registry()
    assert (character_archive.root() / "OldName").exists()

    character_archive.write_live("5070222", {"id": 5070222, "name": "NewName"})

    assert not (character_archive.root() / "OldName").exists()
    assert (character_archive.root() / "NewName" / "live.json").exists()
    assert character_archive.load_registry()["5070222"]["folder"] == "NewName"


def test_write_live_first_pull_creates_name_folder(tmp_path):
    _reset_registry_state()
    character_archive.write_live("9999999", {"id": 9999999, "name": "Brand New"})
    assert (character_archive.root() / "Brand New" / "live.json").exists()
    assert character_archive.load_registry()["9999999"]["folder"] == "Brand New"

