"""Labels: every Label operation the window and a connected model share.

Counting, overriding (one message or many), recording a model's
verdicts, filling a conversation's Unlabeled messages, deleting named
Labels and clearing them all live here once. The REST router
(`routers/labels.py`, `routers/logs.py`) and the MCP tools
(`tools_classify`, `tools_logs`) only parse their input, call one of
these and shape the answer, so the two surfaces cannot drift.

A Label belongs to the message (ADR 0004). A conversation's Labels are
the Labels of the messages its Log holds, the partner's whole alias
group included, found by message hash: a line in two of the user's own
Logs shows one Label in both, and a rename or an unlinked alias orphans
none; a Label stores no owner. The SQL itself stays in the Label
store (`labels.py`), which announces every change on the event bus
once; clearing goes through the Trash (`label_trash`).

The rule threshold is a setting; it is read here, never validated.
"""

from __future__ import annotations

import contextlib
import sqlite3
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator

import aliases as aliases_store
import labels as labels_store
import logs as log_store
from refusals import ValidationFailed
from services import label_trash

#: The two verdicts a Label can hold.
VERDICTS = (labels_store.LABEL_IC, labels_store.LABEL_OOC)

#: How much of a model's reason is kept with its verdict.
REASON_MAX_CHARS = 500

#: Why a model's Label was not written over one the user set.
MANUAL_SKIP_REASON = (
    "The user set this Label by hand; only the user changes it, in the window."
)


def not_a_verdict(label: object) -> ValidationFailed:
    return ValidationFailed(
        "label",
        f"must be IC or OOC, got {label!r}",
        allowed=list(VERDICTS),
    )


def verdict(label: object) -> str:
    """`label` as IC or OOC. Case and surrounding spaces do not matter,
    on either surface; anything else is refused as `validation_failed`."""
    text = label.strip().upper() if isinstance(label, str) else None
    if text not in VERDICTS:
        raise not_a_verdict(label)
    return text


@contextlib.contextmanager
def _store() -> Iterator[tuple[sqlite3.Connection, labels_store.LabelsSettings]]:
    """The Label store and the rule settings the resolver needs."""
    conn = labels_store.connect()
    try:
        yield conn, labels_store.load_settings()
    finally:
        conn.close()


def _messages(character: str, partner: str) -> list[dict]:
    return list(log_store.read_messages(character, partner))


def _counts(
    conn: sqlite3.Connection,
    settings: labels_store.LabelsSettings,
    messages: list[dict],
) -> dict[str, int]:
    counts = labels_store.stats(conn, messages, settings)
    return {
        "ic": counts[labels_store.LABEL_IC],
        "ooc": counts[labels_store.LABEL_OOC],
        "unlabeled": counts[labels_store.LABEL_UNLABELED],
        "total": sum(counts.values()),
    }


# ---- reading ----------------------------------------------------------------


def conversation_stats(character: str, partner: str) -> dict[str, int]:
    """`{ic, ooc, unlabeled, total}` for one conversation, its whole
    alias group included."""
    messages = _messages(character, partner)
    with _store() as (conn, settings):
        return _counts(conn, settings, messages)


def character_stats(character: str) -> list[dict[str, Any]]:
    """`conversation_stats` for every partner of `character`, linked
    aliases folded into their primary, in the order the Logs list them.

    Each row also carries `log_mtime` (the newest of the alias group's
    Log files) and `last_label_at` (the newest Label in the group): a
    conversation whose Log moved after its last Label has messages no
    one has judged yet. A partner whose Log cannot be read (deleted
    between calls, permission denied) is left out rather than failing
    the whole list.
    """
    conversations = log_store.read_conversations(character)
    base = log_store.data_dir() / character / "logs"
    rows: list[dict[str, Any]] = []
    with _store() as (conn, settings):
        for partner, messages in conversations:
            alias_group = aliases_store.all_names_for(conn, character, partner)
            log_mtime = 0.0
            for member in alias_group or [partner]:
                try:
                    log_mtime = max(log_mtime, (base / member).stat().st_mtime)
                except OSError:
                    continue
            rows.append(
                {
                    "partner": partner,
                    **_counts(conn, settings, messages),
                    "log_mtime": log_mtime if log_mtime > 0 else None,
                    "last_label_at": labels_store.max_label_time(conn, messages),
                }
            )
    return rows


