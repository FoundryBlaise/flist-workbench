"""Server-sent event framing for the streaming routes (`/events`, Pull,
Back up all)."""

import json
from typing import Any

from refusals import Refusal

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
