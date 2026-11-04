"""Rendering: the app draws, the sidecar hands the picture on."""

from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from refusals import InvalidRequest, UnsupportedType
from services import render as render_service
from wire import WireModel

router = APIRouter()


class PendingRender(WireModel):
    """Something a tool asked the app to draw: BBCode, the inline
    images it names, the preview theme and the width in pixels.
    `label` is for the app's log line only."""

    id: str
    bbcode: str
    inlines: dict[str, Any]
    theme: str
    width: int
    label: str


class RenderPoll(WireModel):
    #: Null when nothing came to draw before the poll's timeout.
    request: PendingRender | None


class RenderDelivered(WireModel):
    #: False when nobody waits for this picture any more.
    delivered: bool
    bytes: int
    mime: Literal["image/png", "image/jpeg"]


class RenderFailedRequest(BaseModel):
    """Why the app could not draw a picture; without one the caller
    hears a general reason."""

    message: str | None = None


class RenderFailReported(WireModel):
    #: False when nobody waits for this picture any more.
    reported: bool


@router.get("/render/requests")
async def render_next_request(timeout: float = 25.0) -> RenderPoll:
    """The app's long-poll for something to draw.

    Answering this is also how the app says "I am here": a tool asking
    for a picture checks that before it waits, so a model gets told the
    window is closed instead of sitting through a timeout.
    """
    req = await render_service.next_request(
        timeout=max(1.0, min(60.0, timeout))
    )
    return RenderPoll.model_validate({"request": req.to_json() if req is not None else None})


@router.post("/render/result/{request_id}")
async def render_deliver(request_id: str, request: Request) -> RenderDelivered:
    """The finished PNG, straight from the app's offscreen capture."""
    png = await request.body()
    if not png:
        raise InvalidRequest(("body",), "empty body")
    mime = request.headers.get("content-type") or "image/png"
    if mime not in ("image/png", "image/jpeg"):
        raise UnsupportedType(f"unsupported type {mime}")
    delivered = render_service.deliver(request_id, png, mime)
    return RenderDelivered(delivered=delivered, bytes=len(png), mime=mime)


@router.post("/render/failed/{request_id}")
async def render_fail(
    request_id: str, body: RenderFailedRequest | None = None
) -> RenderFailReported:
    """The app could not draw this one — say why rather than let the
    caller sit out the timeout."""
    message = (body.message if body else None) or "the window could not render it"
    return RenderFailReported(reported=render_service.fail(request_id, message))
