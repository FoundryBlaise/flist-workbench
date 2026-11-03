"""The MCP write tools (design §3.3–3.7, §4.2).

Phase-4 acceptance: a model can edit the Workbench, rewrite a description,
set fields and kinks and reorder a gallery — and every invariant the
renderer used to be solely responsible for is enforced here too, since
the sidecar is no longer talking only to the UI.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

import archive_live
import archive_workbench
from mcp_helpers import call_tool, mcp_client, tool_error_text
from test_mcp_reads import MAPPING
from workbench_state import put_workbench, workbench_payload


@pytest.fixture
def workbench(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib
    import json

    import archive_live
    import archive_registry
    import paths

    importlib.reload(paths)
    importlib.reload(archive_registry)

    cache = archive_registry.cache_root() / "mapping-list.json"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(MAPPING), encoding="utf-8")

    archive_registry.register_character("42", "Lady Amber Blaise")
    archive_live.write_live(
        "42",
        {
            "character": {
                "id": 42,
                "name": "Lady Amber Blaise",
                "description": "[b]Published.[/b]",
            },
            "infotags": {"2": "Human"},
            # F-list sends an empty *list* here, which is the shape the
            # payload rules have to cope with.
            "kinks": [],
            "custom_kinks": {},
            "inlines": {},
            "images": [],
            "fetched_at": 1700000000,
        },
    )

    import server
    from services import mapping as mapping_service

    mapping_service.invalidate()
    importlib.reload(server)
    yield
    mapping_service.invalidate()


def payload_of(archive) -> dict[str, Any]:
    """The workbench payload. There is one per character, so nothing to
    address it by."""
    bench = archive_workbench.read_workbench("42")
    assert bench is not None, "no workbench yet"
    return bench.payload


async def open_workbench(session) -> dict[str, Any]:
    """Read the character's Workbench, which seeds it from Live the
    first time, the way the window's first look does."""
    _, body = await call_tool(
        session, "get_workbench", character="Lady Amber Blaise"
    )
    return body


# ---- the workbench -----------------------------------------------------


async def test_the_workbench_starts_as_a_copy_of_live(workbench) -> None:
    async with mcp_client("character") as session:
        body = await open_workbench(session)
    assert body["read_only"] is False
    payload = payload_of(workbench)
    assert payload["character"]["description"] == "[b]Published.[/b]"


async def test_an_empty_kinks_list_from_flist_becomes_a_dict(
    workbench,
) -> None:
    """F-list serves `kinks: []`. Setting a key on a list produces a
    list with a named property, which doesn't survive JSON."""
    async with mcp_client("character") as session:
        await open_workbench(session)
        await call_tool(
            session,
            "set_kink",
            character="Lady Amber Blaise",
            kink="Rough Housing",
            choice="fave",
        )
    payload = payload_of(workbench)
    assert isinstance(payload["kinks"], dict)
    assert payload["kinks"] == {"100": "fave"}


async def test_live_is_never_writable(workbench) -> None:
    """An editing tool has no argument that could name Live: whatever
    it is called with, the edit lands in the Workbench."""
    async with mcp_client("character") as session:
        tools = {t.name: t for t in (await session.list_tools()).tools}
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="[b]Lands in the Workbench.[/b]",
        )
    assert "working_set" not in tools["set_description"].inputSchema["properties"]
    assert archive_live.read_live("42")["character"]["description"] == "[b]Published.[/b]"
    assert payload_of(workbench)["character"]["description"] == (
        "[b]Lands in the Workbench.[/b]"
    )


async def test_the_first_edit_makes_the_workbench(
    workbench,
) -> None:
    """An edit lands in the Workbench, made on the spot if this is the
    first edit. Refusing with "create one first" belonged to the era of
    several named copies; there is one now, and the window makes it
    without asking either."""
    assert archive_workbench.read_workbench("42") is None
    async with mcp_client("character") as session:
        result, _ = await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="written straight into the bench",
        )
        assert not result.isError
        _, read = await call_tool(
            session, "get_description", character="Lady Amber Blaise"
        )
    assert read["description"] == "written straight into the bench"
    # Live is untouched: editing never publishes.
    import archive_live

    live = archive_live.read_live("42")
    assert live["character"]["description"] == "[b]Published.[/b]"


# ---- description -------------------------------------------------------


async def test_set_description_normalises_line_endings(workbench) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="one\r\ntwo\rthree",
        )
    assert payload_of(workbench)["character"]["description"] == "one\ntwo\nthree"


