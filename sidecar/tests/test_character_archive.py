"""Character-archive store tests.

Covers the parts of the archive modules (`archive_*`) that are easy to
get wrong in ways that would hurt real users:

- avatar_path_for must never raise on Unicode names (F-list allows
  them); we hash-fallback when the lowercased name leaves the
  safe-name alphabet.
- image_path / inline_path must reject path-traversal payloads in the
  F-list-supplied filename parts.
"""
from __future__ import annotations


import pytest

import archive_backups
import archive_errors
import archive_images
import archive_live
import archive_registry
import archive_workbench
from workbench_state import put_workbench, workbench_payload


@pytest.fixture(autouse=True)
def isolated_userdata(tmp_path, monkeypatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    yield


class _Clock:
    """The Backup clock, moved by hand: a Backup is named for the second
    `now` holds."""

    def __init__(self, now: float) -> None:
        self.now = now

    def time(self) -> float:
        return self.now


@pytest.fixture
def backup_clock(monkeypatch):
    clock = _Clock(1_790_000_000.0)
    monkeypatch.setattr(archive_backups, "time", clock)
    return clock


def test_avatar_path_ascii_uses_slug():
    p = archive_images.avatar_path_for("Lady Amber Blaise")
    assert p.name == "lady_amber_blaise.png"


def test_avatar_path_unicode_hashes_instead_of_raising():
    # F-list permits Unicode names; the old code raised ValueError
    # and the /flist/avatar/{name} endpoint translated that to a 400.
    p = archive_images.avatar_path_for("Café Noir")
    assert p.suffix == ".png"
    # 40-char hex sha1 → 40-char stem.
    assert len(p.stem) == 40
    assert all(c in "0123456789abcdef" for c in p.stem)


def test_avatar_path_unicode_is_case_insensitive():
    # Matches merge_roster's lowercase keying so two cased variants
    # of the same name land on the same avatar file.
    a = archive_images.avatar_path_for("Café Noir")
    b = archive_images.avatar_path_for("café noir")
    assert a == b


def test_image_path_rejects_path_traversal():
    with pytest.raises(ValueError):
        archive_images.image_path("123", "../etc", "png")
    with pytest.raises(ValueError):
        archive_images.image_path("123", "foo/bar", "png")
    with pytest.raises(ValueError):
        archive_images.image_path("123", "ok", "png/../etc")


def test_image_path_safe_stays_under_images_dir():
    archive_registry.create_character_dir("12345")
    p = archive_images.image_path("12345", "30012128", "png")
    # Resolve relative to the character's images dir — if the safe
    # check ever lets a traversal through, relative_to raises.
    p.relative_to(archive_images.images_dir("12345"))


def test_inline_path_rejects_unsafe_basename():
    with pytest.raises(ValueError):
        archive_images.inline_path("123", "..")
    with pytest.raises(ValueError):
        archive_images.inline_path("123", "foo/bar.png")


def test_save_zip_backup_dedups_unchanged_live(tmp_path):
    cid = "5555"
    archive_live.write_live(
        cid,
        {
            "character": {"id": int(cid), "name": "Z", "description": "v1"},
            "images": [],
            "kinks": {},
            "fetched_at": 100,
        },
    )
    first = archive_backups.save_zip_backup(cid, source="live", occasion="backup-all")
    assert first["saved"] is True
    assert first["filename"].endswith(".zip")
    # Same content → unchanged.
    second = archive_backups.save_zip_backup(cid, source="live", occasion="backup-all")
    assert second == {"saved": False, "reason": "unchanged"}


def test_save_zip_backup_writes_when_content_differs(tmp_path):
    cid = "5556"
    archive_live.write_live(
        cid,
        {
            "character": {"id": int(cid), "name": "Z", "description": "v1"},
            "images": [],
            "kinks": {},
            "fetched_at": 100,
        },
    )
    archive_backups.save_zip_backup(cid, source="live", occasion="backup-all")
    archive_live.write_live(
        cid,
        {
            "character": {"id": int(cid), "name": "Z", "description": "v2"},
            "images": [],
            "kinks": {},
            "fetched_at": 200,
        },
    )
    second = archive_backups.save_zip_backup(cid, source="live", occasion="backup-all")
    assert second["saved"] is True
    third = archive_backups.save_zip_backup(cid, source="live", occasion="backup-all")
    assert third == {"saved": False, "reason": "unchanged"}
    assert len(archive_backups.list_zip_backups(cid)) == 2


def test_save_zip_backup_force_bypasses_dedup(tmp_path):
    cid = "5557"
    archive_live.write_live(
        cid,
        {
            "character": {"id": int(cid), "name": "Z", "description": "v1"},
            "images": [],
            "kinks": {},
            "fetched_at": 100,
        },
    )
    archive_backups.save_zip_backup(cid, source="live", occasion="backup-all")
    # Without force this would dedup.
    second = archive_backups.save_zip_backup(cid, source="live", occasion="backup-all", force=True)
    assert second["saved"] is True
    assert len(archive_backups.list_zip_backups(cid)) == 2


def test_save_zip_backup_no_live(tmp_path):
    archive_registry.create_character_dir("nope")
    assert archive_backups.save_zip_backup("nope", source="live", occasion="backup-all") == {
        "saved": False,
        "reason": "no_live",
    }


def test_list_zip_backups_orders_same_second_writes_newest_first(
    tmp_path, backup_clock
):
    """Two ZIP backups in the same second get the `-N` suffix counter.
    The sort key has to put the highest N at the top so the dedup
    check (`latest_zip_backup_content_hash`) compares against the
    *truly* most-recent ZIP. Lex order alone would surface the
    no-suffix file (the oldest) because `.` > `-` in ASCII. The clock
    stays put, so all three share one second on any machine."""
    cid = "5558"
    archive_live.write_live(
        cid,
        {
            "character": {"id": int(cid), "name": "Z", "description": "a"},
            "images": [],
            "kinks": {},
            "fetched_at": 100,
        },
    )
    archive_backups.save_zip_backup(cid, source="live", occasion="backup-all")
    archive_backups.save_zip_backup(cid, source="live", occasion="backup-all", force=True)
    archive_backups.save_zip_backup(cid, source="live", occasion="backup-all", force=True)
    rows = archive_backups.list_zip_backups(cid)
    # Highest-suffix first.
    assert rows[0]["filename"].endswith("-2.zip")
    assert rows[1]["filename"].endswith("-1.zip")
    # And the no-suffix one is the oldest → last.
    assert "-" not in rows[2]["filename"].rsplit(".zip", 1)[0].split("Z", 1)[1]


def test_list_zip_backups_orders_writes_across_seconds_newest_first(
    tmp_path, backup_clock
):
    """Backups a second apart get no `-N` suffix; the newer second
    still lists first, ahead of a same-second pair from earlier."""
    cid = "5559"
    archive_live.write_live(
        cid,
        {
            "character": {"id": int(cid), "name": "Z", "description": "a"},
            "images": [],
            "kinks": {},
            "fetched_at": 100,
        },
    )
    archive_backups.save_zip_backup(cid, source="live", occasion="backup-all")
    archive_backups.save_zip_backup(cid, source="live", occasion="backup-all", force=True)
    backup_clock.now += 1
    archive_backups.save_zip_backup(cid, source="live", occasion="backup-all", force=True)
    backup_clock.now += 1
    archive_backups.save_zip_backup(cid, source="live", occasion="backup-all", force=True)
    assert [r["filename"] for r in archive_backups.list_zip_backups(cid)] == [
        "2026-09-21T141322Z.zip",
        "2026-09-21T141321Z.zip",
        "2026-09-21T141320Z-1.zip",
        "2026-09-21T141320Z.zip",
    ]


def test_merge_roster_keeps_case_only_distinct_ids():
    # F-list permits two characters whose names differ only in case.
    # Old lowercased-name keying silently collapsed them into one row
    # with the wrong id surviving. With id-keying both rows persist.
    rows = archive_registry.merge_roster(
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
    archive_live.write_live("42", {"name": "Bar", "fetched_at": 0})
    rows = archive_registry.merge_roster(
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
    archive_live.write_live("99", {"name": "Quux", "fetched_at": 0})
    rows = archive_registry.merge_roster(
        [{"name": "Quux", "id": 99}],
        [],
    )
    assert len(rows) == 1
    assert rows[0]["on_account"] is True
    assert rows[0]["has_archive"] is True


def test_compute_pull_status_never_pulled():
    archive_registry.create_character_dir("404")
    s = archive_images.compute_pull_status("404")
    assert s["status"] == "never_pulled"
    assert s["missing_image_ids"] == []
    assert s["expected"] == 0


def test_compute_pull_status_complete():
    cid = "100"
    archive_live.write_live(cid, {
        "name": "Test", "fetched_at": 100,
        "images": [{"image_id": "a1", "extension": "png"},
                   {"image_id": "b2", "extension": "jpg"}],
    })
    # Drop both image files into images_dir to simulate a successful pull
    (archive_images.images_dir(cid) / "a1.png").write_bytes(b"\x89PNG\x00")
    (archive_images.images_dir(cid) / "b2.jpg").write_bytes(b"\xff\xd8\xff\xe0")
    archive_images.write_pull_state(
        cid,
        [{"image_id": "a1", "extension": "png"},
         {"image_id": "b2", "extension": "jpg"}],
        started_at=100,
        finished_at=150,
    )
    s = archive_images.compute_pull_status(cid)
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
    archive_live.write_live(cid, {"name": "Test", "fetched_at": 100, "images": []})
    (archive_images.images_dir(cid) / "a1.png").write_bytes(b"\x89PNG\x00")
    archive_images.write_pull_state(
        cid,
        [{"image_id": "a1", "extension": "png"},
         {"image_id": "b2", "extension": "jpg"},
         {"image_id": "c3", "extension": "png"}],
        started_at=100,
        finished_at=None,
    )
    s = archive_images.compute_pull_status(cid)
    assert s["status"] == "interrupted"
    assert len(s["missing_image_ids"]) == 2
    assert s["present"] == 1
    assert s["expected"] == 3


def test_compute_pull_status_partial_after_failures():
    # Pull ran to completion but some images failed mid-loop. Loop sealed
    # the manifest with finished_at, but disk is short two images.
    cid = "300"
    archive_live.write_live(cid, {"name": "Test", "fetched_at": 100, "images": []})
    (archive_images.images_dir(cid) / "a1.png").write_bytes(b"\x89PNG\x00")
    archive_images.write_pull_state(
        cid,
        [{"image_id": "a1", "extension": "png"},
         {"image_id": "b2", "extension": "jpg"}],
        started_at=100,
        finished_at=120,
    )
    s = archive_images.compute_pull_status(cid)
    assert s["status"] == "partial"
    assert len(s["missing_image_ids"]) == 1
    assert s["missing_image_ids"][0]["image_id"] == "b2"


def test_compute_pull_status_legacy_archive_no_manifest():
    # Archives created before pull_state.json shipped — derive from
    # live.json.images vs disk so users still get the "incomplete" surface.
    cid = "400"
    archive_live.write_live(cid, {
        "name": "Test", "fetched_at": 100,
        "images": [{"image_id": "a1", "extension": "png"},
                   {"image_id": "b2", "extension": "jpg"}],
    })
    (archive_images.images_dir(cid) / "a1.png").write_bytes(b"\x89PNG\x00")
    s = archive_images.compute_pull_status(cid)
    assert s["status"] == "partial"
    assert len(s["missing_image_ids"]) == 1


def test_compute_pull_status_legacy_archive_complete():
    cid = "500"
    archive_live.write_live(cid, {
        "name": "Test", "fetched_at": 100,
        "images": [{"image_id": "a1", "extension": "png"}],
    })
    (archive_images.images_dir(cid) / "a1.png").write_bytes(b"\x89PNG\x00")
    s = archive_images.compute_pull_status(cid)
    assert s["status"] == "complete"


def test_merge_roster_log_attaches_to_id_row_by_name():
    # A log directory's only signal is the lowercased name; it should
    # attach to the matching id-keyed row, not spawn a duplicate.
    rows = archive_registry.merge_roster(
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
    archive_registry.create_character_dir(cid)
    archive_images.write_character_image(cid, "30012128", "png", _PNG_HEADER)
    assert (archive_images.images_dir(cid) / "30012128.png").exists()
    # v5: no parallel pool/ store, ever.
    assert not (archive_registry.character_dir(cid) / "pool").exists()


def test_write_character_image_normalises_jpeg_to_jpg():
    # Pinned because the pull cache check probes the canonical "jpg"
    # extension; if write_character_image stored ".jpeg" the cache would
    # miss for an existing file.
    cid = "508a"
    archive_registry.create_character_dir(cid)
    archive_images.write_character_image(cid, "99", "jpeg", _JPG_HEADER)
    assert (archive_images.images_dir(cid) / "99.jpg").exists()


def test_add_uploaded_image_creates_local_id():
    cid = "509"
    archive_registry.create_character_dir(cid)
    row = archive_images.add_uploaded_image(cid, _PNG_HEADER)
    assert row is not None
    assert row["image_id"].startswith("local-")
    assert row["extension"] == "png"
    assert (archive_images.images_dir(cid) / f"{row['image_id']}.png").exists()


def test_add_uploaded_image_is_idempotent_on_identical_bytes():
    cid = "510"
    archive_registry.create_character_dir(cid)
    a = archive_images.add_uploaded_image(cid, _PNG_HEADER)
    b = archive_images.add_uploaded_image(cid, _PNG_HEADER)
    assert a is not None and b is not None
    assert a["image_id"] == b["image_id"]
    files = list(archive_images.images_dir(cid).glob("local-*.png"))
    assert len(files) == 1


def test_add_uploaded_image_reuses_existing_real_id_file():
    """If a byte-identical file is already on disk under a real F-list
    id (e.g. from an earlier pull), uploading the same bytes must NOT
    mint a parallel `local-<sha8>` copy. Otherwise the Pool ends up
    showing the same image twice once the real-id slot is dragged off
    profile — the bug seen 2026-06-14."""
    cid = "509b"
    archive_registry.create_character_dir(cid)
    archive_images.write_character_image(cid, "45755545", "png", _PNG_HEADER)
    row = archive_images.add_uploaded_image(cid, _PNG_HEADER)
    assert row is not None
    assert row["image_id"] == "45755545"
    files = list(archive_images.images_dir(cid).iterdir())
    assert len(files) == 1


def test_list_collapses_existing_local_duplicate_of_real_id():
    """Cure pass for archives that already have a `local-<sha8>` next to
    a byte-identical real-id file (state created by older builds). The
    first list_character_images must drop the local and move any
    gallery slot that pointed at it onto the real id — leaving the slot
    pointing at bytes that are gone is what turns a profile image into
    a black placeholder."""
    cid = "509c"
    archive_registry.create_character_dir(cid)
    # Pre-existing dupe state on disk: same bytes under two ids.
    archive_images.write_character_image(cid, "45755545", "png", _PNG_HEADER)
    archive_images.write_character_image(
        cid, "local-deadbeef", "png", _PNG_HEADER
    )
    # The gallery lives in the character's Workbench.
    archive_live.write_live(
        cid,
        {
            "character": {"id": cid, "name": "X", "description": ""},
            "infotags": {},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
            "fetched_at": 1000,
        },
    )
    put_workbench(
        cid,
        {
            "_schema_version": archive_workbench.WORKING_SCHEMA_VERSION,
            "_overlay": ["images"],
            "character": {"id": cid, "name": "X"},
            "images": [{"image_id": "local-deadbeef", "description": "mine"}],
        },
    )

    rows = archive_images.list_character_images(cid)
    ids = sorted(r["image_id"] for r in rows)
    assert ids == ["45755545"]
    payload = workbench_payload(cid)
    assert payload is not None
    # The slot keeps its place and its description; only the id moves.
    assert payload["images"] == [
        {"image_id": "45755545", "description": "mine"}
    ]


def test_add_uploaded_image_rejects_non_image_bytes():
    cid = "511"
    archive_registry.create_character_dir(cid)
    row = archive_images.add_uploaded_image(cid, b"not an image")
    assert row is None
    assert not archive_images.images_dir(cid).exists() or not any(
        archive_images.images_dir(cid).iterdir()
    )


def test_list_character_images_includes_added_at():
    cid = "514"
    archive_registry.create_character_dir(cid)
    archive_images.write_character_image(cid, "333", "png", _PNG_HEADER)
    rows = archive_images.list_character_images(cid)
    assert len(rows) == 1
    assert rows[0]["image_id"] == "333"
    assert rows[0]["extension"] == "png"
    assert isinstance(rows[0]["added_at"], int)


def test_normalise_image_ext_jpeg_to_jpg():
    # Pinned because the pull cache check depends on this normalisation
    # to match what write_character_image stores. If F-list ever returns
    # "jpeg" the pull must hit the cache for an existing .jpg file.
    assert archive_images.normalise_image_ext("jpeg") == "jpg"
    assert archive_images.normalise_image_ext("JPEG") == "jpg"
    assert archive_images.normalise_image_ext(".png") == "png"


# ---- name-keyed folder registry ----------------------------------------


def _make_id_folder(cid: str, name: str):
    """Helper: create a legacy <id>/ character folder with live.json."""
    import json as _json
    d = archive_registry.root() / cid
    d.mkdir(parents=True, exist_ok=True)
    (d / "live.json").write_text(_json.dumps({"id": int(cid), "name": name}), encoding="utf-8")
    (d / "images").mkdir(parents=True, exist_ok=True)
    (d / "images" / "demo.png").write_bytes(b"png")
    return d


def _reset_registry_state():
    """Force the next load_registry() to re-run migration."""
    archive_registry._REGISTRY_MIGRATED = False
    archive_registry._invalidate_registry_cache()


def test_slug_for_filesystem_safe_name_passthrough():
    assert archive_registry._slug_for("Spielwiesending") == "Spielwiesending"
    assert archive_registry._slug_for("Cleo Thouvenin") == "Cleo Thouvenin"
    assert archive_registry._slug_for("a.b-c_d") == "a.b-c_d"


def test_slug_for_unicode_or_illegal_falls_back_to_hash():
    s1 = archive_registry._slug_for("Café Noir")
    s2 = archive_registry._slug_for("a/b<c>d")
    s3 = archive_registry._slug_for("CON")
    for s in (s1, s2, s3):
        assert s.startswith("c_")
        assert len(s) == 18  # "c_" + 16 hex


def test_slug_strips_leading_trailing_whitespace():
    # " leading-space " → "leading-space" after strip, which is fs-safe.
    assert archive_registry._slug_for(" leading-space ") == "leading-space"


def test_slug_is_stable_for_same_lowercased_name():
    # Lowercase normalization keeps "Café Noir" and "café noir" colliding —
    # F-list character names are case-insensitive unique anyway.
    assert archive_registry._slug_for("Café Noir") == archive_registry._slug_for("café noir")


def test_migration_renames_numeric_folders_to_name_slugs(tmp_path):
    _reset_registry_state()
    _make_id_folder("5070222", "Spielwiesending")
    _make_id_folder("4076218", "Cleo Thouvenin")
    _make_id_folder("999", "Café Noir")

    reg = archive_registry.load_registry()
    assert reg["5070222"] == {"name": "Spielwiesending", "folder": "Spielwiesending"}
    assert reg["4076218"] == {"name": "Cleo Thouvenin", "folder": "Cleo Thouvenin"}
    assert reg["999"]["folder"].startswith("c_")

    root = archive_registry.root()
    folders = sorted(p.name for p in root.iterdir() if p.is_dir())
    assert "5070222" not in folders
    assert "Spielwiesending" in folders
    assert "Cleo Thouvenin" in folders


def test_character_dir_resolves_via_registry(tmp_path):
    _reset_registry_state()
    _make_id_folder("5070222", "Spielwiesending")
    archive_registry.load_registry()  # trigger migration

    p = archive_registry.character_dir("5070222")
    assert p.name == "Spielwiesending"
    # Image bytes survived the rename.
    assert (p / "images" / "demo.png").exists()


def test_character_dir_falls_back_to_id_when_not_in_registry(tmp_path):
    _reset_registry_state()
    (archive_registry.root() / "999999").mkdir()
    p = archive_registry.character_dir("999999")
    assert p.name == "999999"


def test_character_dir_finds_and_never_creates(tmp_path):
    _reset_registry_state()
    with pytest.raises(archive_errors.CharacterNotFound):
        archive_registry.character_dir("999998")
    assert not (archive_registry.root() / "999998").exists()
    created = archive_registry.create_character_dir("999998")
    assert archive_registry.character_dir("999998") == created


def test_migration_is_idempotent(tmp_path):
    _reset_registry_state()
    _make_id_folder("5070222", "Spielwiesending")
    reg1 = archive_registry.load_registry()
    _reset_registry_state()
    reg2 = archive_registry.load_registry()
    assert reg1 == reg2


def test_migration_handles_collision(tmp_path):
    _reset_registry_state()
    # Pre-create a folder that would collide with the migration target.
    blocker = archive_registry.root() / "Spielwiesending"
    blocker.mkdir(parents=True, exist_ok=True)
    (blocker / "marker").write_text("untouched", encoding="utf-8")
    _make_id_folder("5070222", "Spielwiesending")

    reg = archive_registry.load_registry()
    # Registry should record the legacy id-named folder, not clobber.
    assert reg["5070222"]["folder"] == "5070222"
    assert (blocker / "marker").read_text(encoding="utf-8") == "untouched"


def test_write_live_renames_folder_on_name_change(tmp_path):
    _reset_registry_state()
    _make_id_folder("5070222", "OldName")
    archive_registry.load_registry()
    assert (archive_registry.root() / "OldName").exists()

    archive_live.write_live("5070222", {"id": 5070222, "name": "NewName"})

    assert not (archive_registry.root() / "OldName").exists()
    assert (archive_registry.root() / "NewName" / "live.json").exists()
    assert archive_registry.load_registry()["5070222"]["folder"] == "NewName"


def test_write_live_first_pull_creates_name_folder(tmp_path):
    _reset_registry_state()
    archive_live.write_live("9999999", {"id": 9999999, "name": "Brand New"})
    assert (archive_registry.root() / "Brand New" / "live.json").exists()
    assert archive_registry.load_registry()["9999999"]["folder"] == "Brand New"



def test_rename_zip_backup_persists_in_names_json(tmp_path):
    cid = "8010"
    archive_live.write_live(
        cid,
        {
            "character": {"id": int(cid), "name": "Renamy", "description": "v1"},
            "images": [],
            "kinks": {},
            "fetched_at": 100,
        },
    )
    res = archive_backups.save_zip_backup(cid, force=True, source="workbench", occasion="manual")
    fname = res["filename"]
    archive_backups.rename_zip_backup(cid, fname, "Pre-overhaul")
    rows = archive_backups.list_zip_backups(cid)
    assert rows[0]["name"] == "Pre-overhaul"
    # Empty string clears.
    archive_backups.rename_zip_backup(cid, fname, "")
    rows = archive_backups.list_zip_backups(cid)
    assert rows[0]["name"] is None


def test_forget_backup_name_drops_entry(tmp_path):
    cid = "8011"
    archive_live.write_live(
        cid,
        {
            "character": {"id": int(cid), "name": "Renamy", "description": "v1"},
            "images": [],
            "kinks": {},
            "fetched_at": 100,
        },
    )
    res = archive_backups.save_zip_backup(cid, force=True, source="workbench", occasion="manual")
    fname = res["filename"]
    archive_backups.rename_zip_backup(cid, fname, "label")
    archive_backups.forget_backup_name(cid, fname)
    # After forget, list shows no name on that row.
    rows = archive_backups.list_zip_backups(cid)
    assert rows[0]["name"] is None
