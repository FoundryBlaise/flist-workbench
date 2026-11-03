"""A model editing a character has one tool per action (spec #6, #86).

Kinks are set with `set_kinks`, the description is replaced or edited
in place, and images are imported with `import_images`. The one-item
and append-only variants that did the same thing are gone, without
aliases, so a model never has to choose between near-duplicates.
"""

from __future__ import annotations

import pytest

from mcp_helpers import call_tool, mcp_client, tool_error_text
from test_mcp_edit import workbench  # noqa: F401 — the fixture

ENDPOINTS = ("", "character", "logs", "classify")

GONE = ("set_kink", "append_description", "import_image")


@pytest.mark.parametrize("suffix", ENDPOINTS)
async def test_the_near_duplicates_are_on_no_endpoint(
    workbench, suffix: str  # noqa: F811
) -> None:
    async with mcp_client(suffix) as session:
        listed = {t.name for t in (await session.list_tools()).tools}
    assert not listed & set(GONE), listed & set(GONE)


@pytest.mark.parametrize("name", GONE)
async def test_calling_a_near_duplicate_is_an_unknown_tool(
    workbench, name: str  # noqa: F811
) -> None:
    async with mcp_client("character") as session:
        result, _ = await call_tool(session, name, character="Lady Amber Blaise")
    assert "Unknown tool" in tool_error_text(result)


async def test_the_character_endpoint_has_at_most_47_tools(workbench) -> None:  # noqa: F811
    async with mcp_client("character") as session:
        tools = (await session.list_tools()).tools
    assert len(tools) <= 47, sorted(t.name for t in tools)


async def test_remove_image_has_no_delete_option(workbench) -> None:  # noqa: F811
    async with mcp_client("character") as session:
        tools = {t.name: t for t in (await session.list_tools()).tools}
    params = set(tools["remove_image"].inputSchema["properties"])
    assert params == {"character", "image_id"}
    assert not tools["remove_image"].annotations.destructiveHint
