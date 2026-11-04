"""Labels and aliases across two of the user's own characters.

Built on the `two_characters` scenario: one line in both own
characters' Logs, and a partner known under two names. A Label
belongs to the message (ADR 0004): a conversation's Labels are those of
the messages its Logs hold, whichever character labelled them.
"""

from __future__ import annotations

from mcp_helpers import allow_log_text, call_tool, mcp_client
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
    allow_log_text()
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


async def test_one_label_on_a_shared_line_shows_for_both_characters(
    two_characters: TwoCharacters,
) -> None:
    await _label_over_mcp(two_characters, AZURE, AMBER, {SHARED_LINE: "IC"})

    assert two_characters.message(AMBER, AZURE, SHARED_LINE)["label"] == "IC"


async def test_a_labelled_shared_line_is_not_offered_to_the_other_character(
    two_characters: TwoCharacters,
) -> None:
    await _label_over_mcp(two_characters, AZURE, AMBER, {SHARED_LINE: "IC"})

    allow_log_text()  # batches carry Log text
    async with mcp_client("logs") as session:
        _, batch = await call_tool(
            session, "get_unlabeled_messages", character=AMBER, partner=AZURE
        )
    assert batch["messages"] == []


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


async def test_an_mcp_write_does_not_overwrite_a_manual_label(
    two_characters: TwoCharacters,
) -> None:
    two_characters.label_by_hand(AZURE, PARTNER, PARTNER_LINE, "OOC")

    await _label_over_mcp(
        two_characters, AZURE, PARTNER, {PARTNER_LINE: "IC", OLD_NAME_LINE: "IC"}
    )

    kept = two_characters.message(AZURE, PARTNER, PARTNER_LINE)
    assert (kept["label"], kept["label_source"]) == ("OOC", "manual")


async def test_the_labelling_tool_reports_a_manual_label_it_skipped(
    two_characters: TwoCharacters,
) -> None:
    two_characters.label_by_hand(AZURE, PARTNER, PARTNER_LINE, "OOC")
    manual_hash = two_characters.hash_of(AZURE, PARTNER, PARTNER_LINE)

    body = await _label_over_mcp(
        two_characters, AZURE, PARTNER, {PARTNER_LINE: "IC", OLD_NAME_LINE: "IC"}
    )

    assert body["written"] == 1
    assert [s["hash"] for s in body["skipped"]] == [manual_hash]
    assert "by hand" in body["skipped"][0]["reason"]
    assert "by hand" in body["note"]
    written = two_characters.message(AZURE, PARTNER, OLD_NAME_LINE)
    assert (written["label"], written["label_source"]) == ("IC", "mcp")


async def test_a_call_whose_every_label_was_set_by_hand_is_not_an_error(
    two_characters: TwoCharacters,
) -> None:
    # Nothing to retry: the user's Label stands, so the model is told
    # so rather than sent to fetch a fresh batch.
    two_characters.label_by_hand(AZURE, PARTNER, PARTNER_LINE, "OOC")

    body = await _label_over_mcp(two_characters, AZURE, PARTNER, {PARTNER_LINE: "IC"})

    assert body["written"] == 0
    assert len(body["skipped"]) == 1


def test_the_window_still_changes_and_clears_a_manual_label(
    two_characters: TwoCharacters,
) -> None:
    two_characters.label_by_hand(AZURE, PARTNER, PARTNER_LINE, "OOC")
    two_characters.label_by_hand(AZURE, PARTNER, PARTNER_LINE, "IC")

    changed = two_characters.message(AZURE, PARTNER, PARTNER_LINE)
    assert (changed["label"], changed["label_source"]) == ("IC", "manual")

    two_characters.label_by_hand(AZURE, PARTNER, PARTNER_LINE, None)
    assert two_characters.message(AZURE, PARTNER, PARTNER_LINE)["label"] == "Unlabeled"


async def _clear_over_mcp(**conversation: str) -> dict:
    async with mcp_client() as session:
        result, body = await call_tool(
            session, "clear_labels", **conversation, confirm=True
        )
    assert not result.isError, body
    return body


