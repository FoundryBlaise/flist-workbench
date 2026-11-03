"""A broadcast bus so the window notices what MCP changed.

Before this, the app window was the only writer, so it always
knew the current state of anything it displayed. Now a model can edit
the same Workbench at the same time, and the window has no idea —
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

#: Event names. The renderer switches on these. The two Workbench
#: events keep the names they had when a character held several drafts:
#: the payload changed (with its new etag), and its "last changed" moved.
SET_PAYLOAD_CHANGED = "set-payload-changed"
SETS_CHANGED = "sets-changed"
LIVE_CHANGED = "live-changed"
LABELS_CHANGED = "labels-changed"
SETTINGS_CHANGED = "settings-changed"
INDEX_CHANGED = "index-changed"
#: Files were added to (or taken from) a character's image folder, so
#: the window's pool listing is stale even if no payload changed.
IMAGES_CHANGED = "images-changed"
#: A character's Backup list changed: a Backup written, named, moved to
#: or from the Trash, or deleted from the Trash for good.
BACKUPS_CHANGED = "backups-changed"
#: The character list changed: a character came into the archive, or
#: its name (and with it its folder) changed on F-list.
CHARACTERS_CHANGED = "characters-changed"

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


@dataclass(eq=False)
class _Held:
    """The events a `coalesced` block holds back, by what they are
    about. Closed once the block has sent them: a task the block
    started outlives it with the block's context, and what that task
    publishes later must go out, not into a list nobody sends."""

    events: dict[tuple, dict[str, Any]] = field(default_factory=dict)
    open: bool = True


#: The innermost `coalesced` block's held events; None outside any.
_held: contextvars.ContextVar[_Held | None] = contextvars.ContextVar("held", default=None)


@contextlib.contextmanager
def coalesced() -> Iterator[None]:
    """Publish what this block changes once, when it ends.

    A Pull writes one file per picture and each write announces itself;
    without this the window would reload its pool once per picture. In
    the block, events about the same thing (name, character, Log
    conversation) collapse into the last of them, which describes the
    current state, and go out together at the end, also when the block
    fails partway: what landed did change. A nested block sends its own
    at its own end.
    """
    held = _Held()
    token = _held.set(held)
    try:
        yield
    finally:
        held.open = False
        try:
            _held.reset(token)
        except ValueError:
            # Closed from another context: an async generator finalised
            # by the loop rather than by its consumer.
            pass
        for payload in held.events.values():
            _send(payload)


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
    held = _held.get()
    if held is not None and held.open:
        key = (event, data.get("character_id"), data.get("character"), data.get("partner"))
        held.events.pop(key, None)
        held.events[key] = payload
        return
    _send(payload)


def _send(payload: dict[str, Any]) -> None:
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
