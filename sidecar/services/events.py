"""A broadcast bus so the window notices what MCP changed.

Before this, the Workbench window was the only writer, so it always
knew the current state of anything it displayed. Now a model can edit
the same working set at the same time, and the window has no idea —
it keeps showing a stale draft until the user reloads, and worse, its
next autosave writes the stale version back over the model's edit.

Anything that changes shared state publishes here; the renderer holds
one `GET /events` stream open and reacts. Events are hints, not data:
they carry enough to decide whether a reload is needed, and the
renderer re-reads through the normal endpoints.

Deliberately lossy. A subscriber that falls behind drops the oldest
events rather than growing without bound — the renderer's response to
any of these is "re-read", so missing one of a burst costs nothing.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Iterator

#: Event names. The renderer switches on these.
SET_PAYLOAD_CHANGED = "set-payload-changed"
SETS_CHANGED = "sets-changed"
ACTIVE_SET_CHANGED = "active-set-changed"
LIVE_CHANGED = "live-changed"
LABELS_CHANGED = "labels-changed"
SETTINGS_CHANGED = "settings-changed"
INDEX_CHANGED = "index-changed"

#: Who caused the change. The renderer ignores its own writes — it
#: already has that state — and reacts to everything else. Set by the
#: MCP layer for the duration of a tool call; REST requests leave the
#: default, because the window is the only thing that calls those.
_origin: contextvars.ContextVar[str] = contextvars.ContextVar("origin", default="ui")


@contextlib.contextmanager
def origin(name: str) -> Iterator[None]:
    """Attribute everything published in this block to `name`."""
    token = _origin.set(name)
    try:
        yield
    finally:
        _origin.reset(token)


def current_origin() -> str:
    return _origin.get()


#: Per-subscriber buffer. A renderer that stops reading — a paused
#: debugger, a backgrounded window — must not hold memory hostage.
QUEUE_LIMIT = 64


# `eq=False` keeps the default identity hash: subscribers live in a set
# and two of them are never "the same" just because their queues match.
@dataclass(eq=False)
class _Subscriber:
    queue: asyncio.Queue[dict[str, Any]] = field(
        default_factory=lambda: asyncio.Queue(maxsize=QUEUE_LIMIT)
    )
    dropped: int = 0


_subscribers: set[_Subscriber] = set()

#: The loop the bus belongs to. `publish` is called from worker threads
#: (the ingest job) as well as from request handlers, so a thread-safe
#: hand-off needs to know where to schedule.
_loop: asyncio.AbstractEventLoop | None = None


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Remember the sidecar's event loop. Called once from the lifespan."""
    global _loop
    _loop = loop


def publish(event: str, **data: Any) -> None:
    """Announce a change. Safe to call from any thread, and from code
    with no subscribers — publishing is never worth failing a write
    for."""
    payload = {
        "event": event,
        "at": time.time(),
        "origin": _origin.get(),
        **data,
    }
    loop = _loop
    if loop is None or loop.is_closed():
        return
    try:
        if asyncio.get_running_loop() is loop:
            _fan_out(payload)
            return
    except RuntimeError:
        pass  # not on a loop at all — a worker thread
    try:
        loop.call_soon_threadsafe(_fan_out, payload)
    except RuntimeError:
        # The loop shut down between the check and the call.
        pass


def _fan_out(payload: dict[str, Any]) -> None:
    for sub in list(_subscribers):
        try:
            sub.queue.put_nowait(payload)
        except asyncio.QueueFull:
            # Drop the oldest: the newest event is the one that
            # describes the current state.
            with contextlib.suppress(asyncio.QueueEmpty):
                sub.queue.get_nowait()
            sub.dropped += 1
            with contextlib.suppress(asyncio.QueueFull):
                sub.queue.put_nowait(payload)


@contextlib.asynccontextmanager
async def subscribe() -> AsyncIterator[_Subscriber]:
    """Register for events for the duration of the block.

    No lock: the set is only ever touched from the sidecar's own loop,
    and `add`/`discard` are atomic. That also keeps the cleanup path
    free of `await`, which matters — it runs while the task is being
    cancelled, and awaiting a lock there is how a disconnecting client
    ends up hanging the response instead of closing it.
    """
    sub = _Subscriber()
    _subscribers.add(sub)
    try:
        yield sub
    finally:
        _subscribers.discard(sub)


def subscriber_count() -> int:
    return len(_subscribers)
