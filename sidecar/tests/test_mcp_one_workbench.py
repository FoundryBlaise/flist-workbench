"""MCP sees one Workbench beside Live (spec #3, ticket #52; spec #6, #84, #85).

A model connected over MCP sees what the window shows: each character
has one Workbench and its Live. The tools that listed, named, picked,
deleted, packed or unpacked several drafts, the addressing explainer
and the tool listing pull history are gone. Editing tools take no
copy to address at all: they change the Workbench. A read that can
look at either copy takes `source`, which accepts only `workbench` (the
default) or `live`; no tool takes `working_set` any more.
"""

from __future__ import annotations

import re
from typing import Any

import pytest

import archive_live
import archive_registry
import archive_workbench
from mcp_helpers import call_tool, mcp_client, server_instructions, tool_error_text
from test_mcp_edit import payload_of, workbench  # noqa: F401 — the fixture

ENDPOINTS = ("", "character", "logs", "classify")

REMOVED_TOOLS = (
    "list_working_sets",
    "create_working_set",
    "rename_working_set",
    "activate_working_set",
    "delete_working_set",
    "explain_set_addressing",
    "list_snapshots",
    "export_working_set_bundle",
    "import_working_set_bundle",
    "get_working_set",
    "diff_working_set",
)

#: Every tool that takes `source`, with the least it needs besides.
#: Listed rather than discovered so a new tool with the parameter has to
#: be added here, and so is held to the same refusal. Only reads: an
#: editing tool changes the Workbench and has nothing to address.
TAKES_SOURCE: dict[str, dict[str, Any]] = {
    "get_workbench": {},
    "get_description": {},
    "list_profile_fields": {},
    "list_kinks": {},
    "list_images": {},
    "diff_workbench": {},
    "render_profile_image": {},
}

#: The tools that edit the Workbench, which took `working_set` until
#: spec #6 and must not again.
EDITING_TOOLS = (
    "set_description",
    "edit_description",
    "set_custom_title",
    "set_profile_field",
    "clear_profile_field",
    "set_profile_settings",
    "set_kinks",
    "add_custom_kink",
    "update_custom_kink",
    "delete_custom_kink",
    "put_back_custom_kink",
    "reorder_custom_kinks",
    "set_image_description",
    "reorder_images",
    "remove_image",
    "add_image",
    "import_images",
    "put_workbench_payload",
)

#: A set spoken of as a thing a model could make, name or pick: what
#: neither the instructions nor a tool description may say any more.
SET_AS_A_THING = re.compile(
    r"\b(?:working[ _]sets?|(?:the|a|an|active|another|which|each|new|other)\s+sets?\b(?!\s+of\b))",
    re.IGNORECASE,
)


def _old_archive_with_a_second_draft(archive) -> str:
    """The Workbench, and the id a second draft had in an older version
    (since moved into a Backup at startup). Returns that id."""
    archive_workbench.read_workbench("42", create=True)
    return "bbbbbbbbbbbb"


@pytest.mark.parametrize("name", REMOVED_TOOLS)
async def test_a_removed_tool_is_not_listed_and_is_an_unknown_tool(
    workbench, name: str  # noqa: F811
) -> None:
    async with mcp_client() as session:
        listed = {t.name for t in (await session.list_tools()).tools}
        result, _ = await call_tool(session, name, character="Lady Amber Blaise")
    assert name not in listed
    assert "Unknown tool" in tool_error_text(result)


async def test_the_reads_taking_source_are_the_ones_listed_here(
    workbench,  # noqa: F811
) -> None:
    async with mcp_client() as session:
        tools = (await session.list_tools()).tools
    taking = {t.name for t in tools if "source" in t.inputSchema.get("properties", {})}
    # Its `source` is where to look for names (bookmarks, friends,
    # Logs), not a copy of the profile.
    taking.discard("search_foreign_characters")
    assert taking == set(TAKES_SOURCE)


@pytest.mark.parametrize("suffix", ENDPOINTS)
async def test_no_tool_takes_working_set(workbench, suffix: str) -> None:  # noqa: F811
    async with mcp_client(suffix) as session:
        tools = (await session.list_tools()).tools
    taking = [
        t.name for t in tools if "working_set" in t.inputSchema.get("properties", {})
    ]
    assert taking == []


