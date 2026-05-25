"""logs.py alias-aware behaviour — list_partners groups + read_messages merges.

These tests use the real on-disk + SQLite stack (no mocks) so they
exercise the same code paths the renderer hits.
"""

from __future__ import annotations

import struct
from pathlib import Path

import pytest

import aliases as aliases_store
from logs import LogDirError, PartnerEntry, list_partners, read_messages


def _write_log(path: Path, records: list[tuple[int, str, str]]) -> None:
    """Tiny F-Chat 3.0 log writer. Each record: (ts, speaker, body).

    Mirrors the binary record layout from parser.py — uint32 ts, uint8
    type=0(chat), uint8 sender_len, sender bytes, uint16 body_len,
    body bytes, uint16 record_size footer.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        for ts, speaker, body in records:
            sb = speaker.encode("utf-8")
            bb = body.encode("utf-8")
            # body_type=0 (chat), unused header byte
            record = struct.pack(
                "<IBB",  # ts (uint32), type (uint8), sender_len (uint8)
                ts,
                0,
                len(sb),
            ) + sb + struct.pack("<H", len(bb)) + bb
            footer = struct.pack("<H", len(record))
            f.write(record + footer)


@pytest.fixture
def fake_data(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    # One character with two partner log files that we'll alias together.
    char = tmp_path / "MyChar" / "logs"
    _write_log(char / "Daemon Enariel", [
        (1_700_000_000, "Daemon Enariel", "Old-name line one."),
        (1_700_000_300, "MyChar", "Old-name response."),
    ])
    _write_log(char / "Ashvalia", [
        (1_700_000_900, "Ashvalia", "New-name continuation."),
    ])
    # Plus an unrelated partner so we can verify grouping doesn't bleed.
    _write_log(char / "Other Partner", [
        (1_700_000_500, "Other Partner", "Unrelated."),
    ])
    return tmp_path


# ---- list_partners --------------------------------------------------------


def test_list_partners_unchanged_when_no_aliases(fake_data: Path) -> None:
    entries = list_partners("MyChar", root=fake_data)
    names = [e.name for e in entries]
    assert names == ["Ashvalia", "Daemon Enariel", "Other Partner"]
    assert all(e.aliases == () for e in entries)


def test_list_partners_groups_aliased_entries(fake_data: Path) -> None:
    conn = aliases_store.connect()
    try:
        aliases_store.add_alias(conn, "MyChar", "Daemon Enariel", "Ashvalia")
    finally:
        conn.close()

    entries = list_partners("MyChar", root=fake_data)
    by_name = {e.name: e for e in entries}
    # Daemon Enariel folded into Ashvalia → only one entry per group.
    assert sorted(by_name) == ["Ashvalia", "Other Partner"]
    merged = by_name["Ashvalia"]
    # bytes sum across both files; aliases excludes the primary itself.
    assert merged.aliases == ("Daemon Enariel",)
    daemon_size = (fake_data / "MyChar" / "logs" / "Daemon Enariel").stat().st_size
    ash_size = (fake_data / "MyChar" / "logs" / "Ashvalia").stat().st_size
    assert merged.bytes == daemon_size + ash_size


def test_list_partners_alias_pointing_at_missing_primary(fake_data: Path) -> None:
    """User aliases an on-disk partner under a primary that has no log
    file yet (typical when the partner renames again). The primary
    surfaces in the sidebar even without its own file, carrying the
    alias's bytes."""
    conn = aliases_store.connect()
    try:
        aliases_store.add_alias(
            conn, "MyChar", "Daemon Enariel", "FuturePrimaryName"
        )
    finally:
        conn.close()
    entries = list_partners("MyChar", root=fake_data)
    primary = next(e for e in entries if e.name == "FuturePrimaryName")
    assert "Daemon Enariel" in primary.aliases
    daemon_size = (fake_data / "MyChar" / "logs" / "Daemon Enariel").stat().st_size
    assert primary.bytes == daemon_size


def test_list_partners_alias_aware_per_character(fake_data: Path) -> None:
    # Linking under Character X must not affect Character Y's view.
    char2 = fake_data / "OtherChar" / "logs"
    _write_log(char2 / "Daemon Enariel", [(1, "Daemon Enariel", "hi")])
    conn = aliases_store.connect()
    try:
        aliases_store.add_alias(conn, "MyChar", "Daemon Enariel", "Ashvalia")
    finally:
        conn.close()
    char1_names = {e.name for e in list_partners("MyChar", root=fake_data)}
    char2_names = {e.name for e in list_partners("OtherChar", root=fake_data)}
    assert "Daemon Enariel" not in char1_names  # folded
    assert "Daemon Enariel" in char2_names  # untouched


# ---- read_messages --------------------------------------------------------


def test_read_messages_unchanged_when_no_aliases(fake_data: Path) -> None:
    msgs = list(read_messages("MyChar", "Daemon Enariel", root=fake_data))
    assert len(msgs) == 2
    assert [m["speaker"] for m in msgs] == ["Daemon Enariel", "MyChar"]


def test_read_messages_merges_alias_files_by_ts(fake_data: Path) -> None:
    conn = aliases_store.connect()
    try:
        aliases_store.add_alias(conn, "MyChar", "Daemon Enariel", "Ashvalia")
    finally:
        conn.close()

    # Reading by the primary name yields ts-ordered union of both files.
    msgs = list(read_messages("MyChar", "Ashvalia", root=fake_data))
    timestamps = [m["ts"] for m in msgs]
    assert timestamps == sorted(timestamps)
    speakers = [m["speaker"] for m in msgs]
    assert "Daemon Enariel" in speakers
    assert "Ashvalia" in speakers
    assert len(msgs) == 3


def test_read_messages_works_from_any_alias_in_the_group(fake_data: Path) -> None:
    conn = aliases_store.connect()
    try:
        aliases_store.add_alias(conn, "MyChar", "Daemon Enariel", "Ashvalia")
    finally:
        conn.close()
    # Opening via the OLD name also pulls the new — the merge is
    # symmetric across the group.
    from_old = list(read_messages("MyChar", "Daemon Enariel", root=fake_data))
    from_new = list(read_messages("MyChar", "Ashvalia", root=fake_data))
    assert len(from_old) == len(from_new) == 3
    assert [m["ts"] for m in from_old] == [m["ts"] for m in from_new]


def test_read_messages_limit_offset_apply_to_merged_stream(fake_data: Path) -> None:
    conn = aliases_store.connect()
    try:
        aliases_store.add_alias(conn, "MyChar", "Daemon Enariel", "Ashvalia")
    finally:
        conn.close()
    msgs = list(
        read_messages(
            "MyChar", "Ashvalia", root=fake_data, offset=1, limit=1
        )
    )
    assert len(msgs) == 1
    # All 3 merged messages → ts-sorted […0, …300, …900]; offset 1 → …300.
    assert msgs[0]["ts"] == 1_700_000_300


def test_read_messages_missing_partner_raises(fake_data: Path) -> None:
    with pytest.raises(LogDirError):
        list(read_messages("MyChar", "Nobody", root=fake_data))


def test_partner_entry_shape_backwards_compat() -> None:
    # Existing callers may construct PartnerEntry without aliases.
    e = PartnerEntry(name="X", bytes=10)
    assert e.aliases == ()
