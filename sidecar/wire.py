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
- An event stream, bytes or no body has no response model; the route
  declares `response_class=` and `responses=` from the helpers below
  (or `status_code=204, response_class=Response` for no body). An
  event stream names its events model there (`event_stream`).
- A JSON request body is a model too (`...Request`, `...Update`), never
  a `dict`.

Non-2xx answers are `refusals.RefusalBody` on every route
(`refusals.REFUSAL_RESPONSES`, added where server.py includes the
routers).
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict
from pydantic.experimental.missing_sentinel import MISSING

from refusals import RefusalCode

__all__ = [
    "MISSING",
    "BackupAllEvents",
    "Job",
    "JobError",
    "JobFailureCode",
    "LabelSource",
    "PullEvents",
    "PullStatusName",
    "StreamError",
    "Verdict",
    "WireModel",
    "binary",
    "declare_events",
    "event_stream",
    "image",
]


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


# ---- event streams ----------------------------------------------------------
#
# An event stream's events are declared as an events model: one field
# per event name, typed with that event's JSON data. Nothing builds
# these models (the streams send dicts, which MCP reads too);
# `tests/stream_events.py` checks every sent event against them, and
# the schema carries them so the renderer's types for the events are
# generated (`Schema<'PullEvents'>['image']`).


class StreamError(JobError):
    """A stream's `error` event, which ends it: a job's error, and the
    stage it stopped at."""

    stage: str


class JobCancelled(WireModel):
    """A stream's `cancelled` event: a cancel by job id stopped the
    job. No data."""


class PullTicket(WireModel):
    """A Pull is getting (or refreshing) the F-list ticket. No data."""


class PullFetching(WireModel):
    """A Pull is asking F-list for the character."""

    name: str


class PullImages(WireModel):
    """A Pull's images start: how many the profile lists."""

    total: int
    downloaded: int
    failed: int


class PullImage(WireModel):
    """One image of a Pull: kept (`cached`: it was on disk already) or
    not (`error` says why)."""

    index: int
    total: int
    image_id: str
    ok: bool
    cached: bool | MISSING = MISSING
    error: str | MISSING = MISSING


#: How complete a character's last Pull is (`archive_images.compute_pull_status`).
PullStatusName = Literal["never_pulled", "unknown", "interrupted", "partial", "complete"]


class PullDone(WireModel):
    """A Pull ended: `changed` whether F-list's profile differed from
    Live, and the images by outcome."""

    character_id: str
    name: str
    changed: bool
    image_count: int
    image_downloaded: int
    image_cached: int
    image_failed: int
    pull_status: PullStatusName
    pull_missing: int


class PullEvents(WireModel):
    """A Pull's events, in the order a Pull sends them: the job, then
    its progress, ending with `done`, `error` or `cancelled`."""

    job: Job
    ticket: PullTicket
    fetching: PullFetching
    images: PullImages
    image: PullImage
    done: PullDone
    error: StreamError
    cancelled: JobCancelled


class BackupAllStart(WireModel):
    """Back up all starts: how many characters the account has."""

    total: int


class ImageStats(WireModel):
    """A character's images after its Pull, by outcome."""

    total: int
    downloaded: int
    cached: int
    failed: int


class BackupAllCharacter(WireModel):
    """One character of Back up all: being pulled (`fetching`), then
    `saved` as a Backup (`filename`), `unchanged` since its newest
    Backup, or `error` (`message`; the sweep goes on)."""

    name: str
    character_id: str | MISSING = MISSING
    status: Literal["fetching", "saved", "unchanged", "error"]
    filename: str | MISSING = MISSING
    size: int | MISSING = MISSING
    message: str | MISSING = MISSING
    image_stats: ImageStats | MISSING = MISSING


class BackupAllDone(WireModel):
    """Back up all ended: the characters by outcome, and each one's
    last event."""

    total: int
    saved: int
    unchanged: int
    failed: int
    characters: list[BackupAllCharacter]


class BackupAllEvents(WireModel):
    """Back up all's events: the job, `start`, a `character` event per
    character as it is pulled and as it ends, then `done`, `error` or
    `cancelled`."""

    job: Job
    start: BackupAllStart
    character: BackupAllCharacter
    done: BackupAllDone
    error: StreamError
    cancelled: JobCancelled


#: The events models streams declare, for the schema (`declare_events`).
_EVENTS_MODELS: list[type[BaseModel]] = []


def event_stream(
    description: str, *events: type[BaseModel]
) -> dict[int | str, dict[str, Any]]:
    """The `responses=` of a route answering a server-sent event
    stream (with `response_class=StreamingResponse`). `events`: the
    stream's events model, or the models of each stream it may be
    (`x-events` in the schema)."""
    refs = [{"$ref": f"#/components/schemas/{m.__name__}"} for m in events]
    _EVENTS_MODELS.extend(m for m in events if m not in _EVENTS_MODELS)
    return {
        200: {
            "description": description,
            "content": {
                "text/event-stream": {
                    "schema": {"type": "string"},
                    "x-events": refs[0] if len(refs) == 1 else {"anyOf": refs},
                }
            },
        }
    }


def declare_events(document: dict[str, Any]) -> None:
    """Add the events models `event_stream` was given, and the models
    they use, to `document`'s schemas, which FastAPI fills only with
    the models of JSON bodies. A model already there must be the same."""
    from pydantic.json_schema import models_json_schema

    _, top = models_json_schema(
        [(m, "serialization") for m in _EVENTS_MODELS],
        ref_template="#/components/schemas/{model}",
    )
    schemas = document.setdefault("components", {}).setdefault("schemas", {})
    for name, schema in top.get("$defs", {}).items():
        if schemas.setdefault(name, schema) != schema:
            raise ValueError(f"two different schemas named {name}")
    document["components"]["schemas"] = dict(sorted(schemas.items()))


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
