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


def list_characters(root: Path | None = None) -> list[str]:
    base = root or data_dir()
    if not base.exists():
        raise LogDirError(f"F-Chat data directory not found: {base}")
    return sorted(
        entry.name for entry in base.iterdir() if entry.is_dir() and not entry.name.startswith(".")
    )


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
