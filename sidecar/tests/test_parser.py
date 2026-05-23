import os
from pathlib import Path

import pytest

from parser import classify_kind, extract_mentions, parse_log, strip_bbcode


def test_strip_bbcode_removes_balanced_tags() -> None:
    assert strip_bbcode("[b]hello[/b]") == "hello"
    assert strip_bbcode("[color=red]bright[/color] and [i]slanted[/i]") == "bright and slanted"


def test_strip_bbcode_keeps_inner_text_through_nesting() -> None:
    assert strip_bbcode("[b][i]nested[/i][/b]") == "nested"


def test_strip_bbcode_strips_unbalanced_leftovers() -> None:
    assert strip_bbcode("orphan [b]close missing") == "orphan close missing"


def test_extract_mentions_pulls_icon_user_eicon() -> None:
    mentions = extract_mentions(
        "[icon]Daemon Enariel[/icon] and [user]Somera[/user] with [eicon]smirk[/eicon]"
    )
    assert mentions == ["Daemon Enariel", "Somera", "smirk"]


def test_classify_kind_actions_are_ic() -> None:
    assert classify_kind(1, "smiles softly") == "ic"


def test_classify_kind_ooc_paren_paren_and_bracket() -> None:
    assert classify_kind(0, "(( brb dinner ))") == "ooc"
    assert classify_kind(0, "[OOC]quick note[/OOC]") == "ooc"


def test_classify_kind_default_chat_is_ic() -> None:
    assert classify_kind(0, "normal in-character line") == "ic"


def test_classify_kind_other_types_are_system() -> None:
    assert classify_kind(4, "warning text") == "system"
    assert classify_kind(5, "event") == "system"


# Integration test against the mounted F-Chat data directory.
# Skipped when the mount isn't present (CI / non-devcontainer runs).
DATA_DIR = Path(os.environ.get("FCHAT_DATA_DIR", "/sideprojects/rag/data"))


@pytest.mark.skipif(not DATA_DIR.exists(), reason="F-Chat data dir not mounted")
def test_parse_real_log_smoke() -> None:
    # Pick the smallest non-channel partner log we can find — quick + low risk.
    candidates: list[Path] = []
    for char_dir in DATA_DIR.iterdir():
        logs = char_dir / "logs"
        if not logs.is_dir():
            continue
        for p in logs.iterdir():
            if p.is_file() and not p.name.endswith(".idx") and not p.name.startswith("#") and p.name != "_":
                candidates.append(p)

    assert candidates, "no DM partner logs found in mounted data dir"
    smallest = min(candidates, key=lambda p: p.stat().st_size)
    msgs = list(parse_log(smallest))
    assert msgs, f"expected at least one message in {smallest.name}"
    first = msgs[0]
    assert isinstance(first["ts"], int)
    assert first["type"] in (0, 1, 2, 3, 4, 5)
    assert first["type_name"] in {"chat", "action", "ad", "roll", "warn", "event"}
    assert first["kind"] in {"ic", "ooc", "system"}
    assert "speaker" in first and first["speaker"]
