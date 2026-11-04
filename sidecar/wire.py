"""What the REST surface answers, as the OpenAPI schema declares it.

Every route says what its ok answer is, so the schema (`openapi.json`,
`openapi_schema.py`) and the renderer's generated types know it:

- A JSON answer is a response model: a `WireModel` subclass, named for
  what it is (`Settings`, `McpInfo`), as the route's return annotation.
  The class name is the schema's and the renderer's name for it, so it
  is unique across the app. A model lives in the router file that
  answers it; one that several routers answer lives here.
- An event stream, bytes or no body has no model; the route declares
  `response_class=` and `responses=` from the helpers below (or
  `status_code=204, response_class=Response` for no body).

Non-2xx answers are `refusals.RefusalBody` on every route
(`refusals.REFUSAL_RESPONSES`, added where server.py includes the
routers).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


class WireModel(BaseModel):
    """The base of every response model.

    A route may answer a dict a shared function builds (MCP tools call
    the same functions and keep their dict shapes): it hands it to the
    model (`Model.model_validate(d)`). A key the model does not declare
    is refused rather than dropped, so a model that misses a field
    fails the route's tests instead of changing the wire.
    """

    model_config = ConfigDict(extra="forbid")


class JobError(WireModel):
    """Why a job failed, in the one error shape. `code` is the job's own
    (such as `embedding_model_changed`), not only a refusal code."""

    code: str
    message: str
    details: dict[str, Any]


class Job(WireModel):
    """Long work the sidecar runs as a job, of any kind (`services.jobs`):
    a Pull, Back up all, an ingest. `params`, `progress` and `result`
    are the kind's own. The routes that start one and `/jobs` answer it."""

    id: str
    kind: str
    resource: str
    state: Literal["pending", "running", "done", "cancelled", "failed"]
    params: dict[str, Any]
    progress: dict[str, Any]
    result: dict[str, Any] | None
    error: JobError | None
    cancel_requested: bool
    created_at: float
    finished_at: float | None


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
