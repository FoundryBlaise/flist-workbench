"""Tools that return Log text are off until the user turns them on.

A Log holds the user's partners' lines as well as their own. When a
cloud model is the MCP client, every message a tool returns goes to
that model's provider, so the tools that return message text stay out
of every endpoint's tool list, and refuse a call, until the user turns
them on in Settings → MCP. The switch goes through the settings
service, and a client sees it on its next tool listing.
"""

from __future__ import annotations

import pytest

from mcp_helpers import allow_log_text, call_tool, mcp_client, tool_error_text
from two_characters import AZURE, PARTNER, SEARCH_TERM, two_characters  # noqa: F401

#: Every tool that returns message text: reading, searching, semantic
#: search and fetching messages to label.
LOG_TEXT_TOOLS = {
    "read_log_messages",
    "search_logs",
    "search_logs_semantic",
    "get_unlabeled_messages",
}

#: Each endpoint and the Log-text tools it carries once they are on.
CARRIED = {
    "": LOG_TEXT_TOOLS,
    "character": set(),
    "logs": LOG_TEXT_TOOLS,
    "classify": {"get_unlabeled_messages"},
}


async def _listed(suffix: str) -> set[str]:
    async with mcp_client(suffix) as session:
        return {t.name for t in (await session.list_tools()).tools}


def test_every_tool_returning_message_text_is_tagged_log_text() -> None:
    import workbench_mcp
    from workbench_mcp._registry import TAG_LOG_TEXT, registered_tools

    workbench_mcp.build_mcp_servers()
    tagged = {s.name for s in registered_tools() if TAG_LOG_TEXT in s.tags}
    assert tagged == LOG_TEXT_TOOLS


@pytest.mark.parametrize("suffix", list(CARRIED))
async def test_log_text_tools_are_hidden_from_every_endpoint_by_default(
    two_characters, suffix: str  # noqa: F811
) -> None:
    assert not (await _listed(suffix)) & LOG_TEXT_TOOLS


@pytest.mark.parametrize("suffix", ["", "logs", "classify"])
async def test_a_hidden_log_text_tool_refuses_a_call(
    two_characters, suffix: str  # noqa: F811
) -> None:
    async with mcp_client(suffix) as session:
        result, _ = await call_tool(
            session, "get_unlabeled_messages", character=AZURE, partner=PARTNER
        )
        text = tool_error_text(result)
    assert text.startswith("log_text_off: ")
    assert "Settings → MCP" in text


@pytest.mark.parametrize("suffix", list(CARRIED))
async def test_turned_on_the_log_text_tools_are_listed(
    two_characters, suffix: str  # noqa: F811
) -> None:
    allow_log_text()
    assert (await _listed(suffix)) & LOG_TEXT_TOOLS == CARRIED[suffix]


async def test_turned_on_a_log_text_tool_answers(two_characters) -> None:  # noqa: F811
    allow_log_text()
    async with mcp_client("logs") as session:
        result, body = await call_tool(
            session, "search_logs", character=AZURE, query=SEARCH_TERM
        )
    assert not result.isError, body
    assert body["partners"]


async def test_the_switch_reaches_a_connected_client_on_its_next_listing(
    two_characters,  # noqa: F811
) -> None:
    async with mcp_client("logs") as session:
        before = {t.name for t in (await session.list_tools()).tools}
        allow_log_text()
        on = {t.name for t in (await session.list_tools()).tools}
        result, body = await call_tool(
            session, "read_log_messages", character=AZURE, partner=PARTNER
        )
        assert not result.isError, body
        allow_log_text(False)
        off = {t.name for t in (await session.list_tools()).tools}
        result, _ = await call_tool(
            session, "read_log_messages", character=AZURE, partner=PARTNER
        )
        assert tool_error_text(result).startswith("log_text_off: ")
    assert not before & LOG_TEXT_TOOLS
    assert on & LOG_TEXT_TOOLS == LOG_TEXT_TOOLS
    assert not off & LOG_TEXT_TOOLS


def test_the_endpoint_tool_counts_follow_the_switch(two_characters) -> None:  # noqa: F811
    import server
    import workbench_mcp

    def counts() -> dict[str, int]:
        described = workbench_mcp.describe(server._MCP_SERVERS, 27384)
        return {e["id"]: e["tool_count"] for e in described["endpoints"]}  # type: ignore[index]

    off = counts()
    allow_log_text()
    on = counts()
    assert on["logs"] - off["logs"] == len(LOG_TEXT_TOOLS)
    assert on["classify"] - off["classify"] == 1
    assert on["character"] == off["character"]


async def test_the_classify_endpoint_says_how_to_turn_the_switch_on(
    two_characters,  # noqa: F811
) -> None:
    """With the switch off the labelling loop cannot fetch a batch; the
    rulebook, its first call, says so instead of a workflow that fails
    on its second step."""
    async with mcp_client("classify") as session:
        result, body = await call_tool(session, "get_labelling_guidelines")
    assert not result.isError, body
    assert "Settings → MCP" in body["log_text"]


async def test_turned_on_the_guidelines_carry_no_such_note(
    two_characters,  # noqa: F811
) -> None:
    allow_log_text()
    async with mcp_client("classify") as session:
        _, body = await call_tool(session, "get_labelling_guidelines")
    assert "log_text" not in body


def test_the_window_reads_the_switch_off_and_turns_it_on_in_one_request(
    two_characters,  # noqa: F811
) -> None:
    client = two_characters.client
    assert client.get("/settings").json()["mcp"] == {"log_text": False}

    res = client.put("/settings", json={"mcp": {"log_text": True}})

    assert res.status_code == 200, res.text
    assert res.json()["mcp"] == {"log_text": True}
    assert client.get("/settings").json()["mcp"] == {"log_text": True}


def test_the_switch_takes_only_true_or_false(two_characters) -> None:  # noqa: F811
    res = two_characters.client.put("/settings", json={"mcp": {"log_text": "maybe"}})

    assert res.status_code in (400, 422), res.text
    assert two_characters.client.get("/settings").json()["mcp"] == {"log_text": False}


async def test_a_model_cannot_turn_the_switch_on_itself(
    two_characters,  # noqa: F811
) -> None:
    async with mcp_client("") as session:
        tools = {t.name: t for t in (await session.list_tools()).tools}
    params = tools["update_settings"].inputSchema["properties"]
    assert not {name for name in params if "log" in name}


def test_the_server_instructions_name_the_switch() -> None:
    import workbench_mcp

    servers = workbench_mcp.build_mcp_servers()
    assert "Settings → MCP" in (servers["classify"].instructions or "")
