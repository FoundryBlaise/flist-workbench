"""Tier 7 Step 1 — v5 → v6 storage migration tests."""
from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def isolated_userdata(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    import importlib

    import character_archive

    importlib.reload(character_archive)
    yield


def _seed_v5_working(character_id: str) -> dict:
    import character_archive

    payload = {
        "_schema_version": 5,
        "_overlay": ["character.description"],
        "character": {"id": character_id, "name": "Probe", "description": "[b]hi[/b]"},
        "infotags": {"1": "Human"},
        "custom_kinks": {},
        "_custom_kinks_order": [],
    }
    target = character_archive.working_path(character_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return payload


def test_migration_v5_to_v6_roundtrip():
    import character_archive

    cid = "9999"
    original = _seed_v5_working(cid)
    set_id = character_archive.migrate_v5_working_to_sets(cid)
    assert set_id is not None
    sd = character_archive.sets_dir(cid)
    subdirs = [p for p in sd.iterdir() if p.is_dir()]
    assert len(subdirs) == 1
    assert subdirs[0].name == set_id

    payload = character_archive.read_set_payload(cid, set_id)
    assert payload is not None
    assert payload["character"]["description"] == original["character"]["description"]
    assert payload["_schema_version"] == character_archive.WORKING_SCHEMA_VERSION

    meta = character_archive.read_set_meta(cid, set_id)
    assert meta is not None
    assert meta.name == "Main"
    assert meta.snapshot_count == 0

    assert character_archive.read_active_set_id(cid) == set_id

    # working.json is gone.
    assert not character_archive.working_path(cid).exists()

    # Idempotent — re-running picks up the existing set and is a no-op.
    again = character_archive.migrate_v5_working_to_sets(cid)
    assert again == set_id
    assert len([p for p in sd.iterdir() if p.is_dir()]) == 1


def test_migration_v5_without_working_json():
    import character_archive

    cid = "8888"
    # Live exists but no working.json — migration mints no set, lazy
    # creation happens on first edit.
    character_archive.write_live(cid, {"name": "Lazy", "fetched_at": 100})
    result = character_archive.migrate_v5_working_to_sets(cid)
    assert result is None
    sd = character_archive.character_dir(cid) / character_archive.SETS_DIRNAME
    assert not sd.exists() or not any(p.is_dir() for p in sd.iterdir())
    assert character_archive.read_active_set_id(cid) is None

    # First edit later creates a set explicitly through create_set.
    meta = character_archive.create_set(cid, name="Main", seed="empty")
    assert character_archive.read_active_set_id(cid) == meta.id


def test_migration_is_noop_when_sets_already_exist():
    import character_archive

    cid = "7777"
    meta = character_archive.create_set(cid, name="Pre-existing", seed="empty")
    result = character_archive.migrate_v5_working_to_sets(cid)
    assert result == meta.id


def test_migration_full_roundtrip_preserves_image_bytes(tmp_path: Path):
    import character_archive

    cid = "6666"
    _seed_v5_working(cid)
    img_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    character_archive.write_character_image(cid, "30012128", "png", img_bytes)
    avatar_path = character_archive.avatar_path_for("Probe")
    avatar_path.write_bytes(b"\x89PNG\r\n\x1a\nAVATAR")

    import hashlib

    img_sha_before = hashlib.sha256(
        (character_archive.images_dir(cid) / "30012128.png").read_bytes()
    ).hexdigest()
    avatar_sha_before = hashlib.sha256(avatar_path.read_bytes()).hexdigest()

    set_id = character_archive.migrate_v5_working_to_sets(cid)
    assert set_id is not None

    img_sha_after = hashlib.sha256(
        (character_archive.images_dir(cid) / "30012128.png").read_bytes()
    ).hexdigest()
    avatar_sha_after = hashlib.sha256(avatar_path.read_bytes()).hexdigest()
    assert img_sha_before == img_sha_after
    assert avatar_sha_before == avatar_sha_after
    assert not character_archive.working_path(cid).exists()


def test_migration_keeps_working_json_when_payload_sha_mismatch(
    monkeypatch: pytest.MonkeyPatch,
):
    """If the post-write sha doesn't match the in-memory write, the legacy
    file is preserved for forensics rather than silently deleted."""
    import character_archive

    cid = "5555"
    _seed_v5_working(cid)

    real_sha = character_archive._file_sha256

    def fake_sha(path):
        if path.name == character_archive.SET_PAYLOAD_FILENAME:
            return "deadbeef"
        return real_sha(path)

    monkeypatch.setattr(character_archive, "_file_sha256", fake_sha)
    set_id = character_archive.migrate_v5_working_to_sets(cid)
    assert set_id is not None
    # Legacy file kept for forensics.
    assert character_archive.working_path(cid).exists()
