"""Broker between an MCP tool that wants a picture and the app that
can draw one.

The sidecar cannot rasterise HTML: it is a frozen Python binary, and
giving it that ability means shipping a browser engine inside it. The
Electron app next door already is one, and already owns the BBCode
renderer and the preview stylesheet, so it draws and we hand the
result on.

The app long-polls `next_request`; a tool call parks on a future until
the PNG comes back through `deliver`. Deliberately small: one request
at a time is plenty for a human-driven editing session, there is no
queue to grow unbounded, and a request that nobody collects expires
instead of lingering.

If the window is not running there is nothing to draw with, and the
tool says so rather than timing out silently — `window_attached`
exists for that answer.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

#: How long after its last long-poll we still believe the window is
#: there. The app polls on a ~25 s cycle, so this allows one missed
#: round trip before we call it gone.
WINDOW_TIMEOUT_SEC = 70.0

#: A request nobody has collected is dropped after this. Guards against
#: a tool call that was cancelled client-side leaving work behind.
REQUEST_TTL_SEC = 120.0


@dataclass
class RenderRequest:
    id: str
    #: The BBCode to draw. Resolved here rather than in the app: which
    #: working set counts as "the Workbench" is the sidecar's business,
    #: and the window should not have to agree with it separately.
    bbcode: str
    #: `[img=ID]` needs a manifest to build a CDN URL from an id.
    inlines: dict[str, Any]
    theme: str
    width: int
    #: For the app's log line only.
    label: str = ""
    created_at: float = field(default_factory=time.time)

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "bbcode": self.bbcode,
            "inlines": self.inlines,
            "theme": self.theme,
            "width": self.width,
            "label": self.label,
        }


_pending: list[RenderRequest] = []
_futures: dict[str, asyncio.Future] = {}
_last_poll_at: float = 0.0

# Bound lazily to whichever loop is running. A module-level
# asyncio.Event() attaches itself to the first loop that touches it and
# then refuses every other one — fine while the sidecar has exactly one
# loop for its whole life, and a landmine the moment anything restarts
# it.
_arrival: asyncio.Event | None = None
_arrival_loop: asyncio.AbstractEventLoop | None = None


def _arrival_event() -> asyncio.Event:
    global _arrival, _arrival_loop
    loop = asyncio.get_running_loop()
    if _arrival is None or _arrival_loop is not loop:
        _arrival = asyncio.Event()
        _arrival_loop = loop
    return _arrival


def window_attached() -> bool:
    """Has the app long-polled recently enough to believe it is there?"""
    return (time.time() - _last_poll_at) < WINDOW_TIMEOUT_SEC


def note_poll() -> None:
    global _last_poll_at
    _last_poll_at = time.time()


def _expire() -> None:
    cutoff = time.time() - REQUEST_TTL_SEC
    stale = [r for r in _pending if r.created_at < cutoff]
    for r in stale:
        _pending.remove(r)
        fut = _futures.pop(r.id, None)
        if fut is not None and not fut.done():
            fut.set_exception(TimeoutError("render request expired"))


async def request(
    *,
    bbcode: str,
    inlines: dict[str, Any] | None = None,
    theme: str,
    width: int,
    label: str = "",
    timeout: float = 45.0,
) -> tuple[bytes, str]:
    """Ask the app to draw a profile; wait for the picture.

    Returns the bytes and their media type: the app falls back from PNG
    to JPEG when a profile renders into megabytes, because the picture
    travels to the model as base64 and an oversized tool result is
    refused outright.

    Raises TimeoutError when the app never answers — which, with
    `window_attached` checked first, means the render itself hung
    rather than nobody being home.
    """
    _expire()
    req = RenderRequest(
        id=uuid.uuid4().hex,
        bbcode=bbcode,
        inlines=inlines or {},
        theme=theme,
        width=width,
        label=label,
    )
    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()
    _futures[req.id] = fut
    _pending.append(req)
    _arrival_event().set()
    try:
        return await asyncio.wait_for(fut, timeout=timeout)
    finally:
        _futures.pop(req.id, None)
        if req in _pending:
            _pending.remove(req)


async def next_request(timeout: float = 25.0) -> RenderRequest | None:
    """The app's long-poll. Returns a request to draw, or None when the
    wait elapsed with nothing to do."""
    note_poll()
    _expire()
    if _pending:
        return _pending[0]
    arrival = _arrival_event()
    arrival.clear()
    try:
        await asyncio.wait_for(arrival.wait(), timeout=timeout)
    except (TimeoutError, asyncio.TimeoutError):
        return None
    note_poll()
    return _pending[0] if _pending else None


def deliver(request_id: str, png: bytes, mime: str = "image/png") -> bool:
    """Hand a finished picture to whoever is waiting. False when nobody
    is — a late answer to a request that already gave up."""
    fut = _futures.get(request_id)
    if fut is None or fut.done():
        return False
    fut.set_result((png, mime))
    return True


def fail(request_id: str, message: str) -> bool:
    """Report that the app could not draw this one."""
    fut = _futures.get(request_id)
    if fut is None or fut.done():
        return False
    fut.set_exception(RuntimeError(message))
    return True


def reset() -> None:
    """Test seam: drop all state between cases."""
    global _last_poll_at, _arrival, _arrival_loop
    _arrival = None
    _arrival_loop = None
    _pending.clear()
    for fut in _futures.values():
        if not fut.done():
            fut.cancel()
    _futures.clear()
    _last_poll_at = 0.0
