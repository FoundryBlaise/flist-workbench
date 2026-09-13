"""Working-sets v2 storage helpers — character_archive layer.

Covers: per-set directory layout, meta round-trip, payload etag flow,
active-set pointer, M3 migration of legacy working.json, create/dup/
rename/delete semantics, set-name validation, set_id path-safety.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest


@pytest.fixture(autouse=True)
def isolated_userdata(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    import importlib
    import character_archive

    importlib.reload(character_archive)
    yield character_archive


def _seed_live(archive, cid: str = "123") -> dict[str, Any]:
    live = {
        "character": {
            "id": int(cid),
            "name": "Lady Amber Blaise",
            "description": "[b]hi[/b]",
            "custom_title": None,
        },
        "infotags": {"info_9": "Human"},
        "kinks": {},
        "custom_kinks": {},
        "inlines": {},
        "images": [
            {"image_id": "30012128", "extension": "png", "sort_order": 0,
             "description": ""},
        ],
        "fetched_at": 100,
    }
    archive.write_live(cid, live)
    return live


def _payload(**extra: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "_schema_version": 6,
        "_overlay": ["character.description"],
        "character": {"id": "123", "name": "Probe", "description": "[b]hi[/b]"},
    }
    out.update(extra)
    return out


# ---- schema version ---------------------------------------------------


def test_working_schema_version_is_v6(isolated_userdata) -> None:
    assert isolated_userdata.WORKING_SCHEMA_VERSION == 6


# ---- set-id + name validation ----------------------------------------


def test_validate_set_name_strips_and_rejects_empty(isolated_userdata) -> None:
    archive = isolated_userdata
    assert archive.validate_set_name("  Main  ") == "Main"
    with pytest.raises(ValueError):
        archive.validate_set_name("   ")
    with pytest.raises(ValueError):
        archive.validate_set_name("")


def test_validate_set_name_rejects_nul_and_overlong(isolated_userdata) -> None:
    archive = isolated_userdata
    with pytest.raises(ValueError):
        archive.validate_set_name("bad\x00name")
    with pytest.raises(ValueError):
        archive.validate_set_name("x" * 81)
    # 80 is the boundary and must be accepted.
    assert archive.validate_set_name("x" * 80) == "x" * 80


def test_validate_set_name_accepts_duplicate_names(isolated_userdata) -> None:
    archive = isolated_userdata
    _seed_live(archive)
    a = archive.create_set_from_live("123", "Main")
    b = archive.create_set_from_live("123", "Main")
    assert a.id != b.id
    assert a.name == b.name == "Main"


def test_set_dir_rejects_invalid_set_id(isolated_userdata) -> None:
    archive = isolated_userdata
    with pytest.raises(ValueError):
        archive.set_dir("123", "../../../etc/passwd")
    with pytest.raises(ValueError):
        archive.set_dir("123", "abc")
    with pytest.raises(ValueError):
        archive.set_dir("123", "ABCDEF123456")


# ---- M3 migration -----------------------------------------------------


def test_list_sets_unlinks_legacy_working_json(isolated_userdata) -> None:
    archive = isolated_userdata
    cdir = archive.character_dir("123")
    legacy = cdir / "working.json"
    legacy.write_text(json.dumps({"_schema_version": 5, "_overlay": []}))
    (cdir / "working.json.tmp").write_text("partial")
    (cdir / "working.bak").write_text("older")
    assert archive.list_sets("123") == []
    assert not legacy.exists()
    assert not (cdir / "working.json.tmp").exists()
    assert not (cdir / "working.bak").exists()


def test_migration_is_idempotent_on_clean_dir(isolated_userdata) -> None:
    archive = isolated_userdata
    archive._migrate_working_v2("123")
    archive._migrate_working_v2("123")
    cdir = archive.character_dir("123")
    assert cdir.exists()
    assert not (cdir / "working.json").exists()


# ---- create / list / payload round-trip -------------------------------


def test_create_set_from_live_seeds_payload(isolated_userdata) -> None:
    archive = isolated_userdata
    _seed_live(archive)
    meta = archive.create_set_from_live("123", "Main")
    assert len(meta.id) == 12
    assert meta.name == "Main"
    assert meta.created_at == meta.updated_at
    payload = archive.read_set_payload("123", meta.id)
    assert payload is not None
    assert payload["_schema_version"] == 6
    assert payload["character"]["name"] == "Lady Amber Blaise"
    assert payload["infotags"] == {"info_9": "Human"}
    assert payload["images"][0]["image_id"] == "30012128"


def test_create_set_without_live_raises(isolated_userdata) -> None:
    archive = isolated_userdata
    with pytest.raises(ValueError):
        archive.create_set_from_live("123", "Main")


def test_list_sets_orders_newest_first(isolated_userdata) -> None:
    archive = isolated_userdata
    _seed_live(archive)
    a = archive.create_set_from_live("123", "Older")
    b = archive.create_set_from_live("123", "Newer")
    archive.write_set_meta(
        "123",
        a.id,
        name=a.name,
        created_at=a.created_at,
        updated_at=10,
    )
    archive.write_set_meta(
        "123",
        b.id,
        name=b.name,
        created_at=b.created_at,
        updated_at=20,
    )
    sets = archive.list_sets("123")
    assert [m.id for m in sets] == [b.id, a.id]


def test_list_sets_skips_corrupt_meta(isolated_userdata) -> None:
    archive = isolated_userdata
    _seed_live(archive)
    good = archive.create_set_from_live("123", "Main")
    bad_id = "abcdef012345"
    bad_dir = archive.set_dir("123", bad_id)
    bad_dir.mkdir(parents=True, exist_ok=True)
    (bad_dir / "meta.json").write_text("{not json")
    sets = archive.list_sets("123")
    assert [m.id for m in sets] == [good.id]


# ---- meta round-trip --------------------------------------------------


def test_read_meta_returns_none_for_missing(isolated_userdata) -> None:
    archive = isolated_userdata
    assert archive.read_set_meta("123", "abcdef012345") is None


def test_meta_uses_snake_case_keys_on_disk(isolated_userdata) -> None:
    archive = isolated_userdata
    _seed_live(archive)
    meta = archive.create_set_from_live("123", "Main")
    on_disk = json.loads(
        archive.set_meta_path("123", meta.id).read_text(encoding="utf-8")
    )
    assert set(on_disk.keys()) == {"id", "name", "created_at", "updated_at"}


# ---- payload write + etag --------------------------------------------


def test_write_set_payload_round_trips_with_etag(isolated_userdata) -> None:
    archive = isolated_userdata
    _seed_live(archive)
    meta = archive.create_set_from_live("123", "Main")
    new = _payload(infotags={"info_9": "Elf"})
    first_etag = archive.set_payload_etag("123", meta.id)
    next_etag = archive.write_set_payload(
        "123", meta.id, new, expected_etag=first_etag
    )
    assert isinstance(next_etag, str) and len(next_etag) == 64
    assert next_etag != first_etag
    out = archive.read_set_payload("123", meta.id)
    assert out is not None and out["infotags"] == {"info_9": "Elf"}


def test_write_set_payload_stale_etag_raises(isolated_userdata) -> None:
    archive = isolated_userdata
    _seed_live(archive)
    meta = archive.create_set_from_live("123", "Main")
    with pytest.raises(archive.EtagMismatch) as info:
        archive.write_set_payload(
            "123", meta.id, _payload(), expected_etag="0" * 64
        )
    assert info.value.current_etag is not None


def test_write_set_payload_bumps_updated_at(isolated_userdata) -> None:
    archive = isolated_userdata
    _seed_live(archive)
    meta = archive.create_set_from_live("123", "Main")
    archive.write_set_meta(
        "123",
        meta.id,
        name=meta.name,
        created_at=meta.created_at,
        updated_at=1,
    )
    archive.write_set_payload(
        "123", meta.id, _payload(), expected_etag=None
    )
    after = archive.read_set_meta("123", meta.id)
    assert after is not None and after.updated_at > 1
    assert after.created_at == meta.created_at


def test_write_set_payload_rejects_unknown_set(isolated_userdata) -> None:
    archive = isolated_userdata
    with pytest.raises(FileNotFoundError):
        archive.write_set_payload(
            "123", "abcdef012345", _payload(), expected_etag=None
        )


def test_write_set_payload_rejects_bad_shape(isolated_userdata) -> None:
    archive = isolated_userdata
    _seed_live(archive)
    meta = archive.create_set_from_live("123", "Main")
    with pytest.raises(ValueError):
        archive.write_set_payload(
            "123", meta.id, {"_schema_version": 6, "_overlay": []},
            expected_etag=None,
        )


# ---- active pointer ---------------------------------------------------


def test_active_pointer_missing_reads_as_none(isolated_userdata) -> None:
    archive = isolated_userdata
    assert archive.read_active_set_id("123") is None


def test_active_pointer_set_and_clear(isolated_userdata) -> None:
    archive = isolated_userdata
    _seed_live(archive)
    meta = archive.create_set_from_live("123", "Main")
    archive.set_active_set_id("123", meta.id)
    assert archive.read_active_set_id("123") == meta.id
    archive.clear_active_set_id("123")
    assert archive.read_active_set_id("123") is None


def test_active_pointer_explicit_null_disk_shape(isolated_userdata) -> None:
    archive = isolated_userdata
    archive.clear_active_set_id("123")
    on_disk = json.loads(
        archive.active_set_path("123").read_text(encoding="utf-8")
    )
    assert on_disk == {"active_set_id": None}


def test_active_pointer_rejects_invalid_id(isolated_userdata) -> None:
    archive = isolated_userdata
    with pytest.raises(ValueError):
        archive.set_active_set_id("123", "not-a-set-id")


# ---- duplicate / rename / delete -------------------------------------


def test_duplicate_set_copies_payload_under_new_id(isolated_userdata) -> None:
    archive = isolated_userdata
    _seed_live(archive)
    src = archive.create_set_from_live("123", "Main")
    archive.write_set_payload(
        "123", src.id, _payload(infotags={"info_9": "Human"}),
        expected_etag=None,
    )
    dup = archive.duplicate_set("123", src.id, "Main (copy)")
    assert dup.id != src.id
    assert dup.name == "Main (copy)"
    src_payload = archive.read_set_payload("123", src.id)
    dup_payload = archive.read_set_payload("123", dup.id)
    assert src_payload is not None and dup_payload is not None
    assert src_payload["infotags"] == dup_payload["infotags"]


def test_duplicate_set_missing_source_raises(isolated_userdata) -> None:
    archive = isolated_userdata
    with pytest.raises(FileNotFoundError):
        archive.duplicate_set("123", "abcdef012345", "Copy")


def test_rename_set_updates_meta_only(isolated_userdata) -> None:
    archive = isolated_userdata
    _seed_live(archive)
    meta = archive.create_set_from_live("123", "Main")
    archive.write_set_meta(
        "123",
        meta.id,
        name=meta.name,
        created_at=meta.created_at,
        updated_at=1,
    )
    renamed = archive.rename_set("123", meta.id, "Modern AU")
    assert renamed.id == meta.id
    assert renamed.name == "Modern AU"
    assert renamed.updated_at > 1


def test_rename_missing_set_raises(isolated_userdata) -> None:
    archive = isolated_userdata
    with pytest.raises(FileNotFoundError):
        archive.rename_set("123", "abcdef012345", "Whatever")


def test_delete_set_removes_directory_and_clears_active(
    isolated_userdata,
) -> None:
    archive = isolated_userdata
    _seed_live(archive)
    meta = archive.create_set_from_live("123", "Main")
    archive.set_active_set_id("123", meta.id)
    d = archive.set_dir("123", meta.id)
    assert d.exists()
    archive.delete_set("123", meta.id)
    assert not d.exists()
    assert archive.read_active_set_id("123") is None


def test_delete_other_set_leaves_active_alone(isolated_userdata) -> None:
    archive = isolated_userdata
    _seed_live(archive)
    a = archive.create_set_from_live("123", "Keep")
    b = archive.create_set_from_live("123", "Toss")
    archive.set_active_set_id("123", a.id)
    archive.delete_set("123", b.id)
    assert archive.read_active_set_id("123") == a.id


def test_delete_missing_set_raises(isolated_userdata) -> None:
    archive = isolated_userdata
    with pytest.raises(FileNotFoundError):
        archive.delete_set("123", "abcdef012345")


# ---- the workbench -----------------------------------------------------


def test_the_workbench_is_created_from_live_on_first_ask(
    isolated_userdata,
) -> None:
    """One bench per character, always there. The user never creates it,
    which is the point: "what is a working set and do I need one" was
    the question testers could not answer."""
    ca = isolated_userdata
    ca.register_character("123", "Lady Amber Blaise")
    _seed_live(ca)

    assert ca.resolve_workbench("123", create=False) is None
    bench = ca.resolve_workbench("123")
    assert bench is not None
    assert bench.name == ca.WORKBENCH_SET_NAME
    assert ca.read_active_set_id("123") == bench.id
    # Idempotent: asking again is the same bench, not a second one.
    assert ca.resolve_workbench("123").id == bench.id
    assert len(ca.list_sets("123")) == 1


def test_an_existing_set_becomes_the_workbench_without_being_renamed(
    isolated_userdata,
) -> None:
    """An archive from before the rename needs no migration step. The set
    the user was already editing stays the one they edit — relabelled in
    the window, its own name untouched on disk."""
    ca = isolated_userdata
    ca.register_character("123", "Lady Amber Blaise")
    _seed_live(ca)
    mine = ca.create_set_from_live("123", "V2")
    ca.clear_active_set_id("123")

    bench = ca.resolve_workbench("123")
    assert bench.id == mine.id
    assert bench.name == "V2"
    assert len(ca.list_sets("123")) == 1


def test_several_sets_resolve_to_the_newest_and_keep_the_rest(
    isolated_userdata,
) -> None:
    """Nothing is deleted or renamed behind the user's back. The extras
    stay on disk, reachable through the MCP tools, absent from the
    window."""
    ca = isolated_userdata
    ca.register_character("123", "Lady Amber Blaise")
    _seed_live(ca)
    older = ca.create_set_from_live("123", "Copy_old")
    newer = ca.create_set_from_live("123", "Experiling")
    ca.clear_active_set_id("123")
    # Both were created in the same second, so the sort ties and falls
    # back to the id. Bump the intended winner so "most recently
    # changed" is a real distinction here.
    ca.write_set_meta(
        "123",
        newer.id,
        name=newer.name,
        created_at=newer.created_at,
        updated_at=newer.updated_at + 60,
    )

    bench = ca.resolve_workbench("123")
    assert bench.id == newer.id
    assert {m.id for m in ca.list_sets("123")} == {older.id, newer.id}


def test_the_active_set_wins_over_a_newer_one(isolated_userdata) -> None:
    ca = isolated_userdata
    ca.register_character("123", "Lady Amber Blaise")
    _seed_live(ca)
    chosen = ca.create_set_from_live("123", "the one I was editing")
    ca.create_set_from_live("123", "newer but never activated")
    ca.set_active_set_id("123", chosen.id)

    assert ca.resolve_workbench("123").id == chosen.id


def test_without_live_there_is_nothing_to_seed_a_workbench_from(
    isolated_userdata,
) -> None:
    ca = isolated_userdata
    ca.register_character("123", "Lady Amber Blaise")
    assert ca.resolve_workbench("123") is None


def test_loading_a_backup_overwrites_the_one_bench(isolated_userdata) -> None:
    """The old path made a *new* set from a backup, which is how a user
    ended up with several and stopped knowing which one they were
    editing. Loading now replaces the bench in place."""
    ca = isolated_userdata
    ca.register_character("123", "Lady Amber Blaise")
    _seed_live(ca)
    bench = ca.resolve_workbench("123")
    edited = _payload(
        character={"id": "123", "name": "Probe", "description": "edited since"}
    )
    ca.write_set_payload("123", bench.id, edited, expected_etag=None)
    saved = ca.save_zip_backup("123", kind="manual_single")

    later = _payload(
        character={"id": "123", "name": "Probe", "description": "later change"}
    )
    ca.write_set_payload("123", bench.id, later, expected_etag=None)
    loaded = ca.load_zip_backup_into_workbench("123", saved["filename"])

    assert loaded.id == bench.id, "must not create a second set"
    assert len(ca.list_sets("123")) == 1
    restored = ca.read_set_payload("123", bench.id)
    assert restored["character"]["description"] == "edited since"


def test_a_backup_captures_the_workbench_not_live(isolated_userdata) -> None:
    """Live can be pulled from F-list again whenever you like; the
    workbench cannot. A backup exists to protect what is irreplaceable,
    so it carries the bench. Live's own history is unaffected — that has
    always lived separately under snapshots/.
    """
    import json
    import zipfile

    ca = isolated_userdata
    ca.register_character("123", "Lady Amber Blaise")
    _seed_live(ca)
    bench = ca.resolve_workbench("123")
    ca.write_set_payload(
        "123",
        bench.id,
        _payload(
            character={
                "id": "123",
                "name": "Lady Amber Blaise",
                "description": "unpublished work",
            }
        ),
        expected_etag=None,
    )

    saved = ca.save_zip_backup("123", kind="manual_single")
    with zipfile.ZipFile(saved["path"], "r") as zf:
        stored = json.loads(zf.read("working.json").decode("utf-8"))
    assert stored["character"]["description"] == "unpublished work"
    # Live said "[b]hi[/b]"; the backup is not a copy of it.
    assert stored["character"]["description"] != "[b]hi[/b]"


def test_a_backup_falls_back_to_live_when_there_is_no_bench_yet(
    isolated_userdata,
) -> None:
    """Backing up a character the user has never edited still has to
    produce something useful."""
    import json
    import zipfile

    ca = isolated_userdata
    ca.register_character("123", "Lady Amber Blaise")
    _seed_live(ca)

    saved = ca.save_zip_backup("123", kind="manual_single")
    with zipfile.ZipFile(saved["path"], "r") as zf:
        stored = json.loads(zf.read("working.json").decode("utf-8"))
    assert stored["character"]["description"] == "[b]hi[/b]"
