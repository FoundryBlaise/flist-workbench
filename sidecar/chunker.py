"""Group parsed messages into retrieval chunks.

Port of Chat_RAG/chunk.py adapted to the Workbench:

  - Pure library, no CLI, no file I/O. Caller passes parsed messages
    and the SQLite-backed labels-by-hash map; we return a list of
    Chunk dicts ready for embedding.
  - Reuses `labels.resolve` so the chunker honours the same precedence
    (manual > LLM > rule > Unlabeled) that the log browser shows.
    No second source of truth for what counts as IC.
  - Skips System (parser bucket) and Unlabeled (no LLM verdict and no
    rule hit) always — both would pollute retrieval. OOC is optional
    via `include_ooc`; default off because OOC chunks are mostly noise
    for "what happened in this RP" queries.

Chunk grouping: `(UTC date, label)` per partner conversation. Oversize
groups split into sub-chunks of ~SOFT_SPLIT_CHARS with `overlap`
messages repeated between consecutive sub-chunks so semantically
adjacent embeddings retain enough overlap to retrieve as a unit.
"""

from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timezone
from typing import Iterable, TypedDict

import labels as labels_store
from labels import LabelsSettings, msg_hash

# Chunking defaults tuned for moment-level retrieval against
# conversational RP logs: smaller groups so a single hit lands on the
# specific scene a question is about, slightly more overlap so a turn
# split across chunks still retrieves as a unit. Original (5000/4000/1)
# was inherited from Chat_RAG which targeted longer-form summarisation
# queries; for "wann hat X gesagt …" style questions over chat logs,
# 3000/2000/2 retrieves noticeably better.
DEFAULT_MAX_CHUNK_CHARS = 3000
DEFAULT_SOFT_SPLIT_CHARS = 2000
DEFAULT_OVERLAP_MSGS = 2


class Chunk(TypedDict):
    chunk_id: str
    char_owner: str
    partner: str
    date: str
    label: str
    subchunk: int
    ts_start: int
    ts_end: int
    speakers: list[str]
    msg_count: int
    char_count: int
    text: str
    prev_chunk_id: str | None
    next_chunk_id: str | None


def _safe_id(s: str) -> str:
    return re.sub(r"[^\w\-]+", "_", s).strip("_") or "_"


def _fmt_line(m: dict) -> str:
    iso = datetime.fromtimestamp(m["ts"], tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
    text = (m.get("text") or "").strip()
    return f"[{iso}] {m['speaker']}: {text}"


def _total_chars(msgs: list[dict]) -> int:
    return sum(len(_fmt_line(m)) + 1 for m in msgs)


def _utc_date(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def _split_oversize(
    msgs: list[dict],
    *,
    max_chars: int,
    soft_split: int,
    overlap: int,
) -> list[list[dict]]:
    """If a group fits, return it whole; else split into ~soft_split-char
    sub-groups with `overlap` messages repeated between consecutive parts.
    """
    if _total_chars(msgs) <= max_chars:
        return [msgs]
    parts: list[list[dict]] = []
    current: list[dict] = []
    cur_chars = 0
    for m in msgs:
        line_chars = len(_fmt_line(m)) + 1
        if cur_chars + line_chars > soft_split and current:
            parts.append(current)
            tail = current[-overlap:] if overlap > 0 else []
            current = list(tail) + [m]
            cur_chars = _total_chars(current)
        else:
            current.append(m)
            cur_chars += line_chars
    if current:
        parts.append(current)
    return parts


def chunk_messages(
    messages: Iterable[dict],
    *,
    character: str,
    partner: str,
    labels_by_hash: dict[str, sqlite3.Row | dict] | None = None,
    label_settings: LabelsSettings,
    include_ooc: bool = False,
    max_chars: int = DEFAULT_MAX_CHUNK_CHARS,
    soft_split: int = DEFAULT_SOFT_SPLIT_CHARS,
    overlap: int = DEFAULT_OVERLAP_MSGS,
) -> list[Chunk]:
    """Group an in-memory conversation into retrieval chunks.

    `labels_by_hash` is what `labels.labels_for_partner` returns (just
    the DB rows). The resolver fills in rule-driven IC/OOC outcomes
    on the fly — we never trust a Unlabeled message into the corpus.
    """
    labels_by_hash = labels_by_hash or {}
    groups: dict[tuple[str, str], list[dict]] = {}
    for m in messages:
        # F-Chat 'system' (warn/event/etc) is never useful for RP
        # retrieval. The parser's kind field already buckets these,
        # so we skip them before even touching the resolver.
        if m.get("kind") == "system":
            continue
        h = msg_hash(m)
        label = labels_store.resolve(m, labels_by_hash.get(h), label_settings)
        if label == labels_store.LABEL_UNLABELED:
            continue
        if label == labels_store.LABEL_OOC and not include_ooc:
            continue
        groups.setdefault((_utc_date(m["ts"]), label), []).append(m)

    chunks: list[Chunk] = []
    for (date, label), msgs in sorted(groups.items()):
        msgs.sort(key=lambda x: x["ts"])
        sub_groups = _split_oversize(
            msgs,
            max_chars=max_chars,
            soft_split=soft_split,
            overlap=overlap,
        )
        for sub_idx, sub_msgs in enumerate(sub_groups):
            speakers = sorted({m["speaker"] for m in sub_msgs})
            text = "\n".join(_fmt_line(m) for m in sub_msgs)
            chunks.append(
                Chunk(
                    chunk_id=(
                        f"{_safe_id(character)}__{_safe_id(partner)}"
                        f"__{date}__{label}#{sub_idx}"
                    ),
                    char_owner=character,
                    partner=partner,
                    date=date,
                    label=label,
                    subchunk=sub_idx,
                    ts_start=sub_msgs[0]["ts"],
                    ts_end=sub_msgs[-1]["ts"],
                    speakers=speakers,
                    msg_count=len(sub_msgs),
                    char_count=len(text),
                    text=text,
                    prev_chunk_id=None,
                    next_chunk_id=None,
                )
            )

    # Chronological ordering across labels and dates so prev/next form
    # a single linked walk through the conversation. The neighbor-
    # expansion step in query time walks this chain to add surrounding
    # context to retrieval hits.
    chunks.sort(key=lambda c: (c["ts_start"], c["subchunk"]))
    for i, c in enumerate(chunks):
        c["prev_chunk_id"] = chunks[i - 1]["chunk_id"] if i > 0 else None
        c["next_chunk_id"] = chunks[i + 1]["chunk_id"] if i + 1 < len(chunks) else None
    return chunks
