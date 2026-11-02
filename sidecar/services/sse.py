"""Server-sent event framing for the streaming routes (`/events`, and
the progress of a job: Pull, Back up all)."""

import json
from typing import Any

from starlette.responses import StreamingResponse

from refusals import Refusal

from . import jobs

#: The `code` of a stream that stopped on something nothing expected,
#: as the REST surface answers a 500.
INTERNAL_ERROR = "internal_error"


def event(event: str, data: dict | str) -> bytes:
    """Format one SSE message. Reuses the OpenAI streaming convention:
    each event has an `event:` name + a JSON `data:` payload, separated
    by a blank line.
    """
    if isinstance(data, str):
        payload = data
    else:
        payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n".encode("utf-8")


def error(stage: str, code: str, message: str, **details: Any) -> tuple[str, dict[str, Any]]:
    """A stream's `error` event, as `(event, data)`: the stage it stopped
    at, then the same `code`, `message` and `details` a REST error
    carries (`refusals`), so a caller reads both one way."""
    return ("error", {"stage": stage, "code": code, "message": message, "details": details})


def refused(stage: str, exc: Refusal) -> tuple[str, dict[str, Any]]:
    """`error` for a refusal: its code, message and details."""
    return error(stage, exc.code, exc.message, **exc.details)


#: Headers of every progress stream: no caching, no proxy buffering.
STREAM_HEADERS = {"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"}


def follow(job: jobs.Job) -> StreamingResponse:
    """A job's progress as a stream: first a `job` event (the job as
    `GET /jobs/{id}` answers it), then every event the job has sent and
    sends (`services.jobs.follow`). Closing the stream only stops
    following: the job runs on until it finishes or is cancelled by id."""

    async def producer():
        yield event("job", job.to_dict())
        async for name, data in jobs.follow(job):
            yield event(name, data)

    return StreamingResponse(producer(), media_type="text/event-stream", headers=STREAM_HEADERS)
