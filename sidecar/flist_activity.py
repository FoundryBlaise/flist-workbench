"""In-memory append-only activity log for F-list operations.

Surfaces an audit trail for the trust-question "what did Workbench
just do on my behalf?" — sign-in time, ticket refresh count, per-
character pulls (with stages and counts), idle-clear events, sign-out.

Bounded ring buffer; oldest events evict first. Lives only in the
sidecar process — no disk file, no leakage across runs, no PII beyond
the F-list account name and character names the user already sees in
the picker. See P0-C / UX F4 in REVIEW_2026-05-30_post_tier1_polish.md.
"""
from __future__ import annotations

import copy
import threading
import time
from collections import deque
from typing import Any

# 500 events covers a heavy "pull all characters" burst (≈5 events ×
# 30 characters = 150) plus background sign-in/refresh churn without
# evicting the founding sign-in row. The post-batch-2 QA verification
# (2026-05-30) explicitly flagged 200 as too small for incident
# evidence preservation.
MAX_EVENTS = 500


_buffer: "deque[dict[str, Any]]" = deque(maxlen=MAX_EVENTS)
_lock = threading.Lock()
_started_at = time.time()


def record(kind: str, **fields: Any) -> None:
    """Append an event. `kind` is a short stable identifier (sign-in,
    ticket-refresh, pull-start, pull-done, pull-error, idle-clear,
    sign-out, etc.). Extra fields are captured verbatim — callers
    should avoid sending the password or ticket value.
    """
    event = {"t": time.time(), "kind": kind, **fields}
    with _lock:
        _buffer.append(event)


def snapshot() -> dict[str, Any]:
    """Return the current buffer (newest last) + summary stats.

    Returns deep-copied event dicts so a caller iterating the snapshot
    can't see a later mutation. The buffer is small (<= MAX_EVENTS,
    each event is a tiny dict of primitives), so the copy is cheap.
    """
    with _lock:
        events = [copy.deepcopy(e) for e in _buffer]
    return {
        "started_at": _started_at,
        "event_count": len(events),
        "max_events": MAX_EVENTS,
        "events": events,
    }


def reset() -> None:
    """Test helper — drops the buffer and resets started_at."""
    global _started_at
    with _lock:
        _buffer.clear()
        _started_at = time.time()
