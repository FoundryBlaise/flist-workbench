"""The events models the stream check holds every sent event to
(`stream_events.py`)."""

from __future__ import annotations

from stream_events import undeclared, undeclared_job_event

import wire
from routers.health import ChangeEvents


def test_a_pull_event_its_model_declares_passes() -> None:
    image = {"index": 1, "total": 2, "image_id": "123", "ok": True, "cached": True}

    assert undeclared_job_event("pull", "image", image) is None


def test_an_event_name_the_model_lacks_is_caught() -> None:
    assert undeclared_job_event("pull", "picture", {}) == "PullEvents has no event 'picture'"


def test_a_renamed_key_in_an_events_data_is_caught() -> None:
    images = {"count": 2, "downloaded": 0, "failed": 0}

    why = undeclared(wire.PullEvents, "images", images)

    assert why is not None and why.startswith("PullEvents.images:")


def test_a_job_kind_without_an_events_model_is_caught() -> None:
    assert undeclared_job_event("ingest", "done", {}) is not None


def test_a_change_hint_is_checked_by_its_event_name() -> None:
    hint = {"event": "live-changed", "at": 1.5, "origin": "ui", "character_id": "5150"}

    assert undeclared(ChangeEvents, "live-changed", hint) is None
    assert undeclared(ChangeEvents, "live-changed", {**hint, "partner": "Someone"}) is not None
