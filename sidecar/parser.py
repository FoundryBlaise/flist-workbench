"""F-Chat 3.0 binary log parser.

Adapted from Chat_RAG/parser.py (/sideprojects/rag/parser.py). Kept as
a separate module so the sidecar can evolve independently of the
upstream RAG pipeline.

Record format (little-endian):
    uint32 timestamp
    uint8  type           0=chat, 1=action(/me), 2=ad, 3=roll, 4=warn, 5=event
    uint8  sender_len
    bytes  sender         (sender_len bytes, UTF-8)
    uint16 body_len
    bytes  body           (body_len bytes, UTF-8)
    uint16 record_size    excludes the footer itself
"""

from __future__ import annotations

import re
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, TypedDict

TYPE_NAMES = {0: "chat", 1: "action", 2: "ad", 3: "roll", 4: "warn", 5: "event"}


class Message(TypedDict):
    ts: int
    iso: str
    type: int
    type_name: str
    speaker: str
    raw: str
    text: str
    mentions: list[str]
    kind: str  # ic | ooc | system — heuristic, see classify_kind


_BBCODE_PAIR = re.compile(
    r"\[(?P<tag>[a-zA-Z]+)(?:=(?P<arg>[^\]]*))?\](?P<inner>.*?)\[/(?P=tag)\]",
    re.DOTALL | re.IGNORECASE,
)
_BBCODE_LEFTOVER = re.compile(r"\[/?[a-zA-Z*]+(?:=[^\]]*)?\]")
_MENTION_TAG = re.compile(
    r"\[(?P<tag>icon|user|eicon)\](?P<name>[^\]]+)\[/(?P=tag)\]",
    re.IGNORECASE,
)
_OOC_PREFIX = re.compile(r"^\s*(\(\(|\[ooc])", re.IGNORECASE)


def strip_bbcode(text: str) -> str:
    def repl(m: re.Match) -> str:
        return strip_bbcode(m.group("inner"))

    prev = None
    cur = text
    while prev != cur:
        prev = cur
        cur = _BBCODE_PAIR.sub(repl, cur)
    return _BBCODE_LEFTOVER.sub("", cur)


def extract_mentions(text: str) -> list[str]:
    return [m.group("name").strip() for m in _MENTION_TAG.finditer(text)]


def classify_kind(type_byte: int, body: str) -> str:
    """IC / OOC / system bucket — heuristic since F-Chat doesn't carry it.

    - action (/me) is treated as IC; emotes are nearly always in-character.
    - chat starting with `((` or `[ooc]` is OOC; everything else is IC.
    - everything else (ads, rolls, warns, events) is system.
    """
    if type_byte == 1:
        return "ic"
    if type_byte == 0:
        return "ooc" if _OOC_PREFIX.match(body) else "ic"
    return "system"


#: A record begins with a u32 unix timestamp, the only field with a
#: narrow plausible range — everything else is a length or a raw byte.
#: Resync uses it as the candidate filter. F-Chat 3.0 logs start around
#: 2011; the upper bound is generous so this does not expire.
_TS_MIN = 1262304000  # 2010-01-01
_TS_MAX = 1893456000  # 2030-01-01

#: Consecutive records that must parse before a resync point is
#: believed. One record can line up by chance in binary data; four in a
#: row cannot.
_RESYNC_CONFIRM = 4

#: How far past the damage to look. Observed damage is 44 bytes of nulls
#: (an interrupted write) or a few hundred bytes of garbage; 1 MB is far
#: more than needed and bounds the cost on a file that is truly ruined.
_RESYNC_WINDOW = 1_048_576


def _record_end(data: bytes, pos: int) -> int | None:
    """End offset of a well-formed record at `pos`, else None.

    Same invariants the main loop checks, plus the timestamp range — a
    length field that happens to line up will usually imply a nonsense
    date, which is what makes this usable as a resync probe.
    """
    n = len(data)
    if pos + 8 > n:
        return None
    ts = struct.unpack_from("<I", data, pos)[0]
    if not (_TS_MIN <= ts <= _TS_MAX):
        return None
    s_end = pos + 6 + data[pos + 5]
    if s_end + 2 > n:
        return None
    b_end = s_end + 2 + struct.unpack_from("<H", data, s_end)[0]
    if b_end + 2 > n:
        return None
    if struct.unpack_from("<H", data, b_end)[0] != b_end - pos:
        return None
    return b_end + 2