async def test_clearing_over_mcp_keeps_a_manual_label_and_reports_it(
    two_characters: TwoCharacters,
) -> None:
    two_characters.label_by_hand(AZURE, PARTNER, PARTNER_LINE, "OOC")
    manual_hash = two_characters.hash_of(AZURE, PARTNER, PARTNER_LINE)
    await _label_over_mcp(two_characters, AZURE, PARTNER, {OLD_NAME_LINE: "IC"})

    cleared = await _clear_over_mcp(character=AZURE, partner=PARTNER)

    assert cleared["deleted"] == 1
    assert [s["hash"] for s in cleared["skipped"]] == [manual_hash]
    assert "by hand" in cleared["skipped"][0]["reason"]
    assert "by hand" in cleared["note"]
    kept = two_characters.message(AZURE, PARTNER, PARTNER_LINE)
    assert (kept["label"], kept["label_source"]) == ("OOC", "manual")
    assert two_characters.message(AZURE, PARTNER, OLD_NAME_LINE)["label"] == "Unlabeled"
    # Only what was cleared waits in the Trash; the kept Label is not there.
    entries = two_characters.client.get("/labels/trash").json()["labels"]
    assert [(e["id"], e["count"]) for e in entries] == [(cleared["trash_id"], 1)]


async def test_clearing_a_characters_conversations_over_mcp_keeps_manual_labels(
    two_characters: TwoCharacters,
) -> None:
    two_characters.label_by_hand(AZURE, AMBER, SHARED_LINE, "IC")
    await _label_over_mcp(two_characters, AZURE, PARTNER, {OLD_NAME_LINE: "IC"})

    cleared = await _clear_over_mcp(character=AZURE)

    assert cleared["deleted"] == 1
    assert len(cleared["skipped"]) == 1
    assert two_characters.message(AMBER, AZURE, SHARED_LINE)["label"] == "IC"


async def test_a_clear_over_mcp_that_finds_only_manual_labels_is_not_an_error(
    two_characters: TwoCharacters,
) -> None:
    two_characters.label_by_hand(AZURE, PARTNER, PARTNER_LINE, "OOC")

    cleared = await _clear_over_mcp(character=AZURE, partner=PARTNER)

    assert (cleared["deleted"], cleared["trash_id"]) == (0, None)
    assert len(cleared["skipped"]) == 1
    assert two_characters.client.get("/labels/trash").json()["labels"] == []


async def test_filling_a_conversation_over_mcp_writes_a_models_labels(
    two_characters: TwoCharacters,
) -> None:
    async with mcp_client("logs") as session:
        result, filled = await call_tool(
            session, "label_all_unlabeled",
            character=AZURE, partner=PARTNER, label="IC", confirm=True,
        )
    assert not result.isError, filled
    assert filled["labeled"] == 2

    written = two_characters.message(AZURE, PARTNER, PARTNER_LINE)
    assert (written["label"], written["label_source"]) == ("IC", "mcp")
    assert two_characters.client.get("/labels/rollup").json()["manual"] == 0
    # A model's Labels, so a model may clear them again.
    assert (await _clear_over_mcp(character=AZURE, partner=PARTNER))["deleted"] == 2


def test_filling_a_conversation_in_the_window_writes_manual_labels(
    two_characters: TwoCharacters,
) -> None:
    two_characters.client.post(
        "/labels/fill-unlabeled",
        json={"character": AZURE, "partner": PARTNER, "label": "IC"},
    )

    written = two_characters.message(AZURE, PARTNER, PARTNER_LINE)
    assert (written["label"], written["label_source"]) == ("IC", "manual")


def test_the_windows_clear_still_takes_manual_labels(
    two_characters: TwoCharacters,
) -> None:
    two_characters.label_by_hand(AZURE, PARTNER, PARTNER_LINE, "OOC")

    cleared = two_characters.client.post(
        "/labels/clear", json={"character": AZURE, "partner": PARTNER}
    ).json()

    assert cleared["deleted"] == 1
    assert two_characters.message(AZURE, PARTNER, PARTNER_LINE)["label"] == "Unlabeled"


async def test_clearing_every_conversation_of_a_character_follows_her_logs(
    two_characters: TwoCharacters,
) -> None:
    # The shared line is labelled from Lady Amber Blaise's side, yet it
    # is in Azure Viper's Log as well.
    await _label_over_mcp(two_characters, AMBER, AZURE, {SHARED_LINE: "IC"})
    await _label_over_mcp(two_characters, AZURE, PARTNER, {OLD_NAME_LINE: "IC"})
    await _label_over_mcp(two_characters, AMBER, PARTNER, {AMBER_PARTNER_LINE: "IC"})

    async with mcp_client() as session:
        result, cleared = await call_tool(
            session, "clear_labels", character=AZURE, confirm=True
        )
    assert not result.isError, cleared

    assert cleared["deleted"] == 2
    assert two_characters.message(AMBER, AZURE, SHARED_LINE)["label"] == "Unlabeled"
    assert two_characters.message(AZURE, PARTNER, OLD_NAME_LINE)["label"] == "Unlabeled"
    assert two_characters.message(AMBER, PARTNER, AMBER_PARTNER_LINE)["label"] == "IC"


