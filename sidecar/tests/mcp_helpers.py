"""Test helpers for driving the MCP server the way a client does.

Two levels, both used by the `test_mcp_*` modules:

* `mcp_client(...)` speaks the protocol over an in-memory transport —
  the same `ClientSession` LM Studio and Claude Code use, minus HTTP.
  This is how individual tools are exercised.
* `json_rpc(...)` speaks raw JSON-RPC over the real ASGI stack, which
  is what proves the `/mcp` mount, the session handshake and the
  DNS-rebinding guard actually work.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any

from mcp import ClientSession
from mcp.shared.memory import create_connected_server_and_client_session

MCP_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}


@asynccontextmanager
async def mcp_client(suffix: str = ""):
    """A connected `ClientSession` for one of the three endpoints.

    `suffix` is "" (everything), "character" or "logs".
    """
    import server

    fastmcp = server._MCP_SERVERS[suffix]
    async with create_connected_server_and_client_session(
        fastmcp, raise_exceptions=False
    ) as session:
        yield session


async def server_instructions(suffix: str = "") -> str:
    """The instructions an endpoint hands a client when it connects:
    the first thing a model reads about the app.

    `ClientSession` does not keep its `initialize` answer, so this
    catches it on the way past.
    """
    answers: list[Any] = []
    initialize = ClientSession.initialize

    async def keeping_the_answer(self: ClientSession):  # noqa: ANN202
        answer = await initialize(self)
        answers.append(answer)
        return answer

    ClientSession.initialize = keeping_the_answer  # type: ignore[method-assign]
    try:
        async with mcp_client(suffix):
            pass
    finally:
        ClientSession.initialize = initialize  # type: ignore[method-assign]
    return answers[0].instructions or ""


async def call_tool(session: ClientSession, tool: str, /, **arguments: Any):
    """Call a tool and return `(result, parsed_json_or_text)`.

    Tools return dicts, which the SDK serialises into a text block of
    JSON plus `structuredContent`. Tests mostly want the dict.

    The first two parameters are positional-only so a tool argument
    called `name` or `session` doesn't collide with them.
    """
    result = await session.call_tool(tool, arguments)
    if result.structuredContent is not None:
        return result, result.structuredContent
    texts = [c.text for c in result.content if getattr(c, "type", None) == "text"]
    joined = "\n".join(texts)
    try:
        return result, json.loads(joined)
    except ValueError:
        return result, joined


def allow_log_text(on: bool = True) -> None:
    """Turn the Settings → MCP switch for Log-text tools on (or off),
    through the settings service as the window does.

    Only in a test's own data folder: the switch is stored in
    settings.db, and a test must never change the user's.
    """
    import os

    from services import settings as settings_service

    assert os.environ.get("FLIST_WORKBENCH_DATA_DIR"), (
        "point FLIST_WORKBENCH_DATA_DIR at a temp folder first"
    )
    settings_service.update({"mcp.log_text": on})


def tool_error_text(result: Any) -> str:
    """The error message of a failed tool call, for asserting on the
    structured `code:` prefix from `_context.ToolError`."""
    assert result.isError, "expected the tool call to fail"
    return "\n".join(
        c.text for c in result.content if getattr(c, "type", None) == "text"
    )


def json_rpc(
    client: Any,
    path: str,
    method: str,
    params: dict[str, Any] | None = None,
    *,
    headers: dict[str, str] | None = None,
    request_id: int = 1,
):
    """POST one JSON-RPC request through a FastAPI TestClient."""
    body = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        body["params"] = params
    return client.post(
        path, json=body, headers={**MCP_HEADERS, **(headers or {})}
    )


def initialize_params() -> dict[str, Any]:
    return {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "pytest", "version": "1"},
    }
