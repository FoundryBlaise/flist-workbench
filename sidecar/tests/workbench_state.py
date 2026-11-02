"""Setting a test's scene in the Workbench, through the archive's one
Workbench API, the way the window saves it: over the etag it read."""

from __future__ import annotations

from typing import Any

import archive_workbench


def workbench_payload(character_id: str) -> dict[str, Any]:
    """The Workbench payload, made from Live if the character has none."""
    bench = archive_workbench.read_workbench(character_id, create=True)
    assert bench is not None, "no Live to make a Workbench from"
    return bench.payload


def put_workbench(character_id: str, payload: dict[str, Any]) -> str:
    """Save `payload` as the Workbench; returns the new etag."""
    bench = archive_workbench.read_workbench(character_id, create=True)
    assert bench is not None, "no Live to make a Workbench from"
    return archive_workbench.write_workbench(
        character_id, payload, expected_etag=bench.etag
    )
