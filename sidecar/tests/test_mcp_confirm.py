"""A tool that can lose the user's work asks for `confirm` (spec #6, #78).

The rule lives in the tool registry, not in each tool: a tool marked
destructive must declare `confirm`, and a call without `confirm=true`
is refused with `confirm_required` before the tool's own code runs. So
these tests walk whatever the registry holds on each endpoint, and a
new destructive tool is held to the rule without a new test.
"""

from __future__ import annotations

from typing import Any

import pytest

from mcp_helpers import call_tool, mcp_client, tool_error_text
from test_mcp_edit import payload_of, workbench  # noqa: F401 — the fixture
from workbench_mcp import ENDPOINTS, _registry

#: A value of each JSON type that passes schema validation but names
#: nothing that exists: a tool body that ran anyway would fail on it
#: with its own code, never with `confirm_required`.
_PLACEHOLDER: dict[str, Any] = {
    "string": "no such thing",
    "integer": 0,
    "number": 0,
    "boolean": False,
    "array": [],
    "object": {},
}


def _required_arguments(schema: dict[str, Any]) -> dict[str, Any]:
    """The least a call needs to get past schema validation."""
    properties = schema.get("properties", {})
    arguments = {}
    for name in schema.get("required", []):
        spec = properties[name]
        kind = spec.get("type") or spec["anyOf"][0]["type"]
        arguments[name] = _PLACEHOLDER[kind]
    return arguments


@pytest.mark.parametrize("suffix", sorted(ENDPOINTS))
async def test_every_destructive_tool_refuses_a_call_without_confirm(
    workbench, suffix: str  # noqa: F811
) -> None:
    async with mcp_client(suffix) as session:
        tools = (await session.list_tools()).tools
        destructive = [t for t in tools if t.annotations.destructiveHint]
        refused = {}
        for listed in destructive:
            result, _ = await call_tool(
                session, listed.name, **_required_arguments(listed.inputSchema)
            )
            refused[listed.name] = tool_error_text(result)
    assert destructive, f"no destructive tool on /mcp/{suffix}"
    for name, text in refused.items():
        assert "confirm_required: " in text, (name, text)


@pytest.mark.parametrize("suffix", sorted(ENDPOINTS))
async def test_every_tool_taking_confirm_is_destructive_or_asks_only_sometimes(
    suffix: str,
) -> None:
    """The one tool that asks only sometimes is registered as such."""
    sometimes = {s.name for s in _registry.registered_tools() if s.confirm_when}
    async with mcp_client(suffix) as session:
        tools = (await session.list_tools()).tools
    undeclared = [
        t.name
        for t in tools
        if "confirm" in t.inputSchema.get("properties", {})
        and not t.annotations.destructiveHint
        and t.name not in sometimes
    ]
    assert undeclared == []
    assert sometimes == {"set_description"}

def test_registering_a_destructive_tool_without_confirm_fails() -> None:
    def forget_everything(character: str) -> dict[str, Any]:
        raise AssertionError("never called")

    register = _registry.tool(tags=_registry.TAG_CORE, destructive=True)
    with pytest.raises(ValueError, match="forget_everything.*confirm"):
        register(forget_everything)
    assert "forget_everything" not in {s.name for s in _registry.registered_tools()}


def test_registering_a_tool_that_takes_confirm_but_is_not_destructive_fails() -> None:
    """A `confirm` the registry does not enforce would be a promise
    only the tool's own code keeps."""

    def tidy_up(character: str, confirm: bool = False) -> dict[str, Any]:
        raise AssertionError("never called")

    register = _registry.tool(tags=_registry.TAG_CORE)
    with pytest.raises(ValueError, match="tidy_up.*destructive"):
        register(tidy_up)
    assert "tidy_up" not in {s.name for s in _registry.registered_tools()}


# ---- replacing the whole description ------------------------------------
#
# Replacing the description is an everyday edit, so it is not marked
# destructive; but one that throws away most of the text is the classic
# way a model loses the user's work (a summary written over the
# original), so that one asks first.

OLD = "x" * 100


async def _replace_description(session, text: str, **extra: Any):
    return await call_tool(
        session,
        "set_description",
        character="Lady Amber Blaise",
        text=text,
        **extra,
    )


def _description(archive) -> str:
    return payload_of(archive)["character"]["description"]


async def test_shrinking_the_description_below_half_needs_confirm(
    workbench,  # noqa: F811
) -> None:
    async with mcp_client("character") as session:
        await _replace_description(session, OLD)
        refused, _ = await _replace_description(session, "y" * 49)
        assert "confirm_required: " in tool_error_text(refused)
        assert _description(workbench) == OLD

        done, body = await _replace_description(session, "y" * 49, confirm=True)
    assert not done.isError, body
    assert _description(workbench) == "y" * 49


async def test_a_replacement_of_at_least_half_the_length_needs_no_confirm(
    workbench,  # noqa: F811
) -> None:
    async with mcp_client("character") as session:
        await _replace_description(session, OLD)
        done, body = await _replace_description(session, "y" * 50)
    assert not done.isError, body
    assert _description(workbench) == "y" * 50
