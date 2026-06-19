"""Tests for the assistant's composite (bulk + copy-from-other) tools."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    import importlib
    import sys

    for mod in ("paths", "character_archive", "ai_tools_composite"):
        if mod in sys.modules:
            importlib.reload(sys.modules[mod])
    return tmp_path / "wb"


def _seed(
    character_id: str,
    name: str,
    *,
    kinks: dict[str, str] | None = None,
    custom_kinks: dict[str, Any] | None = None,
    infotags: dict[str, str] | None = None,
) -> None:
    import character_archive

    character_archive.register_character(character_id, name)
    working = {
        "_schema_version": character_archive.WORKING_SCHEMA_VERSION,
        "_overlay": [],
        "character": {"id": int(character_id), "name": name, "description": ""},
        "infotags": infotags or {},
        "settings": {},
        "kinks": kinks or {},
        "custom_kinks": custom_kinks or {},
        "_custom_kinks_order": list((custom_kinks or {}).keys()),
        "images": [],
    }
    character_archive.write_working(character_id, working)


def test_bulk_set_standard_kinks_emits_one_edit_per_assignment(env: Path) -> None:
    import ai_tools_composite

    edits = ai_tools_composite.bulk_set_standard_kinks(
        [{"kink_id": "10", "choice": "fave"}, {"kink_id": "20", "choice": "no"}],
        "test",
    )
    assert len(edits) == 2
    assert {e["composite_id"] for e in edits} == {edits[0]["composite_id"]}
    assert {e["new_value"] for e in edits} == {"fave", "no"}


def test_copy_standard_kinks_from_emits_only_diffs(env: Path) -> None:
    import ai_tools_composite

    _seed("42", "Alpha", kinks={"100": "yes", "200": "no"})
    _seed("43", "Bravo", kinks={"100": "fave", "200": "no", "300": "yes"})
    edits = ai_tools_composite.copy_standard_kinks_from(
        "42", "43", "all", "match B"
    )
    paths = {e["field_path"] for e in edits}
    # 100 differs (yes→fave) and 300 is new (undefined→yes); 200 matches.
    assert paths == {"kinks.100", "kinks.300"}


def test_copy_standard_kinks_only_fave_yes_filters(env: Path) -> None:
    import ai_tools_composite

    _seed("42", "Alpha", kinks={})
    _seed(
        "43", "Bravo",
        kinks={"100": "fave", "200": "no", "300": "yes", "400": "maybe"},
    )
    edits = ai_tools_composite.copy_standard_kinks_from(
        "42", "43", "only_fave_yes", "filter"
    )
    paths = {e["field_path"] for e in edits}
    assert paths == {"kinks.100", "kinks.300"}


def test_copy_standard_kinks_self_target_raises(env: Path) -> None:
    import ai_tools_composite

    _seed("42", "Alpha")
    with pytest.raises(ValueError):
        ai_tools_composite.copy_standard_kinks_from("42", "42", "all", "")


def test_copy_custom_kinks_replace_mode(env: Path) -> None:
    import ai_tools_composite

    _seed(
        "42", "Alpha",
        custom_kinks={"a1": {"name": "Old", "description": "", "choice": "yes"}},
    )
    _seed(
        "43", "Bravo",
        custom_kinks={
            "b1": {"name": "Imported", "description": "", "choice": "fave"},
            "b2": {"name": "Second", "description": "", "choice": "maybe"},
        },
    )
    edits = ai_tools_composite.copy_custom_kinks_from("42", "43", "replace", "swap")
    tools = [e["tool"] for e in edits]
    # One remove for the existing a1, two adds for B's kinks.
    assert tools.count("remove_custom_kink") == 1
    assert tools.count("add_custom_kink") == 2
    names = [e["new_value"]["name"] for e in edits if e["tool"] == "add_custom_kink"]
    assert sorted(names) == ["Imported", "Second"]


def test_copy_custom_kinks_merge_skips_duplicates(env: Path) -> None:
    import ai_tools_composite

    _seed(
        "42", "Alpha",
        custom_kinks={
            "a1": {"name": "Already", "description": "", "choice": "yes"}
        },
    )
    _seed(
        "43", "Bravo",
        custom_kinks={
            "b1": {"name": "ALREADY", "description": "", "choice": "fave"},
            "b2": {"name": "Brand new", "description": "", "choice": "yes"},
        },
    )
    edits = ai_tools_composite.copy_custom_kinks_from("42", "43", "merge", "")
    assert all(e["tool"] == "add_custom_kink" for e in edits)
    names = [e["new_value"]["name"] for e in edits]
    assert names == ["Brand new"]


def test_copy_infotags_from_emits_only_diffs(env: Path) -> None:
    import ai_tools_composite

    _seed("42", "Alpha", infotags={"49": "21", "9": "10"})
    _seed("43", "Bravo", infotags={"49": "22", "9": "10", "1": "6'2"})
    edits = ai_tools_composite.copy_infotags_from(
        "42", "43", ["49", "9", "1"], "copy three"
    )
    paths = {e["field_path"] for e in edits}
    # 49 differs; 9 matches; 1 only on source.
    assert paths == {"infotags.49", "infotags.1"}


def test_clear_all_custom_kinks(env: Path) -> None:
    import ai_tools_composite

    _seed(
        "42", "Alpha",
        custom_kinks={
            "a1": {"name": "One", "description": "", "choice": "yes"},
            "a2": {"name": "Two", "description": "", "choice": "no"},
        },
    )
    edits = ai_tools_composite.clear_all_custom_kinks("42", "wipe")
    assert len(edits) == 2
    assert all(e["tool"] == "remove_custom_kink" for e in edits)


def test_execute_composite_tool_dispatch(env: Path) -> None:
    import ai_tools_composite

    edits = ai_tools_composite.execute_composite_tool(
        "bulk_set_standard_kinks",
        {
            "assignments": [{"kink_id": "10", "choice": "fave"}],
            "rationale": "test",
        },
        active_character_id="42",
    )
    assert len(edits) == 1


def test_execute_composite_tool_unknown(env: Path) -> None:
    import ai_tools_composite

    with pytest.raises(LookupError):
        ai_tools_composite.execute_composite_tool(
            "totally_made_up", {"rationale": "x"}, active_character_id="42"
        )
