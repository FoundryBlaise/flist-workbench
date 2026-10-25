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

This module imports nothing from pytest, so scripts outside the suite
(tests/e2e/fixtures/build_fchat_dir.py) can use it too. Inside the
suite, the `data_invariants` plugin registers a hook with
`on_write` so it learns which Logs F-Chat (played by the test) wrote.
"""

from __future__ import annotations

import struct
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import partial
from pathlib import Path
from typing import Callable, Iterable, Literal

RecordType = Literal["chat", "action", "ad", "roll", "warn", "event"]

#: F-Chat's record type byte, as parser.TYPE_NAMES names it. Type 0 and
#: 1 are messages a person wrote; the rest are system lines.
TYPE_BYTES: dict[RecordType, int] = {
    "chat": 0,
    "action": 1,
    "ad": 2,
    "roll": 3,
    "warn": 4,
    "event": 5,
}


@dataclass(frozen=True, slots=True)
class Record:
    type: RecordType
    speaker: str
    text: str
    at: int


def record(type: RecordType, speaker: str, text: str, *, at: int) -> Record:
    """One record of the given type."""
    return Record(type, speaker, text, at)


#: A plain chat message.
chat = partial(record, "chat")
#: A `/me` action; `text` is what follows `/me`.
action = partial(record, "action")
#: A channel ad (system line).
ad = partial(record, "ad")
#: A dice roll or bottle spin (system line).
roll = partial(record, "roll")
#: A moderator warning (system line).
warn = partial(record, "warn")
#: A status or presence event (system line).
event = partial(record, "event")


def utc(
    year: int, month: int, day: int, hour: int = 0, minute: int = 0, second: int = 0
) -> int:
    """Unix timestamp of a UTC wall-clock time, for records that must
    land on a particular day (the chunker groups by UTC date)."""
    return int(
        datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc).timestamp()
    )


def encode(rec: Record) -> bytes:
    """One record as F-Chat writes it, footer included. For tests that
    splice damage between records; everyone else wants `write_log`."""
    sb = rec.speaker.encode("utf-8")
    tb = rec.text.encode("utf-8")
    body = (
        struct.pack("<IBB", rec.at, TYPE_BYTES[rec.type], len(sb))
        + sb
        + struct.pack("<H", len(tb))
        + tb
    )
    return body + struct.pack("<H", len(body))


_write_hooks: list[Callable[[Path], None]] = []


def on_write(hook: Callable[[Path], None]) -> None:
    """Call `hook(path)` after every `write_log`. Registering the same
    hook twice keeps one."""
    if hook not in _write_hooks:
        _write_hooks.append(hook)


def write_log(path: Path, records: Iterable[Record]) -> Path:
    """Write `records`, in order, as the F-Chat Log at `path` (parent
    folders are created). Returns `path`.

    This is F-Chat writing; in the suite the `log_unchanged` check (see
    `data_invariants`) takes these bytes as the Log's from now on."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"".join(encode(r) for r in records))
    for hook in _write_hooks:
        hook(path)
    return path


def parsed(*records: Record) -> list[dict]:
    """`records` as the real parser reads them back from a Log on disk:
    the message dicts the labels, the chunker and the Index get. For
    tests that hand messages to a library function directly."""
    from parser import parse_log  # the sidecar's; scripts outside it never call this

    with tempfile.TemporaryDirectory() as tmp:
        return list(parse_log(write_log(Path(tmp) / "log", records)))
