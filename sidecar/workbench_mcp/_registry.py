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

import functools
import inspect
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from mcp.types import ToolAnnotations

from services import events

#: Tag applied to tools that belong on the character-editing endpoint.
TAG_CHARACTER = "character"
#: Tag applied to tools that belong on the logs/labels endpoint.
TAG_LOGS = "logs"
#: Tag for tools every endpoint should carry (status, help, settings).
TAG_CORE = "core"
#: The IC/OOC labelling loop and nothing else. Its own endpoint exists
#: because tool schemas are not free: 29 tools on /mcp/logs cost ~5800
#: tokens of context before a single message is judged, and a client
#: running the loop at 12k context could not fit one batch alongside
#: them. Eight tools cost a quarter of that.
TAG_CLASSIFY = "classify"


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
        wrapped = _attributed(fn, tool_name)
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
                fn=wrapped,
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



def _attributed(fn: Callable[..., Any], tool_name: str) -> Callable[..., Any]:
    """Tag everything a tool publishes on the event bus as coming from
    MCP, naming the tool.

    The renderer ignores changes it made itself and reloads for
    everything else, so a write has to say where it came from — and
    "the set you have open just changed" is far more useful to a user
    when it can name `set_description` as the cause.
    """

    if inspect.iscoroutinefunction(fn):

        @functools.wraps(fn)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            with events.origin(f"mcp:{tool_name}"):
                return await fn(*args, **kwargs)

        return async_wrapper

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        with events.origin(f"mcp:{tool_name}"):
            return fn(*args, **kwargs)

    return wrapper


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
