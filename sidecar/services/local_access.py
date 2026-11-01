"""Who may talk to the sidecar (ADR 0002).

Binding to 127.0.0.1 keeps other machines out, not other web pages:
every page open in the user's browser can send requests to the port,
and a DNS-rebinding page can do so from an origin of its own. So the
sidecar trusts exactly two callers:

- the app window, which carries the launch secret Electron generates
  per start (`FLIST_WORKBENCH_LAUNCH_SECRET`; Electron's main process
  adds the header to the window's requests, so images and the event
  stream carry it too);
- the paired browser extension, which carries its pairing token on its
  own routes under `/restore/`.

MCP clients are a third kind of caller with their own optional bearer
(`workbench_mcp._TokenGate`); `/mcp` only gets the Host check here.

One ASGI middleware decides, in this order: Host, then Origin (which
also answers CORS), then the credential. It runs before routing, so a
refused request never reaches a handler.
"""

from __future__ import annotations

import hmac
import json
import os
from typing import Any

SECRET_ENV = "FLIST_WORKBENCH_LAUNCH_SECRET"
#: Set by Electron in dev only: the Vite server the window loads from.
RENDERER_ORIGIN_ENV = "FLIST_WORKBENCH_RENDERER_ORIGIN"

SECRET_HEADER = b"x-workbench-secret"
PAIRING_HEADER = b"x-workbench-auth"

#: Callable without any credential. Starting a pairing has to be: the
#: extension holds nothing yet. Its status is keyed by an unguessable id.
OPEN_ROUTES = frozenset(
    {
        ("GET", "/health"),
        ("POST", "/restore/handshake"),
        ("GET", "/restore/handshake-status"),
    }
)

#: The extension's routes: its pairing token, never the launch secret.
#: Everything else under /restore/ (approving a pairing, revoking it)
#: belongs to the app window.
EXTENSION_PATHS = frozenset(
    {
        "/restore/characters",
        "/restore/snapshots",
        "/restore/snapshot/fresh",
        "/restore/image-ids",
        "/restore/saved",
        "/restore/done",
    }
)
EXTENSION_PATH_PREFIXES = ("/restore/snapshot/",)

#: The built window loads from `app://workbench`, an origin of its own
#: (electron/appPage.ts). Builds from before that loaded from file://,
#: which browsers send as `Origin: null`; a sandboxed iframe on any site
#: sends that too. Either way this grants a CORS read, never trust: the
#: secret still decides.
_WINDOW_ORIGINS = frozenset({"app://workbench", "null"})
#: Open routes the app window never calls. They take no credential, so
#: `null` would let any sandboxed iframe start a pairing; only the
#: extension does, from f-list.net or chrome-extension://.
_NO_WINDOW_ORIGIN = frozenset({("POST", "/restore/handshake")})
_FLIST_ORIGIN = "https://www.f-list.net"
#: An unpacked extension's id depends on the folder it was loaded from,
#: so it cannot be pinned. The pairing token is what identifies it.
_EXTENSION_SCHEME = "chrome-extension://"

_ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE"


def launch_secret() -> str | None:
    return os.environ.get(SECRET_ENV) or None


def require_configured() -> None:
    """Refuse to serve without a secret, rather than serve everyone."""
    if launch_secret() is None:
        raise RuntimeError(
            f"{SECRET_ENV} is not set. F-list Workbench starts the sidecar with a "
            "fresh secret; to run it by hand, set the variable to any value "
            "and send it as the X-Workbench-Secret header."
        )


def _is_mcp(path: str) -> bool:
    return path == "/mcp" or path.startswith("/mcp/")


def _is_extension_route(path: str) -> bool:
    return path in EXTENSION_PATHS or path.startswith(EXTENSION_PATH_PREFIXES)


def _extension_may_call(method: str, path: str) -> bool:
    if _is_extension_route(path):
        return True
    return (method, path) in OPEN_ROUTES and path.startswith("/restore/")


