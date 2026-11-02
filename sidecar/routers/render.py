"""Rendering: the app draws, the sidecar hands the picture on."""

from fastapi import APIRouter, Request

from refusals import InvalidRequest, UnsupportedType
from services import render as render_service

router = APIRouter()


@router.get("/render/requests")
async def render_next_request(timeout: float = 25.0) -> dict:
    """The app's long-poll for something to draw.

    Answering this is also how the app says "I am here": a tool asking
    for a picture checks that before it waits, so a model gets told the
    window is closed instead of sitting through a timeout.
    """
    req = await render_service.next_request(
        timeout=max(1.0, min(60.0, timeout))
    )
    return {"request": req.to_json() if req is not None else None}


@router.post("/render/result/{request_id}")
async def render_deliver(request_id: str, request: Request) -> dict:
    """The finished PNG, straight from the app's offscreen capture."""
    png = await request.body()
    if not png:
        raise InvalidRequest(("body",), "empty body")
    mime = request.headers.get("content-type") or "image/png"
    if mime not in ("image/png", "image/jpeg"):
        raise UnsupportedType(f"unsupported type {mime}")
    delivered = render_service.deliver(request_id, png, mime)
    return {"delivered": delivered, "bytes": len(png), "mime": mime}


@router.post("/render/failed/{request_id}")
async def render_fail(request_id: str, body: dict | None = None) -> dict:
    """The app could not draw this one — say why rather than let the
    caller sit out the timeout."""
    message = (body or {}).get("message") or "the window could not render it"
    return {"reported": render_service.fail(request_id, str(message))}
