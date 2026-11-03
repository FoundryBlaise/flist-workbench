"""Client-driven IC/OOC labelling (design §3.9).

F-list Workbench used to run a classifier itself. It doesn't any more: the
rules still decide the easy cases, and everything they leave as
`Unlabeled` is handed to the model on the other end of this connection,
which sends its Labels back.

The flow, which `get_labelling_guidelines` also spells out for the
model:

    get_label_stats            how much is left
    get_labelling_guidelines   the rulebook, once
    get_messages_to_classify   a batch, with context
    set_message_labels         the Labels
    ...repeat until remaining == 0

Why it matters: only labelled messages are indexed for search. An
unjudged message could be roleplay prose or two players chatting about
their weekend, and indexing the latter poisons retrieval — so the
index simply skips them.

A Label change reaches search on the next `ingest_logs` of the
conversation, not before. That ingest re-embeds only the days whose
messages or Labels changed, and drops messages that are no longer
labelled for the Index (flipped to OOC, or cleared).
"""

from __future__ import annotations

from typing import Any

import labels as labels_store
from services import classification
from services import labels as label_service
from services import settings as settings_service

from ._context import (
    LOG_TEXT_SWITCH,
    ToolError,
    audit,
    resolve_conversation,
    resolve_log_character,
)
from ._registry import TAG_CLASSIFY, TAG_LOG_TEXT, TAG_LOGS, prompt, tool

#: Batch size. Deliberately small: each message carries its own text
#: plus two context messages, so a batch of 40 runs to ~60 KB of JSON.
#: A model whose context cannot hold that sees a truncated response —
#: and a caller that labels only what it could see, then advances the
#: cursor past the whole batch, silently leaves the rest unjudged. Ten
#: fits any client; a client with room can ask for more.
DEFAULT_BATCH = 10
MAX_BATCH = 200

#: What makes a Label change searchable, said in every note that
#: follows one so a model does not tell the user something false.
NEXT_INGEST = (
    "Search sees Label changes after the next ingest_logs of this "
    "conversation: it re-embeds only the days whose messages or Labels "
    "changed, and drops messages that are no longer labelled IC (OOC "
    "ones stay only if that ingest passes include_ooc=true again)."
)


@tool(
    tags=(TAG_LOGS, TAG_CLASSIFY),
    title="Labelling guidelines",
    read_only=True,
)
def get_labelling_guidelines(language: str = "de") -> dict[str, Any]:
    """The rulebook for deciding whether a message is IC or OOC.

    Read this once before labelling. `language` picks the wording:
    `de` (German roleplay — the default), `en`, or `minimal` for a
    short language-agnostic version. These are the same guidelines
    the app's own classifier used before this moved to MCP, so
    Labels stay consistent with anything labelled earlier.
    """
    try:
        result = classification.guidelines(language)
    except ValueError as exc:
        raise ToolError("validation_failed", str(exc)) from exc
    result["workflow"] = _WORKFLOW
    if not settings_service.log_text_over_mcp():
        # The rulebook is the loop's first call; without this the model
        # learns the switch is off only when its second call fails.
        result["log_text"] = (
            "get_messages_to_classify is off: it returns Log text, which "
            f"MCP clients get only once {LOG_TEXT_SWITCH}. Ask the user "
            "to turn it on before you start."
        )
    return result


