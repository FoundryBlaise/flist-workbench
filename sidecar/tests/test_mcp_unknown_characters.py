"""MCP tools find characters; only a Pull brings one into the archive.

The same rule the HTTP routes follow (test_unknown_characters.py): a
character the archive does not know, by name or by a perfectly safe
id, answers `character_not_found` and leaves the disk as it was. The
tools that fetch from F-list (`pull_character`,
`backup_all_characters`) are how a character comes into existence, and
they still create one.

Every tool on the character endpoint that takes a `character` is
swept, read from the server itself, so a new tool is covered the day
it is added. F-list is faked at the HTTP seam; everything else is the
real server.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

import pytest
from mcp.shared.exceptions import McpError
from pydantic import AnyUrl

from mcp_helpers import call_tool, mcp_client
from sidecar_client import disk_tree
from test_mcp_reads import MAPPING

KNOWN = "Lady Amber Blaise"
NAME = "Mira Thornfield"
CID = 4242
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64

#: Tools whose `character` brings the character into the archive.
CREATES = {"pull_character"}
#: Tools whose `character` names someone else's profile on f-list.net,
#: never one in the archive.
FOREIGN = {"get_foreign_profile", "get_foreign_kinks"}


def _seed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):  # noqa: ANN202
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("FCHAT_DATA_DIR", str(tmp_path / "fchat"))
    monkeypatch.setenv("FLIST_WORKBENCH_OFFLINE_STARTUP", "1")
    import importlib

    import character_archive
    import paths

    importlib.reload(paths)
    importlib.reload(character_archive)

    # Seed the mapping-list cache so no network call is attempted.
    cache = character_archive.cache_root() / "mapping-list.json"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(MAPPING), encoding="utf-8")
    character_archive.root()

    import server
    import settings as settings_store
    from services import mapping as mapping_service

    importlib.reload(settings_store)
    mapping_service.invalidate()
    importlib.reload(server)
    return character_archive


@pytest.fixture
def archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):  # noqa: ANN201
    """An archive holding one pulled character, so "unknown" means
    unknown among others rather than an empty archive."""
    character_archive = _seed(tmp_path, monkeypatch)
    character_archive.register_character("42", KNOWN)
    character_archive.write_live(
        "42",
        {
            "character": {"id": 42, "name": KNOWN, "description": "[b]Published.[/b]"},
            "infotags": {},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
            "fetched_at": 1700000000,
        },
    )
    yield character_archive
    from services import mapping as mapping_service

    mapping_service.invalidate()


@pytest.fixture
def empty_archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):  # noqa: ANN201
    character_archive = _seed(tmp_path, monkeypatch)
    yield character_archive
    from services import mapping as mapping_service

    mapping_service.invalidate()


@pytest.fixture
def fake_flist(httpx_mock):  # noqa: ANN001, ANN201
    """F-list with a session open and one character on the account."""
    import flist_api

    flist_api.ticket_store().set(
        flist_api.Ticket(
            account="mira-account",
            value="test-ticket",
            password="test-password",
            acquired_at=time.monotonic(),
        ),
        characters=[{"id": CID, "name": NAME}],
    )
    httpx_mock.add_response(
        url=flist_api.CHARACTER_DATA_URL,
        method="POST",
        json={
            "error": "",
            "id": CID,
            "name": NAME,
            "description": "[b]On F-list.[/b]",
            "infotags": {},
            "kinks": {},
            "custom_kinks": {},
            "inlines": {},
            "images": [],
        },
        is_reusable=True,
    )
    httpx_mock.add_response(
        url=flist_api.avatar_url(NAME),
        method="GET",
        content=PNG,
        is_optional=True,
        is_reusable=True,
    )
    yield httpx_mock
    flist_api.ticket_store().clear()


# ---- unknown characters --------------------------------------------------


_PLACEHOLDER = {
    "string": "x",
    "integer": 1,
    "number": 1,
    "boolean": True,
    "array": [],
    "object": {},
}


def _arguments(schema: dict[str, Any], character: str, scratch: Path) -> dict[str, Any]:
    """Every required argument filled with a placeholder, plus `confirm`
    set. Placeholders may be invalid (an empty list): the character is
    checked first, like the routes do, so the answer must still be
    `character_not_found`. Paths point into `scratch`, which the disk
    check sees."""
    props: dict[str, Any] = schema.get("properties", {})
    args: dict[str, Any] = {"character": character}
    for name in schema.get("required", []):
        if name in args:
            continue
        if name in ("path", "source_path"):
            args[name] = str(scratch / f"{name}.zip")
            continue
        kind = props.get(name, {}).get("type", "string")
        args[name] = _PLACEHOLDER.get(kind, "x")
    for flag in ("confirm", "confirm_cross_character"):
        if flag in props:
            args[flag] = True
    return args


#: The SDK prefixes a raised ToolError with the tool's name.
_NOT_FOUND = re.compile(r"(Error executing tool \S+: )?character_not_found: ")


async def _archive_tools(session) -> list[Any]:  # noqa: ANN001
    listed = (await session.list_tools()).tools
    return [
        t
        for t in listed
        if "character" in t.inputSchema.get("properties", {})
        and t.name not in CREATES | FOREIGN
    ]


@pytest.mark.parametrize("character", ["123", "Nobody", "never-pulled_1"])
async def test_every_character_tool_answers_not_found_and_creates_nothing(
    archive, tmp_path: Path, character: str  # noqa: ANN001
) -> None:
    before = disk_tree(tmp_path)
    failures: list[str] = []
    async with mcp_client("character") as session:
        tools = await _archive_tools(session)
        assert len(tools) > 30
        for t in tools:
            args = _arguments(t.inputSchema, character, tmp_path)
            result, body = await call_tool(session, t.name, **args)
            if not result.isError or not _NOT_FOUND.match(str(body)):
                failures.append(f"{t.name} -> {str(body)[:160]}")
    assert failures == []
    assert disk_tree(tmp_path) == before


async def test_the_description_resource_answers_not_found_and_creates_nothing(
    archive, tmp_path: Path  # noqa: ANN001
) -> None:
    before = disk_tree(tmp_path)
    async with mcp_client("character") as session:
        with pytest.raises(McpError, match="character_not_found"):
            await session.read_resource(AnyUrl("workbench://character/123/description"))
    assert disk_tree(tmp_path) == before


async def test_the_known_character_is_still_found(archive) -> None:  # noqa: ANN001
    async with mcp_client("character") as session:
        result, body = await call_tool(session, "list_backups", character="42")
    assert not result.isError, body


# ---- the tools that bring a character into existence ---------------------


async def test_pull_character_creates_a_character_it_has_not_seen(
    empty_archive, fake_flist  # noqa: ANN001
) -> None:
    async with mcp_client("character") as session:
        result, body = await call_tool(session, "pull_character", character=NAME)
        assert not result.isError, body
        assert body["character_id"] == str(CID)
        _, live = await call_tool(session, "get_live_profile", character=NAME)
    assert (empty_archive.root() / NAME).is_dir()
    assert live["character"] == NAME


async def test_backup_all_characters_creates_a_character_it_has_not_seen(
    empty_archive, fake_flist  # noqa: ANN001
) -> None:
    async with mcp_client("character") as session:
        result, body = await call_tool(session, "backup_all_characters")
        assert not result.isError, body
        _, backups = await call_tool(session, "list_backups", character=NAME)
    assert (empty_archive.root() / NAME).is_dir()
    assert len(backups["backups"]) == 1
