"""chunker tests — pure library, no DB, no LLM."""

from __future__ import annotations

import chunker
import labels as labels_store


def _mkmsg(ts: int, speaker: str, text: str, *, kind: str = "ic") -> dict:
    # Parser-shape dict. `raw` matches `text` for hash determinism since
    # the chunker only reads `ts`, `speaker`, `text`, `kind`.
    return {
        "ts": ts,
        "speaker": speaker,
        "raw": text,
        "text": text,
        "type": 0,
        "kind": kind,
    }


def _settings(threshold: int = 200) -> labels_store.LabelsSettings:
    return labels_store.LabelsSettings(
        threshold_chars=threshold,
        llm_endpoint="",
        llm_model="",
        llm_api_key="",
        system_prompt="",
        context_before=3,
        context_after=3,
    )


def _stored(label: str, source: str = "llm") -> dict:
    """Shape that labels_for_partner returns (sqlite Row-like dict)."""
    return {
        "label": label,
        "source": source,
        "confidence": 1.0,
        "reason": "",
        "prior_label": None,
        "prior_source": None,
    }


# --- happy path ----------------------------------------------------------


def test_groups_by_date_and_label() -> None:
    # Two IC messages on 2026-01-01, one IC on 2026-01-02. Long bodies
    # so rule:short doesn't reroute them.
    long = "x" * 300
    m1 = _mkmsg(ts(2026, 1, 1, 10), "A", long)
    m2 = _mkmsg(ts(2026, 1, 1, 11), "B", long)
    m3 = _mkmsg(ts(2026, 1, 2, 10), "A", long)
    by_hash = {
        labels_store.msg_hash(m1): _stored("IC"),
        labels_store.msg_hash(m2): _stored("IC"),
        labels_store.msg_hash(m3): _stored("IC"),
    }
    chunks = chunker.chunk_messages(
        [m1, m2, m3],
        character="MyChar",
        partner="Partner",
        labels_by_hash=by_hash,
        label_settings=_settings(),
    )
    assert len(chunks) == 2
    assert chunks[0]["date"] == "2026-01-01"
    assert chunks[0]["msg_count"] == 2
    assert chunks[1]["date"] == "2026-01-02"
    assert chunks[1]["msg_count"] == 1
    assert all(c["label"] == "IC" for c in chunks)


def test_chunk_id_format_and_safe_chars() -> None:
    m = _mkmsg(ts(2026, 3, 5, 8), "Foo", "x" * 300)
    by_hash = {labels_store.msg_hash(m): _stored("IC")}
    chunks = chunker.chunk_messages(
        [m],
        character="Lady Amber Blaise",  # space → underscore
        partner="#weird-channel!",  # punctuation collapses
        labels_by_hash=by_hash,
        label_settings=_settings(),
    )
    assert chunks[0]["chunk_id"] == "Lady_Amber_Blaise__weird-channel__2026-03-05__IC#0"
    assert chunks[0]["char_owner"] == "Lady Amber Blaise"
    assert chunks[0]["partner"] == "#weird-channel!"


def test_speakers_deduped_and_sorted() -> None:
    long = "y" * 300
    msgs = [
        _mkmsg(ts(2026, 1, 1, 10), "Bob", long),
        _mkmsg(ts(2026, 1, 1, 11), "Alice", long),
        _mkmsg(ts(2026, 1, 1, 12), "Bob", long),
    ]
    by_hash = {labels_store.msg_hash(m): _stored("IC") for m in msgs}
    chunks = chunker.chunk_messages(
        msgs,
        character="C",
        partner="P",
        labels_by_hash=by_hash,
        label_settings=_settings(),
    )
    assert chunks[0]["speakers"] == ["Alice", "Bob"]


# --- skip rules ----------------------------------------------------------


def test_skips_unlabeled_by_default() -> None:
    # Long body, no DB label, no rule hits → resolver returns Unlabeled.
    m = _mkmsg(ts(2026, 1, 1, 10), "A", "x" * 300)
    chunks = chunker.chunk_messages(
        [m],
        character="C",
        partner="P",
        labels_by_hash={},  # no stored labels
        label_settings=_settings(),
    )
    assert chunks == []