async def test_edit_description_replaces_exactly_once(workbench) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="[b]The innkeeper[/b] waits by the door.",
        )
        _, body = await call_tool(
            session,
            "edit_description",
            character="Lady Amber Blaise",
            old_string="waits by the door",
            new_string="leans on the bar",
        )
        assert body["replacements"] == 1
        _, desc = await call_tool(
            session, "get_description", character="Lady Amber Blaise"
        )
    assert desc["description"] == "[b]The innkeeper[/b] leans on the bar."


async def test_edit_description_refuses_an_ambiguous_match(workbench) -> None:
    """The point of the exact-match edit: on a 30 KB description, a
    silent second replacement is invisible until the user publishes."""
    async with mcp_client("character") as session:
        await open_workbench(session)
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="the door. and again the door.",
        )
        result, _ = await call_tool(
            session,
            "edit_description",
            character="Lady Amber Blaise",
            old_string="the door",
            new_string="the gate",
        )
        text = tool_error_text(result)
        assert "appears 2 times" in text
        # Nothing was written.
        _, desc = await call_tool(
            session, "get_description", character="Lady Amber Blaise"
        )
    assert desc["description"] == "the door. and again the door."


async def test_edit_description_replace_all(workbench) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="the door. and again the door.",
        )
        _, body = await call_tool(
            session,
            "edit_description",
            character="Lady Amber Blaise",
            old_string="the door",
            new_string="the gate",
            replace_all=True,
        )
    assert body["replacements"] == 2
    assert payload_of(workbench)["character"]["description"] == (
        "the gate. and again the gate."
    )


async def test_edit_description_says_how_to_recover_from_a_miss(
    workbench,
) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        result, _ = await call_tool(
            session,
            "edit_description",
            character="Lady Amber Blaise",
            old_string="not in there",
            new_string="x",
        )
    assert "get_description" in tool_error_text(result)


async def test_append_description_starts_a_new_line(workbench) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="first",
            confirm=True,  # shorter than half of Live's description
        )
        await call_tool(
            session, "append_description", character="Lady Amber Blaise", text="second"
        )
    assert payload_of(workbench)["character"]["description"] == "first\nsecond"


# ---- overlay -----------------------------------------------------------


async def test_every_edit_records_its_path_in_the_overlay(workbench) -> None:
    """`_overlay` is what stops the next pull from reverting an edit, so
    an edit that doesn't extend it is silently undone later."""
    async with mcp_client("character") as session:
        await open_workbench(session)
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="mine",
            confirm=True,  # shorter than half of Live's description
        )
        await call_tool(
            session,
            "set_profile_field",
            character="Lady Amber Blaise",
            field="Species",
            value="Elf",
        )
        await call_tool(
            session,
            "set_kink",
            character="Lady Amber Blaise",
            kink="Rough Housing",
            choice="yes",
        )
    overlay = set(payload_of(workbench)["_overlay"])
    assert "character.description" in overlay
    assert "infotags.2" in overlay
    assert "kinks.100" in overlay


# ---- profile fields ----------------------------------------------------


async def test_set_profile_field_by_label(workbench) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        _, body = await call_tool(
            session,
            "set_profile_field",
            character="Lady Amber Blaise",
            field="Species",
            value="Elf",
        )
    assert body["field"] == "Species"
    assert payload_of(workbench)["infotags"]["2"] == "Elf"


async def test_a_dropdown_accepts_the_option_label_and_stores_the_id(
    workbench,
) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        _, body = await call_tool(
            session,
            "set_profile_field",
            character="Lady Amber Blaise",
            field="Orientation",
            value="Bisexual",
        )
    assert body["stored_as"] == "11"
    assert payload_of(workbench)["infotags"]["3"] == "11"


async def test_a_dropdown_refuses_an_unlisted_value_with_the_options(
    workbench,
) -> None:
    """A value F-list doesn't recognise is dropped on upload, so it has
    to fail loudly here rather than look saved."""
    async with mcp_client("character") as session:
        await open_workbench(session)
        result, _ = await call_tool(
            session,
            "set_profile_field",
            character="Lady Amber Blaise",
            field="Orientation",
            value="Undecided-ish",
        )
    text = tool_error_text(result)
    assert "validation_failed" in text
    assert "Straight" in text and "Bisexual" in text


async def test_a_number_field_refuses_prose(workbench) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        result, _ = await call_tool(
            session,
            "set_profile_field",
            character="Lady Amber Blaise",
            field="Height",
            value="quite tall",
        )
    assert "not a number" in tool_error_text(result)


