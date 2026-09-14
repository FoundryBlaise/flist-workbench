"""The MCP write tools (design §3.3–3.7, §4.2).

Phase-4 acceptance: a model can create a draft, rewrite a description,
set fields and kinks and reorder a gallery — and every invariant the
renderer used to be solely responsible for is enforced here too, since
the sidecar is no longer talking only to the UI.
"""

from __future__ import annotations

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
    import json

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
    yield character_archive
    mapping_service.invalidate()


def payload_of(archive) -> dict[str, Any]:
    """The workbench payload. There is one per character, so nothing to
    address it by."""
    bench = archive.resolve_workbench("42", create=False)
    assert bench is not None, "no workbench yet"
    return archive.read_set_payload("42", bench.id) or {}


async def make_draft(session, name: str | None = None) -> dict[str, Any]:
    """Open the character's workbench. `name` is accepted and ignored,
    the way the tool itself now does."""
    _, body = await call_tool(
        session, "create_working_set", character="Lady Amber Blaise", name=name
    )
    return body


# ---- the workbench -----------------------------------------------------


async def test_the_workbench_starts_as_a_copy_of_live(workbench) -> None:
    async with mcp_client("character") as session:
        body = await make_draft(session)
        assert body["active"] is True
        assert body["created"] is True
        assert body["set"] == workbench.WORKBENCH_SET_NAME
        _, sets = await call_tool(
            session, "list_working_sets", character="Lady Amber Blaise"
        )
    assert sets["active_set"] == workbench.WORKBENCH_SET_NAME
    payload = payload_of(workbench)
    assert payload["character"]["description"] == "[b]Published.[/b]"


async def test_opening_the_workbench_twice_returns_the_same_one(
    workbench,
) -> None:
    """A character has one bench, so this is safe to call before editing
    without checking first — which is why it does not need a name and
    cannot make a second."""
    async with mcp_client("character") as session:
        first = await make_draft(session)
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="my unpublished edit",
        )
        second = await make_draft(session, "Something Else")

        assert second["set_id"] == first["set_id"]
        assert second["created"] is False
        assert "already existed and is unchanged" in second["note"]

        _, desc = await call_tool(
            session, "get_description", character="Lady Amber Blaise"
        )
        _, sets = await call_tool(
            session, "list_working_sets", character="Lady Amber Blaise"
        )
    assert desc["description"] == "my unpublished edit", "edits must survive"
    assert len(sets["sets"]) == 1


async def test_an_empty_kinks_list_from_flist_becomes_a_dict(
    workbench,
) -> None:
    """F-list serves `kinks: []`. Setting a key on a list produces a
    list with a named property, which doesn't survive JSON."""
    async with mcp_client("character") as session:
        await make_draft(session)
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


async def test_the_old_source_argument_cannot_branch_a_second_draft(
    workbench,
) -> None:
    """`source` used to accept live / set:<name> / backup:<file> and
    produce another draft each time. It is accepted and ignored now, so
    a caller written against the old contract gets the bench rather than
    a surprise second copy."""
    async with mcp_client("character") as session:
        await make_draft(session)
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="edited on the bench",
        )
        for source in ("set:Workbench", "backup:whatever.zip", "magic"):
            _, body = await call_tool(
                session,
                "create_working_set",
                character="Lady Amber Blaise",
                name="AU",
                source=source,
            )
            assert body["set"] == workbench.WORKBENCH_SET_NAME
        _, sets = await call_tool(
            session, "list_working_sets", character="Lady Amber Blaise"
        )
        _, desc = await call_tool(
            session, "get_description", character="Lady Amber Blaise"
        )
    assert len(sets["sets"]) == 1
    assert desc["description"] == "edited on the bench"


async def test_deleting_a_set_needs_confirmation(workbench) -> None:
    """Kept for the drafts an older version left behind — deleting a
    character's only bench discards unpublished edits and gains nothing,
    since the next call recreates it from Live."""
    async with mcp_client("character") as session:
        bench = await make_draft(session)
        result, _ = await call_tool(
            session,
            "delete_working_set",
            character="Lady Amber Blaise",
            working_set=bench["set"],
        )
        assert "confirm_required" in tool_error_text(result)

        _, body = await call_tool(
            session,
            "delete_working_set",
            character="Lady Amber Blaise",
            working_set=bench["set"],
            confirm=True,
        )
    assert body["remaining_sets"] == []


