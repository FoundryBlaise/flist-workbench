"""Client-driven IC/OOC classification (design §3.9).

Workbench used to run a classifier itself. It doesn't any more: the
rules still decide the easy cases, and everything they leave as
`Unlabeled` is handed to the model on the other end of this connection,
which sends its verdicts back.

The flow, which `get_classification_guidelines` also spells out for the
model:

    get_label_stats            how much is left
    get_classification_guidelines   the rulebook, once
    get_messages_to_classify   a batch, with context
    set_message_labels         the verdicts
    ...repeat until remaining == 0

Why it matters: only labelled messages are indexed for search. An
unjudged message could be roleplay prose or two players chatting about
their weekend, and indexing the latter poisons retrieval — so the
index simply skips them.
"""

from __future__ import annotations

from typing import Any

import aliases as aliases_store
import labels as labels_store
import logs as log_store
import settings as settings_store

from ._context import ToolError, audit
from ._registry import TAG_LOGS, prompt, tool

#: Batch size that keeps a request comfortably inside a small model's
#: context while still making progress. The tool reports how many
#: batches are left so a caller can decide whether to keep going.
DEFAULT_BATCH = 40
MAX_BATCH = 200


def _read_conversation(character: str, partner: str) -> list[dict[str, Any]]:
    """Parse one conversation, distinguishing "no such conversation"
    from "the log directory itself is missing".

    Both come back from the parser as the same exception type, but they
    need different answers: one is a typo the caller can fix, the other
    is a setting the user has to change.
    """
    try:
        return list(log_store.read_messages(character, partner))
    except log_store.LogDirError as exc:
        try:
            known = [
                entry.name for entry in log_store.list_partners(character)
            ]
        except log_store.LogDirError:
            raise ToolError(
                "log_dir_unavailable",
                f"{exc} The F-Chat data directory is set in "
                "Settings → General.",
            ) from exc
        raise ToolError(
            "partner_not_found",
            f"No log for {partner!r} with {character!r}.",
            known_partners=[n for n in known if not n.startswith("#")][:50],
        ) from exc


@tool(tags=TAG_LOGS, title="Classification guidelines", read_only=True)
def get_classification_guidelines(language: str = "de") -> dict[str, Any]:
    """The rulebook for deciding whether a message is IC or OOC.

    Read this once before classifying. `language` picks the wording:
    `de` (German roleplay — the default), `en`, or `minimal` for a
    short language-agnostic version. These are the same guidelines
    Workbench's own classifier used before this moved to MCP, so
    verdicts stay consistent with anything labelled earlier.
    """
    from services import classification

    try:
        result = classification.guidelines(language)
    except ValueError as exc:
        raise ToolError("validation_failed", str(exc)) from exc
    result["workflow"] = _WORKFLOW
    return result


_WORKFLOW = [
    "get_label_stats(character, partner) — see how many are unjudged",
    "get_messages_to_classify(character, partner) — a batch with context",
    "decide IC or OOC for each, using the guidelines above",
    "set_message_labels(character, partner, items) — send the verdicts",
    "repeat while `remaining` > 0, passing back `next_cursor`",
]


@prompt(
    tags=TAG_LOGS,
    name="classify_ic_ooc",
    description="Guidelines for labelling F-Chat log messages IC or OOC.",
)
def classify_ic_ooc_prompt(language: str = "de") -> str:
    """Prompt twin of get_classification_guidelines, for clients that
    support prompts. LM Studio, the primary client, does not — so the
    tool is the load-bearing surface and this is a convenience."""
    from services import classification

    result = classification.guidelines(language)
    return (
        f"{result['guidelines']}\n\n{result['rules_already_applied']}\n\n"
        "Answer with a verdict of IC or OOC for each message you are "
        "given, keyed by its hash."
    )


