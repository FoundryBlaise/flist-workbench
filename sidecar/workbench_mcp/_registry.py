"""Tool registry shared by the MCP endpoints.

The reference MCP SDK has no notion of tags, so tools declare theirs
here and `build_mcp_servers()` filters on them. The indirection buys
two things:

* four endpoints (`/mcp`, `/mcp/character`, `/mcp/logs`,
  `/mcp/classify`) built from exactly one implementation of every
  tool — small local models choke on a long tool list, so the
  narrow endpoints exist;
* a single place that enforces the house style from
  docs/MCP_DESIGN.md §7: every tool carries annotations, and every
  destructive tool takes a `confirm` flag. Registering one without it
  fails at start-up, and a call without `confirm=true` is refused here,
  before the tool's own code runs, so no tool can forget to check.
  Likewise every tool that is not read-only gets `NOT_PUBLISHED` in its
  result here, so no write can leave a model thinking it reached F-list.

FastMCP calls a plain `def` tool on the event loop, where a semantic
search or a zip build would stall the window and every other client
until it returned. So every sync tool and resource is served through an
async twin that runs it in the threadpool (`_off_loop`); its name and
schema come from the original, which tests can still call directly.
"""

from __future__ import annotations

import functools
import inspect
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from mcp.types import ToolAnnotations
from starlette.concurrency import run_in_threadpool

from refusals import Refusal
from services import events

from ._context import ToolError, confirm_required

log = logging.getLogger(__name__)

#: Tag applied to tools that belong on the character-editing endpoint.
TAG_CHARACTER = "character"
#: Tag applied to tools that belong on the logs/labels endpoint.
TAG_LOGS = "logs"
#: Tag for tools every endpoint should carry (status, help, settings).
TAG_CORE = "core"
#: The IC/OOC labelling loop and nothing else. Its own endpoint exists
#: because tool schemas are not free: /mcp/logs's tools fill much of a
#: small context before a single message is judged, and a client
#: running the loop at 12k context could not fit one batch alongside
#: them. The loop's own few tools leave room for one.
TAG_CLASSIFY = "classify"
#: Served on `/mcp` only, which carries every tool whatever its tags:
#: blunt tools a narrow endpoint's model should not be offered.
TAG_FULL = "full"
#: Not an endpoint: marks a tool that returns Log text, the user's
#: partners' lines included. When a cloud model is the client, its
#: provider receives everything a tool returns, so these tools are left
#: out of every endpoint until the user turns them on in Settings → MCP.
TAG_LOG_TEXT = "log_text"

#: How a change reaches F-list, said by both notes below: the single
#: most important thing a connected model must not get wrong.
_USER_UPLOADS = "The user uploads changes themselves, in the browser."

#: Added to the result of every tool not marked read-only. A model that
#: has just changed something tends to report it as done, and "done"
#: must never mean "on F-list": the app does not publish.
NOT_PUBLISHED = "not_published"
NOT_PUBLISHED_NOTE = f"Nothing was published to F-list. {_USER_UPLOADS}"