@pytest.mark.parametrize("suffix", ENDPOINTS)
async def test_no_editing_tool_takes_a_copy_to_address(
    workbench, suffix: str  # noqa: F811
) -> None:
    """An editing tool changes the Workbench; there is no argument a
    model could get wrong and so edit the wrong copy."""
    async with mcp_client(suffix) as session:
        tools = (await session.list_tools()).tools
    for t in tools:
        if t.name in EDITING_TOOLS or not t.annotations.readOnlyHint:
            if t.name in TAKES_SOURCE:
                continue  # a read that writes a file elsewhere
            assert "source" not in t.inputSchema.get("properties", {}), t.name


async def test_an_edit_never_reaches_live(workbench) -> None:  # noqa: F811
    async with mcp_client("character") as session:
        result, _ = await call_tool(
            session,
            "set_custom_title",
            character="Lady Amber Blaise",
            title="on the Workbench",
        )
    assert not result.isError
    assert payload_of(workbench)["character"]["custom_title"] == "on the Workbench"
    assert "custom_title" not in archive_live.read_live("42")["character"]


#: Calls that succeed on the fixture's character, one per kind of result.
CALLS: dict[str, dict[str, Any]] = {
    "set_description": {"text": "[b]Published, and edited.[/b]"},
    "edit_description": {"old_string": "Published", "new_string": "Edited"},
    "set_custom_title": {"title": "x"},
    "set_profile_settings": {"public": True},
    "set_kinks": {"items": [{"kink": "Rough Housing", "choice": "fave"}]},
    "add_custom_kink": {"name": "x"},
    "get_workbench": {"include": ["summary"]},
    "get_description": {},
    "list_profile_fields": {"only_set": True},
    "list_kinks": {},
    "list_images": {},
    "get_workbench_payload": {},
}


@pytest.mark.parametrize("tool_name", sorted(CALLS))
async def test_no_result_names_a_set(workbench, tool_name: str) -> None:  # noqa: F811
    async with mcp_client() as session:
        result, body = await call_tool(
            session, tool_name, character="Lady Amber Blaise", **CALLS[tool_name]
        )
    assert not result.isError, body
    assert "set" not in body


@pytest.mark.parametrize("suffix", ENDPOINTS)
async def test_the_instructions_describe_one_workbench_beside_live(
    workbench, suffix: str  # noqa: F811
) -> None:
    text = await server_instructions(suffix)
    for term in ("Live", "Workbench", "Backup", "Upload"):
        assert term in text, term
    assert not SET_AS_A_THING.search(text), SET_AS_A_THING.search(text)
    assert "working_set" not in text
    assert not re.search(r"\b(?:create|pick|choose|activate)\b[^.]*\bsets?\b", text, re.I)


@pytest.mark.parametrize("suffix", ENDPOINTS)
async def test_no_tool_description_speaks_of_sets(
    workbench, suffix: str  # noqa: F811
) -> None:
    async with mcp_client(suffix) as session:
        tools = (await session.list_tools()).tools
    for t in tools:
        found = SET_AS_A_THING.search(t.description or "")
        assert not found, (t.name, found)


async def test_the_raw_payload_tools_are_on_the_full_endpoint_only(
    workbench,  # noqa: F811
) -> None:
    for suffix in ENDPOINTS:
        async with mcp_client(suffix) as session:
            names = {t.name for t in (await session.list_tools()).tools}
        carried = {"get_workbench_payload", "put_workbench_payload"} & names
        assert carried == (
            {"get_workbench_payload", "put_workbench_payload"} if suffix == "" else set()
        ), suffix
        assert not {"get_working_set_payload", "put_working_set_payload"} & names


@pytest.mark.parametrize("tool_name", sorted(TAKES_SOURCE))
@pytest.mark.parametrize("ref", ["by name", "by id"])
async def test_a_set_name_or_id_is_refused_naming_the_workbench_and_live(
    workbench, tool_name: str, ref: str  # noqa: F811
) -> None:
    other_id = _old_archive_with_a_second_draft(workbench)
    before = payload_of(workbench)
    async with mcp_client() as session:
        result, _ = await call_tool(
            session,
            tool_name,
            character="Lady Amber Blaise",
            source="Main" if ref == "by name" else other_id,
            **TAKES_SOURCE[tool_name],
        )
    text = tool_error_text(result)
    _, found, message = text.partition("validation_failed: source: ")
    assert found, text
    assert "Workbench" in message and "'live'" in message, text
    assert payload_of(workbench) == before, "nothing may be written"


