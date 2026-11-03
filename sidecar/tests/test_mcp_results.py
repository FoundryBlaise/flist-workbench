"""Every tool result reads the same way to a model (spec #6, #88).

* A failure is an error with a code (`code: message {details}`), never
  an ordinary result a model could read as success.
* Every tool that is not read-only says, in its result, that nothing
  was published to F-list. The note is added by the tool registry, not
  by each tool, so a new tool cannot forget it.
* A list or a search never floods the context: its limit is capped, and
  a result that holds back rows says where the next page starts.

These tests walk the registry where they can, so a new tool is held to
the convention without a new test; each goes through the client session
a real MCP client uses.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

import server  # noqa: F401  (building the servers fills the registry)
from fchat_logs import chat, utc, write_log
from mcp_helpers import allow_log_text, call_tool, mcp_client, tool_error_text
from test_mcp_edit import open_workbench, seed_gallery, workbench  # noqa: F401
from test_rag_jobs import _stub_index_services
from two_characters import OLD_NAME, PARTNER, write_logs
from workbench_state import put_workbench, workbench_payload
from workbench_mcp import ENDPOINTS, _registry

CHAR = "Lady Amber Blaise"


@pytest.fixture
def scene(workbench, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):  # noqa: F811
    """One character with a Live, F-Chat Logs, an image in the pool, a
    folder cleared for import, and stubbed embedding: enough for any
    tool to do its work for real."""
    import archive_images
    from services import jobs
    from services import settings as settings_service

    write_logs(tmp_path / "fchat")
    allow_log_text()
    monkeypatch.setattr(jobs, "_registry", jobs.JobRegistry())
    _stub_index_services(monkeypatch)
    archive_images.write_character_image("42", "7", "png", _png())
    folder = tmp_path / "Outputs"
    folder.mkdir()
    (folder / "new.png").write_bytes(_png(2))
    settings_service.update({"image_import_roots": [str(folder)]})
    yield tmp_path
    _wait_for_jobs()


def _png(n: int = 1) -> bytes:
    import io

    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (8 + n, 8), (n * 40, 10, 10)).save(out, "PNG")
    return out.getvalue()


def _wait_for_jobs() -> None:
    """No job may outlive its test: a Pull or an ingest left running
    would write into the next test's data folder."""
    import time

    from services import jobs

    deadline = time.monotonic() + 10
    while any(not j.finished for j in jobs.registry().list()):
        assert time.monotonic() < deadline, "a job outlived its test"
        time.sleep(0.05)


async def _call(session, tool: str, **arguments: Any) -> dict[str, Any]:  # noqa: ANN001
    result, body = await call_tool(session, tool, **arguments)
    assert not result.isError, (tool, body)
    return body


# ---- the no-publish note ---------------------------------------------------

Write = Callable[[Any, Path], Awaitable[dict[str, Any]]]

#: One call of every tool that is not read-only, doing its work for
#: real. A tool missing here fails the registry walk below.
WRITES: dict[str, Write] = {}


def writes(tool: str) -> Callable[[Write], Write]:
    def register(fn: Write) -> Write:
        WRITES[tool] = fn
        return fn

    return register


async def _hash_of_a_message(session) -> str:  # noqa: ANN001
    body = await _call(session, "read_log_messages", character=CHAR, partner=PARTNER)
    return body["messages"][0]["hash"]


async def _custom_kink(session) -> str:  # noqa: ANN001
    return (await _call(session, "add_custom_kink", character=CHAR, name="Tea"))["id"]


@writes("set_message_labels")
async def _(session, _dir):  # noqa: ANN001, ANN202
    items = [{"hash": await _hash_of_a_message(session), "label": "IC"}]
    return await _call(
        session, "set_message_labels", character=CHAR, partner=PARTNER, items=items
    )


@writes("label_all_unlabeled")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(
        session,
        "label_all_unlabeled",
        character=CHAR,
        partner=PARTNER,
        label="IC",
        confirm=True,
    )


