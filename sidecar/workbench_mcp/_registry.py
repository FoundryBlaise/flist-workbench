"""Tool registry shared by the three MCP sub-servers.

The reference MCP SDK has no notion of tags, so tools declare theirs
here and `build_mcp_servers()` filters on them. The indirection buys
two things:

* three endpoints (`/mcp`, `/mcp/character`, `/mcp/logs`) built from
  exactly one implementation of every tool — small local models choke
  on a 70-tool list, so the narrow endpoints exist;
* a single place that enforces the house style from
  docs/MCP_DESIGN.md §7: every tool carries annotations, and every
  destructive tool takes a `confirm` flag.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from mcp.types import ToolAnnotations

#: Tag applied to tools that belong on the character-editing endpoint.
TAG_CHARACTER = "character"
#: Tag applied to tools that belong on the logs/labels endpoint.
TAG_LOGS = "logs"
#: Tag for tools every endpoint should carry (status, help, settings).
TAG_CORE = "core"


@dataclass(frozen=True)
class ToolSpec:
    fn: Callable[..., Any]
    name: str
    title: str | None
    tags: frozenset[str]
    annotations: ToolAnnotations
    structured_output: bool | None = None


_TOOLS: list[ToolSpec] = []
_SEEN: dict[str, str] = {}


def tool(
    *,
    tags: str | tuple[str, ...],
    title: str | None = None,
    name: str | None = None,
    read_only: bool = False,
    destructive: bool = False,
    idempotent: bool | None = None,
    open_world: bool = False,
    structured_output: bool | None = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Register a function as an MCP tool on the tagged sub-servers.

    `read_only` and `destructive` become MCP tool annotations, which
    clients use to decide what to auto-approve. `open_world` marks the
    handful of tools that reach out to f-list.net.
    """
    tag_set = frozenset((tags,) if isinstance(tags, str) else tags)
    if not tag_set:
        raise ValueError("a tool needs at least one tag")

    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        tool_name = name or fn.__name__
        origin = f"{fn.__module__}.{fn.__qualname__}"
        previous = _SEEN.get(tool_name)
        if previous is not None and previous != origin:
            raise ValueError(
                f"duplicate MCP tool name {tool_name!r}: "
                f"{previous} and {origin}"
            )
        if previous is not None:
            # Same function again — a module reload under pytest.
            # Replace rather than stack up a second registration.
            _TOOLS[:] = [s for s in _TOOLS if s.name != tool_name]
        _SEEN[tool_name] = origin
        _TOOLS.append(
            ToolSpec(
                fn=fn,
                name=tool_name,
                title=title,
                tags=tag_set,
                annotations=ToolAnnotations(
                    title=title,
                    readOnlyHint=read_only,
                    destructiveHint=destructive,
                    idempotentHint=idempotent,
                    openWorldHint=open_world,
                ),
                structured_output=structured_output,
            )
        )
        return fn

    return decorate


def registered_tools(tags: frozenset[str] | None = None) -> list[ToolSpec]:
    """Every registered tool, or only those carrying one of `tags`."""
    if tags is None:
        return list(_TOOLS)
    return [spec for spec in _TOOLS if spec.tags & tags]


@dataclass
class PromptSpec:
    fn: Callable[..., Any]
    name: str
    description: str | None = None
    tags: frozenset[str] = field(default_factory=frozenset)


_PROMPTS: list[PromptSpec] = []


def prompt(
    *,
    tags: str | tuple[str, ...],
    name: str | None = None,
    description: str | None = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Register an MCP prompt. Every prompt also has a tool twin —
    LM Studio, the primary client, does not read prompts."""
    tag_set = frozenset((tags,) if isinstance(tags, str) else tags)

    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        _PROMPTS.append(
            PromptSpec(
                fn=fn,
                name=name or fn.__name__,
                description=description,
                tags=tag_set,
            )
        )
        return fn

    return decorate


def registered_prompts(tags: frozenset[str] | None = None) -> list[PromptSpec]:
    if tags is None:
        return list(_PROMPTS)
    return [spec for spec in _PROMPTS if spec.tags & tags]


@dataclass
class ResourceSpec:
    fn: Callable[..., Any]
    uri: str
    name: str
    description: str | None
    mime_type: str | None
    tags: frozenset[str]


_RESOURCES: list[ResourceSpec] = []


def resource(
    uri: str,
    *,
    tags: str | tuple[str, ...],
    name: str | None = None,
    description: str | None = None,
    mime_type: str | None = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    tag_set = frozenset((tags,) if isinstance(tags, str) else tags)

    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        _RESOURCES.append(
            ResourceSpec(
                fn=fn,
                uri=uri,
                name=name or fn.__name__,
                description=description,
                mime_type=mime_type,
                tags=tag_set,
            )
        )
        return fn

    return decorate


def registered_resources(tags: frozenset[str] | None = None) -> list[ResourceSpec]:
    if tags is None:
        return list(_RESOURCES)
    return [spec for spec in _RESOURCES if spec.tags & tags]
