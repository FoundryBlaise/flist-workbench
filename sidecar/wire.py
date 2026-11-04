"""What the REST surface answers, as the OpenAPI schema declares it.

Every route says what its ok answer is, so the schema (`openapi.json`,
`openapi_schema.py`) and the renderer's generated types know it:

- A JSON answer is a response model: a `WireModel` subclass, named for
  what it is (`Settings`, `McpInfo`), as the route's return annotation.
  The class name is the schema's and the renderer's name for it, so it
  is unique across the app. A model lives in the router file that
  answers it; one that several routers answer lives here.
- A key an answer sometimes leaves out is typed `X | MISSING`, default
  `MISSING`: the model leaves it out too (rather than sending null),
  and the schema makes it optional (`key?: X` in the renderer's types).
- An event stream, bytes or no body has no model; the route declares
  `response_class=` and `responses=` from the helpers below (or
  `status_code=204, response_class=Response` for no body).

Non-2xx answers are `refusals.RefusalBody` on every route
(`refusals.REFUSAL_RESPONSES`, added where server.py includes the
routers).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict
from pydantic.experimental.missing_sentinel import MISSING

__all__ = ["MISSING", "WireModel", "binary", "event_stream", "image"]


class WireModel(BaseModel):
    """The base of every response model.

    A route may answer a dict a shared function builds (MCP tools call
    the same functions and keep their dict shapes): it hands it to the
    model (`Model.model_validate(d)`). A key the model does not declare
    is refused rather than dropped, so a model that misses a field
    fails the route's tests instead of changing the wire.
    """

    model_config = ConfigDict(extra="forbid")


def event_stream(description: str) -> dict[int | str, dict[str, Any]]:
    """The `responses=` of a route answering a server-sent event
    stream (with `response_class=StreamingResponse`)."""
    return {
        200: {
            "description": description,
            "content": {"text/event-stream": {"schema": {"type": "string"}}},
        }
    }


def binary(media_type: str, description: str) -> dict[int | str, dict[str, Any]]:
    """The `responses=` of a route answering bytes of `media_type` (a
    zip, an image), with `response_class=Response` or `FileResponse`."""
    return {
        200: {
            "description": description,
            "content": {media_type: {"schema": {"type": "string", "format": "binary"}}},
        }
    }


#: The types an image route may answer: the file's own.
IMAGE_TYPES = ("image/png", "image/jpeg", "image/gif")


def image(description: str) -> dict[int | str, dict[str, Any]]:
    """The `responses=` of a route answering an image file, a PNG, JPEG
    or GIF as the file is (with `response_class=FileResponse`)."""
    return {
        200: {
            "description": description,
            "content": {t: {"schema": {"type": "string", "format": "binary"}} for t in IMAGE_TYPES},
        }
    }
