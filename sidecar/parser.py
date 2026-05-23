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


def parse_log(path: Path) -> Iterator[Message]:
    data = path.read_bytes()
    pos, n = 0, len(data)
    while pos < n:
        if pos + 8 > n:
            break
        ts = struct.unpack_from("<I", data, pos)[0]
        type_byte = data[pos + 4]
        sender_len = data[pos + 5]
        s_start = pos + 6
        s_end = s_start + sender_len
        if s_end + 2 > n:
            break
        sender = data[s_start:s_end].decode("utf-8", errors="replace")
        body_len = struct.unpack_from("<H", data, s_end)[0]
        b_start = s_end + 2
        b_end = b_start + body_len
        if b_end + 2 > n:
            break
        body = data[b_start:b_end].decode("utf-8", errors="replace")
        footer = struct.unpack_from("<H", data, b_end)[0]
        expected = b_end - pos
        if footer != expected:
            sys.stderr.write(
                f"warn: footer mismatch in {path.name} at offset {pos} "
                f"(footer={footer}, expected={expected}); stopping file\n"
            )
            break
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
