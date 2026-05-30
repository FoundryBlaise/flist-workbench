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


# ---- Tier 6 anchor against OOC Hub fixture (when ZIP_SCHEMA_FIXTURE lands)


def test_round_trip_against_ooc_hub_fixture():
    fixture = (
        FIXTURE_DIR.parent / "flist_OOC_Hub_1766849657193.zip"
    )
    if not fixture.exists():
        pytest.skip("OOC Hub ZIP fixture not in tree until Tier 6")
    serialiser = _load_serialiser()
    # Tier 6 implementer fills in: load ZIP, derive matching working.json,
    # call serialiser.to_zip_character_json, byte-compare modulo
    # meta.exportedAt.
    pytest.fail("Tier 6: implement the round-trip when the serialiser lands")