#: Said by reads that show profile data, as their `note`.
NO_PUSH_NOTE = f"The app never writes to f-list.net. {_USER_UPLOADS}"


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
    warning: str | Callable[..., str] | None = None,
    confirm_when: str | None = None,
    idempotent: bool | None = None,
    open_world: bool = False,
    structured_output: bool | None = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Register a function as an MCP tool on the tagged sub-servers.

    `read_only` and `destructive` become MCP tool annotations, which
    clients use to decide what to auto-approve. `open_world` marks the
    handful of tools that reach out to f-list.net.

    A destructive tool is called only with `confirm=true`; without it
    the call is refused with `confirm_required`, carrying `warning`:
    what the call would do to the user's work, so a model can put it to
    the user. `warning` may be a function of the call's arguments when
    the numbers matter ("all 120 unlabeled messages").

    A tool that is not destructive but can be, depending on its
    arguments, checks `confirm` itself and says when in `confirm_when`;
    any other tool taking `confirm` is refused at registration.
    """
    tag_set = frozenset((tags,) if isinstance(tags, str) else tags)
    if not tag_set:
        raise ValueError("a tool needs at least one tag")

    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        tool_name = name or fn.__name__
        origin = f"{fn.__module__}.{fn.__qualname__}"
        takes_confirm = "confirm" in inspect.signature(fn).parameters
        if destructive and not takes_confirm:
            raise ValueError(
                f"MCP tool {tool_name!r} is destructive, so it must take "
                "a `confirm` parameter"
            )
        if takes_confirm and not (destructive or confirm_when):
            raise ValueError(
                f"MCP tool {tool_name!r} takes `confirm` but is not marked "
                "destructive, nor says in `confirm_when` when it asks"
            )
        if not read_only and not _returns_a_dict(fn):
            raise ValueError(
                f"MCP tool {tool_name!r} writes, so it must return a dict "
                f"for `{NOT_PUBLISHED}` to go in"
            )
        guard = _confirm_guard(fn, tool_name, warning) if destructive else None
        wrapped = _attributed(fn, tool_name, guard, writes=not read_only)
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



def _returns_a_dict(fn: Callable[..., Any]) -> bool:
    returns = inspect.signature(fn).return_annotation
    return returns is dict or str(returns).startswith(("dict", "Dict"))


def _not_published(result: dict[str, Any]) -> dict[str, Any]:
    return {**result, NOT_PUBLISHED: NOT_PUBLISHED_NOTE}


def _confirm_guard(
    fn: Callable[..., Any],
    tool_name: str,
    warning: str | Callable[..., str] | None,
) -> Callable[..., None]:
    """A check that refuses a call without `confirm=true`, run before
    the tool body whatever that body does."""
    signature = inspect.signature(fn)

    def require_confirm(*args: Any, **kwargs: Any) -> None:
        bound = signature.bind_partial(*args, **kwargs)
        bound.apply_defaults()
        if bound.arguments.get("confirm") is True:
            return
        raise confirm_required(_warning_text(tool_name, warning, bound.arguments))

    return require_confirm


def _warning_text(
    tool_name: str,
    warning: str | Callable[..., str] | None,
    arguments: dict[str, Any],
) -> str:
    if isinstance(warning, str):
        return warning
    if warning is not None:
        # A warning that counts what is at stake reads the user's data,
        # and the arguments may name nothing that exists. The call is
        # refused either way; only the detail is lost.
        try:
            return warning(**arguments)
        except Exception:  # noqa: BLE001
            log.warning("%s: its warning could not be worded", tool_name, exc_info=True)
    return f"{tool_name} can lose the user's work."


def _attributed(
    fn: Callable[..., Any],
    tool_name: str,
    require_confirm: Callable[..., None] | None = None,
    *,
    writes: bool = False,
) -> Callable[..., Any]:
    """Tag everything a tool publishes on the event bus as coming from
    MCP, naming the tool, and report a `Refusal` from anywhere under the
    tool as a `ToolError` with its code and details.

    The renderer ignores changes it made itself and reloads for
    everything else, so a write has to say where it came from — and
    "the set you have open just changed" is far more useful to a user
    when it can name `set_description` as the cause. A refusal reads
    the same to a model as to the window (`refusals`).

    `require_confirm`, when given, runs first and refuses the call
    before the tool body can. A tool that `writes` gets the
    `NOT_PUBLISHED` note in its result.
    """
    finish = _not_published if writes else (lambda result: result)

    if inspect.iscoroutinefunction(fn):

        @functools.wraps(fn)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            with events.origin(f"mcp:{tool_name}"):
                try:
                    if require_confirm is not None:
                        await run_in_threadpool(require_confirm, *args, **kwargs)
                    return finish(await fn(*args, **kwargs))
                except Refusal as exc:
                    raise ToolError.from_refusal(exc) from exc

        return async_wrapper

    # A call is one change to the window, however many files it writes
    # (an import of several images, a Backup and its name). Only the
    # quick ones: a streaming tool (a Pull, Back up all) groups its own.
    def call(*args: Any, **kwargs: Any) -> Any:
        with events.origin(f"mcp:{tool_name}"), events.coalesced():
            try:
                if require_confirm is not None:
                    require_confirm(*args, **kwargs)
                return finish(fn(*args, **kwargs))
            except Refusal as exc:
                raise ToolError.from_refusal(exc) from exc

    return _off_loop(fn, call)


def _off_loop(
    fn: Callable[..., Any], call: Callable[..., Any] | None = None
) -> Callable[..., Any]:
    """An async stand-in for the sync `fn` that runs `call` (default:
    `fn`) in the threadpool. `functools.wraps` carries the name,
    docstring and signature FastMCP builds the schema from."""
    run = call or fn

    @functools.wraps(fn)
    async def in_threadpool(*args: Any, **kwargs: Any) -> Any:
        return await run_in_threadpool(run, *args, **kwargs)

    return in_threadpool


def registered_tools(tags: frozenset[str] | None = None) -> list[ToolSpec]:
    """Every registered tool, or only those carrying one of `tags`."""
    if tags is None:
        return list(_TOOLS)
    return [spec for spec in _TOOLS if spec.tags & tags]


def hidden_tools() -> frozenset[str]:
    """The tools no endpoint lists or runs right now: the Log-text
    tools, while the user has not turned them on.

    Read on every listing and call rather than when the servers are
    built, so the switch reaches a connected client on its next listing.
    """
    from services import settings as settings_service

    if settings_service.log_text_over_mcp():
        return frozenset()
    return frozenset(spec.name for spec in _TOOLS if TAG_LOG_TEXT in spec.tags)


def listed_tools(tags: frozenset[str] | None = None) -> list[ToolSpec]:
    """The tools an endpoint serving `tags` lists right now."""
    hidden = hidden_tools()
    return [spec for spec in registered_tools(tags) if spec.name not in hidden]


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
                fn=fn if inspect.iscoroutinefunction(fn) else _off_loop(fn),
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
