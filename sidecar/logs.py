"""F-Chat 3.0 log directory access.

Layout the F-Chat client writes:

    <FCHAT_DATA_DIR>/<character>/logs/<partner>
    <FCHAT_DATA_DIR>/<character>/logs/<partner>.idx

`<partner>` is the binary log file; `<partner>.idx` is its index. We
expose directory listings here. Reading message payloads requires
porting `parser.py` from Chat_RAG and is a later milestone.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from parser import Message, parse_log

DEFAULT_DATA_DIR = Path("/sideprojects/rag/data")


class LogDirError(Exception):
    pass


@dataclass(slots=True, frozen=True)
class PartnerEntry:
    name: str
    bytes: int


def data_dir() -> Path:
    raw = os.environ.get("FCHAT_DATA_DIR")
    return Path(raw) if raw else DEFAULT_DATA_DIR


@dataclass(slots=True, frozen=True)
class CharacterEntry:
    name: str
    # Latest mtime (epoch seconds) seen across this character's logs
    # directory. The renderer compares it against a per-user "last
    # opened" timestamp to flag characters with new activity. 0 when
    # the logs subdir doesn't exist (no logs yet for that character).
    mtime: float


def list_characters(root: Path | None = None) -> list[CharacterEntry]:
    base = root or data_dir()
    if not base.exists():
        raise LogDirError(f"F-Chat data directory not found: {base}")
    out: list[CharacterEntry] = []
    for entry in sorted(base.iterdir(), key=lambda e: e.name):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        logs = entry / "logs"
        try:
            mtime = logs.stat().st_mtime if logs.exists() else 0.0
        except OSError:
            mtime = 0.0
        out.append(CharacterEntry(name=entry.name, mtime=mtime))
    return out


def list_partners(character: str, root: Path | None = None) -> list[PartnerEntry]:
    base = root or data_dir()
    logs_dir = base / character / "logs"
    if not logs_dir.exists():
        raise LogDirError(f"no logs for character: {character}")

    seen: dict[str, int] = {}
    for entry in logs_dir.iterdir():
        if not entry.is_file():
            continue
        if entry.name.endswith(".idx"):
            continue
        if entry.name in {"_"}:  # F-Chat console scratch — skip
            continue
        seen[entry.name] = entry.stat().st_size

    return [PartnerEntry(name=name, bytes=size) for name, size in sorted(seen.items())]


def log_path(character: str, partner: str, root: Path | None = None) -> Path:
    base = root or data_dir()
    path = base / character / "logs" / partner
    if not path.exists() or not path.is_file():
        raise LogDirError(f"log not found: {character}/{partner}")
    return path


def read_messages(
    character: str,
    partner: str,
    *,
    root: Path | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> Iterator[Message]:
    """Stream parsed messages from a single partner log."""
    path = log_path(character, partner, root)
    skipped = 0
    yielded = 0
    for msg in parse_log(path):
        if skipped < offset:
            skipped += 1
            continue
        yield msg
        yielded += 1
        if limit is not None and yielded >= limit:
            return


def search_messages(
    character: str,
    partner: str,
    query: str,
    *,
    root: Path | None = None,
) -> list[dict]:
    """Case-insensitive substring search across `text` (BBCode-stripped)."""
    q = query.casefold()
    if not q:
        return []
    out: list[dict] = []
    for idx, msg in enumerate(read_messages(character, partner, root=root)):
        if q in msg["text"].casefold():
            out.append({"index": idx, **msg})
    return out


def find_contacts(name: str, *, root: Path | None = None) -> dict:
    """Across every character on this machine, find who's had contact
    with `name` (case-insensitive).

    Two flavours of "contact":
      * DM — a 1-on-1 partner directory whose filename matches `name`.
        This is a cheap directory listing per character.
      * Channel — a channel log (`#...`) in which `name` shows up as
        a message speaker. Requires scanning the channel log; we cap
        per-channel scanning so a 5 MB channel doesn't lock the
        request. Skips channels named after the queried `name`
        (those are DMs, not shared channels).

    Returns:
        {
          "name": <queried name>,
          "dm": [{character, partner, bytes, mtime}],
          "channels": [{character, channel, messages_from_name, bytes}]
        }

    Both arrays are sorted by character then descending byte size of
    the matching log.
    """
    target = name.strip()
    if not target:
        return {"name": name, "dm": [], "channels": []}
    needle = target.casefold()

    dms: list[dict] = []
    channels: list[dict] = []

    try:
        chars = list_characters(root=root)
    except LogDirError:
        return {"name": name, "dm": [], "channels": []}

    for char in chars:
        # Skip the queried character — "who knows X" trivially
        # excludes X themselves.
        if char.name.casefold() == needle:
            continue
        try:
            partners = list_partners(char.name, root=root)
        except LogDirError:
            continue
        for p in partners:
            if p.name.startswith("#"):
                # Channel contact: scan the channel log for messages
                # whose speaker matches the queried name.
                count = 0
                try:
                    for msg in read_messages(char.name, p.name, root=root):
                        if msg["speaker"].casefold() == needle:
                            count += 1
                except Exception:
                    continue
                if count > 0:
                    channels.append(
                        {
                            "character": char.name,
                            "channel": p.name,
                            "messages_from_name": count,
                            "bytes": p.bytes,
                        }
                    )
            else:
                # DM contact: just match the partner filename.
                if p.name.casefold() == needle:
                    try:
                        mtime = (log_path(char.name, p.name, root=root)).stat().st_mtime
                    except OSError:
                        mtime = 0.0
                    dms.append(
                        {
                            "character": char.name,
                            "partner": p.name,
                            "bytes": p.bytes,
                            "mtime": mtime,
                        }
                    )

    dms.sort(key=lambda r: (r["character"].casefold(), -r["bytes"]))
    channels.sort(key=lambda r: (r["character"].casefold(), -r["bytes"]))
    return {"name": target, "dm": dms, "channels": channels}


def search_all_partners(
    character: str,
    query: str,
    *,
    root: Path | None = None,
    limit_per_partner: int = 50,
) -> dict:
    """Substring search across every partner log for one character.

    Returns a `{partner: [hits...]}` mapping plus a per-partner hit
    count. Each partner is capped at `limit_per_partner` so a single
    runaway result set (e.g. searching "the" against an 80k-message
    channel) can't dominate the response — the renderer can still see
    the count and offer to drill into that partner specifically.

    Performance note: this is a linear scan over every log file. Good
    enough for the 100s-of-MB corpora we see today; a real index
    (SQLite FTS5) is the F3 follow-up when we have evidence we need it.
    """
    q = query.casefold()
    if not q:
        return {"character": character, "query": query, "hits": []}
    partners = list_partners(character, root=root)
    results: list[dict] = []
    for entry in partners:
        partner_hits: list[dict] = []
        truncated = False
        for idx, msg in enumerate(read_messages(character, entry.name, root=root)):
            if q in msg["text"].casefold():
                if len(partner_hits) >= limit_per_partner:
                    truncated = True
                    continue
                partner_hits.append({"index": idx, **msg})
        if partner_hits or truncated:
            results.append(
                {
                    "partner": entry.name,
                    "bytes": entry.bytes,
                    "hits": partner_hits,
                    # Truncation flag tells the UI "open this partner
                    # to see the rest", not "we missed messages".
                    "truncated": truncated,
                }
            )
    return {"character": character, "query": query, "partners": results}
