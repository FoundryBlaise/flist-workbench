"""One Labels service behind REST and MCP.

The window (REST) and a connected model (MCP) reach the same Label
operations: counting, overriding, filling and clearing. Both are thin
adapters over `services.labels`, so the same operation on the same
conversation gives the same result whichever surface asked, and each
change is announced to the window once.

Built on the `two_characters` scenario: Azure Viper's conversation with
Antiquill spans two Logs through an alias link (Quill Ashgrove) and
holds two long lines no rule decides, plus two short ones the rules
call OOC.
"""

from __future__ import annotations

import inspect
from typing import Any, Callable

import pytest

from mcp_helpers import allow_log_text, call_tool, mcp_client
from two_characters import (  # noqa: F401  (the fixture is used by name)
    AMBER,
    AZURE,
    OLD_NAME,
    OLD_NAME_LINE,
    PARTNER,
    PARTNER_LINE,
    TwoCharacters,
    two_characters,
)

CONV = {"character": AZURE, "partner": PARTNER}
COUNTS = ("ic", "ooc", "unlabeled", "total")


@pytest.fixture
def label_events(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Every `labels-changed` event published while the test runs."""
    from services import events

    seen: list[dict[str, Any]] = []
    publish = events.publish

    def record(event: str, **data: Any) -> None:
        if event == events.LABELS_CHANGED:
            seen.append(data)
        publish(event, **data)

    monkeypatch.setattr(events, "publish", record)
    return seen


async def _mcp(tool: str, **arguments: Any) -> dict[str, Any]:
    async with mcp_client("logs") as session:
        result, body = await call_tool(session, tool, **arguments)
    assert not result.isError, body
    return body


async def _verdicts(scenario: TwoCharacters, character: str, partner: str, label: str) -> dict:
    """A model's `label` for every message of the conversation no rule
    or Label decides yet, in one batch."""
    items = [
        {"hash": m["hash"], "label": label}
        for m in scenario.messages(character, partner)
        if m["label"] == "Unlabeled"
    ]
    return await _mcp("set_message_labels", character=character, partner=partner, items=items)


def _rest_stats(scenario: TwoCharacters, character: str, partner: str) -> dict[str, int]:
    res = scenario.client.get("/labels/stats", params={"char": character, "partner": partner})
    assert res.status_code == 200, res.text
    return {k: res.json()[k] for k in COUNTS}


def _ref(scenario: TwoCharacters, text: str) -> dict[str, Any]:
    """A message of Azure Viper's conversation with Antiquill, as the
    log view sends it to the override routes."""
    m = scenario.message(AZURE, PARTNER, text)
    return {"hash": m["hash"], "ts": m["ts"], "speaker": m["speaker"]}


async def _run(operation: Callable[[], Any]) -> None:
    result = operation()
    if inspect.isawaitable(result):
        await result
    else:
        assert result.status_code == 200, result.text


# ---- each change is announced once -----------------------------------------


def _writes(scenario: TwoCharacters) -> dict[str, Callable[[], Any]]:
    post = scenario.client.post
    both = [_ref(scenario, PARTNER_LINE), _ref(scenario, OLD_NAME_LINE)]
    return {
        "rest override": lambda: post(
            "/labels/override", json={**CONV, **both[0], "label": "IC"}
        ),
        "rest override many": lambda: post(
            "/labels/override-many", json={**CONV, "items": both, "label": "OOC"}
        ),
        "rest fill": lambda: post("/labels/fill-unlabeled", json={**CONV, "label": "IC"}),
        "mcp verdicts": lambda: _verdicts(scenario, AZURE, PARTNER, "IC"),
        "mcp fill": lambda: _mcp("label_all_unlabeled", **CONV, label="IC", confirm=True),
    }


@pytest.mark.parametrize(
    "operation",
    ["rest override", "rest override many", "rest fill", "mcp verdicts", "mcp fill"],
)
async def test_every_label_write_is_announced_once(
    two_characters: TwoCharacters, label_events: list[dict[str, Any]], operation: str
) -> None:
    await _run(_writes(two_characters)[operation])

    assert len(label_events) == 1, label_events


@pytest.mark.parametrize(
    "operation",
    ["rest reset", "rest reset many", "rest delete", "rest clear", "mcp clear"],
)
async def test_every_label_removal_is_announced_once(
    two_characters: TwoCharacters, label_events: list[dict[str, Any]], operation: str
) -> None:
    post = two_characters.client.post
    filled = post("/labels/fill-unlabeled", json={**CONV, "label": "IC"}).json()
    one = _ref(two_characters, PARTNER_LINE)
    label_events.clear()

    removals = {
        "rest reset": lambda: post("/labels/override", json={**CONV, **one, "label": None}),
        "rest reset many": lambda: post(
            "/labels/override-many", json={**CONV, "items": [one], "label": None}
        ),
        "rest delete": lambda: post(
            "/labels/delete-hashes", json={**CONV, "hashes": filled["hashes"]}
        ),
        "rest clear": lambda: post("/labels/clear", json=CONV),
        "mcp clear": lambda: _mcp("clear_labels", **CONV, confirm=True),
    }
    await _run(removals[operation])

    assert len(label_events) == 1, label_events


# ---- the same operation gives the same result on both surfaces -------------


@pytest.mark.parametrize("asked_as", [PARTNER, OLD_NAME])
async def test_rest_and_mcp_count_a_conversation_alike(
    two_characters: TwoCharacters, asked_as: str
) -> None:
    await _verdicts(two_characters, AZURE, PARTNER, "IC")
    two_characters.label_by_hand(AZURE, PARTNER, OLD_NAME_LINE, "OOC")

    over_mcp = await _mcp("get_label_stats", character=AZURE, partner=asked_as)

    over_rest = _rest_stats(two_characters, AZURE, asked_as)
    assert over_rest == {k: over_mcp[k] for k in COUNTS}
    assert over_rest == {"ic": 1, "ooc": 3, "unlabeled": 0, "total": 4}


async def test_rest_and_mcp_count_every_conversation_of_a_character_alike(
    two_characters: TwoCharacters,
) -> None:
    await _verdicts(two_characters, AZURE, AMBER, "IC")

    over_mcp = await _mcp("get_label_stats", character=AZURE)
    over_rest = two_characters.client.get("/labels/stats-all", params={"char": AZURE}).json()

    def rows(body: dict) -> dict[str, dict[str, int]]:
        return {r["partner"]: {k: r[k] for k in COUNTS} for r in body["partners"]}

    assert rows(over_rest) == rows(over_mcp)
    assert rows(over_rest) == {
        AMBER: {"ic": 1, "ooc": 1, "unlabeled": 0, "total": 2},
        PARTNER: {"ic": 0, "ooc": 2, "unlabeled": 2, "total": 4},
    }


async def test_rest_and_mcp_fill_a_conversation_alike(
    two_characters: TwoCharacters,
) -> None:
    post = two_characters.client.post
    over_rest = post("/labels/fill-unlabeled", json={**CONV, "label": "IC"}).json()
    after_rest = _rest_stats(two_characters, AZURE, PARTNER)
    post("/labels/delete-hashes", json={**CONV, "hashes": over_rest["hashes"]})

    over_mcp = await _mcp("label_all_unlabeled", **CONV, label="IC", confirm=True)

    keys = ("label", "labeled", "already_labeled", "decided_by_rules", "total_messages")
    assert {k: over_rest[k] for k in keys} == {k: over_mcp[k] for k in keys}
    assert {k: over_rest[k] for k in keys} == {
        "label": "IC",
        "labeled": 2,
        "already_labeled": 0,
        "decided_by_rules": 2,
        "total_messages": 4,
    }
    assert _rest_stats(two_characters, AZURE, PARTNER) == after_rest


async def test_rest_and_mcp_clear_a_conversation_alike(
    two_characters: TwoCharacters,
) -> None:
    await _verdicts(two_characters, AZURE, PARTNER, "IC")
    over_rest = two_characters.client.post("/labels/clear", json=CONV).json()
    after_rest = _rest_stats(two_characters, AZURE, PARTNER)

    await _verdicts(two_characters, AZURE, PARTNER, "IC")
    over_mcp = await _mcp("clear_labels", **CONV, confirm=True)

    assert over_rest["deleted"] == over_mcp["deleted"] == 2
    assert over_rest["trash_id"] and over_mcp["trash_id"]
    assert _rest_stats(two_characters, AZURE, PARTNER) == after_rest
    assert after_rest["unlabeled"] == 2


async def test_a_label_reads_the_same_whichever_surface_set_it(
    two_characters: TwoCharacters,
) -> None:
    two_characters.label_by_hand(AZURE, PARTNER, PARTNER_LINE, "OOC")
    await _verdicts(two_characters, AZURE, PARTNER, "IC")
    allow_log_text()

    over_mcp = await _mcp("read_log_messages", **CONV)

    def labels(messages: list[dict]) -> dict[str, tuple[str, str | None]]:
        return {m["hash"]: (m["label"], m.get("label_source")) for m in messages}

    by_rest = labels(two_characters.messages(AZURE, PARTNER))
    assert by_rest == labels(over_mcp["messages"])
    assert by_rest[_ref(two_characters, PARTNER_LINE)["hash"]] == ("OOC", "manual")
    assert by_rest[_ref(two_characters, OLD_NAME_LINE)["hash"]] == ("IC", "mcp")


async def test_a_verdict_is_ic_or_ooc_in_any_case_on_both_surfaces(
    two_characters: TwoCharacters,
) -> None:
    res = two_characters.client.post(
        "/labels/override",
        json={**CONV, **_ref(two_characters, PARTNER_LINE), "label": " ooc"},
    )
    filled = await _mcp("label_all_unlabeled", **CONV, label="ic", confirm=True)

    assert res.json()["label"] == "OOC"
    assert (filled["label"], filled["labeled"]) == ("IC", 1)
    assert _rest_stats(two_characters, AZURE, PARTNER) == {
        "ic": 1,
        "ooc": 3,
        "unlabeled": 0,
        "total": 4,
    }


@pytest.mark.parametrize("label", ["maybe", "", "I C"])
async def test_a_non_verdict_is_refused_alike_on_both_surfaces(
    two_characters: TwoCharacters, label: str
) -> None:
    res = two_characters.client.post("/labels/fill-unlabeled", json={**CONV, "label": label})
    async with mcp_client("logs") as session:
        result, body = await call_tool(
            session, "label_all_unlabeled", **CONV, label=label, confirm=True
        )

    assert res.status_code == 400
    assert res.json()["code"] == "validation_failed"
    assert res.json()["details"]["allowed"] == ["IC", "OOC"]
    assert result.isError and "validation_failed" in str(body)
    assert _rest_stats(two_characters, AZURE, PARTNER)["unlabeled"] == 2