_WORKFLOW = [
    "get_label_stats(character, partner) — see how many are unjudged",
    "get_messages_to_classify(character, partner) — a batch with context",
    "decide IC or OOC for each, using the guidelines above",
    "set_message_labels(character, partner, items) — send the Labels",
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
    """Prompt twin of get_labelling_guidelines, for clients that
    support prompts. LM Studio, the primary client, does not — so the
    tool is the load-bearing surface and this is a convenience."""
    result = classification.guidelines(language)
    return (
        f"{result['guidelines']}\n\n{result['rules_already_applied']}\n\n"
        "Answer with a Label of IC or OOC for each message you are "
        "given, keyed by its hash."
    )


@tool(
    tags=(TAG_LOGS, TAG_CLASSIFY, TAG_LOG_TEXT),
    title="Messages awaiting a Label",
    read_only=True,
)
def get_messages_to_classify(
    character: str,
    partner: str,
    limit: int = DEFAULT_BATCH,
    cursor: int = 0,
    context_before: int = 1,
    context_after: int = 1,
    language: str = "de",
) -> dict[str, Any]:
    """A batch of messages that still need an IC/OOC Label, each with
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
    batch = classification.pending(
        character,
        partner,
        limit=capped,
        cursor=int(cursor),
        context_before=max(0, min(10, int(context_before))),
        context_after=max(0, min(10, int(context_after))),
    )

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
            "has a Label or was settled by the rules."
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
    tags=(TAG_LOGS, TAG_CLASSIFY),
    title="Record IC/OOC Labels",
    idempotent=True,
)
def set_message_labels(
    character: str, partner: str, items: list[dict[str, Any]]
) -> dict[str, Any]:
    """Store IC/OOC Labels for messages.

    Each item is `{"hash": ..., "label": "IC"|"OOC", "reason": ...}`.
    The reason is optional but worth writing — it shows in the log
    viewer's tooltip and is how the user audits a Label they
    disagree with.

    Only hashes from get_messages_to_classify (or read_log_messages)
    are accepted; an unknown hash is reported back rather than
    silently written, because a wrong hash would label some other
    message. If nothing at all could be written this raises instead of
    returning — a write that stored none of its Labels is a failed
    call, and reporting it as a result invites a caller to treat the
    batch as finished.

    The response carries `unlabeled_remaining` for this conversation,
    counted after the write. That number, not the caller's memory of
    how many batches it has done, is what says whether the work is
    complete.

    Labels reach search on the next ingest_logs of the conversation,
    which picks up new and changed Labels alike.
    """
    if not isinstance(items, list) or not items:
        raise ToolError("validation_failed", "items is empty")

    conv = resolve_conversation(character, partner)
    character, partner = conv.character, conv.partner
    result = label_service.record_verdicts(character, partner, items)
    written, unknown, rejected = result.written, result.unknown, result.rejected

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
            "None of the Labels could be stored, so this batch is "
            "unchanged. Hashes must be copied verbatim from "
            "get_messages_to_classify — fetch a fresh batch and try "
            "again with the hashes it returns.",
            unknown_hashes=unknown,
            rejected=rejected,
        )

    remaining = result.unlabeled_remaining
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
            "still have no Label and stay out of the Index. Call "
            "get_messages_to_classify again (cursor=0) and keep going."
        )
    else:
        notes.append(
            "Every message in this conversation now has a Label. " + NEXT_INGEST
        )
    out["note"] = " ".join(notes)
    return out


def _label_all_warning(
    character: str, partner: str, label: str, **_: Any
) -> str:
    """The refusal names the count: a model asking the user to approve
    this should be able to say how much it covers."""
    label = label_service.verdict(label)
    conv = resolve_conversation(character, partner)
    pending = label_service.conversation_stats(conv.character, conv.partner)["unlabeled"]
    return (
        f"This writes {label} to all {pending} unlabeled message(s) in "
        f"{conv.partner} with {conv.character} without reading them. Only "
        f"do it if the user said this conversation is entirely {label}."
    )


@tool(
    tags=(TAG_CLASSIFY, TAG_LOGS),
    title="Label every unlabeled message at once",
    destructive=True,
    warning=_label_all_warning,
)
def label_all_unlabeled(
    character: str,
    partner: str,
    label: str,
    confirm: bool = False,
) -> dict[str, Any]:
    """Give every still-unlabeled message in one conversation the same
    Label, in one call.

    Only for a conversation the *user* has told you is entirely IC (or
    entirely OOC). It is not a shortcut for judging: never call it
    because a batch looks uniform, or to finish a long labelling
    run faster. If the user has not said so about this specific
    conversation, keep labelling in batches.

    Messages that already have a Label keep it, and messages the
    rules decide (empty, short, `((` prefix) keep resolving through the
    rules — so this adds labels and never overwrites. `labeled` in the
    reply counts what was written; the user can undo it in the app.

    Unlabeled messages are skipped by ingest, so a conversation filled
    this way is found by search only after the next ingest_logs.
    """
    label = label_service.verdict(label)

    conv = resolve_conversation(character, partner)
    character, partner = conv.character, conv.partner

    result = label_service.fill_unlabeled(character, partner, label)

    audit(
        "label_all_unlabeled",
        character=character,
        partner=partner,
        label=label,
        labeled=result["labeled"],
    )
    return {
        "character": character,
        "partner": partner,
        "label": label,
        "labeled": result["labeled"],
        "already_labeled": result["already_labeled"],
        "decided_by_rules": result["decided_by_rules"],
        "total_messages": result["total_messages"],
        "note": (
            f"{result['labeled']} message(s) are now {label}. " + NEXT_INGEST
        ),
    }


@tool(
    tags=TAG_LOGS,
    title="Clear stored Labels",
    destructive=True,
    warning=(
        "This deletes every stored Label of the conversation (of every "
        "conversation of the character when no partner is given), "
        "including the user's own manual overrides. A copy goes to the "
        "Trash, where only the user can restore it."
    ),
)
def clear_labels(
    character: str, partner: str | None = None, confirm: bool = False
) -> dict[str, Any]:
    """Delete stored IC/OOC Labels, reverting messages to Unlabeled.

    It removes the user's own manual overrides as well as anything a
    model decided. Rule-based hints keep firing. Ask the user before
    calling this with confirm=true. The cleared Labels go to the
    character's Trash as one entry (`trash_id`), which the user can
    restore in the window.

    Search keeps finding the cleared messages until the next
    ingest_logs of the conversation, which drops them from the Index.
    """
    if partner:
        conv = resolve_conversation(character, partner)
        character, partner = conv.character, conv.partner
    else:
        character = resolve_log_character(character)

    cleared = label_service.clear(character, partner)

    audit(
        "clear_labels",
        character=character,
        partner=partner,
        deleted=cleared["deleted"],
        trash_id=cleared["trash_id"],
    )
    return {
        "character": character,
        "partner": partner,
        "deleted": cleared["deleted"],
        "trash_id": cleared["trash_id"],
        "note": (
            "Those messages are Unlabeled again. The cleared Labels are in "
            "the character's Trash; the user can restore them in the "
            "window. Search still finds the messages until the next "
            "ingest_logs, which drops them from the Index."
        ),
    }
