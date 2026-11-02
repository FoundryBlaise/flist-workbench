"""MCP sees one Workbench beside Live (spec #3, ticket #52).

A model connected over MCP sees what the window shows: each character
has one Workbench and its Live. The tools that listed, named, picked,
deleted, packed or unpacked several drafts, the addressing explainer
and the tool listing pull history are gone, and a tool that takes
`working_set` accepts only the Workbench (omitted) or Live.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

import pytest

from mcp_helpers import call_tool, mcp_client, tool_error_text
from test_mcp_edit import payload_of, workbench  # noqa: F401 — the fixture

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
)

#: Every tool that takes `working_set`, with the least it needs besides.
#: Listed rather than discovered so a new tool with the parameter has to
#: be added here, and so is held to the same refusal.
TAKES_WORKING_SET: dict[str, dict[str, Any]] = {
    "get_working_set": {},
    "get_description": {},
    "list_profile_fields": {},
    "list_kinks": {},
    "list_images": {},
    "diff_working_set": {},
    "get_working_set_payload": {},
    "render_profile_image": {},
    # Outside the source tree: a call that is wrongly let through must
    # not leave a zip behind in the checkout.
    "export_restore_zip": {"path": str(Path(tempfile.gettempdir()) / "never-written.zip")},
    "set_description": {"text": "x"},
    "edit_description": {"old_string": "a", "new_string": "b"},
    "append_description": {"text": "x"},
    "set_custom_title": {"title": "x"},
    "set_profile_field": {"field": "Species", "value": "Elf"},
    "clear_profile_field": {"field": "Species"},
    "set_profile_settings": {},
    "set_kink": {"kink": "Rough Housing", "choice": "fave"},
    "set_kinks": {"items": [{"kink": "Rough Housing", "choice": "fave"}]},
    "add_custom_kink": {"name": "x"},
    "update_custom_kink": {"kink_id": "1"},
    "delete_custom_kink": {"kink_id": "1", "confirm": True},
    "restore_custom_kink": {"kink_id": "1"},
    "reorder_custom_kinks": {"kink_ids": ["1"]},
    "set_image_description": {"image_id": "1", "description": "x"},
    "reorder_images": {"image_ids": ["1"]},
    "remove_image": {"image_id": "1"},
    "add_image": {"image_id": "1"},
    "import_images": {"items": [{"source_path": "C:/nowhere/a.png"}]},
    "import_image": {"source_path": "C:/nowhere/a.png"},
    "put_working_set_payload": {"payload": {}, "confirm": True},
}


def _old_archive_with_a_second_draft(archive) -> str:
    """The Workbench, and the id a second draft had in an older version
    (since moved into a Backup at startup). Returns that id."""
    archive.read_workbench("42", create=True)
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


async def test_the_tools_taking_working_set_are_the_ones_listed_here(
    workbench,  # noqa: F811
) -> None:
    async with mcp_client() as session:
        tools = (await session.list_tools()).tools
    taking = {
        t.name for t in tools if "working_set" in t.inputSchema.get("properties", {})
    }
    assert taking == set(TAKES_WORKING_SET)


@pytest.mark.parametrize("tool_name", sorted(TAKES_WORKING_SET))
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
            working_set="Main" if ref == "by name" else other_id,
            **TAKES_WORKING_SET[tool_name],
        )
    text = tool_error_text(result)
    _, found, message = text.partition("validation_failed: working_set: ")
    assert found, text
    assert "Workbench" in message and "'live'" in message, text
    assert payload_of(workbench) == before, "nothing may be written"


async def test_diff_against_a_set_name_is_refused(workbench) -> None:  # noqa: F811
    _old_archive_with_a_second_draft(workbench)
    async with mcp_client() as session:
        result, _ = await call_tool(
            session, "diff_working_set", character="Lady Amber Blaise", against="Main"
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
            working_set="live",
        )
    assert wrote["set"] == read["set"] == "Workbench"
    assert read["description"] == "edited on the Workbench"
    assert payload_of(workbench)["character"]["description"] == "edited on the Workbench"
    assert live["read_only"] is True
    assert live["description"] == "[b]Published.[/b]"


async def test_the_workbench_can_be_named_explicitly(workbench) -> None:  # noqa: F811
    """`workbench` names the same thing as leaving the parameter out, so
    a diff can put Live on the left and the Workbench on the right."""
    async with mcp_client("character") as session:
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            working_set="workbench",
            text="mine",
        )
        _, body = await call_tool(
            session,
            "diff_working_set",
            character="Lady Amber Blaise",
            working_set="live",
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
    old_copy = workbench.character_dir("42") / "snapshots" / "1000.json"
    old_copy.parent.mkdir()
    old_copy.write_text("{}", encoding="utf-8")
    async with mcp_client() as session:
        _, listed = await call_tool(session, "list_characters")
        _, status = await call_tool(session, "get_workbench_status")
    for rows in (listed["characters"], status["characters"]):
        row = next(c for c in rows if c["name"] == "Lady Amber Blaise")
        assert row["backup_count"] == 0
        assert not any("snapshot" in key for key in row)
