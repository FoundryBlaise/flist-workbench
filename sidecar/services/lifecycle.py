"""How the sidecar process runs and how the app stops it.

Electron owns the process: it starts `server.py` with a port and a
launch secret, and at quit it asks `POST /shutdown` (with that secret)
rather than killing it, so the server loop ends the way Ctrl+C would:
open requests get a few seconds, the lifespan's shutdown runs, and the
process exits on its own. Electron kills it only when that takes too
long (electron/sidecar.ts).
"""

from __future__ import annotations

from typing import Any

#: How long open requests (the window's event stream, the render
#: long-poll) may keep running once a stop is asked for, in seconds.
#: Electron waits a little longer than this before it kills.
GRACEFUL_SHUTDOWN_S = 1

_server: Any = None


def serve(app: Any, port: int) -> None:
    """Run `app` on 127.0.0.1:`port` until a stop is asked for."""
    import uvicorn

    global _server
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level="info",
        timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_S,
    )
    _server = uvicorn.Server(config)
    try:
        _server.run()
    finally:
        _server = None


def request_stop() -> bool:
    """End the server loop `serve` runs. False when there is none: the
    app was mounted some other way (tests, a hand-started uvicorn)."""
    if _server is None:
        return False
    _server.should_exit = True
    return True
