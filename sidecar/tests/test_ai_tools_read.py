"""Tests for the assistant's read tools (cross-character + backups)."""
from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Any

import pytest


MAPPING_LIST: dict[str, Any] = {
    "infotags": {
        "49": {
            "id": 49,
            "name": "Language",
            "list": [{"id": 21, "name": "English"}, {"id": 22, "name": "German"}],
        }
    },
    "kinks": [{"id": 100, "name": "k100"}],
}


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    monkeypatch.delenv("FCHAT_DATA_DIR", raising=False)
    import importlib
    import sys

    for mod in (
        "paths",
        "character_archive",
        "ai_tools_read",
        "ai_tools_composite",
    ):
        if mod in sys.modules:
            importlib.reload(sys.modules[mod])
    return tmp_path / "wb"


def _seed(character_id: str, name: str, *, with_kinks: dict[str, str] | None = None,
          custom_kinks: dict[str, Any] | None = None) -> None:
    import character_archive

    character_archive.register_character(character_id, name)
    working = {
        "_schema_version": character_archive.WORKING_SCHEMA_VERSION,
        "_overlay": [],
        "character": {"id": int(character_id), "name": name, "description": "desc"},
        "infotags": {"49": "21"},
        "settings": {"public": True},
        "kinks": with_kinks or {"100": "yes"},
        "custom_kinks": custom_kinks or {},
        "_custom_kinks_order": list((custom_kinks or {}).keys()),
        "images": [],
    }
    character_archive.write_working(character_id, working)


def test_list_my_characters_returns_registered(env: Path) -> None:
    import ai_tools_read

    _seed("42", "Alpha")
    _seed("43", "Bravo")
    chars = ai_tools_read.list_my_characters()
    names = [c["name"] for c in chars]
    assert names == ["Alpha", "Bravo"]
    assert all(c["has_working_copy"] for c in chars)


def test_get_other_character_refuses_unknown(env: Path) -> None:
    import ai_tools_read

    _seed("42", "Alpha")
    with pytest.raises(LookupError, match="unknown_local_character"):
        ai_tools_read.get_other_character("9999")


def test_get_active_character_compressed_shape(env: Path) -> None:
    import ai_tools_read

    _seed("42", "Alpha", with_kinks={"100": "fave", "200": "no"})
    out = ai_tools_read.get_active_character("42")
    assert out["_compressed"] is True
    assert out["kinks"]["fave"] == ["100"]
    assert out["kinks"]["no"] == ["200"]


def test_get_active_character_with_fields_returns_slice(env: Path) -> None:
    import ai_tools_read

    _seed("42", "Alpha")
    out = ai_tools_read.get_active_character(
        "42", fields=["character.description", "infotags.49"]
    )
    assert out["character"]["description"] == "desc"
    assert out["infotags"]["49"] == "21"
    # Not requested → absent
    assert "kinks" not in out


def test_get_active_character_kinks_raw_marker(env: Path) -> None:
    import ai_tools_read

    _seed("42", "Alpha", with_kinks={"100": "fave"})
    out = ai_tools_read.get_active_character(
        "42", fields=["kinks.raw", "character.description"]
    )
    assert out["kinks"] == {"100": "fave"}


def test_get_backup_field_reads_single_path(env: Path, tmp_path: Path) -> None:
    """Write a synthetic ZIP into the character's backups dir and read
    one field out of it via the tool — the backup integration."""
    import ai_tools_read
    import character_archive

    _seed("42", "Alpha")
    backups = character_archive.backups_dir("42")
    backups.mkdir(parents=True, exist_ok=True)
    zip_path = backups / "2026-06-01T120000Z.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr(
            "working.json",
            json.dumps(
                {
                    "character": {"description": "older body"},
                    "infotags": {"49": "22"},
                }
            ),
        )
    val = ai_tools_read.get_backup_field("42", zip_path.name, "infotags.49")
    assert val == "22"


def test_get_mapping_list_options_resolves(env: Path) -> None:
    import ai_tools_read

    options = ai_tools_read.get_mapping_list_options("49", MAPPING_LIST)
    labels = [o["label"] for o in options]
    assert "English" in labels
    assert "German" in labels


def test_execute_read_tool_dispatch_unknown(env: Path) -> None:
    import ai_tools_read

    with pytest.raises(LookupError, match="unknown read tool"):
        ai_tools_read.execute_read_tool(
            "exfiltrate", {}, active_character_id="42", mapping_list=MAPPING_LIST
        )
