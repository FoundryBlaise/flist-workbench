"""The read-only MCP tools (design §3.1–3.4, §3.9–3.10).

Phase-2 acceptance: a model connected to the endpoint can find out what
characters exist, read a profile, resolve field and kink names, browse
logs and search them — all without touching the UI.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from mcp_helpers import call_tool, mcp_client, tool_error_text

# A trimmed mapping list with the shapes F-list actually uses: infotags
# pointing at a listitem *category* name, and a separate listitems array.
MAPPING = {
    "infotags": [
        {"id": "1", "name": "Age", "type": "text", "group_id": "1"},
        {"id": "2", "name": "Species", "type": "text", "group_id": "1"},
        {
            "id": "3",
            "name": "Orientation",
            "type": "list",
            "list": "orientation",
            "group_id": "2",
        },
        {"id": "4", "name": "Height", "type": "number", "group_id": "1"},
        {"id": "9", "name": "Mystery", "type": "wat"},
    ],
    "infotag_groups": [
        {"id": "1", "name": "General details"},
        {"id": "2", "name": "Sexual details"},
    ],
    "listitems": [
        {"id": "10", "name": "orientation", "value": "Straight"},
        {"id": "11", "name": "orientation", "value": "Bisexual"},
        {"id": "12", "name": "orientation", "value": "Gay"},
    ],
    "kinks": [
        {"id": "100", "name": "Rough Housing", "group_id": "7"},
        {"id": "101", "name": "Long Walks", "group_id": "7"},
    ],
    "kink_groups": [{"id": "7", "name": "Miscellaneous"}],
}


@pytest.fixture
def workbench(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A sidecar rooted at a temp dir, with one archived character."""
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib
    import json

    import character_archive
    import flist_api
    import paths

    importlib.reload(paths)
    importlib.reload(character_archive)

    # Seed the mapping-list cache so no network call is attempted.
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
                "description": "[b]A published profile.[/b]",
                "custom_title": "Innkeeper",
            },
            "infotags": {"2": "Human"},
            "kinks": {},
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


def _seed_set(archive, name: str = "Draft", **payload: Any) -> str:
    meta = archive.create_set_from_live("42", name)
    body = archive.read_set_payload("42", meta.id) or {}
    body.update(payload)
    archive.write_set_payload("42", meta.id, body, expected_etag=None)
    archive.set_active_set_id("42", meta.id)
    return meta.id


# ---- characters & sets -------------------------------------------------


async def test_list_characters_reports_the_archive(workbench) -> None:
    async with mcp_client() as session:
        _, body = await call_tool(session, "list_characters")
    names = {c["name"] for c in body["characters"]}
    assert "Lady Amber Blaise" in names
    row = next(c for c in body["characters"] if c["name"] == "Lady Amber Blaise")
    assert row["has_archive"] is True
    assert row["working_sets"] == 0


async def test_get_live_profile_omits_the_description_by_default(
    workbench,
) -> None:
    async with mcp_client() as session:
        _, short = await call_tool(
            session, "get_live_profile", character="Lady Amber Blaise"
        )
        _, full = await call_tool(
            session,
            "get_live_profile",
            character="Lady Amber Blaise",
            include_description=True,
        )
    assert "description" not in short
    assert short["description_length"] == len("[b]A published profile.[/b]")
    assert full["description"] == "[b]A published profile.[/b]"
    assert full["custom_title"] == "Innkeeper"


async def test_characters_resolve_case_insensitively(workbench) -> None:
    async with mcp_client() as session:
        _, body = await call_tool(
            session, "get_live_profile", character="lady amber blaise"
        )
    assert body["character"] == "Lady Amber Blaise"


async def test_an_unknown_character_lists_the_known_ones(workbench) -> None:
    async with mcp_client() as session:
        result, _ = await call_tool(
            session, "get_live_profile", character="Nobody At All"
        )
    text = tool_error_text(result)
    assert "character_not_found" in text
    assert "Lady Amber Blaise" in text