async def test_live_is_never_writable(workbench) -> None:
    async with mcp_client("character") as session:
        await make_draft(session)
        result, _ = await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            working_set="live",
            text="should not land",
        )
    text = tool_error_text(result)
    assert "live_is_read_only" in text
    assert workbench.read_live("42")["character"]["description"] == "[b]Published.[/b]"


async def test_editing_without_naming_a_set_lands_in_the_workbench(
    workbench,
) -> None:
    """No set named means the Workbench, created on the spot if this is
    the first edit. Refusing with "create one first" belonged to the
    era of several named sets; there is one now, and the window makes
    it without asking either."""
    async with mcp_client("character") as session:
        _, body = await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="written straight into the bench",
        )
        assert body["set"] == "Workbench"
        _, read = await call_tool(
            session, "get_description", character="Lady Amber Blaise"
        )
    assert read["description"] == "written straight into the bench"
    # Live is untouched: editing never publishes.
    import character_archive

    live = character_archive.read_live("42")
    assert live["character"]["description"] == "[b]Published.[/b]"


# ---- description -------------------------------------------------------


async def test_set_description_normalises_line_endings(workbench) -> None:
    async with mcp_client("character") as session:
        await make_draft(session)
        await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="one\r\ntwo\rthree",
        )
    assert payload_of(workbench)["character"]["description"] == "one\ntwo\nthree"


