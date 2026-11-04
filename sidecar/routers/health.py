"""Health, shutdown, the event stream and the MCP endpoint description."""

from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

import workbench_mcp
from refusals import NotStoppable
from services import events as event_bus
from services import lifecycle, sse
from wire import WireModel, event_stream

router = APIRouter()


class Health(WireModel):
    """The sidecar answers, and which app version started it."""

    status: Literal["ok"]
    version: str


class ShutdownStarted(WireModel):
    stopping: bool


class McpEndpoint(WireModel):
    """One MCP endpoint the sidecar serves. `all` carries every tool;
    the narrow ones exist because small local models choke on long
    tool lists."""

    id: Literal["all", "character", "logs", "classify"]
    label: str
    path: str
    url: str
    tool_count: int


class McpAuth(WireModel):
    """The optional bearer token for the MCP endpoints; off by default."""

    required: bool
    token: str | None


class McpInfo(WireModel):
    port: int
    endpoints: list[McpEndpoint]
    auth: McpAuth


class McpToken(WireModel):
    token: str


class McpTokenRevoked(WireModel):
    required: bool


@router.get("/health")
def health(request: Request) -> Health:
    return Health(status="ok", version=request.app.version)


@router.post("/shutdown", status_code=202)
def shutdown() -> ShutdownStarted:
    """The app asks its sidecar to stop (at quit, or to replace it).

    Needs the launch secret like every other route (ADR 0002): a web
    page that can reach the port must not be able to stop it. The
    answer goes out first; open requests then get
    `lifecycle.GRACEFUL_SHUTDOWN_S` and the process exits.
    """
    if not lifecycle.request_stop():
        raise NotStoppable()
    return ShutdownStarted(stopping=True)


@router.get(
    "/events",
    response_class=StreamingResponse,
    responses=event_stream("Change hints, `{event, at, ...ids}` per event."),
)
async def events_stream(request: Request) -> StreamingResponse:
    """Server-sent stream of changes to shared state.

    The renderer holds one of these open for the life of the window.
    It exists because the window is no longer the only writer: a model
    connected over MCP edits the same Workbench, and without this
    the window would keep showing a stale draft and then autosave it
    back over the model's work.

    Events are hints — `{event, at, ...ids}`. The renderer re-reads
    through the normal endpoints when one arrives.
    """

    async def producer():
        import asyncio

        async with event_bus.subscribe() as sub:
            # Announce immediately so the client knows the stream is
            # live rather than merely connected.
            yield sse.event("ready", {"subscribers": event_bus.subscriber_count()})
            while True:
                if await request.is_disconnected():
                    return
                try:
                    payload = await asyncio.wait_for(sub.queue.get(), timeout=20.0)
                except asyncio.TimeoutError:
                    # A comment frame keeps proxies and the renderer's
                    # own read timeout from treating idle as dead.
                    yield b": keep-alive\n\n"
                    continue
                yield sse.event(payload["event"], payload)

    return StreamingResponse(
        producer(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/mcp-info")
def mcp_info(request: Request) -> McpInfo:
    """What the MCP endpoints are and how many tools each carries.

    Powers Settings → MCP. Deliberately *not* under /mcp — that prefix
    belongs to the protocol itself, and this is a plain REST read for
    the renderer.
    """
    return McpInfo.model_validate(
        workbench_mcp.describe(request.app.state.mcp_servers, request.app.state.sidecar_port)
    )


@router.post("/mcp-info/token")
def mcp_token_create() -> McpToken:
    """Issue a bearer token for the MCP endpoints, replacing any
    existing one. Clients using the old token stop working.

    Off by default — see `services/mcp_auth.py` for why. The token is
    returned once here and again from `/mcp-info`, because the user has
    to be able to copy it into a client config at any point.
    """
    from services import mcp_auth

    return McpToken(token=mcp_auth.generate())


@router.delete("/mcp-info/token")
def mcp_token_revoke() -> McpTokenRevoked:
    """Turn the MCP bearer requirement back off."""
    from services import mcp_auth

    mcp_auth.revoke()
    return McpTokenRevoked(required=False)
