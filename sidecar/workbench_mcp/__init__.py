"""The Model Context Protocol server(s) exposed by the sidecar.

Everything the Workbench UI can do is reachable here as a tool, so a
local model (LM Studio) or Claude can edit profiles, read logs and
drive classification without touching the UI. See docs/MCP_DESIGN.md.

Three endpoints are served, all built from the same tool
implementations and differing only in which tags they include:

    /mcp             everything
    /mcp/character   profile editing only
    /mcp/logs        logs, labels, classification, retrieval

The package is deliberately *not* called `mcp`: `sidecar/` is on
`sys.path`, so that name would shadow the MCP SDK itself.

Note on the library choice: this uses the reference SDK's bundled
FastMCP (`mcp.server.fastmcp`) rather than the third-party `fastmcp`
2.x package the design doc first picked — see the dependency comment
in `pyproject.toml` for why.
"""

from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.prompts import Prompt
from mcp.server.fastmcp.server import StreamableHTTPASGIApp
from mcp.server.transport_security import TransportSecuritySettings
from starlette.routing import Route

from ._registry import (
    TAG_CHARACTER,
    TAG_CORE,
    TAG_LOGS,
    registered_prompts,
    registered_resources,
    registered_tools,
)

if TYPE_CHECKING:  # pragma: no cover
    from fastapi import FastAPI

#: Mount suffix → the tags that endpoint serves. `""` is the full
#: server mounted at `/mcp`.
ENDPOINTS: dict[str, frozenset[str] | None] = {
    "": None,
    "character": frozenset({TAG_CORE, TAG_CHARACTER}),
    "logs": frozenset({TAG_CORE, TAG_LOGS}),
}

_INSTRUCTIONS = """\
F-list Workbench is a local desktop tool for editing F-list character
profiles offline, and for reading the user's own F-Chat logs.

Two things to keep straight:

1. Workbench NEVER writes to f-list.net. Every tool here changes local
   files only. When the user wants a profile published they review it
   in the Workbench window and upload it themselves in the browser.
   Never tell the user a change is live on F-list.
2. `live` is the last profile pulled down from F-list and is
   read-only. All editing happens in a "working set" — a named local
   draft. If a character has no active working set, create one.

Characters and sets are addressed by name; ids also work.
"""


def _build(name: str, tags: frozenset[str] | None) -> FastMCP:
    """Create one server and register the tools matching `tags`."""
    server = FastMCP(
        name=name,
        instructions=_INSTRUCTIONS,
        # The sub-app is mounted under /mcp[...] by `mount()`, so its
        # own route must sit at the mount root or the path would come
        # out as /mcp/mcp.
        streamable_http_path="/",
        # Loopback only, and refuse a browser page on another origin
        # from driving the endpoint (DNS-rebinding protection).
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=[
                "127.0.0.1",
                "127.0.0.1:*",
                "localhost",
                "localhost:*",
                "[::1]",
                "[::1]:*",
            ],
            allowed_origins=[
                "http://127.0.0.1:*",
                "http://localhost:*",
                "http://[::1]:*",
            ],
        ),
    )

    for spec in registered_tools(tags):
        server.add_tool(
            spec.fn,
            name=spec.name,
            title=spec.title,
            annotations=spec.annotations,
            structured_output=spec.structured_output,
        )
    for prompt_spec in registered_prompts(tags):
        server.add_prompt(
            Prompt.from_function(
                prompt_spec.fn,
                name=prompt_spec.name,
                description=prompt_spec.description,
            )
        )
    for res in registered_resources(tags):
        # The decorator form handles both fixed URIs and templates
        # (`workbench://character/{name}/live`), which `add_resource`
        # does not.
        server.resource(
            res.uri,
            name=res.name,
            description=res.description,
            mime_type=res.mime_type,
        )(res.fn)
    return server


def build_mcp_servers() -> dict[str, FastMCP]:
    """Build every MCP endpoint. Importing the tool modules here is
    what populates the registry."""
    from . import (  # noqa: F401  (registration side effects)
        tools_logs,
        tools_rag,
        tools_session,
        tools_sets,
    )

    return {
        suffix: _build(_server_name(suffix), tags)
        for suffix, tags in ENDPOINTS.items()
    }


def _server_name(suffix: str) -> str:
    return "flist-workbench" if not suffix else f"flist-workbench-{suffix}"


def _session_manager(server: FastMCP):  # noqa: ANN202
    """The server's StreamableHTTP session manager.

    It is built lazily on the first `streamable_http_app()` call and
    the property raises until then, so force it once. The Starlette
    app that call returns is discarded — see `mount()`.
    """
    server.streamable_http_app()
    return server.session_manager


def endpoint_path(suffix: str) -> str:
    return "/mcp" if not suffix else f"/mcp/{suffix}"


def mount(app: "FastAPI", servers: dict[str, FastMCP]) -> None:
    """Attach every MCP server to the sidecar app.

    Routes, not mounts. A Starlette `Mount("/mcp")` never matches the
    bare path `/mcp` — its pattern requires something after the prefix
    — so the router answers with a 307 to `/mcp/`, and not every MCP
    client follows a redirect on POST. Clients are configured with
    `http://127.0.0.1:27384/mcp`, so that exact path has to answer.

    The raw ASGI handler is used rather than `streamable_http_app()`
    for the same reason (that wrapper is itself a redirecting router).
    Transport security is configured on the session manager, so
    nothing is lost by skipping it.

    Each endpoint is registered with and without a trailing slash;
    every MCP verb (POST for calls, GET for the SSE stream, DELETE to
    end a session) hits the same handler.
    """
    for suffix, server in servers.items():
        asgi = StreamableHTTPASGIApp(_session_manager(server))
        path = endpoint_path(suffix)
        app.router.routes.append(Route(path, endpoint=asgi))
        app.router.routes.append(Route(f"{path}/", endpoint=asgi))


def describe(servers: dict[str, FastMCP], port: int) -> dict[str, object]:
    """What the Settings → MCP pane shows: one row per endpoint with
    its URL and tool count, plus ready-to-paste client config."""
    endpoints = []
    for suffix, server in servers.items():
        path = endpoint_path(suffix)
        endpoints.append(
            {
                "id": suffix or "all",
                "label": _ENDPOINT_LABELS[suffix],
                "path": path,
                "url": f"http://127.0.0.1:{port}{path}",
                "tool_count": len(registered_tools(ENDPOINTS[suffix])),
            }
        )
    return {"port": port, "endpoints": endpoints}


_ENDPOINT_LABELS = {
    "": "Everything",
    "character": "Character editing only",
    "logs": "Logs, labels and retrieval only",
}


@contextlib.asynccontextmanager
async def session_manager_lifespan(
    servers: dict[str, FastMCP],
) -> AsyncIterator[None]:
    """Run every mounted server's session manager.

    Without this the endpoints accept connections and then fail with
    "Task group is not initialized" on the first request — the single
    most common way to get an MCP mount wrong.
    """
    async with contextlib.AsyncExitStack() as stack:
        for server in servers.values():
            await stack.enter_async_context(_session_manager(server).run())
        yield