async def test_a_field_the_mapping_list_does_not_describe_is_refused(
    workbench,
) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        result, _ = await call_tool(
            session,
            "set_profile_field",
            character="Lady Amber Blaise",
            field="Mystery",
            value="anything",
        )
    assert "dropped when the profile is uploaded" in tool_error_text(result)


async def test_an_unknown_field_name_points_at_the_list(workbench) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        result, _ = await call_tool(
            session,
            "set_profile_field",
            character="Lady Amber Blaise",
            field="Favourite Biscuit",
            value="digestive",
        )
    text = tool_error_text(result)
    assert "field_not_found" in text
    assert "list_profile_fields" in text


async def test_clearing_a_field_removes_the_key(workbench) -> None:
    """Not the same as writing an empty string, which publishes an
    empty field."""
    async with mcp_client("character") as session:
        await open_workbench(session)
        await call_tool(
            session,
            "set_profile_field",
            character="Lady Amber Blaise",
            field="Species",
            value="Elf",
        )
        _, body = await call_tool(
            session,
            "clear_profile_field",
            character="Lady Amber Blaise",
            field="Species",
        )
    assert body["was_set"] is True
    assert "2" not in payload_of(workbench)["infotags"]


async def test_setting_a_field_to_an_empty_string_is_refused(workbench) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        result, _ = await call_tool(
            session,
            "set_profile_field",
            character="Lady Amber Blaise",
            field="Species",
            value="",
        )
    assert "clear_profile_field" in tool_error_text(result)


# ---- kinks -------------------------------------------------------------


async def test_undecided_removes_the_kink_entry(workbench) -> None:
    """F-list has no "undecided" value — the absence of an entry is
    what means no opinion."""
    async with mcp_client("character") as session:
        await open_workbench(session)
        await call_tool(
            session,
            "set_kink",
            character="Lady Amber Blaise",
            kink="Rough Housing",
            choice="fave",
        )
        await call_tool(
            session,
            "set_kink",
            character="Lady Amber Blaise",
            kink="Rough Housing",
            choice="undecided",
        )
    assert payload_of(workbench)["kinks"] == {}


async def test_an_invalid_choice_lists_the_valid_ones(workbench) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        result, _ = await call_tool(
            session,
            "set_kink",
            character="Lady Amber Blaise",
            kink="Rough Housing",
            choice="sure why not",
        )
    text = tool_error_text(result)
    assert "fave" in text and "maybe" in text


async def test_set_kinks_validates_everything_before_writing(workbench) -> None:
    """A partial write would leave the set in a state the caller didn't
    ask for and can't easily tell from success."""
    async with mcp_client("character") as session:
        await open_workbench(session)
        result, _ = await call_tool(
            session,
            "set_kinks",
            character="Lady Amber Blaise",
            items=[
                {"kink": "Rough Housing", "choice": "fave"},
                {"kink": "Nonexistent Kink", "choice": "yes"},
            ],
        )
        assert "nothing was written" in tool_error_text(result)
    assert payload_of(workbench).get("kinks", {}) == {}


async def test_set_kinks_writes_a_valid_batch(workbench) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        _, body = await call_tool(
            session,
            "set_kinks",
            character="Lady Amber Blaise",
            items=[
                {"kink": "Rough Housing", "choice": "fave"},
                {"kink": "Long Walks", "choice": "no"},
            ],
        )
    assert len(body["updated"]) == 2
    assert payload_of(workbench)["kinks"] == {"100": "fave", "101": "no"}


# ---- custom kinks ------------------------------------------------------


async def test_a_new_custom_kink_gets_a_local_id_and_joins_the_order(
    workbench,
) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        _, body = await call_tool(
            session,
            "add_custom_kink",
            character="Lady Amber Blaise",
            name="Thunderstorms",
            description="the sound, mostly",
            choice="fave",
        )
    assert body["id"].startswith("local:")
    payload = payload_of(workbench)
    assert payload["custom_kinks"][body["id"]]["name"] == "Thunderstorms"
    assert payload["_custom_kinks_order"] == [body["id"]]


async def test_deleting_a_local_custom_kink_drops_it_outright(
    workbench,
) -> None:
    """It was never uploaded, so there is nothing for the exporter to
    remove — a tombstone would just be noise."""
    async with mcp_client("character") as session:
        await open_workbench(session)
        _, added = await call_tool(
            session,
            "add_custom_kink",
            character="Lady Amber Blaise",
            name="Thunderstorms",
        )
        _, deleted = await call_tool(
            session,
            "delete_custom_kink",
            character="Lady Amber Blaise",
            kink_id=added["id"],
            confirm=True,
        )
    assert deleted["outcome"] == "dropped"
    assert deleted["restorable"] is False
    payload = payload_of(workbench)
    assert added["id"] not in payload["custom_kinks"]
    assert payload["_custom_kinks_order"] == []
    # The overlay entries went with it, or a later reset would
    # resurrect the id as an empty stub.
    assert not any(added["id"] in p for p in payload["_overlay"])