@writes("clear_labels")
async def _(session, _dir):  # noqa: ANN001, ANN202
    await _call(
        session,
        "label_all_unlabeled",
        character=CHAR,
        partner=PARTNER,
        label="IC",
        confirm=True,
    )
    return await _call(
        session, "clear_labels", character=CHAR, partner=PARTNER, confirm=True
    )


@writes("load_backup_into_workbench")
async def _(session, _dir):  # noqa: ANN001, ANN202
    await open_workbench(session)
    backup = (await _call(session, "create_backup", character=CHAR))["filename"]
    return await _call(
        session,
        "load_backup_into_workbench",
        character=CHAR,
        backup=backup,
        confirm=True,
    )


@writes("set_description")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(
        session, "set_description", character=CHAR, text="[b]Rewritten.[/b]", confirm=True
    )


@writes("edit_description")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(
        session,
        "edit_description",
        character=CHAR,
        old_string="Published",
        new_string="Drafted",
    )


@writes("set_custom_title")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(session, "set_custom_title", character=CHAR, title="Innkeeper")


@writes("set_profile_field")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(
        session, "set_profile_field", character=CHAR, field="Age", value="30"
    )


@writes("clear_profile_field")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(session, "clear_profile_field", character=CHAR, field="Species")


@writes("set_profile_settings")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(session, "set_profile_settings", character=CHAR, public=True)


@writes("set_kinks")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(
        session,
        "set_kinks",
        character=CHAR,
        items=[{"kink": "Rough Housing", "choice": "fave"}],
    )


@writes("add_custom_kink")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(session, "add_custom_kink", character=CHAR, name="Tea")


@writes("update_custom_kink")
async def _(session, _dir):  # noqa: ANN001, ANN202
    kink_id = await _custom_kink(session)
    return await _call(
        session, "update_custom_kink", character=CHAR, kink_id=kink_id, name="Coffee"
    )


@writes("delete_custom_kink")
async def _(session, _dir):  # noqa: ANN001, ANN202
    kink_id = await _custom_kink(session)
    return await _call(
        session, "delete_custom_kink", character=CHAR, kink_id=kink_id, confirm=True
    )


@writes("restore_custom_kink")
async def _(session, _dir):  # noqa: ANN001, ANN202
    # Only a kink F-list knows can come back; a local one is gone.
    await open_workbench(session)
    payload = workbench_payload("42")
    payload["custom_kinks"] = {"5": {"name": "Tea", "description": "", "choice": "yes"}}
    put_workbench("42", payload)
    kink_id = "5"
    await _call(
        session, "delete_custom_kink", character=CHAR, kink_id=kink_id, confirm=True
    )
    return await _call(session, "restore_custom_kink", character=CHAR, kink_id=kink_id)


@writes("reorder_custom_kinks")
async def _(session, _dir):  # noqa: ANN001, ANN202
    first, second = await _custom_kink(session), await _custom_kink(session)
    return await _call(
        session, "reorder_custom_kinks", character=CHAR, kink_ids=[second, first]
    )


@writes("set_image_description")
async def _(session, _dir):  # noqa: ANN001, ANN202
    await _call(session, "add_image", character=CHAR, image_id="7")
    return await _call(
        session, "set_image_description", character=CHAR, image_id="7", description="Tea"
    )


@writes("reorder_images")
async def _(session, _dir):  # noqa: ANN001, ANN202
    await open_workbench(session)
    seed_gallery(None, ["1", "2"])
    return await _call(session, "reorder_images", character=CHAR, image_ids=["2", "1"])


@writes("remove_image")
async def _(session, _dir):  # noqa: ANN001, ANN202
    await _call(session, "add_image", character=CHAR, image_id="7")
    return await _call(session, "remove_image", character=CHAR, image_id="7")


@writes("trash_images")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(session, "trash_images", character=CHAR, image_ids=["7"])


@writes("restore_image")
async def _(session, _dir):  # noqa: ANN001, ANN202
    await _call(session, "trash_images", character=CHAR, image_ids=["7"])
    return await _call(session, "restore_image", character=CHAR, image_id="7")


@writes("add_image")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(session, "add_image", character=CHAR, image_id="7")


