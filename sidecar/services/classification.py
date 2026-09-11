"""Which messages still need an IC/OOC verdict, and their context.

Workbench no longer classifies anything itself. The rules in
`labels.resolve` still decide the easy cases (empty, shorter than the
threshold, `((` prefixed ⇒ OOC); everything they leave as `Unlabeled`
is handed to the connected model through the MCP tools in
`workbench_mcp/tools_logs.py`, which writes the verdicts back.

The selection and context-window logic here is the same one the
deleted in-app classifier used (`labels_llm.build_user_prompt` /
`classify_messages`), lifted out before that module went away: same
skip rules, same default window, same truncation of neighbours. Only
the output changed — structured messages instead of a prompt string,
because the model on the other end formats its own prompt.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable

import aliases as aliases_store
import labels as labels_store

#: Neighbours shown on each side of the message being judged. One is
#: usually enough to tell "yes" (an IC reply) from "yes" (an OOC
#: answer to a question), which is the case the rules cannot decide.
DEFAULT_CONTEXT_BEFORE = 1
DEFAULT_CONTEXT_AFTER = 1

#: Context messages are cut at this length. The target message is
#: never truncated — it is the thing being judged.
CONTEXT_TRUNCATE_CHARS = 500


@dataclass(frozen=True)
class ContextMessage:
    speaker: str
    text: str
    ts: int
    is_action: bool
    truncated: bool


@dataclass(frozen=True)
class PendingMessage:
    """One message awaiting a verdict, with its neighbours."""

    hash: str
    index: int
    ts: int
    speaker: str
    text: str
    char_count: int
    is_action: bool
    context_before: list[ContextMessage]
    context_after: list[ContextMessage]

    def to_dict(self) -> dict[str, Any]:
        return {
            "hash": self.hash,
            "ts": self.ts,
            "timestamp": _iso(self.ts),
            "speaker": self.speaker,
            "text": self.text,
            "char_count": self.char_count,
            "is_action": self.is_action,
            "context_before": [_ctx_dict(c) for c in self.context_before],
            "context_after": [_ctx_dict(c) for c in self.context_after],
        }


def _iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S"
    )


def _ctx_dict(c: ContextMessage) -> dict[str, Any]:
    out: dict[str, Any] = {
        "speaker": c.speaker,
        "text": c.text,
        "timestamp": _iso(c.ts),
    }
    if c.is_action:
        out["is_action"] = True
    if c.truncated:
        out["truncated"] = True
    return out


def _context_message(msg: dict) -> ContextMessage:
    text = (msg.get("text") or "").replace("\n", " ").strip()
    truncated = len(text) > CONTEXT_TRUNCATE_CHARS
    if truncated:
        text = text[:CONTEXT_TRUNCATE_CHARS].rstrip() + " […]"
    return ContextMessage(
        speaker=msg.get("speaker") or "",
        text=text,
        ts=int(msg.get("ts") or 0),
        # F-Chat type byte 1 is a /me action. Worth flagging: an action
        # line is almost always IC even when it is short.
        is_action=msg.get("type") == 1,
        truncated=truncated,
    )


@dataclass(frozen=True)
class PendingBatch:
    items: list[PendingMessage]
    #: Index to pass back as `cursor` for the next batch, or None when
    #: the conversation is exhausted.
    next_cursor: int | None
    #: Unlabeled messages left after this batch.
    remaining: int
    #: Messages the rules already decided, for context in the reply.
    total_messages: int
    already_labelled: int
    decided_by_rules: int


def collect_pending(
    messages: Iterable[dict],
    labels_conn,
    character: str,
    partner: str,
    settings: labels_store.LabelsSettings,
    *,
    limit: int = 40,
    cursor: int = 0,
    context_before: int = DEFAULT_CONTEXT_BEFORE,
    context_after: int = DEFAULT_CONTEXT_AFTER,
) -> PendingBatch:
    """Messages from `cursor` onward whose label is still `Unlabeled`.

    A message is skipped when it already has a stored verdict, or when
    the rules resolve it without help. `cursor` is an index into the
    conversation, so a caller can walk a long log in batches without
    re-reading what it already judged.
    """
    msgs = list(messages)
    alias_group = aliases_store.all_names_for(labels_conn, character, partner)
    by_hash = labels_store.labels_for_partner(
        labels_conn, character, partner, partner_aliases=alias_group
    )

    already_labelled = 0
    decided_by_rules = 0
    pending_indices: list[tuple[int, str]] = []

    for idx, msg in enumerate(msgs):
        h = labels_store.msg_hash(msg)
        if h in by_hash:
            already_labelled += 1
            continue
        if labels_store.resolve(msg, None, settings) != labels_store.LABEL_UNLABELED:
            decided_by_rules += 1
            continue
        pending_indices.append((idx, h))

    start = max(0, int(cursor))
    in_window = [(idx, h) for idx, h in pending_indices if idx >= start]
    batch = in_window[: max(0, int(limit))]

    items: list[PendingMessage] = []
    for idx, h in batch:
        msg = msgs[idx]
        lo = max(0, idx - context_before)
        hi = min(len(msgs), idx + context_after + 1)
        text = (msg.get("text") or "").strip()
        items.append(
            PendingMessage(
                hash=h,
                index=idx,
                ts=int(msg.get("ts") or 0),
                speaker=msg.get("speaker") or "",
                text=text,
                char_count=len(text),
                is_action=msg.get("type") == 1,
                context_before=[_context_message(msgs[i]) for i in range(lo, idx)],
                context_after=[
                    _context_message(msgs[i]) for i in range(idx + 1, hi)
                ],
            )
        )

    next_cursor = batch[-1][0] + 1 if len(in_window) > len(batch) else None
    return PendingBatch(
        items=items,
        next_cursor=next_cursor,
        remaining=len(in_window) - len(batch),
        total_messages=len(msgs),
        already_labelled=already_labelled,
        decided_by_rules=decided_by_rules,
    )


def guidelines(language: str = "de") -> dict[str, Any]:
    """The classification rulebook, as text for the connected model.

    These are the same prompts the in-app classifier used, so verdicts
    stay comparable with anything labelled before the migration.
    """
    wanted = (language or "de").strip().lower()
    aliases = {
        "de": "de-default",
        "german": "de-default",
        "en": "en-default",
        "english": "en-default",
        "minimal": "minimal",
        "any": "minimal",
    }
    preset_id = aliases.get(wanted, wanted)
    for preset in labels_store.PROMPT_PRESETS:
        if preset.id == preset_id:
            return {
                "id": preset.id,
                "label": preset.label,
                "language": preset.language,
                "description": preset.description,
                "guidelines": preset.body,
                "rules_already_applied": _RULES_NOTE.format(
                    threshold=labels_store.load_settings().threshold_chars
                ),
            }
    raise ValueError(
        f"unknown guideline set {language!r}; available: "
        + ", ".join(p.id for p in labels_store.PROMPT_PRESETS)
    )


_RULES_NOTE = (
    "Workbench already decided some messages without a model: an empty "
    "message, one shorter than {threshold} characters, or one starting "
    "with '((' is OOC. Those never reach you — every message you are "
    "given is one the rules could not settle."
)