def _resync(data: bytes, pos: int) -> int | None:
    """First offset at or after `pos` where the record chain resumes.

    A damaged record used to end the file: the reader stopped there and
    everything after it was lost silently. On a real archive that cost
    10 MB of a 16 MB log to 44 bytes of nulls — 154451 messages that
    parse perfectly once the damage is stepped over. The format is a
    flat sequence of self-delimiting records, so recovery only needs a
    trustworthy place to start again.
    """
    end = min(len(data), pos + _RESYNC_WINDOW)
    for cand in range(pos, end):
        if cand + 4 > len(data):
            break
        ts = struct.unpack_from("<I", data, cand)[0]
        if not (_TS_MIN <= ts <= _TS_MAX):
            continue
        probe, ok = cand, 0
        while ok < _RESYNC_CONFIRM:
            nxt = _record_end(data, probe)
            if nxt is None:
                break
            probe, ok = nxt, ok + 1
        if ok >= _RESYNC_CONFIRM:
            return cand
    return None


def parse_log(path: Path) -> Iterator[Message]:
    data = path.read_bytes()
    pos, n = 0, len(data)

    def recover(reason: str) -> int | None:
        """Step over damage and report where reading resumed.

        Every way a record can be unreadable ends up here — a truncated
        header, a length that runs past the file, a footer that does not
        match. They used to end the file, which threw away everything
        after the damage without saying how much: on one real log, 44
        bytes of nulls cost 10 MB of 16 and 154451 messages that parse
        perfectly once skipped.
        """
        resumed = _resync(data, pos)
        if resumed is None:
            print(
                f"warn: {reason} in {path.name} at offset {pos}; no resync"
                f" within {_RESYNC_WINDOW} bytes, stopping file",
                file=sys.stderr,
            )
            return None
        print(
            f"warn: {reason} in {path.name} at offset {pos}; skipped"
            f" {resumed - pos} byte(s) and resumed",
            file=sys.stderr,
        )
        return resumed

    while pos < n:
        if pos + 8 > n:
            break
        ts = struct.unpack_from("<I", data, pos)[0]
        type_byte = data[pos + 4]
        sender_len = data[pos + 5]
        s_start = pos + 6
        s_end = s_start + sender_len
        if s_end + 2 > n:
            resumed = recover("truncated sender")
            if resumed is None:
                break
            pos = resumed
            continue
        sender = data[s_start:s_end].decode("utf-8", errors="replace")
        body_len = struct.unpack_from("<H", data, s_end)[0]
        b_start = s_end + 2
        b_end = b_start + body_len
        if b_end + 2 > n:
            resumed = recover("body runs past end of file")
            if resumed is None:
                break
            pos = resumed
            continue
        body = data[b_start:b_end].decode("utf-8", errors="replace")
        footer = struct.unpack_from("<H", data, b_end)[0]
        if footer != b_end - pos:
            resumed = recover(
                f"footer mismatch (footer={footer}, expected={b_end - pos})"
            )
            if resumed is None:
                break
            pos = resumed
            continue
        pos = b_end + 2
        text = strip_bbcode(body)
        if type_byte == 1:
            # /me action: F-Chat stores it with a leading space and no
            # subject. Prepend speaker so emotes read naturally.
            text = f"{sender} {text.lstrip()}"
        yield {
            "ts": ts,
            "iso": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
            "type": type_byte,
            "type_name": TYPE_NAMES.get(type_byte, f"unknown_{type_byte}"),
            "speaker": sender,
            "raw": body,
            "text": text,
            "mentions": extract_mentions(body),
            "kind": classify_kind(type_byte, body),
        }