def test_skips_ooc_by_default() -> None:
    long = "x" * 300
    ic_msg = _mkmsg(ts(2026, 1, 1, 10), "A", long)
    ooc_msg = _mkmsg(ts(2026, 1, 1, 11), "A", long)
    by_hash = {
        labels_store.msg_hash(ic_msg): _stored("IC"),
        labels_store.msg_hash(ooc_msg): _stored("OOC"),
    }
    chunks = chunker.chunk_messages(
        [ic_msg, ooc_msg],
        character="C",
        partner="P",
        labels_by_hash=by_hash,
        label_settings=_settings(),
    )
    assert len(chunks) == 1
    assert chunks[0]["label"] == "IC"


def test_includes_ooc_when_requested() -> None:
    long = "x" * 300
    ic_msg = _mkmsg(ts(2026, 1, 1, 10), "A", long)
    ooc_msg = _mkmsg(ts(2026, 1, 1, 11), "A", long)
    by_hash = {
        labels_store.msg_hash(ic_msg): _stored("IC"),
        labels_store.msg_hash(ooc_msg): _stored("OOC"),
    }
    chunks = chunker.chunk_messages(
        [ic_msg, ooc_msg],
        character="C",
        partner="P",
        labels_by_hash=by_hash,
        label_settings=_settings(),
        include_ooc=True,
    )
    labels = sorted(c["label"] for c in chunks)
    assert labels == ["IC", "OOC"]


def test_skips_system_messages_always() -> None:
    long = "x" * 300
    sysmsg = _mkmsg(ts(2026, 1, 1, 10), "F-Chat", long, kind="system")
    by_hash = {labels_store.msg_hash(sysmsg): _stored("IC")}  # even if labeled
    chunks = chunker.chunk_messages(
        [sysmsg],
        character="C",
        partner="P",
        labels_by_hash=by_hash,
        label_settings=_settings(),
    )
    assert chunks == []


def test_rule_short_messages_grouped_as_ooc_when_included() -> None:
    # Short body (< threshold=200) hits rule:short → resolver returns OOC
    # without needing a DB entry. With include_ooc=True these chunk.
    short = _mkmsg(ts(2026, 1, 1, 10), "A", "hi")
    chunks = chunker.chunk_messages(
        [short],
        character="C",
        partner="P",
        labels_by_hash={},
        label_settings=_settings(threshold=200),
        include_ooc=True,
    )
    assert len(chunks) == 1
    assert chunks[0]["label"] == "OOC"


# --- oversize splitting --------------------------------------------------


def test_oversize_split_with_overlap() -> None:
    # Build a wall of messages whose total exceeds max_chars to force
    # splitting. Each formatted line is ~ 32 chars + text. With a
    # ~600-char text body we get ~640 chars/line. Picking max_chars=1500
    # and soft_split=1200 means a split after ~2 messages.
    big = "y" * 600
    msgs = [_mkmsg(ts(2026, 1, 1, 10 + i), "A", big) for i in range(5)]
    by_hash = {labels_store.msg_hash(m): _stored("IC") for m in msgs}
    chunks = chunker.chunk_messages(
        msgs,
        character="C",
        partner="P",
        labels_by_hash=by_hash,
        label_settings=_settings(),
        max_chars=1500,
        soft_split=1200,
        overlap=1,
    )
    # Multiple sub-chunks; each tagged with monotonically-increasing
    # subchunk index sharing the same (date, label) base.
    assert len(chunks) >= 2
    base = chunks[0]["chunk_id"].split("#")[0]
    for i, c in enumerate(chunks):
        assert c["chunk_id"] == f"{base}#{i}"
        assert c["subchunk"] == i
    # Overlap: the last message of sub-chunk i must reappear as the
    # first message of sub-chunk i+1 (overlap=1).
    for i in range(len(chunks) - 1):
        prev_last = chunks[i]["text"].splitlines()[-1]
        nxt_first = chunks[i + 1]["text"].splitlines()[0]
        assert prev_last == nxt_first


