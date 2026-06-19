"""Unit tests for the AI-assistant validation guards.

Pure-function module — no FastAPI client, no temp dirs. Each test
isolates one guard so a failure points at the rule that broke.
"""
from __future__ import annotations

from typing import Any

import pytest

import ai_draft_validate as v


MAPPING_LIST: dict[str, Any] = {
    "infotags": {
        "49": {
            "id": 49,
            "name": "Language preferences",
            "type": "list",
            "list": [
                {"id": 21, "name": "English"},
                {"id": 22, "name": "German"},
                {"id": 23, "name": "French"},
            ],
        },
        "1": {
            "id": 1,
            "name": "Height",
            "type": "text",
        },
        "9": {
            "id": 9,
            "name": "Species",
            "type": "list",
            "list": [
                {"id": 10, "name": "Human"},
                {"id": 22, "name": "Anthro"},
            ],
        },
    },
    "kinks": [
        {"id": 100, "name": "k100"},
        {"id": 200, "name": "k200"},
    ],
}


def _working() -> dict[str, Any]:
    return {
        "_schema_version": 6,
        "_overlay": [],
        "character": {
            "id": 42,
            "name": "Test",
            "description": "Hello [b]world[/b].\nLine two.",
        },
        "infotags": {"49": "21", "1": "5'10\""},
        "settings": {"public": True, "show_friends": False},
        "kinks": {"100": "yes"},
        "custom_kinks": {"a1": {"name": "Strap", "description": "[b]bold[/b]", "choice": "yes"}},
        "_custom_kinks_order": ["a1"],
        "images": [{"image_id": "img-1", "description": "", "sort_order": 0}],
    }


def test_generate_allowlist_includes_core_paths():
    al = v.generate_allowlist(MAPPING_LIST)
    assert "character.description" in al
    assert "infotags.49" in al
    assert "infotags.1" in al
    assert "kinks.100" in al
    assert "kinks.200" in al
    assert "settings.public" in al
    # custom_kinks paths are wildcarded — collection root is in the set,
    # per-row paths resolve via is_path_allowed.
    assert "custom_kinks" in al
    assert "images" in al


def test_is_path_allowed_handles_custom_kink_wildcards():
    al = v.generate_allowlist(MAPPING_LIST)
    assert v.is_path_allowed("custom_kinks.a1", al)
    assert v.is_path_allowed("custom_kinks.a1.name", al)
    assert v.is_path_allowed("custom_kinks.a1.choice", al)
    assert not v.is_path_allowed("custom_kinks.a1.nope", al)


def test_check_bbcode_fidelity_rejects_uppercase():
    ok, msg = v.check_bbcode_fidelity("Hello [B]world[/B]")
    assert not ok
    assert "lowercase" in msg


def test_check_bbcode_fidelity_rejects_markdown_heading():
    ok, _ = v.check_bbcode_fidelity("# Title\n\nbody")
    assert not ok


def test_check_bbcode_fidelity_rejects_markdown_bold():
    ok, _ = v.check_bbcode_fidelity("here is **bold** text")
    assert not ok


def test_check_bbcode_fidelity_accepts_lowercase_bbcode():
    ok, _ = v.check_bbcode_fidelity("[b]bold[/b] and [user]name[/user]")
    assert ok


def test_check_anchor_handles_whitespace_normalisation():
    assert v.check_anchor("hello world", "hello   world")
    assert v.check_anchor("a\nb", "a\r\nb")
    assert not v.check_anchor("hello world", "goodbye world")


def test_reverse_lookup_infotag_resolves_label():
    listitem_id, label = v.reverse_lookup_infotag(49, "English", MAPPING_LIST)
    assert listitem_id == "21"
    assert label == "English"


def test_reverse_lookup_infotag_resolves_numeric():
    listitem_id, label = v.reverse_lookup_infotag(49, "22", MAPPING_LIST)
    assert listitem_id == "22"
    assert label == "German"


