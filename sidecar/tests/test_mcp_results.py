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
from pathlib import Path
from typing import Any

import pytest

import server  # noqa: F401  (building the servers fills the registry)
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


@writes("append_description")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(session, "append_description", character=CHAR, text=" More.")


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


@writes("set_kink")
async def _(session, _dir):  # noqa: ANN001, ANN202
    return await _call(
        session, "set_kink", character=CHAR, kink="Rough Housing", choice="fave"
    )


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


@writes("import_image")
async def _(session, data_dir):  # noqa: ANN001, ANN202
    return await _call(
        session,
        "import_image",
        character=CHAR,
        source_path=str(data_dir / "Outputs" / "new.png"),
    )


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


@writes("export_restore_zip")
async def _(session, data_dir):  # noqa: ANN001, ANN202
    return await _call(
        session, "export_restore_zip", character=CHAR, path=str(data_dir / "Outputs")
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
