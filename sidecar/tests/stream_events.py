"""Every event a stream sends is one its events model declares.

An event stream's schema names an events model (`wire.event_stream`):
one field per event name, typed with that event's data. The renderer's
types for the events come from those models, so an event the model
does not declare, or data it does not describe, would reach the window
untyped. The sidecar builds its events as dicts (MCP reads the same
ones), so nothing checks them on the way out; this does, in tests.

The `stream_events_declared` fixture is autouse (conftest.py): every
event a job keeps for its followers (`services.jobs.Job.emit`) and
every change hint the event bus sends (`services.events._send`) is
checked against its stream's model, and a test whose code sent one the
model does not describe fails, listing them.
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import BaseModel, TypeAdapter, ValidationError

import wire
from routers.health import ChangeEvents
from services import backup_all, events, jobs, pull

#: The events model of each job kind that streams its progress.
EVENTS_BY_KIND: dict[str, type[BaseModel]] = {
    pull.KIND: wire.PullEvents,
    backup_all.KIND: wire.BackupAllEvents,
}


def _event_types(model: type[BaseModel]) -> dict[str, Any]:
    """Each event name of `model` (a field's alias, or its name) with
    the type of its data."""
    return {(f.alias or name): f.annotation for name, f in model.model_fields.items()}


def undeclared(model: type[BaseModel], event: str, data: Any) -> str | None:
    """Why `event` with `data` is not an event of `model`, or None."""
    types = _event_types(model)
    if event not in types:
        return f"{model.__name__} has no event {event!r}"
    try:
        TypeAdapter(types[event]).validate_python(data)
    except ValidationError as exc:
        return f"{model.__name__}.{event}: {exc.errors(include_url=False)}"
    return None


def undeclared_job_event(kind: str, event: str, data: Any) -> str | None:
    model = EVENTS_BY_KIND.get(kind)
    if model is None:
        return f"job kind {kind!r} streams events but names no events model"
    return undeclared(model, event, data)


@pytest.fixture(autouse=True)
def stream_events_declared(monkeypatch: pytest.MonkeyPatch):
    problems: list[str] = []

    emit = jobs.Job.emit

    def checked_emit(self: jobs.Job, event: str, data: dict[str, Any]) -> None:
        why = undeclared_job_event(self.kind, event, data)
        if why:
            problems.append(why)
        emit(self, event, data)

    send = events._send

    def checked_send(payload: dict[str, Any]) -> None:
        why = undeclared(ChangeEvents, str(payload.get("event")), payload)
        if why:
            problems.append(why)
        send(payload)

    monkeypatch.setattr(jobs.Job, "emit", checked_emit)
    monkeypatch.setattr(events, "_send", checked_send)
    yield
    if problems:
        pytest.fail("events their stream's events model does not declare:\n" + "\n".join(problems))