def test_reverse_lookup_infotag_unknown_value():
    listitem_id, err = v.reverse_lookup_infotag(49, "Klingon", MAPPING_LIST)
    assert listitem_id is None
    assert "unknown" in err.lower()


def test_reverse_lookup_infotag_unknown_infotag():
    listitem_id, err = v.reverse_lookup_infotag(99999, "anything", MAPPING_LIST)
    assert listitem_id is None
    assert "unknown infotag" in err.lower()


def test_reverse_lookup_infotag_free_text():
    listitem_id, label = v.reverse_lookup_infotag(1, "6'2\"", MAPPING_LIST)
    assert listitem_id == "6'2\""
    assert label == "6'2\""


def test_validate_set_infotag_happy_path():
    al = v.generate_allowlist(MAPPING_LIST)
    edit = {
        "tool": "set_infotag",
        "field_path": "infotags.49",
        "new_value": "German",
        "rationale": "user asked for German",
    }
    r = v.validate_edit(edit, _working(), al, MAPPING_LIST)
    assert r.ok, r.message
    assert r.edit["new_value"] == "22"
    assert r.edit["new_label_hint"] == "German"
    assert r.edit["old_value"] == "21"


def test_validate_set_infotag_rejects_unknown_label():
    al = v.generate_allowlist(MAPPING_LIST)
    edit = {
        "tool": "set_infotag",
        "field_path": "infotags.49",
        "new_value": "Klingon",
        "rationale": "alien speak",
    }
    r = v.validate_edit(edit, _working(), al, MAPPING_LIST)
    assert not r.ok
    assert r.reason == "unknown_value"


def test_validate_replace_description_rejects_markdown():
    al = v.generate_allowlist(MAPPING_LIST)
    edit = {
        "tool": "replace_description",
        "field_path": "character.description",
        "new_value": "# Title\n\nbody",
        "rationale": "polish",
    }
    r = v.validate_edit(edit, _working(), al, MAPPING_LIST)
    assert not r.ok
    assert r.reason == "bbcode_fidelity"


def test_validate_patch_description_anchor_match():
    al = v.generate_allowlist(MAPPING_LIST)
    edit = {
        "tool": "patch_description",
        "field_path": "character.description",
        "old_excerpt": "Hello [b]world[/b].",
        "new_value": "Hello [b]friend[/b].",
        "rationale": "swap",
    }
    r = v.validate_edit(edit, _working(), al, MAPPING_LIST)
    assert r.ok, r.message


def test_validate_patch_description_anchor_mismatch():
    al = v.generate_allowlist(MAPPING_LIST)
    edit = {
        "tool": "patch_description",
        "field_path": "character.description",
        "old_excerpt": "Goodbye [b]world[/b].",
        "new_value": "Hello [b]friend[/b].",
        "rationale": "swap",
    }
    r = v.validate_edit(edit, _working(), al, MAPPING_LIST)
    assert not r.ok
    assert r.reason == "anchor_mismatch"


def test_validate_set_standard_kink_enum_violation():
    al = v.generate_allowlist(MAPPING_LIST)
    edit = {
        "tool": "set_standard_kink",
        "field_path": "kinks.100",
        "new_value": "love",
        "rationale": "ranked too high",
    }
    r = v.validate_edit(edit, _working(), al, MAPPING_LIST)
    assert not r.ok
    assert r.reason == "bad_choice"


def test_validate_set_standard_kink_happy_path():
    al = v.generate_allowlist(MAPPING_LIST)
    edit = {
        "tool": "set_standard_kink",
        "field_path": "kinks.100",
        "new_value": "fave",
        "rationale": "user loves this",
    }
    r = v.validate_edit(edit, _working(), al, MAPPING_LIST)
    assert r.ok, r.message
    assert r.edit["new_value"] == "fave"
    assert r.edit["old_value"] == "yes"