def rollup() -> dict[str, Any]:
    """IC/OOC/Unlabeled counts across every conversation of every
    character, plus how many Labels the user set by hand. Walks every
    Log under the F-Chat folder: a few seconds on a large corpus.

    Raises `LogDirUnavailable` when the F-Chat folder is missing.
    """
    characters = log_store.list_characters()
    totals = {"ic": 0, "ooc": 0, "unlabeled": 0, "total": 0}
    with _store() as (conn, settings):
        manual = labels_store.count_by_source(conn, "manual")
        for char in characters:
            # A character folder whose Logs cannot be listed counts nothing.
            with contextlib.suppress(log_store.LogDirError):
                for _, messages in log_store.read_conversations(char.name):
                    counts = _counts(conn, settings, messages)
                    for key in totals:
                        totals[key] += counts[key]
    return {
        "ic": totals["ic"],
        "ooc": totals["ooc"],
        "unlabeled": totals["unlabeled"],
        "manual": manual,
        "total": totals["total"],
        "character_count": len(characters),
    }


@dataclass(frozen=True, slots=True)
class LabelledMessage:
    """One message with the Label it resolves to, None for a system
    line. `stored` is its stored Label row (`labels.LABEL_COLUMNS`),
    None when a rule decides or nothing does."""

    message: dict
    hash: str
    label: str | None
    stored: dict | None


def label_messages(messages: Iterable[dict]) -> list[LabelledMessage]:
    """Resolve each of `messages` from one conversation to IC, OOC or
    Unlabeled, live: a stored Label first, then the rules at the current
    threshold. A system line resolves to no Label."""
    messages = list(messages)
    with _store() as (conn, settings):
        by_hash = labels_store.labels_for_messages(conn, messages)
        out = []
        for msg in messages:
            h = labels_store.msg_hash(msg)
            label = labels_store.resolve(msg, by_hash.get(h), settings)
            # A row left on a system line from before they had no Label
            # decides nothing, so it is not shown either.
            row = by_hash.get(h) if label is not None else None
            out.append(
                LabelledMessage(
                    message=msg,
                    hash=h,
                    label=label,
                    stored=dict(row) if row is not None else None,
                )
            )
        return out


# ---- writing ----------------------------------------------------------------


def override(
    *,
    hash: str,
    ts: int,
    speaker: str,
    label: str | None,
) -> dict[str, Any]:
    """The user's own verdict on one message, or with `label` None its
    removal, so the rules (or nobody) decide it again.

    Returns `{hash, deleted, label: None}` for a removal, else the
    stored `{hash, label, source, prior_label, prior_source}`.
    """
    if label is None:
        conn = labels_store.connect()
        try:
            removed = labels_store.delete_label(conn, hash)
        finally:
            conn.close()
        return {"hash": hash, "deleted": removed, "label": None}
    label = verdict(label)
    conn = labels_store.connect()
    try:
        labels_store.upsert_label(
            conn,
            hash=hash,
            ts=ts,
            speaker=speaker,
            label=label,
            source="manual",
            reason="manual override",
        )
        row = labels_store.label_row(conn, hash) or {}
    finally:
        conn.close()
    return {
        "hash": hash,
        "label": row.get("label"),
        "source": row.get("source"),
        "prior_label": row.get("prior_label"),
        "prior_source": row.get("prior_source"),
    }


def override_many(
    items: Iterable[tuple[str, int, str]], label: str | None
) -> int:
    """`override` for any set of `(hash, ts, speaker)`: one verdict for
    all, or with `label` None their removal. Returns how many Labels
    changed."""
    if label is not None:
        label = verdict(label)
    items = list(items)
    conn = labels_store.connect()
    try:
        if label is None:
            return labels_store.delete_labels_by_hash(conn, [h for h, _ts, _speaker in items])
        return labels_store.upsert_labels_many(conn, items, label=label)
    finally:
        conn.close()


@dataclass(slots=True)
class Verdicts:
    """What `record_verdicts` did with a model's batch."""

    written: list[str] = field(default_factory=list)
    #: Hashes that are no message of this conversation.
    unknown: list[str] = field(default_factory=list)
    #: Items that carried no usable verdict, with the reason.
    rejected: list[dict[str, str]] = field(default_factory=list)
    #: Messages whose Label the user set by hand, `{hash, reason}`
    #: each: only the window changes those.
    skipped: list[dict[str, str]] = field(default_factory=list)
    #: Messages of the conversation still without a verdict, counted
    #: after the write (None when no hash was known). A caller that
    #: only ever hears `written: 20` has nothing to check its own
    #: bookkeeping against; this number says whether the work is done.
    unlabeled_remaining: int | None = None