@pytest.mark.parametrize("tool_name", sorted(TAKES_SOURCE))
async def test_reading_live_of_a_character_never_pulled_is_refused(
    workbench, tool_name: str  # noqa: F811
) -> None:
    """There is no Live until a pull, and the refusal says to pull. The
    diff asks for both copies, and a character never pulled has no
    Workbench either: that is the side it names."""
    archive_registry.register_character("99", "Ghost")
    expected, extra = ("no_live", {})
    if tool_name == "diff_workbench":
        expected, extra = ("no_workbench", {"against": "workbench"})
    async with mcp_client() as session:
        result, _ = await call_tool(
            session,
            tool_name,
            character="Ghost",
            source="live",
            **{**TAKES_SOURCE[tool_name], **extra},
        )
    text = tool_error_text(result)
    assert f": {expected}: " in text, text
    assert "pull" in text.lower(), text


async def test_diff_against_a_set_name_is_refused(workbench) -> None:  # noqa: F811
    _old_archive_with_a_second_draft(workbench)
    async with mcp_client() as session:
        result, _ = await call_tool(
            session, "diff_workbench", character="Lady Amber Blaise", against="Main"
        )
    text = tool_error_text(result)
    _, found, message = text.partition("validation_failed: against: ")
    assert found, text
    assert "Workbench" in message and "'live'" in message, text


async def test_reading_and_editing_without_a_set_reference_use_the_workbench(
    workbench,  # noqa: F811
) -> None:
    """The omitted reference is the Workbench the window shows, and an
    old draft's name never comes back to the model."""
    _old_archive_with_a_second_draft(workbench)
    async with mcp_client("character") as session:
        _, wrote = await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="edited on the Workbench",
        )
        _, read = await call_tool(
            session, "get_description", character="Lady Amber Blaise"
        )
        _, live = await call_tool(
            session,
            "get_description",
            character="Lady Amber Blaise",
            source="live",
        )
    assert "set" not in wrote and "set" not in read
    assert read["read_only"] is False
    assert read["description"] == "edited on the Workbench"
    assert payload_of(workbench)["character"]["description"] == "edited on the Workbench"
    assert live["read_only"] is True
    assert live["description"] == "[b]Published.[/b]"


async def test_the_workbench_can_be_named_explicitly(workbench) -> None:  # noqa: F811
    """`workbench` names the same thing as leaving `source` out, so a
    diff can put Live on the left and the Workbench on the right."""
    async with mcp_client("character") as session:
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="mine",
            confirm=True,  # shorter than half of Live's description
        )
        _, body = await call_tool(
            session,
            "diff_workbench",
            character="Lady Amber Blaise",
            source="live",
            against="workbench",
        )
    assert body["from"] == "Workbench"
    assert body["to"] == "live"
    assert body["changes"]["description"]["changed"] is True


async def test_list_characters_does_not_count_drafts(workbench) -> None:  # noqa: F811
    _old_archive_with_a_second_draft(workbench)
    async with mcp_client() as session:
        _, body = await call_tool(session, "list_characters")
    row = next(c for c in body["characters"] if c["name"] == "Lady Amber Blaise")
    assert "working_sets" not in row
    assert "active_set" not in row


async def test_no_character_listing_counts_old_copies_of_live(workbench) -> None:  # noqa: F811
    old_copy = archive_registry.character_dir("42") / "snapshots" / "1000.json"
    old_copy.parent.mkdir()
    old_copy.write_text("{}", encoding="utf-8")
    async with mcp_client() as session:
        _, listed = await call_tool(session, "list_characters")
        _, status = await call_tool(session, "get_workbench_status")
    for rows in (listed["characters"], status["characters"]):
        row = next(c for c in rows if c["name"] == "Lady Amber Blaise")
        assert row["backup_count"] == 0
        assert not any("snapshot" in key for key in row)
