"""Append-only activity log for F-list operations.

Surfaces an audit trail for the trust-question "what did Workbench
just do on my behalf?" — sign-in time, ticket refresh count, per-
character pulls (with stages and counts), idle-clear events, sign-out.

Two tiers:
  - In-memory ring buffer (`_buffer`, max MAX_EVENTS) → fast read path
    for `snapshot()`, used by the GET /flist/activity endpoint.
  - On-disk redacted line-JSON at `<userdata>/flist-activity.log` →
    survives sidecar restart, capped via rotation (`.1` suffix when
    the live file exceeds MAX_LOG_BYTES). Hydrates the in-memory buffer
    from the tail at startup so a fresh sidecar still has audit context
    for "the app did something weird last night".

No PII beyond the F-list account name and character names the user
already sees in the picker. Specifically NOT logged: password,
ticket value, image bytes. See UX F4 + verification follow-ups in
REVIEW_2026-05-30_post_tier1_polish.md.
"""
from __future__ import annotations

import copy
import json
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

import documents

# 500 events covers a heavy "pull all characters" burst (≈5 events ×
# 30 characters = 150) plus background sign-in/refresh churn without
# evicting the founding sign-in row. The post-batch-2 QA verification
# (2026-05-30) explicitly flagged 200 as too small for incident
# evidence preservation.
MAX_EVENTS = 500

# 1 MB cap on the live log file; older content rolls to `.1` and the
# previous `.1` is overwritten. Each event is well under 1 KB so this
# keeps ~1k–10k events on disk depending on payload size.
LOG_FILENAME = "flist-activity.log"
MAX_LOG_BYTES = 1_000_000

# Field allow-list — only these keys (plus `t` and `kind`) are written
# to disk. Anything else is dropped at write-time so a future caller
# can't accidentally persist a secret by passing `password=...`.
_DISK_ALLOWED_FIELDS = frozenset({
    "t", "kind",
    "account",          # user-entered account name — public-ish
    "character_count",  # int
    "name",             # character name — public
    "character_id",     # public F-list id
    "image_count",      # int
    "image_failed",     # int
    "missing",          # int
    "status",           # enum
    "stage",            # enum
    "error",            # F-list error string; redacted below
    "idle_seconds",     # int
})

# Substrings that we redact out of any string field before writing. F-list
# errors don't contain credentials in practice, but a defence-in-depth
# pass costs almost nothing.
_REDACTION_PATTERNS = ("password", "ticket")


_buffer: "deque[dict[str, Any]]" = deque(maxlen=MAX_EVENTS)
_lock = threading.Lock()
_disk_lock = threading.Lock()
_started_at = time.time()
_disk_enabled = True


def log_path(root: Path | None = None) -> Path:
    base = root or documents.user_data_dir()
    base.mkdir(parents=True, exist_ok=True)
    return base / LOG_FILENAME


def disable_disk_writes() -> None:
    """Test helper — turns off on-disk mirroring."""
    global _disk_enabled
    _disk_enabled = False


def enable_disk_writes() -> None:
    global _disk_enabled
    _disk_enabled = True


def _redact_value(value: Any) -> Any:
    if isinstance(value, str):
        lowered = value.lower()
        for pat in _REDACTION_PATTERNS:
            if pat in lowered:
                return "<redacted>"
    return value


def _redacted_for_disk(event: dict[str, Any]) -> dict[str, Any]:
    """Strip non-allow-listed keys and redact known-sensitive substrings."""
    out: dict[str, Any] = {}
    for k, v in event.items():
        if k not in _DISK_ALLOWED_FIELDS:
            continue
        out[k] = _redact_value(v)
    return out


def _rotate_if_needed(path: Path) -> None:
    try:
        size = path.stat().st_size
    except OSError:
        return
    if size < MAX_LOG_BYTES:
        return
    rotated = path.with_suffix(path.suffix + ".1")
    try:
        # Overwrite the previous .1 — best-effort, no infinite history.
        if rotated.exists():
            rotated.unlink()
        path.rename(rotated)
    except OSError:
        # Disk full, perms, etc — keep going; the live file just keeps
        # growing one cycle longer.
        pass


def _append_to_disk(event: dict[str, Any]) -> None:
    if not _disk_enabled:
        return
    try:
        path = log_path()
        line = json.dumps(_redacted_for_disk(event), ensure_ascii=False)
        with _disk_lock:
            _rotate_if_needed(path)
            with path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
    except OSError:
        # Disk full / perms — the in-memory buffer still has it; on-disk
        # is a survivability bonus, not a correctness requirement.
        pass


def hydrate_from_disk(root: Path | None = None, max_events: int | None = None) -> int:
    """Read the last `max_events` (default MAX_EVENTS) lines from disk
    into the in-memory buffer. Called at sidecar startup so an audit
    trail crossing a restart is still visible in the modal. Returns
    the number of events loaded.
    """
    cap = max_events or MAX_EVENTS
    path = log_path(root)
    if not path.exists():
        return 0
    try:
        # Read all lines; the file is capped at MAX_LOG_BYTES (~1 MB)
        # so reading it whole is fine, and the tail-slice keeps the
        # newest. A partial last line (crash mid-write) is dropped by
        # the json.loads try/except.
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return 0
    tail = lines[-cap:]
    loaded = 0
    with _lock:
        for raw in tail:
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict) or "kind" not in event:
                continue
            _buffer.append(event)
            loaded += 1
    return loaded


def record(kind: str, **fields: Any) -> None:
    """Append an event. `kind` is a short stable identifier (sign-in,
    ticket-refresh, pull-start, pull-done, pull-error, idle-clear,
    sign-out, etc.). Extra fields are captured verbatim into the
    in-memory buffer; only the disk-allow-listed subset is persisted.
    """
    event = {"t": time.time(), "kind": kind, **fields}
    with _lock:
        _buffer.append(event)
    _append_to_disk(event)


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
    """Test helper — drops the in-memory buffer and resets started_at.
    Does NOT touch the on-disk log; tests that need a clean disk
    should also call `disable_disk_writes()` or point at a tmp_path.
    """
    global _started_at
    with _lock:
        _buffer.clear()
        _started_at = time.time()