def test_no_split_when_under_limit() -> None:
    long = "x" * 300
    msgs = [_mkmsg(ts(2026, 1, 1, 10 + i), "A", long) for i in range(3)]
    by_hash = {labels_store.msg_hash(m): _stored("IC") for m in msgs}
    chunks = chunker.chunk_messages(
        msgs,
        character="C",
        partner="P",
        labels_by_hash=by_hash,
        label_settings=_settings(),
    )
    # All three messages in one chunk, subchunk=0.
    assert len(chunks) == 1
    assert chunks[0]["subchunk"] == 0
    assert chunks[0]["msg_count"] == 3


# --- prev/next pointers --------------------------------------------------


def test_prev_next_pointers_form_chain() -> None:
    long = "x" * 300
    msgs = [
        _mkmsg(ts(2026, 1, 1, 10), "A", long),
        _mkmsg(ts(2026, 1, 2, 10), "A", long),
        _mkmsg(ts(2026, 1, 3, 10), "A", long),
    ]
    by_hash = {labels_store.msg_hash(m): _stored("IC") for m in msgs}
    chunks = chunker.chunk_messages(
        msgs,
        character="C",
        partner="P",
        labels_by_hash=by_hash,
        label_settings=_settings(),
    )
    assert chunks[0]["prev_chunk_id"] is None
    assert chunks[0]["next_chunk_id"] == chunks[1]["chunk_id"]
    assert chunks[1]["prev_chunk_id"] == chunks[0]["chunk_id"]
    assert chunks[1]["next_chunk_id"] == chunks[2]["chunk_id"]
    assert chunks[2]["prev_chunk_id"] == chunks[1]["chunk_id"]
    assert chunks[2]["next_chunk_id"] is None


def test_prev_next_cross_label_boundaries_when_ooc_included() -> None:
    # IC and OOC on different days should still chain chronologically.
    long = "x" * 300
    ic1 = _mkmsg(ts(2026, 1, 1, 10), "A", long)
    ooc1 = _mkmsg(ts(2026, 1, 2, 10), "A", long)
    ic2 = _mkmsg(ts(2026, 1, 3, 10), "A", long)
    by_hash = {
        labels_store.msg_hash(ic1): _stored("IC"),
        labels_store.msg_hash(ooc1): _stored("OOC"),
        labels_store.msg_hash(ic2): _stored("IC"),
    }
    chunks = chunker.chunk_messages(
        [ic1, ooc1, ic2],
        character="C",
        partner="P",
        labels_by_hash=by_hash,
        label_settings=_settings(),
        include_ooc=True,
    )
    assert [c["label"] for c in chunks] == ["IC", "OOC", "IC"]
    assert chunks[0]["next_chunk_id"] == chunks[1]["chunk_id"]
    assert chunks[1]["next_chunk_id"] == chunks[2]["chunk_id"]


# --- edge cases ----------------------------------------------------------


def test_empty_input_returns_empty() -> None:
    assert (
        chunker.chunk_messages(
            [],
            character="C",
            partner="P",
            labels_by_hash={},
            label_settings=_settings(),
        )
        == []
    )


# --- speaker aliases ----------------------------------------------------


def test_speaker_aliases_rewrite_in_text_and_speakers_field() -> None:
    """When the partner is a merged rename group, messages whose
    speaker matches an aliased name are surfaced under the primary
    name so the LLM treats both as the same character."""
    long = "x" * 300
    old_name_msg = _mkmsg(ts(2026, 1, 1, 10), "Daemon Enariel", long)
    new_name_msg = _mkmsg(ts(2026, 1, 1, 11), "Ashvalia", long)
    by_hash = {
        labels_store.msg_hash(old_name_msg): _stored("IC"),
        labels_store.msg_hash(new_name_msg): _stored("IC"),
    }
    chunks = chunker.chunk_messages(
        [old_name_msg, new_name_msg],
        character="MyChar",
        partner="Ashvalia",
        labels_by_hash=by_hash,
        label_settings=_settings(),
        speaker_aliases=["Ashvalia", "Daemon Enariel"],
    )
    assert len(chunks) == 1
    # Both speaker mentions in the chunk text collapsed to the primary.
    assert "Ashvalia:" in chunks[0]["text"]
    assert "Daemon Enariel:" not in chunks[0]["text"]
    # Same for the speakers payload — deduped down to one entry.
    assert chunks[0]["speakers"] == ["Ashvalia"]