def test_validate_custom_kink_attr_choice():
    al = v.generate_allowlist(MAPPING_LIST)
    edit = {
        "tool": "set_custom_kink",
        "field_path": "custom_kinks.a1.choice",
        "new_value": "fave",
        "rationale": "promote",
    }
    r = v.validate_edit(edit, _working(), al, MAPPING_LIST)
    assert r.ok, r.message
    assert r.edit["new_value"] == "fave"


def test_validate_custom_kink_rejects_unknown_id():
    al = v.generate_allowlist(MAPPING_LIST)
    edit = {
        "tool": "set_custom_kink",
        "field_path": "custom_kinks.unknown.choice",
        "new_value": "fave",
        "rationale": "bogus",
    }
    r = v.validate_edit(edit, _working(), al, MAPPING_LIST)
    assert not r.ok
    assert r.reason == "unknown_custom_kink"


def test_validate_set_character_setting_disallowed_key():
    al = v.generate_allowlist(MAPPING_LIST)
    edit = {
        "tool": "set_character_setting",
        "field_path": "settings.admin_mode",
        "new_value": True,
        "rationale": "elevate",
    }
    r = v.validate_edit(edit, _working(), al, MAPPING_LIST)
    assert not r.ok
    assert r.reason == "field_not_editable"


def test_validate_set_character_setting_allowed_key():
    al = v.generate_allowlist(MAPPING_LIST)
    edit = {
        "tool": "set_character_setting",
        "field_path": "settings.public",
        "new_value": False,
        "rationale": "go private",
    }
    r = v.validate_edit(edit, _working(), al, MAPPING_LIST)
    assert r.ok, r.message
    assert r.edit["new_value"] is False
    assert r.edit["old_value"] is True


def test_validate_add_image_to_gallery_dedup():
    al = v.generate_allowlist(MAPPING_LIST)
    edit = {
        "tool": "add_image_to_gallery",
        "field_path": "images",
        "new_value": "img-1",  # already in gallery
        "rationale": "duplicate",
    }
    r = v.validate_edit(edit, _working(), al, MAPPING_LIST)
    assert not r.ok
    assert r.reason == "already_in_gallery"


def test_validate_reorder_gallery_permutation_guard():
    al = v.generate_allowlist(MAPPING_LIST)
    edit = {
        "tool": "reorder_gallery",
        "field_path": "images",
        "new_value": ["img-1", "img-999"],  # not in current
        "rationale": "shuffle",
    }
    r = v.validate_edit(edit, _working(), al, MAPPING_LIST)
    assert not r.ok
    assert r.reason == "not_a_permutation"


def test_validate_reorder_gallery_happy_path():
    al = v.generate_allowlist(MAPPING_LIST)
    working = _working()
    working["images"].append({"image_id": "img-2", "description": "", "sort_order": 1})
    edit = {
        "tool": "reorder_gallery",
        "field_path": "images",
        "new_value": ["img-2", "img-1"],
        "rationale": "newer first",
    }
    r = v.validate_edit(edit, working, al, MAPPING_LIST)
    assert r.ok, r.message


def test_validate_unknown_tool_rejected():
    al = v.generate_allowlist(MAPPING_LIST)
    edit = {
        "tool": "exfiltrate_data",
        "field_path": "character.description",
        "rationale": "nope",
    }
    r = v.validate_edit(edit, _working(), al, MAPPING_LIST)
    assert not r.ok
    assert r.reason == "unknown_tool"


def test_validate_path_not_in_allowlist():
    al = v.generate_allowlist(MAPPING_LIST)
    edit = {
        "tool": "set_infotag",
        "field_path": "infotags.99999",  # not in mapping
        "new_value": "anything",
        "rationale": "bypass attempt",
    }
    r = v.validate_edit(edit, _working(), al, MAPPING_LIST)
    assert not r.ok
    assert r.reason == "field_not_editable"
