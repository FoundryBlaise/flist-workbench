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
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from parser import Message, parse_log


def default_data_dir() -> Path:
    """OS-native location where F-Chat 3.0 writes its logs by default.

    F-Chat's own storage layout (matches what Frolic and the F-Chat
    Electron client write):
      - Windows: %APPDATA%/fchat/data
      - macOS:   ~/Library/Application Support/fchat/data
      - Linux:   ~/.config/fchat/data  (XDG)

    The devcontainer ships with a corpus at /sideprojects/rag/data
    and sets FCHAT_DATA_DIR to point at it, so users developing
    against this repo never hit this fallback.
    """
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "fchat" / "data"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "fchat" / "data"
    xdg = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(xdg) / "fchat" / "data"


# Kept as a module-level constant so existing tests / callers that
# imported it still resolve. The function above is the live source of
# truth — it picks up env changes per call.
DEFAULT_DATA_DIR = default_data_dir()


class LogDirError(Exception):
    pass


@dataclass(slots=True, frozen=True)
class PartnerEntry:
    name: str
    bytes: int


def data_dir() -> Path:
    # Env var wins so tests and the devcontainer can pin a known
    # directory regardless of UI state. Otherwise check the settings
    # store the user has the option to point at a custom path.
    raw = os.environ.get("FCHAT_DATA_DIR")
    if raw:
        return Path(raw)
    try:
        # Local import to avoid a circular reference at module load
        # time — settings imports documents which has no deps on logs.
        import settings as _settings  # noqa: PLC0415

        conn = _settings.connect()
        try:
            override = _settings.get(conn, _settings.KEY_FCHAT_DATA_DIR)
        finally:
            conn.close()
        if override:
            return Path(override)
    except Exception:
        # Settings DB unreachable / first launch / readonly filesystem
        # — fall through to the OS-native default.
        pass
    return default_data_dir()


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
    """Across every character on this machine, find which of YOUR
    characters has a 1-on-1 DM log with `name` (case-insensitive).

    A "DM" is a non-channel partner directory whose filename matches
    the queried name. Channels are deliberately ignored — they'd
    require scanning every message of every channel log, and the user
    interface is built around the 1:1 case.

    Returns:
        {
          "name": <queried name>,
          "dm": [{character, partner, bytes, mtime}]
        }

    Sorted by your character (alphabetical) then descending byte size
    of the DM log.
    """
    target = name.strip()
    if not target:
        return {"name": name, "dm": []}
    needle = target.casefold()

    dms: list[dict] = []

    try:
        chars = list_characters(root=root)
    except LogDirError:
        return {"name": name, "dm": []}

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
                continue
            if p.name.casefold() != needle:
                continue
            try:
                mtime = log_path(char.name, p.name, root=root).stat().st_mtime
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
    return {"name": target, "dm": dms}


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