@tool(tags=TAG_LOGS, title="Messages awaiting a verdict", read_only=True)
def get_messages_to_classify(
    character: str,
    partner: str,
    limit: int = DEFAULT_BATCH,
    cursor: int = 0,
    context_before: int = 1,
    context_after: int = 1,
) -> dict[str, Any]:
    """A batch of messages that still need an IC/OOC verdict, each with
    its neighbours for context.

    Only messages the rules couldn't settle are returned — empty,
    short and `((`-prefixed ones are already OOC and never appear here.
    Each carries a `hash`; pass those back to set_message_labels.

    Work through a conversation by passing the returned `next_cursor`
    on the following call. `remaining` says how many are left after
    this batch, so you can tell the user up front how long this will
    take instead of looping silently.
    """
    capped = max(1, min(MAX_BATCH, int(limit)))
    from services import classification

    messages = _read_conversation(character, partner)

    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    try:
        lab_settings = labels_store.load_settings(settings_conn)
        batch = classification.collect_pending(
            messages,
            labels_conn,
            character,
            partner,
            lab_settings,
            limit=capped,
            cursor=int(cursor),
            context_before=max(0, min(10, int(context_before))),
            context_after=max(0, min(10, int(context_after))),
        )
    finally:
        settings_conn.close()
        labels_conn.close()

    out: dict[str, Any] = {
        "character": character,
        "partner": partner,
        "messages": [item.to_dict() for item in batch.items],
        "remaining": batch.remaining,
        "conversation": {
            "total_messages": batch.total_messages,
            "already_judged": batch.already_labelled,
            "decided_by_rules": batch.decided_by_rules,
        },
    }
    if batch.next_cursor is not None:
        out["next_cursor"] = batch.next_cursor
    if not batch.items:
        out["note"] = (
            "Nothing left to judge in this conversation — every message "
            "has a verdict or was settled by the rules."
        )
    elif batch.remaining:
        batches_left = -(-batch.remaining // capped)  # ceil
        out["note"] = (
            f"{batch.remaining} more after this batch — about "
            f"{batches_left} further call(s) at this limit. Tell the user "
            "before starting a long run."
        )
    return out


@tool(
    tags=TAG_LOGS,
    title="Record IC/OOC verdicts",
    idempotent=True,
)
def set_message_labels(
    character: str, partner: str, items: list[dict[str, Any]]
) -> dict[str, Any]:
    """Store IC/OOC verdicts for messages.

    Each item is `{"hash": ..., "label": "IC"|"OOC", "reason": ...}`.
    The reason is optional but worth writing — it shows in the log
    viewer's tooltip and is how the user audits a verdict they
    disagree with.

    Only hashes from get_messages_to_classify (or read_log_messages)
    are accepted; an unknown hash is reported back rather than
    silently written, because a wrong hash would label some other
    message.
    """
    if not isinstance(items, list) or not items:
        raise ToolError("validation_failed", "items is empty")

    messages = _read_conversation(character, partner)
    by_hash = {labels_store.msg_hash(m): m for m in messages}

    written: list[str] = []
    unknown: list[str] = []
    rejected: list[dict[str, str]] = []

    conn = labels_store.connect()
    try:
        # Verdicts are stored under the alias group's primary name so
        # the partner column stays consistent across a rename.
        primary = aliases_store.primary_for(conn, character, partner)
        for raw in items:
            if not isinstance(raw, dict):
                rejected.append({"item": str(raw), "reason": "not an object"})
                continue
            h = str(raw.get("hash") or "").strip()
            label = str(raw.get("label") or "").strip().upper()
            if label not in (labels_store.LABEL_IC, labels_store.LABEL_OOC):
                rejected.append(
                    {"hash": h, "reason": f"label must be IC or OOC, got {label!r}"}
                )
                continue
            msg = by_hash.get(h)
            if msg is None:
                unknown.append(h)
                continue
            reason = raw.get("reason")
            labels_store.upsert_label(
                conn,
                hash=h,
                character=character,
                partner=primary,
                ts=int(msg.get("ts") or 0),
                speaker=str(msg.get("speaker") or ""),
                label=label,
                source="mcp",
                reason=str(reason)[:500] if reason else None,
            )
            written.append(h)
    finally:
        conn.close()

    audit(
        "set_message_labels",
        character=character,
        partner=partner,
        written=len(written),
        unknown=len(unknown),
        rejected=len(rejected),
    )

    out: dict[str, Any] = {
        "character": character,
        "partner": partner,
        "written": len(written),
    }
    if unknown:
        out["unknown_hashes"] = unknown
        out["note"] = (
            "Some hashes aren't in this conversation. They may belong to "
            "a different partner, or the log may have been re-read since. "
            "Fetch a fresh batch with get_messages_to_classify."
        )
    if rejected:
        out["rejected"] = rejected
    return out


@tool(
    tags=TAG_LOGS,
    title="Clear stored verdicts",
    destructive=True,
)
def clear_labels(
    character: str, partner: str | None = None, confirm: bool = False
) -> dict[str, Any]:
    """Delete stored IC/OOC verdicts, reverting messages to Unlabeled.

    Permanent, and it removes the user's own manual overrides as well
    as anything a model decided. Rule-based hints keep firing. Ask the
    user before calling this with confirm=true.
    """
    if not confirm:
        scope = f"{partner} with {character}" if partner else f"every conversation of {character}"
        raise ToolError(
            "confirm_required",
            f"This deletes every stored verdict for {scope}, including "
            "the user's own manual overrides, and cannot be undone. Ask "
            "the user, then call again with confirm=true.",
        )

    conn = labels_store.connect()
    try:
        if partner:
            alias_group = aliases_store.all_names_for(conn, character, partner)
            deleted = labels_store.delete_labels_for_partner(
                conn, character, partner, partner_aliases=alias_group
            )
        else:
            cur = conn.execute(
                "DELETE FROM labels WHERE character = ?", (character,)
            )
            conn.commit()
            deleted = cur.rowcount
    finally:
        conn.close()

    audit("clear_labels", character=character, partner=partner, deleted=deleted)
    return {
        "character": character,
        "partner": partner,
        "deleted": deleted,
        "note": "Those messages are Unlabeled again and will be skipped by ingest.",
    }