@writes("import_images")
async def _(session, data_dir):  # noqa: ANN001, ANN202
    items = [{"source_path": str(data_dir / "Outputs" / "new.png")}]
    return await _call(session, "import_images", character=CHAR, items=items)


@writes("put_workbench_payload")
async def _(session, _dir):  # noqa: ANN001, ANN202
    payload = (await _call(session, "get_workbench_payload", character=CHAR))["payload"]
    return await _call(
        session, "put_workbench_payload", character=CHAR, payload=payload, confirm=True
    )


@writes("pull_character")
async def _(session, _dir):  # noqa: ANN001, ANN202
    # Nobody is signed in, so the job fails at once in the background;
    # the answer that started it is what is under test.
    return await _call(session, "pull_character", character=CHAR, wait=False)


@writes("backup_all_characters")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(session, "backup_all_characters", wait=False)


@writes("create_backup")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(session, "create_backup", character=CHAR)


@writes("ingest_logs")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(session, "ingest_logs", character=CHAR)


@writes("cancel_job")
async def _(session, _dir):  # noqa: ANN001, ANN202
    started = await _call(session, "ingest_logs", character=CHAR, wait=False)
    return await _call(session, "cancel_job", job_id=started["job_id"])


@writes("wipe_search_index")
async def _(session, _dir):  # noqa: ANN001, ANN202
    await _call(session, "ingest_logs", character=CHAR)
    return await _call(session, "wipe_search_index", confirm=True)


@writes("export_upload_zip")
async def _(session, data_dir):  # noqa: ANN001, ANN202
    return await _call(
        session, "export_upload_zip", character=CHAR, path=str(data_dir / "Outputs")
    )


@writes("update_settings")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(session, "update_settings", ooc_threshold_chars=250)


@writes("add_alias")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(
        session, "add_alias", character=CHAR, name=OLD_NAME, primary_name=PARTNER
    )


@writes("remove_alias")
async def _(session, _dir):  # noqa: ANN001, ANN202
    await _call(session, "add_alias", character=CHAR, name=OLD_NAME, primary_name=PARTNER)
    return await _call(
        session, "remove_alias", character=CHAR, name=OLD_NAME, confirm=True
    )


#: Every tool the registry holds that is not marked read-only.
TOOLS_THAT_WRITE = sorted(
    spec.name
    for spec in _registry.registered_tools()
    if not spec.annotations.readOnlyHint
)


@pytest.mark.parametrize("tool", TOOLS_THAT_WRITE)
async def test_every_write_says_nothing_was_published(scene: Path, tool: str) -> None:
    assert tool in WRITES, f"add a call of {tool} to WRITES"
    async with mcp_client("") as session:
        body = await WRITES[tool](session, scene)
    assert "Nothing was published to F-list" in body["not_published"], body
    assert "ok" not in body


async def test_a_read_says_nothing_about_publishing(scene: Path) -> None:
    async with mcp_client("") as session:
        body = await open_workbench(session)
    assert "not_published" not in body




def test_registering_a_write_that_returns_no_dict_fails() -> None:
    """The note goes into the result, so a write's result is a dict."""

    def say_done(character: str) -> str:
        raise AssertionError("never called")

    register = _registry.tool(tags=_registry.TAG_CORE)
    with pytest.raises(ValueError, match="say_done.*dict"):
        register(say_done)
    assert "say_done" not in {s.name for s in _registry.registered_tools()}


# ---- failures are errors ---------------------------------------------------

#: What every failed call reads like: `code: message`, the code in
#: snake case (`_context.ToolError`).
ERROR = re.compile(r"(?:Error executing tool \w+: )?[a-z][a-z_]+: \S")


def _failed(result, body) -> str:  # noqa: ANN001
    assert result.isError, f"a failure came back as a result: {body}"
    text = tool_error_text(result)
    assert ERROR.match(text), text
    return text


#: Aliases are names kept beside the Labels, not read from the Logs, so
#: a character without Logs can still have some: these answer by name.
ANSWERS_FOR_ANYONE = {"list_aliases", "add_alias", "remove_alias"}