async def test_list_working_sets_marks_the_active_one(workbench) -> None:
    _seed_set(workbench, "Main")
    _seed_set(workbench, "AU")
    async with mcp_client() as session:
        _, body = await call_tool(
            session, "list_working_sets", character="Lady Amber Blaise"
        )
    assert {s["name"] for s in body["sets"]} == {"Main", "AU"}
    assert body["active_set"] == "AU"


async def test_reading_a_set_without_one_active_explains_itself(
    workbench,
) -> None:
    async with mcp_client() as session:
        result, _ = await call_tool(
            session, "get_description", character="Lady Amber Blaise"
        )
    text = tool_error_text(result)
    assert "no_active_set" in text
    assert "create_working_set" in text


async def test_live_is_addressable_but_flagged_read_only(workbench) -> None:
    async with mcp_client() as session:
        _, body = await call_tool(
            session, "get_description", character="Lady Amber Blaise", set="live"
        )
    assert body["read_only"] is True
    assert body["description"] == "[b]A published profile.[/b]"


# ---- description paging ------------------------------------------------


async def test_get_description_pages_through_a_long_text(workbench) -> None:
    set_id = _seed_set(workbench)
    payload = workbench.read_set_payload("42", set_id)
    payload["character"]["description"] = "ABCDEFGHIJ"
    workbench.write_set_payload("42", set_id, payload, expected_etag=None)

    async with mcp_client() as session:
        _, head = await call_tool(
            session, "get_description", character="Lady Amber Blaise", length=4
        )
        _, tail = await call_tool(
            session,
            "get_description",
            character="Lady Amber Blaise",
            offset=4,
            length=100,
        )
    assert head["description"] == "ABCD"
    assert head["has_more"] is True
    assert head["total_length"] == 10
    assert tail["description"] == "EFGHIJ"
    assert tail["has_more"] is False


# ---- profile fields ----------------------------------------------------


async def test_profile_fields_resolve_names_and_options(workbench) -> None:
    set_id = _seed_set(workbench)
    payload = workbench.read_set_payload("42", set_id)
    payload["infotags"] = {"2": "Elf", "3": "11"}
    workbench.write_set_payload("42", set_id, payload, expected_etag=None)

    async with mcp_client() as session:
        _, body = await call_tool(
            session,
            "list_profile_fields",
            character="Lady Amber Blaise",
            only_set=True,
        )
    by_label = {f["label"]: f for f in body["fields"]}
    assert by_label["Species"]["value"] == "Elf"
    # A list field reports the option's label, with the stored id kept
    # alongside so a caller can round-trip it.
    assert by_label["Orientation"]["value"] == "Bisexual"
    assert by_label["Orientation"]["raw_value"] == "11"
    assert "Straight" in by_label["Orientation"]["options"]


async def test_profile_fields_lists_everything_settable_by_default(
    workbench,
) -> None:
    _seed_set(workbench)
    async with mcp_client() as session:
        _, body = await call_tool(
            session, "list_profile_fields", character="Lady Amber Blaise"
        )
    labels = {f["label"] for f in body["fields"]}
    assert {"Age", "Species", "Orientation", "Height"} <= labels
    assert body["groups"] == ["General details", "Sexual details"]


async def test_profile_fields_filter_by_group_and_query(workbench) -> None:
    _seed_set(workbench)
    async with mcp_client() as session:
        _, by_group = await call_tool(
            session,
            "list_profile_fields",
            character="Lady Amber Blaise",
            group="Sexual details",
        )
        _, by_query = await call_tool(
            session,
            "list_profile_fields",
            character="Lady Amber Blaise",
            query="heig",
        )
    assert [f["label"] for f in by_group["fields"]] == ["Orientation"]
    assert [f["label"] for f in by_query["fields"]] == ["Height"]