async def test_a_cleared_conversation_comes_back_from_the_trash_with_the_same_labels(
    two_characters: TwoCharacters,
) -> None:
    await _label_over_mcp(
        two_characters, AZURE, PARTNER, {PARTNER_LINE: "IC", OLD_NAME_LINE: "OOC"}
    )
    await _label_over_mcp(two_characters, AMBER, PARTNER, {AMBER_PARTNER_LINE: "IC"})
    before = {
        m["hash"]: (m["label"], m.get("label_source"))
        for m in two_characters.messages(AZURE, PARTNER)
    }

    cleared = two_characters.client.post(
        "/labels/clear", json={"character": AZURE, "partner": PARTNER}
    ).json()
    assert cleared["deleted"] == 2
    put_back = two_characters.client.post(
        "/labels/trash/put-back", json={"ids": [cleared["trash_id"]]}
    ).json()

    assert put_back["restored"] == [
        {"id": cleared["trash_id"], "restored": 2, "skipped": []}
    ]
    after = {
        m["hash"]: (m["label"], m.get("label_source"))
        for m in two_characters.messages(AZURE, PARTNER)
    }
    assert after == before
    assert two_characters.message(AMBER, PARTNER, AMBER_PARTNER_LINE)["label"] == "IC"


async def test_unlinking_an_alias_keeps_its_labels(
    two_characters: TwoCharacters,
) -> None:
    await _label_over_mcp(two_characters, AZURE, PARTNER, {OLD_NAME_LINE: "IC"})

    two_characters.unlink_alias()

    assert two_characters.message(AZURE, OLD_NAME, OLD_NAME_LINE)["label"] == "IC"


async def test_resetting_every_label_keeps_each_characters_labels_apart_in_the_trash(
    two_characters: TwoCharacters,
) -> None:
    # The shared line is in both characters' Logs; one more Label is on
    # a message no Log holds any more.
    await _label_over_mcp(two_characters, AZURE, AMBER, {SHARED_LINE: "IC"})
    await _label_over_mcp(two_characters, AZURE, PARTNER, {PARTNER_LINE: "OOC"})
    await _label_over_mcp(two_characters, AMBER, PARTNER, {AMBER_PARTNER_LINE: "IC"})
    res = two_characters.client.post(
        "/labels/override",
        json={
            "character": AZURE, "partner": PARTNER, "hash": "0123456789abcdef",
            "ts": 1700000000, "speaker": PARTNER, "label": "IC",
        },
    )
    assert res.status_code == 200, res.text
    labelled = {
        (c, p, line): two_characters.message(c, p, line)["label"]
        for c, p, line in (
            (AZURE, AMBER, SHARED_LINE),
            (AMBER, AZURE, SHARED_LINE),
            (AZURE, PARTNER, PARTNER_LINE),
            (AMBER, PARTNER, AMBER_PARTNER_LINE),
        )
    }

    cleared = two_characters.client.post("/labels/clear-all").json()

    assert cleared["labels_deleted"] == 4
    entries = two_characters.client.get("/labels/trash").json()["labels"]
    assert sorted(e["id"] for e in entries) == sorted(cleared["trash_ids"])
    # One entry per character whose Logs hold the messages, the shared
    # line in only one of them, and one for the message in no Log.
    assert {e["character"] for e in entries} == {AZURE, AMBER, None}
    assert sum(e["count"] for e in entries) == 4
    assert all(e["partner"] is None for e in entries)
    assert two_characters.message(AMBER, AZURE, SHARED_LINE)["label"] == "Unlabeled"

    put_back = two_characters.client.post(
        "/labels/trash/put-back", json={"ids": cleared["trash_ids"]}
    ).json()

    assert sum(r["restored"] for r in put_back["restored"]) == 4
    assert {
        key: two_characters.message(*key)["label"] for key in labelled
    } == labelled