@pytest.mark.parametrize("suffix", sorted(ENDPOINTS), ids=lambda s: f"/mcp/{s}")
async def test_every_tool_given_a_character_nobody_knows_fails_with_a_code(
    scene: Path, suffix: str
) -> None:
    """Every family of tools addresses a character; none may answer an
    unknown one with an ordinary result. Tools that reach out to F-list
    are left out: there an unknown name is F-list's to judge."""
    async with mcp_client(suffix) as session:
        tools = (await session.list_tools()).tools
        called = []
        for listed in tools:
            properties = listed.inputSchema.get("properties", {})
            if "character" not in properties or listed.annotations.openWorldHint:
                continue
            if listed.name in ANSWERS_FOR_ANYONE:
                continue
            arguments = _required_arguments(listed.inputSchema)
            arguments["character"] = "Nobody Here"
            if "confirm" in properties:
                arguments["confirm"] = True
            _failed(*await call_tool(session, listed.name, **arguments))
            called.append(listed.name)
    assert called, f"no tool on /mcp/{suffix} takes a character"


#: A value of each JSON type that passes schema validation but names
#: nothing that exists.
_PLACEHOLDER: dict[str, Any] = {
    "string": "no such thing",
    "integer": 1,
    "number": 1,
    "boolean": False,
    "object": {},
}


def _required_arguments(schema: dict[str, Any]) -> dict[str, Any]:
    properties = schema.get("properties", {})
    arguments = {}
    for name in schema.get("required", []):
        spec = properties[name]
        kind = spec.get("type") or spec["anyOf"][0]["type"]
        if kind == "array":
            strings = spec.get("items", {}).get("type") == "string"
            arguments[name] = ["no such thing"] if strings else [{"source_path": "nowhere.png"}]
        else:
            arguments[name] = _PLACEHOLDER[kind]
    return arguments


#: The tools that take no character, each with a call that must fail.
FAILING_CALLS: dict[str, dict[str, Any]] = {
    "get_job": {"job_id": "no-such-job"},
    "cancel_job": {"job_id": "no-such-job"},
    "update_settings": {},
    "find_contacts": {"name": " "},
    "get_mapping_list": {"section": "nothing"},
    "search_logs_semantic": {"question": " "},
    "wipe_search_index": {},
}


@pytest.mark.parametrize("tool", sorted(FAILING_CALLS))
async def test_a_tool_without_a_character_fails_with_a_code(
    scene: Path, tool: str
) -> None:
    async with mcp_client("") as session:
        _failed(*await call_tool(session, tool, **FAILING_CALLS[tool]))


