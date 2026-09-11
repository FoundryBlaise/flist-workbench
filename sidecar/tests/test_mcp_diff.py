"""`diff_working_set` — what would change if this were published.

Structural rather than textual (design D6): a model needs facts it can
act on, not a side-by-side rendering.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from mcp_helpers import call_tool, mcp_client, tool_error_text
from test_mcp_reads import MAPPING


@pytest.fixture
def workbench(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import character_archive
    import paths

    importlib.reload(paths)
    importlib.reload(character_archive)

    cache = character_archive.cache_root() / "mapping-list.json"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(MAPPING), encoding="utf-8")

    character_archive.register_character("42", "Lady Amber Blaise")
    character_archive.write_live(
        "42",
        {
            "character": {
                "id": 42,
                "name": "Lady Amber Blaise",
                "description": "Published text.",
                "custom_title": "Innkeeper",
            },
            "infotags": {"2": "Human", "3": "10"},
            "kinks": {"100": "yes"},
            "custom_kinks": {
                "7788": {"name": "Old favourite", "description": "", "choice": "fave"}
            },
            "inlines": {},
            "images": [
                {"image_id": "1", "description": "", "sort_order": 0},
                {"image_id": "2", "description": "", "sort_order": 1},
            ],
            "fetched_at": 1700000000,
        },
    )

    import server
    from services import mapping as mapping_service

    mapping_service.invalidate()
    importlib.reload(server)
    yield character_archive
    mapping_service.invalidate()


async def draft(session, name: str = "Draft") -> None:
    await call_tool(
        session, "create_working_set", character="Lady Amber Blaise", name=name
    )


async def test_an_untouched_draft_matches_live(workbench) -> None:
    async with mcp_client("character") as session:
        await draft(session)
        _, body = await call_tool(
            session, "diff_working_set", character="Lady Amber Blaise"
        )
    assert body["changes"] == {"identical": True}
    assert "matches live exactly" in body["note"]


async def test_a_field_change_names_the_field_and_the_option(
    workbench,
) -> None:
    async with mcp_client("character") as session:
        await draft(session)
        await call_tool(
            session,
            "set_profile_field",
            character="Lady Amber Blaise",
            field="Species",
            value="Elf",
        )
        await call_tool(
            session,
            "set_profile_field",
            character="Lady Amber Blaise",
            field="Orientation",
            value="Gay",
        )
        _, body = await call_tool(
            session, "diff_working_set", character="Lady Amber Blaise"
        )
    changes = {c["field"]: c for c in body["changes"]["profile_fields"]}
    assert changes["Species"] == {
        "field": "Species",
        "before": "Human",
        "after": "Elf",
    }
    # A list field stores an id; the diff has to show what a human
    # would read on the profile.
    assert changes["Orientation"]["before"] == "Straight"
    assert changes["Orientation"]["after"] == "Gay"


async def test_the_description_is_summarised_not_diffed(workbench) -> None:
    """Two 30 KB BBCode blobs in a tool result help nobody."""
    async with mcp_client("character") as session:
        await draft(session)
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="Published text. And quite a lot more besides.",
        )
        _, body = await call_tool(
            session, "diff_working_set", character="Lady Amber Blaise"
        )
    description = body["changes"]["description"]
    assert description["changed"] is True
    assert description["delta_chars"] == len(" And quite a lot more besides.")
    assert "get_description" in description["note"]


async def test_kink_changes_use_names_and_name_the_undecided_state(
    workbench,
) -> None:
    async with mcp_client("character") as session:
        await draft(session)
        await call_tool(
            session,
            "set_kink",
            character="Lady Amber Blaise",
            kink="Rough Housing",
            choice="undecided",
        )
        await call_tool(
            session,
            "set_kink",
            character="Lady Amber Blaise",
            kink="Long Walks",
            choice="fave",
        )
        _, body = await call_tool(
            session, "diff_working_set", character="Lady Amber Blaise"
        )
    changes = {c["field"]: c for c in body["changes"]["kinks"]}
    assert changes["Rough Housing"]["after"] == "undecided"
    assert changes["Long Walks"] == {
        "field": "Long Walks",
        "before": "undecided",
        "after": "fave",
    }


async def test_custom_kink_changes_are_classified(workbench) -> None:
    async with mcp_client("character") as session:
        await draft(session)
        await call_tool(
            session,
            "add_custom_kink",
            character="Lady Amber Blaise",
            name="Thunderstorms",
        )
        await call_tool(
            session,
            "delete_custom_kink",
            character="Lady Amber Blaise",
            kink_id="7788",
        )
        _, body = await call_tool(
            session, "diff_working_set", character="Lady Amber Blaise"
        )
    by_change = {c["change"]: c for c in body["changes"]["custom_kinks"]}
    assert by_change["added"]["name"] == "Thunderstorms"
    assert by_change["removed"]["name"] == "Old favourite"


async def test_a_gallery_reorder_is_called_out_as_such(workbench) -> None:
    """Same images, different order still changes the profile page."""
    async with mcp_client("character") as session:
        await draft(session)
        await call_tool(
            session,
            "reorder_images",
            character="Lady Amber Blaise",
            image_ids=["2", "1"],
        )
        _, body = await call_tool(
            session, "diff_working_set", character="Lady Amber Blaise"
        )
    images = body["changes"]["images"]
    assert images["reordered"] is True
    assert images["order_after"] == ["2", "1"]
    assert "added" not in images


async def test_a_removed_image_is_listed(workbench) -> None:
    async with mcp_client("character") as session:
        await draft(session)
        await call_tool(
            session, "remove_image", character="Lady Amber Blaise", image_id="1"
        )
        _, body = await call_tool(
            session, "diff_working_set", character="Lady Amber Blaise"
        )
    assert body["changes"]["images"]["removed"] == ["1"]


async def test_two_drafts_can_be_compared(workbench) -> None:
    async with mcp_client("character") as session:
        await draft(session, "Main")
        await call_tool(
            session, "set_description", character="Lady Amber Blaise", text="one"
        )
        await draft(session, "AU")
        await call_tool(
            session, "set_description", character="Lady Amber Blaise", text="two"
        )
        _, body = await call_tool(
            session,
            "diff_working_set",
            character="Lady Amber Blaise",
            working_set="AU",
            against="Main",
        )
    assert body["from"] == "Main"
    assert body["to"] == "AU"
    assert body["changes"]["description"]["changed"] is True


async def test_comparing_a_set_with_itself_is_refused(workbench) -> None:
    async with mcp_client("character") as session:
        await draft(session, "Main")
        result, _ = await call_tool(
            session,
            "diff_working_set",
            character="Lady Amber Blaise",
            working_set="Main",
            against="Main",
        )
    assert "nothing to compare" in tool_error_text(result)


async def test_the_custom_title_change_is_reported(workbench) -> None:
    async with mcp_client("character") as session:
        await draft(session)
        await call_tool(
            session,
            "set_custom_title",
            character="Lady Amber Blaise",
            title="Landlady",
        )
        _, body = await call_tool(
            session, "diff_working_set", character="Lady Amber Blaise"
        )
    assert body["changes"]["custom_title"] == {
        "field": "custom_title",
        "before": "Innkeeper",
        "after": "Landlady",
    }
