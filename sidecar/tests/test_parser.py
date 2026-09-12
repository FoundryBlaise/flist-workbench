import os
import struct
from pathlib import Path

import pytest

import parser
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


def _record(ts: int, speaker: str, body: str, type_byte: int = 0) -> bytes:
    sb = speaker.encode("utf-8")
    bb = body.encode("utf-8")
    rec = (
        struct.pack("<IBB", ts, type_byte, len(sb))
        + sb
        + struct.pack("<H", len(bb))
        + bb
    )
    return rec + struct.pack("<H", len(rec))


def test_a_damaged_record_no_longer_ends_the_file(tmp_path: Path) -> None:
    """F-Chat can leave a half-written record behind — observed as 44
    bytes of nulls mid-file. The reader used to stop there, silently
    discarding everything after it: on one real log that was 10 MB of 16,
    154451 messages that parse perfectly once the damage is stepped over.
    """
    good_before = [_record(1700000000 + i, "A", "x" * 40) for i in range(3)]
    good_after = [_record(1700001000 + i, "B", "y" * 40) for i in range(5)]
    path = tmp_path / "damaged"
    path.write_bytes(b"".join(good_before) + b"\x00" * 44 + b"".join(good_after))

    messages = list(parser.parse_log(path))
    assert len(messages) == 8, [m["speaker"] for m in messages]
    assert [m["speaker"] for m in messages[:3]] == ["A", "A", "A"]
    assert [m["speaker"] for m in messages[3:]] == ["B"] * 5


def test_garbage_in_the_middle_is_stepped_over(tmp_path: Path) -> None:
    """The other shape seen in the wild: a few hundred bytes of unrelated
    bytes rather than nulls."""
    before = [_record(1700000000 + i, "A", "x" * 40) for i in range(2)]
    after = [_record(1700002000 + i, "B", "y" * 40) for i in range(6)]
    path = tmp_path / "garbage"
    path.write_bytes(
        b"".join(before) + bytes(range(256)) * 3 + b"".join(after)
    )
    messages = list(parser.parse_log(path))
    assert [m["speaker"] for m in messages] == ["A", "A"] + ["B"] * 6


def test_a_file_that_is_only_damage_still_stops(tmp_path: Path) -> None:
    """Resync must not turn an unreadable file into an endless scan, and
    must not invent messages out of noise."""
    path = tmp_path / "ruined"
    path.write_bytes(
        b"".join(_record(1700000000, "A", "x" * 40) for _ in range(1))
        + b"\xff" * 5000
    )
    messages = list(parser.parse_log(path))
    assert [m["speaker"] for m in messages] == ["A"]


def test_resync_needs_several_records_before_it_believes_a_position(
    tmp_path: Path,
) -> None:
    """A single record can line up by chance in binary data. One valid-
    looking record after the damage is not enough to resume on."""
    before = [_record(1700000000, "A", "x" * 40)]
    lone = _record(1700003000, "C", "z" * 40)
    path = tmp_path / "one-lucky-record"
    path.write_bytes(b"".join(before) + b"\x00" * 30 + lone + b"\xff" * 400)
    messages = list(parser.parse_log(path))
    # The lone record is not trusted, so parsing stops at the damage.
    assert [m["speaker"] for m in messages] == ["A"]
