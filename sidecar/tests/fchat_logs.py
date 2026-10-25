"""The one F-Chat Log writer every sidecar test uses.

A test declares the records it needs and gets a binary Log on disk
that the real parser reads, so nothing downstream (labels, the
chunker, the MCP tools) is tested against a hand-built message dict:

    write_log(root / "Azure Viper" / "logs" / "Antiquill", [
        chat("Azure Viper", "Evening.", at=utc(2024, 3, 9, 23, 59)),
        action("Antiquill", "tips his hat.", at=utc(2024, 3, 10)),
        ad("Aina Sato", "Looking for a story.", at=1700000000),
    ])

Record layout (little-endian), as parser.py reads it: u32 timestamp,
u8 type, u8 speaker length, speaker, u16 text length, text, then a u16
footer holding the record's size without the footer.

`text` is written exactly as given. For an action that is what the
user typed after `/me`; the parser presents it with the speaker in
front, so `action("Antiquill", "tips his hat.")` reads back as
"Antiquill tips his hat.".
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

#: F-Chat's record type byte, as parser.TYPE_NAMES names it. Type 0 and
#: 1 are messages a person wrote; the rest are system lines.
TYPE_BYTES = {"chat": 0, "action": 1, "ad": 2, "roll": 3, "warn": 4, "event": 5}


@dataclass(frozen=True, slots=True)
class Record:
    type: str
    speaker: str
    text: str
    at: int


def chat(speaker: str, text: str, *, at: int) -> Record:
    """A plain chat message."""
    return Record("chat", speaker, text, at)


def action(speaker: str, text: str, *, at: int) -> Record:
    """A `/me` action; `text` is what follows `/me`."""
    return Record("action", speaker, text, at)


def ad(speaker: str, text: str, *, at: int) -> Record:
    """A channel ad (system line)."""
    return Record("ad", speaker, text, at)


def roll(speaker: str, text: str, *, at: int) -> Record:
    """A dice roll or bottle spin (system line)."""
    return Record("roll", speaker, text, at)


def warn(speaker: str, text: str, *, at: int) -> Record:
    """A moderator warning (system line)."""
    return Record("warn", speaker, text, at)


def event(speaker: str, text: str, *, at: int) -> Record:
    """A status or presence event (system line)."""
    return Record("event", speaker, text, at)


def utc(
    year: int, month: int, day: int, hour: int = 0, minute: int = 0, second: int = 0
) -> int:
    """Unix timestamp of a UTC wall-clock time, for records that must
    land on a particular day (the chunker groups by UTC date)."""
    return int(
        datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc).timestamp()
    )


def encode(record: Record) -> bytes:
    """One record as F-Chat writes it, footer included. For tests that
    splice damage between records; everyone else wants `write_log`."""
    sb = record.speaker.encode("utf-8")
    tb = record.text.encode("utf-8")
    body = (
        struct.pack("<IBB", record.at, TYPE_BYTES[record.type], len(sb))
        + sb
        + struct.pack("<H", len(tb))
        + tb
    )
    return body + struct.pack("<H", len(body))


def write_log(path: Path, records: Iterable[Record]) -> Path:
    """Write `records`, in order, as the F-Chat Log at `path` (parent
    folders are created). Returns `path`.

    This is F-Chat writing, so the `log_unchanged` check (see
    `data_invariants`) takes these bytes as the Log's from now on."""
    import data_invariants

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"".join(encode(r) for r in records))
    data_invariants.fchat_wrote(path)
    return path
