"""Activity log: append-only ring buffer for F-list operations.

Round-trip tests + capacity cap. The buffer is in-memory only; no
disk file, no leakage across runs.
"""
from __future__ import annotations

import flist_activity


def setup_function() -> None:
    flist_activity.reset()


def test_record_and_snapshot_roundtrip():
    flist_activity.record("sign-in", account="acct", character_count=12)
    flist_activity.record("pull-start", name="Lady Amber Blaise")
    snap = flist_activity.snapshot()
    assert snap["event_count"] == 2
    assert snap["events"][0]["kind"] == "sign-in"
    assert snap["events"][0]["account"] == "acct"
    assert snap["events"][1]["kind"] == "pull-start"
    assert snap["events"][1]["name"] == "Lady Amber Blaise"
    assert all("t" in e for e in snap["events"])


def test_buffer_evicts_oldest_past_capacity():
    for i in range(flist_activity.MAX_EVENTS + 50):
        flist_activity.record("noise", i=i)
    snap = flist_activity.snapshot()
    assert snap["event_count"] == flist_activity.MAX_EVENTS
    # First 50 should be gone; oldest still in buffer is i=50.
    assert snap["events"][0]["i"] == 50
    assert snap["events"][-1]["i"] == flist_activity.MAX_EVENTS + 49


def test_snapshot_is_a_copy_not_a_live_view():
    flist_activity.record("a", x=1)
    snap = flist_activity.snapshot()
    flist_activity.record("b", x=2)
    # The earlier snapshot must not reflect the later record.
    assert snap["event_count"] == 1
    assert len(snap["events"]) == 1
