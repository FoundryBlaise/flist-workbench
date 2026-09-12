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


def _fmt_line(m: dict, *, speaker_override: str | None = None) -> str:
    iso = datetime.fromtimestamp(m["ts"], tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
    text = (m.get("text") or "").strip()
    speaker = speaker_override if speaker_override is not None else m["speaker"]
    return f"[{iso}] {speaker}: {text}"


def _total_chars(msgs: list[dict], speaker_map: dict[str, str] | None = None) -> int:
    if speaker_map is None:
        return sum(len(_fmt_line(m)) + 1 for m in msgs)
    return sum(
        len(_fmt_line(m, speaker_override=speaker_map.get(m["speaker"]))) + 1
        for m in msgs
    )


def _utc_date(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def _split_long_message(m: dict, *, max_chars: int) -> list[dict]:
    """Break one over-long message into several, on text boundaries.

    `_split_oversize` only ever splits *between* messages, which is fine
    while the cap is large. It is not fine once the cap follows an
    embedding model's token window: a single roleplay post routinely runs
    to three thousand characters, so it became one chunk of its own and
    the model silently read the first few hundred characters of it. This
    splits within the post — paragraphs first, then sentences, then a
    hard cut — so every piece actually fits.

    The pieces keep the original timestamp and speaker; they differ only
    in text. Ordering is preserved, so the prev/next chain a query walks
    for context still reads as one continuous post.
    """
    text = (m.get("text") or "").strip()
    # The rendered line carries "[date time] speaker: " in front of the
    # text, and that prefix counts against the window too.
    overhead = len(_fmt_line({**m, "text": ""}))
    budget = max(80, max_chars - overhead)
    if len(text) <= budget:
        return [m]

    pieces: list[str] = []
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        if len(para) <= budget:
            pieces.append(para)
            continue
        # Sentence-ish boundaries, keeping the delimiter with the
        # sentence. BBCode and roleplay punctuation make a real sentence
        # splitter pointless here; this is about not cutting mid-word.
        current = ""
        for sentence in re.split(r"(?<=[.!?…])\s+", para):
            if not sentence:
                continue
            if len(sentence) > budget:
                if current:
                    pieces.append(current)
                    current = ""
                for i in range(0, len(sentence), budget):
                    pieces.append(sentence[i : i + budget])
                continue
            if len(current) + 1 + len(sentence) > budget and current:
                pieces.append(current)
                current = sentence
            else:
                current = f"{current} {sentence}".strip()
        if current:
            pieces.append(current)

    return [{**m, "text": piece} for piece in pieces] or [m]


def _split_oversize(
    msgs: list[dict],
    *,
    max_chars: int,
    soft_split: int,
    overlap: int,
    speaker_map: dict[str, str] | None = None,
) -> list[list[dict]]:
    """If a group fits, return it whole; else split into ~soft_split-char
    sub-groups with `overlap` messages repeated between consecutive parts.
    """
    if _total_chars(msgs, speaker_map) <= max_chars:
        return [msgs]

    # Expand any single message that cannot fit on its own before
    # grouping — otherwise it lands in a part of its own and blows the
    # cap no matter how the parts are arranged.
    expanded: list[dict] = []
    for m in msgs:
        expanded.extend(_split_long_message(m, max_chars=max_chars))
    msgs = expanded

    def line_len(m: dict) -> int:
        speaker = (speaker_map or {}).get(m["speaker"])
        return len(_fmt_line(m, speaker_override=speaker)) + 1

    def carry(part: list[dict], incoming: int) -> list[dict]:
        """Messages to repeat at the head of the next part.

        Bounded by characters, not only by `overlap`. The count was
        chosen when a chunk held 3000 characters, where repeating two
        messages is a rounding error. Against a cap that follows an
        embedding model's window it becomes the dominant term — two
        400-character tails plus the new message put every part near
        1200, three times the cap it was just split to respect. Keep as
        much of the tail as still leaves the next part under max_chars,
        which is a no-op at the large caps the endpoint backend uses.
        """
        if overlap <= 0:
            return []
        kept: list[dict] = []
        acc = incoming
        for m in reversed(part[-overlap:]):
            c = line_len(m)
            if acc + c > max_chars:
                break
            kept.insert(0, m)
            acc += c
        return kept

    parts: list[list[dict]] = []
    current: list[dict] = []
    cur_chars = 0
    for m in msgs:
        line_chars = line_len(m)
        if cur_chars + line_chars > soft_split and current:
            parts.append(current)
            current = carry(current, line_chars) + [m]
            cur_chars = _total_chars(current, speaker_map)
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
    speaker_aliases: list[str] | None = None,
    skipped_unlabeled: list[int] | None = None,
) -> list[Chunk]:
    """Group an in-memory conversation into retrieval chunks.

    `labels_by_hash` is what `labels.labels_for_partner` returns (just
    the DB rows). The resolver fills in rule-driven IC/OOC outcomes
    on the fly — we never trust a Unlabeled message into the corpus.

    `skipped_unlabeled` — pass a one-element list to receive the count
    of messages dropped for lack of a verdict. Callers surface it so a
    user whose log is mostly unjudged is told to run the MCP
    classification flow rather than left wondering why the index is
    empty.

    `speaker_aliases` — pass the partner's alias group when this
    conversation is a merged rename. Any message whose `speaker`
    matches an aliased name gets rewritten to `partner` (the primary)
    in both the chunk text and the `speakers` payload so the LLM
    treats "Daemon Enariel" and "Ashvalia" as the same character.
    Labels are untouched: they're hash-keyed and each row records the
    literal speaker as written on disk.
    """
    labels_by_hash = labels_by_hash or {}
    # Build the speaker rewrite map once: every aliased name (excluding
    # the primary, which already equals partner) maps to the partner.
    # None when there's no group → fast-path the unrelated cases.
    speaker_map: dict[str, str] | None = None
    if speaker_aliases:
        aliased = {n for n in speaker_aliases if n and n != partner}
        if aliased:
            speaker_map = {n: partner for n in aliased}

    if skipped_unlabeled is None:
        skipped_unlabeled = [0]

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
            # Not indexed: an unjudged message could be either IC prose
            # or OOC chatter, and mixing OOC into the index poisons
            # retrieval. Counted so the caller can tell the user to run
            # the classification flow first — silently dropping half a
            # log and reporting "0 chunks" is the confusing alternative.
            skipped_unlabeled[0] += 1
            continue
        if label == labels_store.LABEL_OOC and not include_ooc:
            continue
        groups.setdefault((_utc_date(m["ts"]), label), []).append(m)

    def render_speaker(speaker: str) -> str:
        return (speaker_map or {}).get(speaker, speaker)

    chunks: list[Chunk] = []
    for (date, label), msgs in sorted(groups.items()):
        msgs.sort(key=lambda x: x["ts"])
        sub_groups = _split_oversize(
            msgs,
            max_chars=max_chars,
            soft_split=soft_split,
            overlap=overlap,
            speaker_map=speaker_map,
        )
        for sub_idx, sub_msgs in enumerate(sub_groups):
            speakers = sorted({render_speaker(m["speaker"]) for m in sub_msgs})
            text = "\n".join(
                _fmt_line(m, speaker_override=render_speaker(m["speaker"]))
                for m in sub_msgs
            )
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