def record_verdicts(
    character: str, partner: str, items: Iterable[Any]
) -> Verdicts:
    """Store a connected model's verdicts, `{hash, label, reason?}` each.

    Only hashes of this conversation's messages are written: a wrong
    hash would label some other message, so it is reported back as
    unknown instead. An item without a verdict is rejected on its own;
    the rest of the batch is still written, in one go. A message whose
    Label the user set by hand keeps it and is reported as skipped.
    """
    messages = _messages(character, partner)
    by_hash = {labels_store.msg_hash(m): m for m in messages}
    result = Verdicts()
    rows: list[tuple[str, int, str, str, str | None]] = []
    for raw in items:
        if not isinstance(raw, dict):
            result.rejected.append({"item": str(raw), "reason": "not an object"})
            continue
        h = str(raw.get("hash") or "").strip()
        label = str(raw.get("label") or "").strip().upper()
        if label not in VERDICTS:
            result.rejected.append(
                {"hash": h, "reason": f"label must be IC or OOC, got {label!r}"}
            )
            continue
        msg = by_hash.get(h)
        if msg is None:
            result.unknown.append(h)
            continue
        reason = raw.get("reason")
        rows.append(
            (
                h,
                int(msg.get("ts") or 0),
                str(msg.get("speaker") or ""),
                label,
                str(reason)[:REASON_MAX_CHARS] if reason else None,
            )
        )
    if not rows:
        return result
    with _store() as (conn, settings):
        known = list(dict.fromkeys(row[0] for row in rows))
        manual = labels_store.manual_hashes(conn, known)
        result.skipped = [
            {"hash": h, "reason": MANUAL_SKIP_REASON} for h in known if h in manual
        ]
        rows = [row for row in rows if row[0] not in manual]
        result.written = [row[0] for row in rows]
        if rows:
            labels_store.upsert_verdicts(conn, rows, source="mcp")
        result.unlabeled_remaining = _counts(conn, settings, messages)["unlabeled"]
    return result


def fill_unlabeled(
    character: str, partner: str, label: str, *, source: str
) -> dict[str, Any]:
    """Give every still-Unlabeled message of one conversation the same
    verdict, for a conversation the user knows is all IC (or all OOC).

    Messages with a stored Label keep it and messages the rules decide
    keep resolving through the rules, so this adds Labels and never
    overwrites one. `source` says who wrote them: 'manual' from the
    window, 'mcp' from a connected model, whose Labels a later MCP
    clear may take again. Returns `{label, labeled, hashes, already_labeled,
    decided_by_rules, total_messages}`; `hashes` is exactly what was
    written, which `delete` takes to undo it.
    """
    label = verdict(label)
    messages = _messages(character, partner)
    with _store() as (conn, settings):
        return labels_store.fill_unlabeled(
            conn, messages, settings, label, source=source
        )


def delete(hashes: Iterable[str]) -> int:
    """Remove the named Labels and nothing else: the undo of one
    `fill_unlabeled`. Returns how many were removed."""
    conn = labels_store.connect()
    try:
        return labels_store.delete_labels_by_hash(conn, list(hashes))
    finally:
        conn.close()


def clear(
    character: str, partner: str | None = None, *, keep_manual: bool = False
) -> dict[str, Any]:
    """Clear every Label of one conversation, or of every conversation
    of `character` when `partner` is None, a copy going to the Trash
    first. The window clears them all; MCP passes `keep_manual`, since
    only the window changes or clears a Label the user set by hand.
    Returns `{deleted, trash_id, skipped}`, `skipped` naming each
    manual Label left alone as `{hash, reason}`."""
    cleared = label_trash.clear(character, partner, keep_manual=keep_manual)
    return {
        "deleted": cleared["deleted"],
        "trash_id": cleared["trash_id"],
        "skipped": [{"hash": h, "reason": MANUAL_SKIP_REASON} for h in cleared["kept"]],
    }


def clear_all() -> dict[str, Any]:
    """Clear every Label there is, one Trash entry per character whose
    Logs hold the messages (see `label_trash.clear_all`). Returns
    `{deleted, trash_ids}`."""
    return label_trash.clear_all()
