"""Tier 6 ZIP-serialiser contract tests, pinned in Tier 2/3 so the
wire shape can't drift before the serialiser ships.

Each case is marked `@pytest.mark.skip` until `sidecar.zip_serialise`
appears with a `to_zip_character_json(working_payload) -> dict` entry
point. The tests are the contract: once Tier 6 lands, removing the
skip turns them on and the implementer can't ship a serialiser that
breaks the rename map or omits the documented strips.

Reference: PHASE7_TIER2_PLAN.md §"ZIP serialisation reference" + the
custom_kinks_sample.json fixture.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "working"
CUSTOM_KINKS_SAMPLE = FIXTURE_DIR / "custom_kinks_sample.json"


def _load_sample() -> dict:
    return json.loads(CUSTOM_KINKS_SAMPLE.read_text(encoding="utf-8"))


def _load_serialiser():
    try:
        return importlib.import_module("zip_serialise")
    except ModuleNotFoundError:
        pytest.skip("zip_serialise ships in Tier 6")


# ---- Tier 2 settings rename map (PHASE7_TIER2_PLAN §"ZIP serialisation reference")


def test_settings_keys_renamed():
    serialiser = _load_serialiser()
    out = serialiser.to_zip_character_json(_load_sample())
    settings = out["settings"]
    assert settings["customsfirst"] is False
    assert settings["unbookmarkable"] is False
    assert settings["showfriends"] is False
    assert "guestbook" not in settings


def test_owner_only_settings_filled_from_defaults():
    serialiser = _load_serialiser()
    out = serialiser.to_zip_character_json(_load_sample())
    settings = out["settings"]
    assert settings["showtimezone"] is True
    assert settings["showbadges"] is False
    assert settings["showcharlist"] is True


def test_images_reshape_array_to_list_and_avatar():
    serialiser = _load_serialiser()
    payload = _load_sample()
    payload["images"] = [
        {"image_id": "1", "extension": "jpg"},
        {"image_id": "2", "extension": "png"},
    ]
    out = serialiser.to_zip_character_json(payload)
    assert "list" in out["images"]
    assert "avatar" in out["images"]


def test_inlines_reshape_dict_to_id_array():
    serialiser = _load_serialiser()
    payload = _load_sample()
    payload["inlines"] = {"5": {"hash": "x", "extension": "png", "nsfw": False}}
    out = serialiser.to_zip_character_json(payload)
    assert isinstance(out["inlines"], list)
    assert out["inlines"] == ["5"]


def test_overlay_and_schema_version_stripped():
    serialiser = _load_serialiser()
    out = serialiser.to_zip_character_json(_load_sample())
    for forbidden in ("_overlay", "_schema_version", "_custom_kinks_order"):
        assert forbidden not in out


# ---- Tier 3 custom-kinks transform (PHASE7_TIER3_PLAN §"Custom-kinks transform")


def test_zip_serialise_custom_kinks_count_omits_tombstone():
    serialiser = _load_serialiser()
    out = serialiser.to_zip_character_json(_load_sample())
    customs = out["customKinks"]
    assert len(customs) == 5


def test_zip_serialise_custom_kinks_order_matches_array_minus_tombstone():
    serialiser = _load_serialiser()
    out = serialiser.to_zip_character_json(_load_sample())
    ids_in_order = [
        c.get("id") for c in out["customKinks"] if c.get("id") is not None
    ]
    assert ids_in_order == ["31712021", "31712022", "31712024", "31712025"]


def test_zip_serialise_local_id_becomes_null():
    serialiser = _load_serialiser()
    out = serialiser.to_zip_character_json(_load_sample())
    local_entries = [c for c in out["customKinks"] if c["name"] == "Newly added"]
    assert len(local_entries) == 1
    assert local_entries[0]["id"] is None


def test_zip_serialise_custom_kinks_strip_children_and_deleted():
    serialiser = _load_serialiser()
    out = serialiser.to_zip_character_json(_load_sample())
    for entry in out["customKinks"]:
        assert "children" not in entry
        assert "_deleted" not in entry


def test_zip_serialise_invalid_choice_falls_back_to_undecided():
    serialiser = _load_serialiser()
    payload = _load_sample()
    payload["custom_kinks"]["31712024"]["choice"] = "nonsense"
    out = serialiser.to_zip_character_json(payload)
    entry = next(c for c in out["customKinks"] if c["name"] == "Maybe one")
    assert entry["choice"] == "undecided"


def test_zip_serialise_unicode_name_preserved():
    serialiser = _load_serialiser()
    out = serialiser.to_zip_character_json(_load_sample())
    names = [c["name"] for c in out["customKinks"]]
    assert "Custom kink B Ünïcøde" in names


# ---- Tier 3 standard-kinks passthrough


def test_zip_serialise_standard_kinks_passthrough():
    serialiser = _load_serialiser()
    payload = _load_sample()
    payload["kinks"] = {f"fetish_{i}": "undecided" for i in range(559)}
    payload["kinks"]["fetish_71"] = "fave"
    out = serialiser.to_zip_character_json(payload)
    assert out["kinks"]["fetish_71"] == "fave"
    assert len(out["kinks"]) == 559


# ---- Tier 6 format-drift canary -------------------------------------


def _candidate_fixture_paths():
    """Look up a real flistcharexporter export to canary against. The
    fixture isn't committed (treat real character exports as sensitive),
    so the test scans:
      1. `tests/fixtures/working/flist_OOC_Hub_*.zip` — local checkout
      2. `/sideprojects/flistcharexporter/flist_OOC_Hub_*.zip` — read-only
         mount inside the devcontainer
    First match wins; skip if neither is present (e.g. CI without the
    sideprojects mount)."""
    in_tree = list(FIXTURE_DIR.glob("flist_OOC_Hub_*.zip"))
    if in_tree:
        return in_tree[0]
    side = Path("/sideprojects/flistcharexporter")
    if side.exists():
        matches = list(side.glob("flist_OOC_Hub_*.zip"))
        if matches:
            return matches[0]
    return None


def _derive_working_from_character_json(character_json: dict) -> tuple[dict, dict]:
    """Invert the flistcharexporter shape into a working.json + pool
    manifest so the round-trip canary can re-serialise and compare.
    Implemented as the test fixture, not production code — the production
    inverse (loading a Tier 6 ZIP back into the editor for Diff) is a
    follow-up after the userscript-side restore lands."""
    import zip_serialise as zs

    # Invert the settings rename map.
    reverse_rename = {v: k for k, v in zs._SETTINGS_RENAME.items()}
    settings = {
        reverse_rename.get(k, k): v
        for k, v in character_json.get("settings", {}).items()
    }
    # Reshape custom kinks back to a dict + order.
    custom_kinks: dict = {}
    order: list = []
    for entry in character_json.get("customKinks", []):
        key = (
            entry["id"]
            if entry.get("id") is not None
            else f"local:{entry['name'][:8]}"
        )
        custom_kinks[key] = {
            "name": entry["name"],
            "description": entry.get("description", ""),
            "choice": entry.get("choice", "undecided"),
            "children": [],
        }
        order.append(key)
    # Reshape images: synthesise a pool manifest so the round-trip has
    # somewhere to look up the image_id during re-serialisation.
    pool_manifest: dict = {}
    working_images: list = []
    for entry in character_json.get("images", {}).get("list", []):
        filename = entry["filename"]
        stem = filename.rsplit("/", 1)[-1].rsplit(".", 1)
        image_id, ext = stem[0], stem[1]
        # Use a synthetic sha derived from the image_id so the inverse
        # is deterministic.
        fake_sha = f"shacanary{image_id}".ljust(64, "0")[:64]
        pool_manifest[fake_sha] = {"extension": ext, "image_id": image_id}
        working_images.append(
            {"sha256": fake_sha, "description": entry.get("description", "")}
        )
    char = character_json.get("character", {})
    working = {
        "_schema_version": 3,
        "_overlay": [],
        "character": {
            "id": char.get("id"),
            "name": char.get("name"),
            "description": char.get("description", ""),
            "custom_title": char.get("customTitle", ""),
        },
        "settings": settings,
        "infotags": character_json.get("infotags", {}),
        "kinks": character_json.get("kinks", {}),
        "custom_kinks": custom_kinks,
        "_custom_kinks_order": order,
        "images": working_images,
        "inlines": {
            sid: {"hash": "x", "extension": "png", "nsfw": False}
            for sid in character_json.get("inlines", [])
        },
    }
    return working, pool_manifest


def test_round_trip_against_real_export_fixture():
    """Canary against a real flistcharexporter export. Builds an
    equivalent working.json from the captured character.json, runs the
    serialiser, and asserts shape-equivalence modulo `meta`. Catches
    F-list form-field renames that would otherwise ship a corrupt
    restore bundle (QA feedback BLOCK #11)."""
    import zipfile

    fixture = _candidate_fixture_paths()
    if fixture is None:
        pytest.skip(
            "no flistcharexporter OOC Hub sample available (commit one to "
            "tests/fixtures/working/ or mount /sideprojects/flistcharexporter)"
        )
    serialiser = _load_serialiser()
    with zipfile.ZipFile(fixture) as z:
        original = json.loads(z.read("character.json"))
    working, manifest = _derive_working_from_character_json(original)
    reproduced = serialiser.to_zip_character_json(
        working, pool_manifest=manifest
    )

    # Compare modulo meta (exportedAt + version are emitter-specific).
    original_no_meta = {k: v for k, v in original.items() if k != "meta"}
    reproduced_no_meta = {k: v for k, v in reproduced.items() if k != "meta"}
    assert reproduced_no_meta == original_no_meta, (
        "round-trip diverged from original export — "
        "the userscript's reader will fail to consume the Workbench ZIP"
    )


# ---- pinned local_ prefix length (NIT #9) ----------------------------


def test_local_image_id_prefix_is_pinned_length():
    """User-uploaded images get a stable synthetic image_id derived from
    the sha. The prefix length is pinned at 16 hex chars (~64 bits) so
    collisions across a heavy user's lifetime pool are astronomically
    unlikely; shorter would court collisions, longer adds no value."""
    serialiser = _load_serialiser()
    sha = "a" * 64
    payload = {
        "_schema_version": 3,
        "_overlay": [],
        "images": [{"sha256": sha, "description": ""}],
    }
    manifest = {sha: {"extension": "png", "image_id": None, "source": "user_upload"}}
    out = serialiser.to_zip_character_json(payload, pool_manifest=manifest)
    filename = out["images"]["list"][0]["filename"]
    # images/local_<16 hex chars>.png
    assert filename == f"images/local_{'a' * 16}.png"
