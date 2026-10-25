"""Labels and aliases across two of the user's own characters.

Built on the `two_characters` scenario: one line in both own
characters' Logs, and a partner known under two names. What works today
is pinned by passing tests; the Label bugs #5 fixes (ADR 0004: a Label
belongs to the message) are strict xfails named after the behaviour
they expect, so each flips to a pass without rewording.
"""

from __future__ import annotations

import pytest

from mcp_helpers import call_tool, mcp_client
from two_characters import (  # noqa: F401  (the fixture is used by name)
    AMBER,
    AMBER_PARTNER_LINE,
    AZURE,
    OLD_NAME,
    OLD_NAME_LINE,
    PARTNER,
    PARTNER_LINE,
    SEARCH_TERM,
    SHARED_LINE,
    TwoCharacters,
    two_characters,
)


# ---- the scenario itself ---------------------------------------------------


def test_the_shared_line_is_one_unlabeled_message_in_both_logs(
    two_characters: TwoCharacters,
) -> None:
    in_azures = two_characters.message(AZURE, AMBER, SHARED_LINE)
    in_ambers = two_characters.message(AMBER, AZURE, SHARED_LINE)

    assert in_azures["hash"] == in_ambers["hash"]
    assert in_azures["label"] == in_ambers["label"] == "Unlabeled"


# ---- what works today: alias groups ----------------------------------------


def test_a_renamed_partner_is_listed_once_under_the_primary_name(
    two_characters: TwoCharacters,
) -> None:
    res = two_characters.client.get("/logs/partners", params={"char": AZURE})

    partners = {p["name"]: p["aliases"] for p in res.json()["partners"]}
    assert partners == {AMBER: [], PARTNER: [OLD_NAME]}


async def test_mcp_lists_a_renamed_partner_once_under_the_primary_name(
    two_characters: TwoCharacters,
) -> None:
    async with mcp_client("logs") as session:
        _, body = await call_tool(session, "list_partners", character=AZURE)

    rows = {r["partner"]: r.get("also_known_as", []) for r in body["partners"]}
    assert rows == {AMBER: [], PARTNER: [OLD_NAME]}


def test_the_primary_names_conversation_reads_both_logs(
    two_characters: TwoCharacters,
) -> None:
    texts = [m["text"] for m in two_characters.messages(AZURE, PARTNER)]

    assert OLD_NAME_LINE in texts and PARTNER_LINE in texts


def test_searching_a_conversation_covers_every_name_in_its_alias_group(
    two_characters: TwoCharacters,
) -> None:
    res = two_characters.client.get(
        "/logs/search", params={"char": AZURE, "partner": PARTNER, "q": SEARCH_TERM}
    )

    # Both names' lines, and not Lady Amber Blaise's line with the same
    # partner name: the alias group is Azure Viper's alone.
    assert sorted(h["text"] for h in res.json()["hits"]) == sorted(
        [OLD_NAME_LINE, PARTNER_LINE]
    )


async def test_mcp_search_by_the_old_name_covers_the_whole_alias_group(
    two_characters: TwoCharacters,
) -> None:
    async with mcp_client("logs") as session:
        _, body = await call_tool(
            session, "search_logs", character=AZURE, partner=OLD_NAME, query=SEARCH_TERM
        )

    assert body["partner"] == PARTNER
    assert sorted(h["text"] for h in body["hits"]) == sorted(
        [OLD_NAME_LINE, PARTNER_LINE]
    )


# ---- what works today: Labels ----------------------------------------------


async def _label_over_mcp(
    scenario: TwoCharacters, character: str, partner: str, verdicts: dict[str, str]
) -> dict:
    """Send `{text: label}` verdicts the way a connected model does."""
    items = [
        {"hash": scenario.hash_of(character, partner, text), "label": label}
        for text, label in verdicts.items()
    ]
    async with mcp_client("logs") as session:
        result, body = await call_tool(
            session, "set_message_labels", character=character, partner=partner, items=items
        )
    assert not result.isError, body
    return body


def _unlabeled(scenario: TwoCharacters, character: str, partner: str) -> int:
    res = scenario.client.get(
        "/labels/stats", params={"char": character, "partner": partner}
    )
    return res.json()["unlabeled"]