def test_speaker_aliases_leave_non_aliased_speakers_alone() -> None:
    """Only names in the alias group get rewritten — the user's own
    character (and anyone else in the room) keeps their literal name."""
    long = "x" * 300
    old_msg = _mkmsg(ts(2026, 1, 1, 10), "Daemon Enariel", long)
    own_msg = _mkmsg(ts(2026, 1, 1, 11), "MyChar", long)
    chunks = chunker.chunk_messages(
        [old_msg, own_msg],
        character="MyChar",
        partner="Ashvalia",
        labels_by_hash={
            labels_store.msg_hash(old_msg): _stored("IC"),
            labels_store.msg_hash(own_msg): _stored("IC"),
        },
        label_settings=_settings(),
        speaker_aliases=["Ashvalia", "Daemon Enariel"],
    )
    assert "MyChar:" in chunks[0]["text"]
    # And both renamed-partner-side names collapse to the primary.
    assert "Daemon Enariel:" not in chunks[0]["text"]
    assert chunks[0]["speakers"] == ["Ashvalia", "MyChar"]


def test_speaker_aliases_default_off_preserves_literal_speaker() -> None:
    """Backwards-compat — calls without speaker_aliases get the original
    speaker rendering. Important because most chunker callers don't
    have an alias group to thread through."""
    long = "x" * 300
    m = _mkmsg(ts(2026, 1, 1, 10), "Daemon Enariel", long)
    chunks = chunker.chunk_messages(
        [m],
        character="MyChar",
        partner="Ashvalia",
        labels_by_hash={labels_store.msg_hash(m): _stored("IC")},
        label_settings=_settings(),
    )
    assert "Daemon Enariel:" in chunks[0]["text"]
    assert chunks[0]["speakers"] == ["Daemon Enariel"]


def test_speaker_aliases_oversize_split_uses_normalised_lengths() -> None:
    """The split-by-char-budget logic measures line length AFTER
    speaker normalisation, so a long aliased name doesn't accidentally
    push the chunk past its limit."""
    big = "y" * 600
    # All messages from the aliased speaker → every line gets shortened
    # if the alias is shorter than the primary. Split should still
    # produce sub-chunks correctly under the budget.
    msgs = [_mkmsg(ts(2026, 1, 1, 10 + i), "VeryLongOldName", big) for i in range(5)]
    by_hash = {labels_store.msg_hash(m): _stored("IC") for m in msgs}
    chunks = chunker.chunk_messages(
        msgs,
        character="MyChar",
        partner="X",
        labels_by_hash=by_hash,
        label_settings=_settings(),
        max_chars=1500,
        soft_split=1200,
        overlap=1,
        speaker_aliases=["X", "VeryLongOldName"],
    )
    assert len(chunks) >= 2
    # No chunk text exceeds the hard cap.
    assert all(len(c["text"]) <= 1500 for c in chunks)
    # All chunks render the speaker as the primary.
    assert all("VeryLongOldName:" not in c["text"] for c in chunks)
    assert all("X:" in c["text"] for c in chunks)


def test_manual_label_takes_precedence() -> None:
    # Manual OOC override should suppress chunking even if include_ooc=False,
    # which is the same precedence the log browser shows.
    long = "x" * 300
    m = _mkmsg(ts(2026, 1, 1, 10), "A", long)
    by_hash = {labels_store.msg_hash(m): _stored("OOC", source="manual")}
    chunks = chunker.chunk_messages(
        [m],
        character="C",
        partner="P",
        labels_by_hash=by_hash,
        label_settings=_settings(),
    )
    assert chunks == []


# --- helpers -------------------------------------------------------------


def ts(year: int, month: int, day: int, hour: int) -> int:
    from datetime import datetime, timezone

    return int(datetime(year, month, day, hour, tzinfo=timezone.utc).timestamp())