async def test_unmapped_fields_are_surfaced_separately(workbench) -> None:
    set_id = _seed_set(workbench)
    payload = workbench.read_set_payload("42", set_id)
    payload["infotags"] = {"999": "something F-list no longer describes"}
    workbench.write_set_payload("42", set_id, payload, expected_etag=None)

    async with mcp_client() as session:
        _, body = await call_tool(
            session, "list_profile_fields", character="Lady Amber Blaise"
        )
    assert body["unknown_fields"] == [
        {
            "id": "999",
            "value": "something F-list no longer describes",
            "note": "not in the mapping list",
        }
    ]


# ---- kinks -------------------------------------------------------------


async def test_list_kinks_resolves_names_and_counts_choices(workbench) -> None:
    set_id = _seed_set(workbench)
    payload = workbench.read_set_payload("42", set_id)
    payload["kinks"] = {"100": "fave", "101": "no"}
    payload["custom_kinks"] = {
        "local:abc": {"name": "Thunderstorms", "description": "", "choice": "yes"},
        "local:dead": {"name": "Gone", "choice": "no", "_deleted": True},
    }
    workbench.write_set_payload("42", set_id, payload, expected_etag=None)

    async with mcp_client() as session:
        _, body = await call_tool(
            session, "list_kinks", character="Lady Amber Blaise"
        )
    assert {k["kink"]: k["choice"] for k in body["kinks"]} == {
        "Rough Housing": "fave",
        "Long Walks": "no",
    }
    assert body["kinks"][0]["group"] == "Miscellaneous"
    assert body["counts"] == {"fave": 1, "no": 1}
    # Tombstoned custom kinks are gone as far as any reader is concerned.
    assert [c["name"] for c in body["custom_kinks"]] == ["Thunderstorms"]


async def test_list_kinks_can_filter_to_one_choice(workbench) -> None:
    set_id = _seed_set(workbench)
    payload = workbench.read_set_payload("42", set_id)
    payload["kinks"] = {"100": "fave", "101": "no"}
    workbench.write_set_payload("42", set_id, payload, expected_etag=None)

    async with mcp_client() as session:
        _, body = await call_tool(
            session, "list_kinks", character="Lady Amber Blaise", choice="fave"
        )
    assert [k["kink"] for k in body["kinks"]] == ["Rough Housing"]


# ---- reference ---------------------------------------------------------


async def test_bbcode_reference_covers_the_flist_specific_tags(
    workbench,
) -> None:
    async with mcp_client() as session:
        _, body = await call_tool(session, "get_bbcode_reference")
    tags = " ".join(t["tag"] for t in body["tags"])
    assert "[collapse=" in tags
    assert "[eicon]" in tags
    # The one thing a model will reach for and get wrong.
    assert any("no [img] tag" in n for n in body["notes"])


async def test_mapping_list_section_is_validated(workbench) -> None:
    async with mcp_client() as session:
        result, _ = await call_tool(session, "get_mapping_list", section="nope")
    text = tool_error_text(result)
    assert "validation_failed" in text
    assert "infotags" in text


# ---- tag filtering -----------------------------------------------------


async def test_the_narrow_endpoints_carry_their_own_tools() -> None:
    async with mcp_client("character") as session:
        character_tools = {t.name for t in (await session.list_tools()).tools}
    async with mcp_client("logs") as session:
        log_tools = {t.name for t in (await session.list_tools()).tools}

    assert "list_profile_fields" in character_tools
    assert "read_log_messages" not in character_tools
    assert "read_log_messages" in log_tools
    assert "list_profile_fields" not in log_tools
    # Core tools are on both, so a model on either endpoint can orient.
    assert "get_workbench_status" in character_tools & log_tools


async def test_every_read_tool_is_annotated_read_only() -> None:
    async with mcp_client() as session:
        for tool in (await session.list_tools()).tools:
            if tool.name.startswith(("get_", "list_", "search_", "find_")):
                assert tool.annotations is not None, tool.name
                assert tool.annotations.readOnlyHint, tool.name
