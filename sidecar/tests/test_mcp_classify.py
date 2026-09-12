"""Client-driven IC/OOC classification (design §3.9).

Phase-3 acceptance: the worked flow labels a real conversation end to
end, the verdicts land in the label store, and the messages that were
labelled become eligible for ingest.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from mcp_helpers import call_tool, mcp_client, tool_error_text
from test_mcp_logs import write_log

LONG_A = "She set the lantern down and listened to the rain. " * 6
LONG_B = "Honestly my commute today was a nightmare, took two hours. " * 6
SHORT = "mhm"


@pytest.fixture
def conversation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """One conversation: two long messages needing a verdict, one short
    one the rules already call OOC."""
    root = tmp_path / "fchat"
    monkeypatch.setenv("FCHAT_DATA_DIR", str(root))
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "wb"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")

    write_log(
        root / "Lady Amber Blaise" / "logs" / "Daemon Enariel",
        [
            (1700000000, "Lady Amber Blaise", LONG_A),
            (1700000060, "Daemon Enariel", SHORT),
            (1700000120, "Daemon Enariel", LONG_B),
        ],
    )

    import importlib

    import labels
    import logs
    import paths
    import server
    import settings

    importlib.reload(paths)
    importlib.reload(logs)
    importlib.reload(settings)
    importlib.reload(labels)
    importlib.reload(server)
    return root


# ---- guidelines --------------------------------------------------------


async def test_guidelines_come_with_the_workflow(conversation) -> None:
    async with mcp_client("logs") as session:
        _, body = await call_tool(session, "get_classification_guidelines")
    assert body["id"] == "de-default"
    assert "Klassifikator" in body["guidelines"]
    # The rules already applied must be stated, or the model will
    # wonder why it never sees short messages.
    assert "200" in body["rules_already_applied"]
    assert any("set_message_labels" in step for step in body["workflow"])


async def test_guidelines_available_in_english_and_minimal(conversation) -> None:
    async with mcp_client("logs") as session:
        _, en = await call_tool(session, "get_classification_guidelines", language="en")
        _, minimal = await call_tool(
            session, "get_classification_guidelines", language="minimal"
        )
    assert en["id"] == "en-default"
    assert minimal["id"] == "minimal"


async def test_an_unknown_language_lists_the_options(conversation) -> None:
    async with mcp_client("logs") as session:
        result, _ = await call_tool(
            session, "get_classification_guidelines", language="klingon"
        )
    text = tool_error_text(result)
    assert "validation_failed" in text
    assert "de-default" in text


async def test_the_prompt_twin_is_exposed(conversation) -> None:
    async with mcp_client("logs") as session:
        prompts = {p.name for p in (await session.list_prompts()).prompts}
        assert "classify_ic_ooc" in prompts
        rendered = await session.get_prompt("classify_ic_ooc", {"language": "en"})
    body = rendered.messages[0].content.text
    assert "classifier" in body.lower()


# ---- batches -----------------------------------------------------------


async def test_only_rule_undecidable_messages_are_offered(conversation) -> None:
    async with mcp_client("logs") as session:
        _, body = await call_tool(
            session,
            "get_messages_to_classify",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
    assert len(body["messages"]) == 2
    assert body["conversation"]["total_messages"] == 3
    assert body["conversation"]["decided_by_rules"] == 1
    assert body["remaining"] == 0


async def test_batches_carry_context_around_each_message(conversation) -> None:
    async with mcp_client("logs") as session:
        _, body = await call_tool(
            session,
            "get_messages_to_classify",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
    second = body["messages"][1]
    # The short message sits between the two long ones, so it shows up
    # as context even though it is never offered for judgement.
    assert second["context_before"][0]["text"] == SHORT
    assert second["context_before"][0]["speaker"] == "Daemon Enariel"


async def test_context_can_be_switched_off(conversation) -> None:
    async with mcp_client("logs") as session:
        _, body = await call_tool(
            session,
            "get_messages_to_classify",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
            context_before=0,
            context_after=0,
        )
    assert all(not m["context_before"] for m in body["messages"])
    assert all(not m["context_after"] for m in body["messages"])


async def test_a_limited_batch_reports_what_is_left(conversation) -> None:
    async with mcp_client("logs") as session:
        _, first = await call_tool(
            session,
            "get_messages_to_classify",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
            limit=1,
        )
        assert first["remaining"] == 1
        assert "next_cursor" in first
        assert "1 more after this batch" in first["note"]

        _, second = await call_tool(
            session,
            "get_messages_to_classify",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
            limit=1,
            cursor=first["next_cursor"],
        )
    assert second["remaining"] == 0
    assert second["messages"][0]["hash"] != first["messages"][0]["hash"]


async def test_an_unknown_partner_is_named_as_such(conversation) -> None:
    async with mcp_client("logs") as session:
        result, _ = await call_tool(
            session,
            "get_messages_to_classify",
            character="Lady Amber Blaise",
            partner="Nobody",
        )
    assert "partner_not_found" in tool_error_text(result)


# ---- the worked flow ---------------------------------------------------


async def test_the_full_flow_labels_a_conversation(conversation) -> None:
    """The §3.9 worked flow: stats → batch → verdicts → stats."""
    async with mcp_client("logs") as session:
        _, before = await call_tool(
            session,
            "get_label_stats",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
        assert before["unlabeled"] == 2

        _, batch = await call_tool(
            session,
            "get_messages_to_classify",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
        # The model's part: the first message is scene prose, the
        # second is the player talking about their commute.
        verdicts = [
            {
                "hash": batch["messages"][0]["hash"],
                "label": "IC",
                "reason": "scene narration in the third person",
            },
            {
                "hash": batch["messages"][1]["hash"],
                "label": "OOC",
                "reason": "first-person anecdote about real life",
            },
        ]
        _, written = await call_tool(
            session,
            "set_message_labels",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
            items=verdicts,
        )
        assert written["written"] == 2

        _, after = await call_tool(
            session,
            "get_label_stats",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
        assert after["unlabeled"] == 0
        assert after["ic"] == 1
        assert after["ooc"] == 2  # the rule-OOC short one plus the verdict
        assert "ready to ingest" in after["note"]

        # Nothing left to offer.
        _, empty = await call_tool(
            session,
            "get_messages_to_classify",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
        assert empty["messages"] == []
        assert "Nothing left to judge" in empty["note"]


async def test_verdicts_are_readable_back_with_their_reason(
    conversation,
) -> None:
    async with mcp_client("logs") as session:
        _, batch = await call_tool(
            session,
            "get_messages_to_classify",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
        await call_tool(
            session,
            "set_message_labels",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
            items=[
                {
                    "hash": batch["messages"][0]["hash"],
                    "label": "IC",
                    "reason": "third-person scene",
                }
            ],
        )
        _, read = await call_tool(
            session,
            "read_log_messages",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
    labelled = next(m for m in read["messages"] if m["label_source"] == "mcp")
    assert labelled["label"] == "IC"


# ---- validation --------------------------------------------------------


async def test_an_unknown_hash_is_reported_not_written(conversation) -> None:
    """A wrong hash would label some other message, so it must never be
    silently accepted."""
    async with mcp_client("logs") as session:
        _, body = await call_tool(
            session,
            "set_message_labels",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
            items=[{"hash": "0123456789abcdef", "label": "IC"}],
        )
    assert body["written"] == 0
    assert body["unknown_hashes"] == ["0123456789abcdef"]
    assert "get_messages_to_classify" in body["note"]


async def test_a_bad_label_is_rejected_per_item(conversation) -> None:
    async with mcp_client("logs") as session:
        _, batch = await call_tool(
            session,
            "get_messages_to_classify",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
        _, body = await call_tool(
            session,
            "set_message_labels",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
            items=[
                {"hash": batch["messages"][0]["hash"], "label": "IC"},
                {"hash": batch["messages"][1]["hash"], "label": "maybe?"},
            ],
        )
    # The good one still lands; only the bad one is refused.
    assert body["written"] == 1
    assert len(body["rejected"]) == 1
    assert "IC or OOC" in body["rejected"][0]["reason"]


async def test_labels_are_accepted_case_insensitively(conversation) -> None:
    async with mcp_client("logs") as session:
        _, batch = await call_tool(
            session,
            "get_messages_to_classify",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
        _, body = await call_tool(
            session,
            "set_message_labels",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
            items=[{"hash": batch["messages"][0]["hash"], "label": "ic"}],
        )
    assert body["written"] == 1


async def test_empty_items_is_refused(conversation) -> None:
    async with mcp_client("logs") as session:
        result, _ = await call_tool(
            session,
            "set_message_labels",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
            items=[],
        )
    assert "validation_failed" in tool_error_text(result)


# ---- clearing ----------------------------------------------------------


async def test_clearing_requires_confirmation(conversation) -> None:
    async with mcp_client("logs") as session:
        result, _ = await call_tool(
            session,
            "clear_labels",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
    text = tool_error_text(result)
    assert "confirm_required" in text
    assert "manual overrides" in text


async def test_clearing_reverts_to_unlabeled(conversation) -> None:
    async with mcp_client("logs") as session:
        _, batch = await call_tool(
            session,
            "get_messages_to_classify",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
        await call_tool(
            session,
            "set_message_labels",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
            items=[{"hash": m["hash"], "label": "IC"} for m in batch["messages"]],
        )
        _, cleared = await call_tool(
            session,
            "clear_labels",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
            confirm=True,
        )
        assert cleared["deleted"] == 2

        _, stats = await call_tool(
            session,
            "get_label_stats",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
    assert stats["unlabeled"] == 2


async def test_clear_labels_is_annotated_destructive() -> None:
    async with mcp_client("logs") as session:
        tools = {t.name: t for t in (await session.list_tools()).tools}
    assert tools["clear_labels"].annotations.destructiveHint is True
    assert tools["set_message_labels"].annotations.readOnlyHint is False


# ---- addressing by name, whatever the case -----------------------------


async def test_verdicts_survive_a_differently_cased_address(conversation) -> None:
    """Labels written under the on-disk spelling must still be found when
    the caller spells either name differently.

    The regression this guards: messages are read through the filesystem,
    which is case-insensitive on Windows, while the `labels` and
    `partner_aliases` tables match their key exactly. A call addressed as
    `lady amber blaise` / `daemon enariel` therefore used to return the
    right messages with none of their verdicts — `ic: 0` and every judged
    message back in `unlabeled`, with no error to show for it.
    """
    async with mcp_client("logs") as session:
        _, batch = await call_tool(
            session,
            "get_messages_to_classify",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
        await call_tool(
            session,
            "set_message_labels",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
            items=[
                {"hash": batch["messages"][0]["hash"], "label": "IC"},
                {"hash": batch["messages"][1]["hash"], "label": "OOC"},
            ],
        )

        _, canonical = await call_tool(
            session,
            "get_label_stats",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
        for character, partner in (
            ("lady amber blaise", "daemon enariel"),
            ("LADY AMBER BLAISE", "DAEMON ENARIEL"),
            ("Lady Amber Blaise", "daemon enariel"),
        ):
            _, body = await call_tool(
                session,
                "get_label_stats",
                character=character,
                partner=partner,
            )
            assert body == canonical, (character, partner)


async def test_writing_labels_through_a_cased_address_hits_one_row_set(
    conversation,
) -> None:
    """A verdict written under `daemon enariel` must be the same row the
    canonical address reads — not a second, parallel set of labels."""
    async with mcp_client("logs") as session:
        _, batch = await call_tool(
            session,
            "get_messages_to_classify",
            character="lady amber blaise",
            partner="daemon enariel",
        )
        await call_tool(
            session,
            "set_message_labels",
            character="lady amber blaise",
            partner="daemon enariel",
            items=[{"hash": batch["messages"][0]["hash"], "label": "IC"}],
        )
        _, body = await call_tool(
            session,
            "get_label_stats",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
    assert body["ic"] == 1
    assert body["unlabeled"] == 1


async def test_an_unknown_partner_is_refused_rather_than_counted(
    conversation,
) -> None:
    async with mcp_client("logs") as session:
        result, _ = await call_tool(
            session,
            "get_label_stats",
            character="Lady Amber Blaise",
            partner="Nobody At All",
        )
    text = tool_error_text(result)
    assert "partner_not_found" in text
    assert "list_partners" in text


def test_the_guidelines_describe_a_tool_call_not_a_text_answer() -> None:
    """The prompt predates MCP. It used to demand one bare JSON object and
    forbid chain-of-thought, because Workbench parsed the model's reply
    itself. Over MCP the verdicts arrive as `set_message_labels`
    arguments, so that contract contradicted the workflow in the same
    response — and told a reasoning model to stop reasoning for no gain.
    """
    import labels as labels_store

    for preset in labels_store.PROMPT_PRESETS:
        body = preset.body
        assert "set_message_labels" in body, preset.id
        assert "chain-of-thought" not in body.lower(), preset.id
        assert "Vor-Überlegung" not in body, preset.id
        # The one output rule that still applies is the stored field.
        assert "60" in body, preset.id


async def test_progress_fields_come_before_the_messages(conversation) -> None:
    """A client whose context cannot hold the whole response loses the
    tail of it. When `remaining` and `next_cursor` sat after `messages`,
    that is exactly what went missing — and a caller that then labelled
    only what it could see and advanced the cursor past the whole batch
    left the invisible remainder unjudged for the rest of the walk.
    """
    async with mcp_client("logs") as session:
        result, body = await call_tool(
            session,
            "get_messages_to_classify",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
    text = "\n".join(
        c.text for c in result.content if getattr(c, "type", None) == "text"
    )
    assert text.index('"remaining"') < text.index('"messages"')
    assert body["returned"] == len(body["messages"])


async def test_cursor_zero_walks_the_whole_conversation(conversation) -> None:
    """The documented safe loop: label, then ask again at cursor 0."""
    async with mcp_client("logs") as session:
        seen: set[str] = set()
        for _ in range(10):
            _, batch = await call_tool(
                session,
                "get_messages_to_classify",
                character="Lady Amber Blaise",
                partner="Daemon Enariel",
                cursor=0,
                limit=1,
            )
            if not batch["messages"]:
                break
            hashes = [m["hash"] for m in batch["messages"]]
            assert not seen.intersection(hashes), "cursor 0 re-offered a judged one"
            seen.update(hashes)
            await call_tool(
                session,
                "set_message_labels",
                character="Lady Amber Blaise",
                partner="Daemon Enariel",
                items=[{"hash": h, "label": "IC"} for h in hashes],
            )
        _, stats = await call_tool(
            session,
            "get_label_stats",
            character="Lady Amber Blaise",
            partner="Daemon Enariel",
        )
    assert stats["unlabeled"] == 0
    assert len(seen) == 2
