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

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from refusals import RefusalCode


class WireModel(BaseModel):
    """The base of every response model.

    A route may answer a dict a shared function builds (MCP tools call
    the same functions and keep their dict shapes): it hands it to the
    model (`Model.model_validate(d)`). A key the model does not declare
    is refused rather than dropped, so a model that misses a field
    fails the route's tests instead of changing the wire. The answer
    lists the fields in the order the model declares them, so a model
    declares them in the order the dict has them.
    """

    model_config = ConfigDict(extra="forbid")


def _drop_null(schema: dict[str, Any]) -> None:
    """The schema of an `omittable()` field: its type without the null
    and the default it only has for Python."""
    schema.pop("default", None)
    any_of = [s for s in schema.pop("anyOf", []) if s != {"type": "null"}]
    if len(any_of) == 1:
        schema.update(any_of[0])
    elif any_of:
        schema["anyOf"] = any_of


def omittable() -> Any:
    """A field the answer leaves out rather than sending null: declare
    it `name: T | None = omittable()`. Absent in the dict, absent on the
    wire; the schema makes it an optional key of type T (never null)."""
    return Field(default=None, exclude_if=lambda v: v is None, json_schema_extra=_drop_null)


# ---- Labels -----------------------------------------------------------------

#: The verdict a stored Label holds.
Verdict = Literal["IC", "OOC"]

#: Who decided a stored Label: the model connected over MCP, the user
#: by hand, or the in-app classifier from before the MCP migration.
LabelSource = Literal["mcp", "manual", "llm"]


# ---- jobs -------------------------------------------------------------------


class JobFailureCode(StrEnum):
    """The codes a job fails with that no refusal carries. A job's
    `error.code` is a refusal code (`refusals.RefusalCode`: what
    stopped it was a refusal, or `internal_error`) or one of these.
    `tests/test_openapi_schema.py` fails when a job or a job's stream
    fails with a code in neither list."""

    # An ingest (rag_jobs): the embedding model could not be used, or
    # the Index was built with another one.
    EMBEDDING_FAILED = "embedding_failed"
    EMBEDDING_MODEL_CHANGED = "embedding_model_changed"


class JobError(WireModel):
    """Why a job failed, in the one error shape `{code, message,
    details}`."""

    code: RefusalCode | JobFailureCode
    message: str
    details: dict[str, Any]


class Job(WireModel):
    """Long work the sidecar runs as a job, of any kind
    (`services.jobs`): started by its own route, then polled and
    cancelled by id (`/jobs/{id}`). `params`, `progress` and `result`
    are the kind's own; `error` is set when it failed."""

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
