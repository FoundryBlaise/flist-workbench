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

from ._context import (
    ToolError,
    audit,
    resolve_conversation,
    resolve_log_character,
)
from ._registry import TAG_LOGS, prompt, tool

#: Batch size. Deliberately small: each message carries its own text
#: plus two context messages, so a batch of 40 runs to ~60 KB of JSON.
#: A model whose context cannot hold that sees a truncated response —
#: and a caller that labels only what it could see, then advances the
#: cursor past the whole batch, silently leaves the rest unjudged. Ten
#: fits any client; a client with room can ask for more.
DEFAULT_BATCH = 10
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
    "get_messages_to_classify takes 10 messages at a time — leave the "
    "limit alone; a bigger batch risks a truncated response and silently "
    "skipped messages",
    "repeat while `remaining` > 0 — calling again with cursor=0 is "
    "the safe way: judged messages drop out, so nothing can be skipped",
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
    language: str = "de",
) -> dict[str, Any]:
    """A batch of messages that still need an IC/OOC verdict, each with
    its neighbours for context.

    Leave `limit` at its default of 10. Raising it does not make the run
    faster — each message carries its own text plus two context
    messages, so a larger batch mostly buys a response too big for the
    context it has to fit in. What follows is not an error: the reply is
    truncated, the caller labels only the part it could read, and the
    rest of the batch is never seen again. A real run lost a third of a
    conversation that way while reporting it complete. Ten messages,
    more calls.

    Only messages the rules couldn't settle are returned — empty,
    short and `((`-prefixed ones are already OOC and never appear here.
    Each carries a `hash`; pass those back to set_message_labels.

    Two ways to walk a conversation:

    - Simplest, and safe: label the batch, then call again with
      `cursor=0`. Judged messages drop out of the pending list, so
      cursor 0 returns the next ones. Repeat until `messages` is empty.
      Nothing can be skipped this way, whatever happened in between.
    - With `next_cursor`, if you want to keep your place across a
      pause. Only do this if you labelled every message in the batch —
      the cursor moves past all of them, so any you left out will not
      come back in this walk. Lower `limit` rather than risk it.

    `remaining` says how many are left after this batch. It and
    `next_cursor` come before `messages` in the response so a truncated
    read still tells you where you are.

    Every batch is a complete work order: `rules` carries the decision
    rule in short form, so the judgement does not depend on the full
    rulebook still being in context. A long loop fills a client's
    context, and what a client drops first is its oldest turn — which is
    where the system prompt, and the instruction to re-fetch it, both
    live. `language` picks the wording: `de` (default), `en`, `minimal`.
    """
    conv = resolve_conversation(character, partner)
    character, partner = conv.character, conv.partner
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

    # Field order is load-bearing: a client whose context cannot hold
    # the whole response loses the tail, so everything needed to
    # continue goes in front of the payload.
    out: dict[str, Any] = {
        "character": character,
        "partner": partner,
        "rules": labels_store.COMPACT_RULES.get(
            str(language).strip().lower(), labels_store.COMPACT_RULES["de"]
        ),
        "returned": len(batch.items),
        "remaining": batch.remaining,
        "conversation": {
            "total_messages": batch.total_messages,
            "already_judged": batch.already_labelled,
            "decided_by_rules": batch.decided_by_rules,
        },
    }
    if batch.next_cursor is not None:
        out["next_cursor"] = batch.next_cursor
    out["messages"] = [item.to_dict() for item in batch.items]
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
    if capped > DEFAULT_BATCH:
        # Said in the response as well as the description, because the
        # description is read once and this is read every round.
        out["note"] = (
            f"You asked for {capped} messages; {DEFAULT_BATCH} is the "
            "recommended maximum. A batch this size may not fit your "
            "context, and anything you cannot read you will not label — "
            f"it then drops out of this walk silently. "
            + str(out.get("note") or "")
        ).strip()
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
    message. If nothing at all could be written this raises instead of
    returning — a write that stored none of its verdicts is a failed
    call, and reporting it as a result invites a caller to treat the
    batch as finished.

    The response carries `unlabeled_remaining` for this conversation,
    counted after the write. That number, not the caller's memory of
    how many batches it has done, is what says whether the work is
    complete.
    """
    if not isinstance(items, list) or not items:
        raise ToolError("validation_failed", "items is empty")

    conv = resolve_conversation(character, partner)
    character, partner = conv.character, conv.partner
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

    if not written:
        raise ToolError(
            "nothing_written",
            "None of the verdicts could be stored, so this batch is "
            "unchanged. Hashes must be copied verbatim from "
            "get_messages_to_classify — fetch a fresh batch and try "
            "again with the hashes it returns.",
            unknown_hashes=unknown,
            rejected=rejected,
        )

    remaining = _unlabeled_remaining(character, partner, messages)
    out: dict[str, Any] = {
        "character": character,
        "partner": partner,
        "written": len(written),
        "unlabeled_remaining": remaining,
    }
    notes: list[str] = []
    if unknown:
        out["unknown_hashes"] = unknown
        notes.append(
            f"{len(unknown)} hash(es) aren't in this conversation and were "
            "not written. They may belong to a different partner, or the "
            "log may have been re-read since. Fetch a fresh batch."
        )
    if rejected:
        out["rejected"] = rejected
    if remaining:
        notes.append(
            f"NOT FINISHED: {remaining} message(s) in this conversation "
            "still have no verdict and stay out of the index. Call "
            "get_messages_to_classify again (cursor=0) and keep going."
        )
    else:
        notes.append(
            "Every message in this conversation now has a verdict. Run "
            "ingest_logs to make the new ones searchable."
        )
    out["note"] = " ".join(notes)
    return out


def _unlabeled_remaining(
    character: str, partner: str, messages: list[dict[str, Any]]
) -> int:
    """How many messages still have no verdict, counted after a write.

    Cheap: the conversation is already parsed, so this is one labels
    query plus a resolve per message. Worth it on every write — a
    caller that only ever sees `written: 20` has nothing to check its
    own bookkeeping against, and a model summarising a long run will
    fill that gap with a plausible number instead of a true one.
    """
    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    try:
        lab_settings = labels_store.load_settings(settings_conn)
        alias_group = aliases_store.all_names_for(labels_conn, character, partner)
        by_hash = labels_store.labels_for_partner(
            labels_conn, character, partner, partner_aliases=alias_group
        )
        return sum(
            1
            for m in messages
            if labels_store.resolve(
                m, by_hash.get(labels_store.msg_hash(m)), lab_settings
            )
            == labels_store.LABEL_UNLABELED
        )
    finally:
        settings_conn.close()
        labels_conn.close()


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
    if partner:
        conv = resolve_conversation(character, partner)
        character, partner = conv.character, conv.partner
    else:
        character = resolve_log_character(character)

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