async def test_edit_description_replaces_exactly_once(workbench) -> None:
    async with mcp_client("character") as session:
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
        await call_tool(
            session, "set_description", character="Lady Amber Blaise", text="first"
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
        await make_draft(session)
        await call_tool(
            session, "set_description", character="Lady Amber Blaise", text="mine"
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
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
        meta = next(m for m in workbench.list_sets("42"))
        payload = workbench.read_set_payload("42", meta.id)
        payload["custom_kinks"] = {
            "7788": {"name": "From F-list", "description": "", "choice": "yes"}
        }
        workbench.write_set_payload("42", meta.id, payload, expected_etag=None)

        _, deleted = await call_tool(
            session,
            "delete_custom_kink",
            character="Lady Amber Blaise",
            kink_id="7788",
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
        await make_draft(session)
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
        await make_draft(session)
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
    meta = next(m for m in archive.list_sets("42"))
    payload = archive.read_set_payload("42", meta.id)
    payload["images"] = [
        {"image_id": i, "description": "", "sort_order": n}
        for n, i in enumerate(image_ids)
    ]
    archive.write_set_payload("42", meta.id, payload, expected_etag=None)


async def test_reordering_the_gallery_renumbers_from_zero(workbench) -> None:
    """F-list renders by sort_order, so a gap silently reorders the
    profile."""
    async with mcp_client("character") as session:
        await make_draft(session)
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
        await make_draft(session)
        seed_gallery(workbench, ["1", "2", "3"])
        _, body = await call_tool(
            session, "remove_image", character="Lady Amber Blaise", image_id="2"
        )
        assert body["file_deleted"] is False
    rows = payload_of(workbench)["images"]
    assert [(r["image_id"], r["sort_order"]) for r in rows] == [("1", 0), ("3", 1)]


async def test_reordering_refuses_a_partial_list(workbench) -> None:
    async with mcp_client("character") as session:
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
        result, _ = await call_tool(
            session, "add_image", character="Lady Amber Blaise", image_id="404"
        )
    assert "image_not_found" in tool_error_text(result)


# ---- profile settings --------------------------------------------------


async def test_profile_settings_round_trip(workbench) -> None:
    async with mcp_client("character") as session:
        await make_draft(session)
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
        await make_draft(session)
        result, _ = await call_tool(
            session, "set_profile_settings", character="Lady Amber Blaise"
        )
    assert "no settings given" in tool_error_text(result)


# ---- raw payload -------------------------------------------------------


async def test_raw_payload_write_needs_confirmation(workbench) -> None:
    async with mcp_client("character") as session:
        await make_draft(session)
        result, _ = await call_tool(
            session,
            "put_working_set_payload",
            character="Lady Amber Blaise",
            payload={"_overlay": [], "character": {"description": "raw"}},
        )
    text = tool_error_text(result)
    assert "confirm_required" in text
    assert "targeted editing tools" in text


async def test_raw_payload_round_trips_with_its_etag(workbench) -> None:
    async with mcp_client("character") as session:
        await make_draft(session)
        _, read = await call_tool(
            session, "get_working_set_payload", character="Lady Amber Blaise"
        )
        body = read["payload"]
        body["character"]["description"] = "written raw"
        _, written = await call_tool(
            session,
            "put_working_set_payload",
            character="Lady Amber Blaise",
            payload=body,
            if_match=read["etag"],
            confirm=True,
        )
        assert written["etag"] != read["etag"]

        # A second write with the stale etag must be refused.
        result, _ = await call_tool(
            session,
            "put_working_set_payload",
            character="Lady Amber Blaise",
            payload=body,
            if_match=read["etag"],
            confirm=True,
        )
    assert "etag_conflict" in tool_error_text(result)


# ---- concurrency -------------------------------------------------------


async def test_an_edit_retries_once_when_the_ui_saves_underneath(
    workbench,
) -> None:
    """The Workbench window and a model can both be editing. A save
    landing between our read and write is expected, not an error — the
    two are usually touching different fields."""
    from services import payload_ops

    meta_id = None

    async with mcp_client("character") as session:
        await make_draft(session)
        meta_id = next(m.id for m in workbench.list_sets("42"))

        original = payload_ops.edit
        calls = {"n": 0}

        def racing_edit(character_id, set_id, mutate):  # noqa: ANN001
            def wrapper(payload):
                calls["n"] += 1
                if calls["n"] == 1:
                    # Simulate the UI saving between our read and write.
                    other = workbench.read_set_payload("42", meta_id)
                    other["settings"] = {"public": True}
                    workbench.write_set_payload(
                        "42", meta_id, other, expected_etag=None
                    )
                return mutate(payload)

            return original(character_id, set_id, wrapper)

        payload_ops.edit = racing_edit
        try:
            _, body = await call_tool(
                session,
                "set_description",
                character="Lady Amber Blaise",
                text="mine",
            )
        finally:
            payload_ops.edit = original

    assert body["length"] == 4
    payload = payload_of(workbench)
    # Both writes survived: ours and the one that raced us.
    assert payload["character"]["description"] == "mine"
    assert payload["settings"] == {"public": True}


# ---- annotations -------------------------------------------------------


async def test_destructive_tools_are_annotated_as_such() -> None:
    async with mcp_client("character") as session:
        tools = {t.name: t for t in (await session.list_tools()).tools}
    for name in (
        "delete_working_set",
        "delete_custom_kink",
        "put_working_set_payload",
    ):
        assert tools[name].annotations.destructiveHint is True, name
    assert tools["set_description"].annotations.readOnlyHint is False


async def test_write_tools_say_workbench_does_not_publish(workbench) -> None:
    """A model must never tell the user a change is live on F-list."""
    async with mcp_client("character") as session:
        await make_draft(session)
        _, body = await call_tool(
            session, "set_description", character="Lady Amber Blaise", text="x"
        )
    assert "never writes to f-list.net" in body["note"]


# ---- BBCode F-list would refuse -----------------------------------------
#
# The site parses BBCode in the browser and rejects some nestings; a
# profile that trips it cannot be uploaded. A model finding that out
# from the site, after the user has already left the app, is the
# failure this prevents — so the write itself refuses, and says what to
# write instead.


async def test_a_description_f_list_would_reject_is_refused(workbench) -> None:
    async with mcp_client("character") as session:
        await make_draft(session)
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
        await make_draft(session)
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
        await make_draft(session)
        _, body = await call_tool(
            session,
            "set_description",
            character="Lady Amber Blaise",
            text="[color=cyan][big][b]Athali[/b][/big][/color]",
        )
    assert body["length"] == len("[color=cyan][big][b]Athali[/b][/big][/color]")


async def test_appending_something_invalid_is_refused_too(workbench) -> None:
    async with mcp_client("character") as session:
        await make_draft(session)
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