async def test_an_ingest_that_fails_is_an_error_not_a_result(
    scene: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed ingest used to come back as `state: failed` beside the
    counts, which reads like a finished job."""
    import rag_embed

    def no_model(settings, *, timeout=30.0):  # noqa: ANN001, ANN202, ARG001
        raise rag_embed.EmbedError("the model would not load")

    monkeypatch.setattr(rag_embed, "probe", no_model)
    async with mcp_client("logs") as session:
        text = _failed(*await call_tool(session, "ingest_logs", character=CHAR))
    assert "embedding_failed: " in text
    assert "check_embedding" in text


# ---- capped and paged lists ------------------------------------------------
#
# Each list or search below gets more rows than its cap, then is asked
# for far more than the cap: it answers the cap and the offset of the
# next page, and following those offsets reads every row exactly once.

#: More than any cap.
TOO_MANY = 10_000


def _crowd_the_catalogue(count: int) -> None:
    """A field catalogue with `count` fields and `count` kinks."""
    import json

    import archive_registry
    from services import mapping as mapping_service

    mapping = {
        "infotags": [
            {"id": str(n), "name": f"Field {n:03}", "type": "text", "group_id": "1"}
            for n in range(1, count + 1)
        ],
        "infotag_groups": [{"id": "1", "name": "General details"}],
        "listitems": [],
        "kinks": [
            {"id": str(1000 + n), "name": f"Kink {n:03}", "group_id": "7"}
            for n in range(count)
        ],
        "kink_groups": [{"id": "7", "name": "Miscellaneous"}],
    }
    cache = archive_registry.cache_root() / "mapping-list.json"
    cache.write_text(json.dumps(mapping), encoding="utf-8")
    mapping_service.invalidate()


def _many_characters(count: int, fchat: Path) -> None:
    """`count` characters of the user's, known from their Logs only."""
    for n in range(count):
        write_log(
            fchat / f"Extra {n:03}" / "logs" / PARTNER,
            [chat(PARTNER, "Hello.", at=utc(2024, 1, 1, 12, 0))],
        )


def _many_images(count: int) -> None:
    import archive_images

    for n in range(count):
        archive_images.write_character_image("42", str(9000 + n), "png", _png(n))


def _many_backups(count: int) -> None:
    import archive_backups
    import backup_origin

    for _ in range(count):
        archive_backups.save_zip_backup(
            "42", source=backup_origin.LIVE, occasion=backup_origin.MANUAL, force=True
        )


def _many_partners(count: int, fchat: Path) -> None:
    """`count` partners, each with one line about the lighthouse."""
    for n in range(count):
        name = f"Partner {n:03}"
        write_log(
            fchat / CHAR / "logs" / name,
            [chat(name, "The lighthouse is dark.", at=utc(2024, 1, 1, 12, n % 60))],
        )


def _many_hits(count: int, fchat: Path) -> None:
    """One conversation with `count` lines about the lighthouse."""
    write_log(
        fchat / CHAR / "logs" / "Chatterbox",
        [
            chat("Chatterbox", f"Lighthouse, again ({n}).", at=utc(2024, 2, 1, 10, 0) + n)
            for n in range(count)
        ],
    )


def _much_activity(count: int) -> None:
    import flist_activity

    for n in range(count):
        flist_activity.record("test", n=n)


@dataclass(frozen=True)
class Paged:
    """A list or search tool: how to crowd it, how to call it, which
    rows its page holds, and its cap."""

    crowd: Callable[[Path], None]
    arguments: dict[str, Any]
    rows: Callable[[dict[str, Any]], list[Any]]
    cap: int


PAGED: dict[str, Paged] = {
    "list_characters": Paged(
        lambda data_dir: _many_characters(120, data_dir / "fchat"),
        {},
        lambda body: body["characters"],
        cap=100,
    ),
    "list_profile_fields": Paged(
        lambda _: _crowd_the_catalogue(120),
        {"character": CHAR},
        lambda body: body["fields"],
        cap=100,
    ),
    "list_kinks": Paged(
        lambda _: _crowd_the_catalogue(120),
        {"character": CHAR, "include_unset": True},
        lambda body: body["kinks"],
        cap=100,
    ),
    "list_images": Paged(
        lambda _: _many_images(60),
        {"character": CHAR},
        lambda body: body["gallery"] + body["not_on_profile"],
        cap=50,
    ),
    "list_backups": Paged(
        lambda _: _many_backups(55),
        {"character": CHAR},
        lambda body: body["backups"],
        cap=50,
    ),
    "list_partners": Paged(
        lambda data_dir: _many_partners(120, data_dir / "fchat"),
        {"character": CHAR},
        lambda body: body["partners"],
        cap=100,
    ),
    "search_logs": Paged(
        lambda data_dir: _many_hits(120, data_dir / "fchat"),
        {"character": CHAR, "partner": "Chatterbox", "query": "lighthouse"},
        lambda body: body["hits"],
        cap=100,
    ),
    "get_activity_log": Paged(
        lambda _: _much_activity(120),
        {},
        lambda body: body["events"],
        cap=100,
    ),
}


@pytest.mark.parametrize("tool", sorted(PAGED))
async def test_a_list_asked_for_too_much_answers_the_cap_and_pages_the_rest(
    scene: Path, tool: str
) -> None:
    paged = PAGED[tool]
    paged.crowd(scene)
    async with mcp_client("") as session:
        await open_workbench(session)
        body = await _call(session, tool, **paged.arguments, limit=TOO_MANY)
        rows = paged.rows(body)
        assert len(rows) == paged.cap
        assert body["page"]["limit"] == paged.cap
        assert body["page"]["next_offset"] == paged.cap

        while body["page"]["next_offset"] is not None:
            body = await _call(
                session,
                tool,
                **paged.arguments,
                limit=TOO_MANY,
                offset=body["page"]["next_offset"],
            )
            rows += paged.rows(body)
    assert len(rows) == body["page"]["total"] > paged.cap
    assert len({_row_key(row) for row in rows}) == len(rows), "a row came twice"


def _row_key(row: Any) -> str:
    import json

    return json.dumps(row, sort_keys=True, default=str)


async def test_a_search_of_every_partner_pages_by_partner(scene: Path) -> None:
    """Without a partner, `limit` caps the hits per partner, and the
    partners come a page at a time."""
    _many_partners(25, scene / "fchat")
    seen: list[str] = []
    offset = 0
    async with mcp_client("logs") as session:
        while offset is not None:
            body = await _call(
                session,
                "search_logs",
                character=CHAR,
                query="lighthouse",
                limit=TOO_MANY,
                offset=offset,
            )
            assert len(body["partners"]) <= 10
            assert body["limit_per_partner"] == 20
            seen += [row["partner"] for row in body["partners"]]
            offset = body["page"]["next_offset"]
    # Antiquill mentions it too, in the shared Logs.
    assert len(seen) == len(set(seen)) == 26


async def test_a_semantic_search_caps_its_hits_and_pages_the_rest(scene: Path) -> None:
    async with mcp_client("logs") as session:
        for partner in (PARTNER, "Azure Viper"):
            await _call(
                session,
                "label_all_unlabeled",
                character=CHAR,
                partner=partner,
                label="IC",
                confirm=True,
            )
        await _call(session, "ingest_logs", character=CHAR)

        search = {"question": "lighthouse", "character": CHAR, "neighbors": 0}
        asked_too_much = await _call(
            session, "search_logs_semantic", **search, top_k=TOO_MANY
        )
        first = await _call(session, "search_logs_semantic", **search, top_k=1)
        second = await _call(
            session,
            "search_logs_semantic",
            **search,
            top_k=1,
            offset=first["page"]["next_offset"],
        )

    assert asked_too_much["page"]["limit"] == 20
    assert len(asked_too_much["hits"]) == 2
    assert asked_too_much["page"]["next_offset"] is None
    assert len(first["hits"]) == len(second["hits"]) == 1
    assert first["page"]["next_offset"] == 1
    assert second["page"]["next_offset"] is None
    both = {first["hits"][0]["chunk_id"], second["hits"][0]["chunk_id"]}
    assert both == {hit["chunk_id"] for hit in asked_too_much["hits"]}


# ---- the error codes MCP.md lists ------------------------------------------

SIDECAR = Path(__file__).resolve().parents[1]
MCP_DOC = SIDECAR.parent / "docs" / "MCP.md"


def _documented_codes() -> set[str]:
    text = MCP_DOC.read_text(encoding="utf-8")
    table = text.split("## When something goes wrong", 1)[1].split("\n## ", 1)[0]
    codes: set[str] = set()
    for line in table.splitlines():
        if line.startswith("| `"):
            first_cell = line.split("|")[1]
            codes |= set(re.findall(r"`([a-z_]+)`", first_cell))
    return codes


def _codes_in_the_sidecar() -> set[str]:
    """Every quoted snake_case word in the sidecar's own code: a code in
    use is one of them."""
    words: set[str] = set()
    for path in SIDECAR.rglob("*.py"):
        if ".venv" in path.parts or "tests" in path.parts:
            continue
        words |= set(re.findall(r"\"([a-z]+(?:_[a-z]+)+)\"", path.read_text(encoding="utf-8")))
    return words


def test_every_error_code_mcp_md_lists_is_still_in_use() -> None:
    documented = _documented_codes()
    assert documented, "MCP.md's error table was not found"
    assert documented - _codes_in_the_sidecar() == set()


def test_mcp_md_lists_the_codes_a_waiting_ingest_fails_with() -> None:
    """A failed ingest is an error now, carrying the job's code."""
    assert {
        "embedding_failed",
        "embedding_model_changed",
        "log_dir_unavailable",
    } <= _documented_codes()