async def test_deleting_an_flist_side_custom_kink_leaves_a_tombstone(
    workbench,
) -> None:
    """The tombstone is how the exporter knows to remove it from the
    published profile."""
    async with mcp_client("character") as session:
        await open_workbench(session)
        payload = workbench_payload("42")
        payload["custom_kinks"] = {
            "7788": {"name": "From F-list", "description": "", "choice": "yes"}
        }
        put_workbench("42", payload)

        _, deleted = await call_tool(
            session,
            "delete_custom_kink",
            character="Lady Amber Blaise",
            kink_id="7788",
            confirm=True,
        )
        assert deleted["outcome"] == "tombstoned"
        assert deleted["restorable"] is True

        _, listed = await call_tool(
            session, "list_kinks", character="Lady Amber Blaise"
        )
        assert listed["custom_kinks"] == []

        await call_tool(
            session,
            "restore_custom_kink",
            character="Lady Amber Blaise",
            kink_id="7788",
        )
        _, restored = await call_tool(
            session, "list_kinks", character="Lady Amber Blaise"
        )
    assert [c["name"] for c in restored["custom_kinks"]] == ["From F-list"]


async def test_restoring_a_dropped_local_kink_explains_it_is_gone(
    workbench,
) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        result, _ = await call_tool(
            session,
            "restore_custom_kink",
            character="Lady Amber Blaise",
            kink_id="local:never-existed",
        )
    assert "gone for good" in tool_error_text(result)


async def test_reorder_custom_kinks_requires_the_complete_list(
    workbench,
) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        _, a = await call_tool(
            session, "add_custom_kink", character="Lady Amber Blaise", name="A"
        )
        _, b = await call_tool(
            session, "add_custom_kink", character="Lady Amber Blaise", name="B"
        )
        result, _ = await call_tool(
            session,
            "reorder_custom_kinks",
            character="Lady Amber Blaise",
            kink_ids=[a["id"]],
        )
        assert "must list every custom kink" in tool_error_text(result)

        await call_tool(
            session,
            "reorder_custom_kinks",
            character="Lady Amber Blaise",
            kink_ids=[b["id"], a["id"]],
        )
    assert payload_of(workbench)["_custom_kinks_order"] == [b["id"], a["id"]]


# ---- gallery -----------------------------------------------------------


def seed_gallery(archive, image_ids: list[str]) -> None:
    payload = workbench_payload("42")
    payload["images"] = [
        {"image_id": i, "description": "", "sort_order": n}
        for n, i in enumerate(image_ids)
    ]
    put_workbench("42", payload)


async def test_reordering_the_gallery_renumbers_from_zero(workbench) -> None:
    """F-list renders by sort_order, so a gap silently reorders the
    profile."""
    async with mcp_client("character") as session:
        await open_workbench(session)
        seed_gallery(workbench, ["1", "2", "3"])
        await call_tool(
            session,
            "reorder_images",
            character="Lady Amber Blaise",
            image_ids=["3", "1", "2"],
        )
    rows = payload_of(workbench)["images"]
    assert [(r["image_id"], r["sort_order"]) for r in rows] == [
        ("3", 0),
        ("1", 1),
        ("2", 2),
    ]


async def test_removing_an_image_closes_the_gap_in_sort_order(
    workbench,
) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        seed_gallery(workbench, ["1", "2", "3"])
        _, body = await call_tool(
            session, "remove_image", character="Lady Amber Blaise", image_id="2"
        )
        assert body["file_trashed"] is False
    rows = payload_of(workbench)["images"]
    assert [(r["image_id"], r["sort_order"]) for r in rows] == [("1", 0), ("3", 1)]


async def test_reordering_refuses_a_partial_list(workbench) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        seed_gallery(workbench, ["1", "2", "3"])
        result, _ = await call_tool(
            session,
            "reorder_images",
            character="Lady Amber Blaise",
            image_ids=["3", "1"],
        )
    assert "must list every image" in tool_error_text(result)


async def test_captioning_an_image_that_is_not_on_the_profile(
    workbench,
) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        seed_gallery(workbench, ["1"])
        result, _ = await call_tool(
            session,
            "set_image_description",
            character="Lady Amber Blaise",
            image_id="99",
            description="x",
        )
    assert "list_images" in tool_error_text(result)