def _origin_allowed(origin: str, method: str, path: str) -> bool:
    if origin in _WINDOW_ORIGINS:
        return (method, path) not in _NO_WINDOW_ORIGIN
    dev = os.environ.get(RENDERER_ORIGIN_ENV)
    if dev and origin == dev.rstrip("/"):
        return True
    if _extension_may_call(method, path):
        return origin == _FLIST_ORIGIN or origin.startswith(_EXTENSION_SCHEME)
    return False


def _matches(given: str | None, expected: str | None) -> bool:
    if not given or not expected:
        return False
    return hmac.compare_digest(given.encode(), expected.encode())


def _credential_ok(method: str, path: str, headers: dict[bytes, str]) -> bool:
    if (method, path) in OPEN_ROUTES:
        return True
    if _is_extension_route(path):
        import restore

        return restore.auth_token_valid(headers.get(PAIRING_HEADER))
    return _matches(headers.get(SECRET_HEADER), launch_secret())


class LocalAccessGuard:
    """ASGI middleware enforcing the rules above on every HTTP request."""

    def __init__(self, app: Any, port: int) -> None:
        self.app = app
        self._hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {
            key.lower(): value.decode("latin-1") for key, value in scope["headers"]
        }
        method, path = scope["method"], scope["path"]

        if headers.get(b"host") not in self._hosts:
            await _refuse(send, 403, "forbidden_host", "Unknown Host header.")
            return
        if _is_mcp(path):
            await self.app(scope, receive, send)
            return

        origin = headers.get(b"origin")
        preflight = method == "OPTIONS" and b"access-control-request-method" in headers
        if preflight:
            requested = headers[b"access-control-request-method"].upper()
            if origin is None or not _origin_allowed(origin, requested, path):
                await _refuse(send, 403, "forbidden_origin", "Origin not allowed.")
                return
            await _send_preflight(send, origin, headers)
            return
        if origin is not None and not _origin_allowed(origin, method, path):
            await _refuse(send, 403, "forbidden_origin", "Origin not allowed.")
            return

        if not _credential_ok(method, path, headers):
            await _refuse(
                send,
                401,
                "unauthorized",
                "This route answers only the app window or the paired extension.",
                origin,
            )
            return

        if origin is None:
            await self.app(scope, receive, send)
            return

        async def send_with_cors(message: dict) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                message["headers"] = [
                    *message["headers"],
                    *_cors_headers(origin),
                ]
            await send(message)

        await self.app(scope, receive, send_with_cors)


def _cors_headers(origin: str) -> list[tuple[bytes, bytes]]:
    return [
        (b"access-control-allow-origin", origin.encode("latin-1")),
        (b"vary", b"Origin"),
    ]


async def _send_preflight(send: Any, origin: str, headers: dict[bytes, str]) -> None:
    response_headers = [
        *_cors_headers(origin),
        (b"access-control-allow-methods", _ALLOWED_METHODS.encode()),
        (b"access-control-max-age", b"600"),
        (b"content-length", b"0"),
    ]
    requested = headers.get(b"access-control-request-headers")
    if requested:
        response_headers.append(
            (b"access-control-allow-headers", requested.encode("latin-1"))
        )
    await send({"type": "http.response.start", "status": 200, "headers": response_headers})
    await send({"type": "http.response.body", "body": b""})


async def _refuse(
    send: Any, status: int, code: str, message: str, origin: str | None = None
) -> None:
    body = json.dumps({"code": code, "message": message}).encode()
    response_headers = [
        (b"content-type", b"application/json"),
        (b"content-length", str(len(body)).encode()),
    ]
    # An allowed caller with a bad credential should be able to read why.
    if origin is not None:
        response_headers.extend(_cors_headers(origin))
    await send({"type": "http.response.start", "status": status, "headers": response_headers})
    await send({"type": "http.response.body", "body": body})