async def test_resetting_one_characters_conversation_leaves_another_characters_labels(
    two_characters: TwoCharacters,
) -> None:
    # Both own characters talk to someone called Antiquill.
    await _label_over_mcp(two_characters, AZURE, PARTNER, {PARTNER_LINE: "IC"})
    await _label_over_mcp(two_characters, AMBER, PARTNER, {AMBER_PARTNER_LINE: "IC"})

    two_characters.client.post(
        "/labels/clear", json={"character": AZURE, "partner": PARTNER}
    )

    assert two_characters.message(AZURE, PARTNER, PARTNER_LINE)["label"] == "Unlabeled"
    assert two_characters.message(AMBER, PARTNER, AMBER_PARTNER_LINE)["label"] == "IC"


async def test_the_unlabeled_count_follows_the_alias_group(
    two_characters: TwoCharacters,
) -> None:
    # Labelled under the old name before the rename was linked.
    two_characters.unlink_alias()
    await _label_over_mcp(two_characters, AZURE, OLD_NAME, {OLD_NAME_LINE: "IC"})
    two_characters.link_alias()

    written = await _label_over_mcp(two_characters, AZURE, PARTNER, {PARTNER_LINE: "IC"})

    assert written["unlabeled_remaining"] == 0
    assert _unlabeled(two_characters, AZURE, PARTNER) == 0
    async with mcp_client("logs") as session:
        _, stats = await call_tool(
            session, "get_label_stats", character=AZURE, partner=PARTNER
        )
    assert stats["unlabeled"] == 0


# ---- Label bugs #5 fixes (ADR 0004) ----------------------------------------


@pytest.mark.xfail(
    strict=True,
    reason="#5: a Label is stored under one character and filtered by it",
)
async def test_one_label_on_a_shared_line_shows_for_both_characters(
    two_characters: TwoCharacters,
) -> None:
    await _label_over_mcp(two_characters, AZURE, AMBER, {SHARED_LINE: "IC"})

    assert two_characters.message(AMBER, AZURE, SHARED_LINE)["label"] == "IC"


@pytest.mark.xfail(
    strict=True,
    reason="#5: a Label is stored under one character and filtered by it",
)
async def test_a_labelled_shared_line_is_not_offered_to_the_other_character(
    two_characters: TwoCharacters,
) -> None:
    await _label_over_mcp(two_characters, AZURE, AMBER, {SHARED_LINE: "IC"})

    async with mcp_client("logs") as session:
        _, batch = await call_tool(
            session, "get_messages_to_classify", character=AMBER, partner=AZURE
        )
    assert batch["messages"] == []


@pytest.mark.xfail(
    strict=True,
    reason="#5: resetting a conversation deletes by stored partner, not by its Log",
)
async def test_resetting_a_conversation_leaves_the_labels_of_a_log_unlinked_from_it(
    two_characters: TwoCharacters,
) -> None:
    # Labelled while the old name was part of Antiquill's conversation.
    await _label_over_mcp(two_characters, AZURE, PARTNER, {OLD_NAME_LINE: "IC"})
    two_characters.unlink_alias()

    # Antiquill's conversation no longer holds the old name's Log, so
    # resetting it must leave that Log's Label alone.
    two_characters.client.post(
        "/labels/clear", json={"character": AZURE, "partner": PARTNER}
    )

    two_characters.link_alias()
    assert two_characters.message(AZURE, PARTNER, OLD_NAME_LINE)["label"] == "IC"


@pytest.mark.xfail(
    strict=True,
    reason="#5: an MCP write replaces a manual Label",
)
async def test_an_mcp_write_does_not_overwrite_a_manual_label(
    two_characters: TwoCharacters,
) -> None:
    two_characters.label_by_hand(AZURE, PARTNER, PARTNER_LINE, "OOC")

    await _label_over_mcp(
        two_characters, AZURE, PARTNER, {PARTNER_LINE: "IC", OLD_NAME_LINE: "IC"}
    )

    kept = two_characters.message(AZURE, PARTNER, PARTNER_LINE)
    assert (kept["label"], kept["label_source"]) == ("OOC", "manual")


@pytest.mark.xfail(
    strict=True,
    reason="#5: Labels written under the primary detach from an unlinked alias",
)
async def test_unlinking_an_alias_keeps_its_labels(
    two_characters: TwoCharacters,
) -> None:
    await _label_over_mcp(two_characters, AZURE, PARTNER, {OLD_NAME_LINE: "IC"})

    two_characters.unlink_alias()

    assert two_characters.message(AZURE, OLD_NAME, OLD_NAME_LINE)["label"] == "IC"