async def test_adding_an_image_that_is_not_on_disk(workbench) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        result, _ = await call_tool(
            session, "add_image", character="Lady Amber Blaise", image_id="404"
        )
    assert "image_not_found" in tool_error_text(result)


# ---- profile settings --------------------------------------------------


async def test_profile_settings_round_trip(workbench) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        _, body = await call_tool(
            session,
            "set_profile_settings",
            character="Lady Amber Blaise",
            public=True,
            guestbook=False,
        )
    assert body["settings"]["public"] is True
    assert body["settings"]["guestbook"] is False
    # Untouched switches stay absent rather than being defaulted.
    assert "show_friends" not in body["settings"]


async def test_profile_settings_needs_at_least_one(workbench) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        result, _ = await call_tool(
            session, "set_profile_settings", character="Lady Amber Blaise"
        )
    assert "no settings given" in tool_error_text(result)


# ---- raw payload -------------------------------------------------------


async def test_raw_payload_write_needs_confirmation(workbench) -> None:
    async with mcp_client() as session:
        await open_workbench(session)
        result, _ = await call_tool(
            session,
            "put_workbench_payload",
            character="Lady Amber Blaise",
            payload={"_overlay": [], "character": {"description": "raw"}},
        )
    text = tool_error_text(result)
    assert "confirm_required" in text
    assert "targeted tools" in text


async def test_raw_payload_round_trips_with_its_etag(workbench) -> None:
    async with mcp_client() as session:
        await open_workbench(session)
        _, read = await call_tool(
            session, "get_workbench_payload", character="Lady Amber Blaise"
        )
        body = read["payload"]
        body["character"]["description"] = "written raw"
        _, written = await call_tool(
            session,
            "put_workbench_payload",
            character="Lady Amber Blaise",
            payload=body,
            if_match=read["etag"],
            confirm=True,
        )
        assert written["etag"] != read["etag"]

        # A second write with the stale etag must be refused.
        result, _ = await call_tool(
            session,
            "put_workbench_payload",
            character="Lady Amber Blaise",
            payload=body,
            if_match=read["etag"],
            confirm=True,
        )
    assert "etag_mismatch" in tool_error_text(result)


# ---- annotations -------------------------------------------------------


async def test_destructive_tools_are_annotated_as_such() -> None:
    async with mcp_client() as session:
        tools = {t.name: t for t in (await session.list_tools()).tools}
    for name in (
        "delete_custom_kink",
        "put_workbench_payload",
        "load_backup_into_workbench",
    ):
        assert tools[name].annotations.destructiveHint is True, name
    assert tools["set_description"].annotations.readOnlyHint is False


async def test_write_tools_say_workbench_does_not_publish(workbench) -> None:
    """A model must never tell the user a change is live on F-list."""
    async with mcp_client("character") as session:
        await open_workbench(session)
        _, body = await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="x",
            confirm=True,  # shorter than half of Live's description
        )
    assert "Nothing was published to F-list" in body["not_published"]


# ---- BBCode F-list would refuse -----------------------------------------
#
# The site parses BBCode in the browser and rejects some nestings; a
# profile that trips it cannot be uploaded. A model finding that out
# from the site, after the user has already left the app, is the
# failure this prevents — so the write itself refuses, and says what to
# write instead.


async def test_a_description_f_list_would_reject_is_refused(workbench) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        result, _ = await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="[big][b][color=cyan]Athali[/color][/b][/big]",
        )
    text = tool_error_text(result)
    assert "bbcode_rejected" in text
    assert "The [color] tag is not allowed here" in text
    # The refusal has to carry the fix, or the model just tries again.
    assert "[color=cyan][big][b]" in text


async def test_the_refused_text_was_not_written(workbench) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="a perfectly ordinary description",
        )
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="[sub][color=gray]nope[/color][/sub]",
        )
        _, body = await call_tool(
            session, "get_description", character="Lady Amber Blaise"
        )
    assert body["description"] == "a perfectly ordinary description"


async def test_the_same_markup_with_the_colour_outside_goes_through(
    workbench,
) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        _, body = await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="[color=cyan][big][b]Athali[/b][/big][/color]",
        )
    assert body["length"] == len("[color=cyan][big][b]Athali[/b][/big][/color]")


async def test_appending_something_invalid_is_refused_too(workbench) -> None:
    async with mcp_client("character") as session:
        await open_workbench(session)
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="An opening paragraph.",
        )
        result, _ = await call_tool(
            session,
            "append_description",
            character="Lady Amber Blaise",
            text="[big][i][color=red]and this[/color][/i][/big]",
        )
    assert "not allowed here" in tool_error_text(result)
