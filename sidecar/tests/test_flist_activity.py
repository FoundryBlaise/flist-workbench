"""Activity log: append-only ring buffer + on-disk redacted rotation
for F-list operations.

Round-trip tests + capacity cap + disk persistence + restart-survival
+ redaction at the disk boundary.
"""
from __future__ import annotations

import json

import pytest

import flist_activity


@pytest.fixture(autouse=True)
def _isolated_state(tmp_path, monkeypatch):
    # Point user_data_dir at a tmpdir so on-disk writes are isolated;
    # clear the in-memory buffer between tests.
    monkeypatch.setenv("FLIST_WORKBENCH_DATA_DIR", str(tmp_path))
    flist_activity.reset()
    flist_activity.enable_disk_writes()
    yield


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
    flist_activity.disable_disk_writes()  # avoid 1 MB writes during this test
    for i in range(flist_activity.MAX_EVENTS + 50):
        flist_activity.record("noise", i=i)
    snap = flist_activity.snapshot()
    assert snap["event_count"] == flist_activity.MAX_EVENTS
    # First 50 should be gone; oldest still in buffer is i=50.
    assert snap["events"][0]["i"] == 50
    assert snap["events"][-1]["i"] == flist_activity.MAX_EVENTS + 49


def test_snapshot_is_a_copy_not_a_live_view():
    flist_activity.record("a", account="acct")
    snap = flist_activity.snapshot()
    flist_activity.record("b", account="acct2")
    # The earlier snapshot must not reflect the later record.
    assert snap["event_count"] == 1
    assert len(snap["events"]) == 1
    # And a deep-copy means mutating the snapshot's event doesn't
    # corrupt the live buffer either.
    snap["events"][0]["account"] = "hijacked"
    snap2 = flist_activity.snapshot()
    assert snap2["events"][0]["account"] == "acct"


def test_disk_persistence_round_trip():
    flist_activity.record("sign-in", account="acct", character_count=3)
    flist_activity.record("pull-start", name="Lady Amber Blaise")
    # Wipe in-memory state, hydrate from disk → should see both.
    flist_activity.reset()
    assert flist_activity.snapshot()["event_count"] == 0
    loaded = flist_activity.hydrate_from_disk()
    assert loaded == 2
    snap = flist_activity.snapshot()
    assert snap["event_count"] == 2
    assert snap["events"][0]["kind"] == "sign-in"
    assert snap["events"][1]["name"] == "Lady Amber Blaise"


def test_disk_excludes_non_allowlisted_keys():
    # A misbehaving caller could attempt to record something sensitive.
    # Allow-list at the disk boundary catches it.
    flist_activity.record(
        "sign-in",
        account="acct",
        password="should-not-land-on-disk",  # noqa: S106 — test fixture
    )
    path = flist_activity.log_path()
    contents = path.read_text(encoding="utf-8")
    assert "should-not-land-on-disk" not in contents
    # Yet the in-memory snapshot still has it so audit context is
    # available within-process if someone has it open. (Memory cleared
    # at sidecar restart per the credential discipline.)
    snap = flist_activity.snapshot()
    assert snap["events"][0]["password"] == "should-not-land-on-disk"


def test_disk_redacts_sensitive_substrings_in_allowed_fields():
    # An error string that *contains* "password" still gets redacted
    # at the disk boundary. F-list's verbatim 401 message mentions
    # "password" — we keep it in memory but write the redacted form.
    flist_activity.record(
        "sign-in-failed",
        account="acct",
        error="Login Failed. Recover your password from the website.",
    )
    contents = flist_activity.log_path().read_text(encoding="utf-8")
    assert "<redacted>" in contents
    assert "Recover your" not in contents
    snap = flist_activity.snapshot()
    assert "Recover your" in snap["events"][0]["error"]


def test_disk_rotation_caps_log_size():
    # Cap the rotation threshold tiny so a few records trigger a roll.
    original_cap = flist_activity.MAX_LOG_BYTES
    flist_activity.MAX_LOG_BYTES = 200
    try:
        for i in range(20):
            flist_activity.record(
                "pull-done",
                name=f"Character{i:03d}",
                image_count=i,
            )
        path = flist_activity.log_path()
        rotated = path.with_suffix(path.suffix + ".1")
        assert rotated.exists(), "expected a rotated .1 file"
        # Live file is bounded; rotated holds the older slice.
        assert path.stat().st_size < flist_activity.MAX_LOG_BYTES * 2
    finally:
        flist_activity.MAX_LOG_BYTES = original_cap


def test_partial_last_line_dropped_on_hydrate():
    # Simulate a sidecar crash mid-write: the trailing line is invalid
    # JSON. Hydrate must skip it without losing earlier events.
    flist_activity.record("sign-in", account="acct")
    path = flist_activity.log_path()
    with path.open("a", encoding="utf-8") as f:
        f.write('{"kind":"truncated",')  # no newline, no closing brace
    flist_activity.reset()
    loaded = flist_activity.hydrate_from_disk()
    assert loaded == 1
    assert flist_activity.snapshot()["events"][0]["kind"] == "sign-in"


def test_hydrate_skips_missing_kind():
    # A line that *parses* but lacks `kind` is also dropped — guards
    # against schema drift later.
    path = flist_activity.log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        f.write(json.dumps({"t": 1.0, "kind": "valid"}) + "\n")
        f.write(json.dumps({"t": 1.0, "notkind": "x"}) + "\n")
    loaded = flist_activity.hydrate_from_disk()
    assert loaded == 1
