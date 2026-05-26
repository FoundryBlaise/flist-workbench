"""Tracks running label-classification jobs so the UI can show progress
and cancel.

A job is one "Classify …" action — for one conversation, one
character's full partner set, or every character on disk. We keep
state in-process; the UI polls GET /labels/jobs/<id> to render the
progress bar. There's no persistence: if the sidecar restarts mid-job
the user sees it disappear, which matches the on-demand model
(re-running picks up where we left off because labels are upserted
atomically).
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Literal

import labels as labels_store
import labels_llm
import logs as logs_store
import settings as settings_store

JobState = Literal["pending", "running", "done", "cancelled", "failed"]


@dataclass(slots=True)
class JobProgress:
    classified: int = 0
    failed: int = 0
    total: int = 0
    skipped_existing: int = 0
    skipped_rule: int = 0
    last_label: str | None = None
    last_error: str | None = None
    current_partner: str | None = None


@dataclass(slots=True)
class Job:
    id: str
    scope: dict
    # When true, classify_messages is called with skip_existing=False,
    # so messages that already have an LLM/manual label get re-classified
    # in place. Used by "Re-classify (overwrite)" after a prompt or
    # model change.
    overwrite: bool = False
    state: JobState = "pending"
    progress: JobProgress = field(default_factory=JobProgress)
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    _cancel: threading.Event = field(default_factory=threading.Event)
    _thread: threading.Thread | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "scope": self.scope,
            "overwrite": self.overwrite,
            "state": self.state,
            "classified": self.progress.classified,
            "failed": self.progress.failed,
            "total": self.progress.total,
            "skipped_existing": self.progress.skipped_existing,
            "skipped_rule": self.progress.skipped_rule,
            "last_label": self.progress.last_label,
            "last_error": self.progress.last_error,
            "current_partner": self.progress.current_partner,
            "error": self.error,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
        }


class JobRegistry:
    """Thread-safe job dict + retention sweep.

    Finished jobs linger for `retention_seconds` so the UI can fetch
    the final state after polling. New jobs evict old ones on insert.
    """

    def __init__(self, retention_seconds: float = 300.0) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self.retention_seconds = retention_seconds

    def create(self, scope: dict, *, overwrite: bool = False) -> Job:
        job_id = uuid.uuid4().hex[:12]
        job = Job(id=job_id, scope=scope, overwrite=overwrite)
        with self._lock:
            self._sweep_locked()
            self._jobs[job_id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            return list(self._jobs.values())

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            return False
        job._cancel.set()
        return True

    def _sweep_locked(self) -> None:
        now = time.time()
        stale = [
            jid for jid, j in self._jobs.items()
            if j.finished_at is not None and (now - j.finished_at) > self.retention_seconds
        ]
        for jid in stale:
            del self._jobs[jid]


_registry = JobRegistry()


def registry() -> JobRegistry:
    """Module-level singleton accessor — tests can monkeypatch it."""
    return _registry


def _resolve_targets(scope: dict) -> list[tuple[str, str]]:
    """Expand a scope into a flat list of (character, partner) tuples.

    Scope shapes:
      {character: <name>, partner: <name>}         → one conversation
      {character: <name>}                          → all partners for that char
      {} or {character: None}                      → all characters × all partners
    """
    # Channels (#-prefixed) used to be silently skipped here. They're
    # visible in the partner list and the chip strip shows non-zero
    # unlabeled counts for them — silently excluding them from classify
    # was the most confusing surface in the entire labels flow per PO
    # review. Include them; the rule resolver will still mark short and
    # `((` messages OOC by rule, and the LLM gets the rest.
    character = scope.get("character")
    partner = scope.get("partner")
    if character and partner:
        return [(character, partner)]
    if character:
        partners = logs_store.list_partners(character)
        return [(character, p.name) for p in partners]
    targets: list[tuple[str, str]] = []
    chars = logs_store.list_characters()
    for c in chars:
        try:
            partners = logs_store.list_partners(c.name)
        except logs_store.LogDirError:
            continue
        for p in partners:
            targets.append((c.name, p.name))
    return targets


def _run_job(job: Job) -> None:
    """Worker body — iterates targets and calls labels_llm.classify_messages."""
    job.state = "running"
    try:
        targets = _resolve_targets(job.scope)
    except logs_store.LogDirError as exc:
        job.error = str(exc)
        job.state = "failed"
        job.finished_at = time.time()
        return

    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    try:
        lab_settings = labels_store.load_settings(settings_conn)

        # Running totals across all conversations in this job. The
        # classifier reports per-conversation deltas; we hold the
        # cross-conversation sum here so the UI sees one growing
        # progress bar even when the scope is multi-character.
        finished_classified = 0
        finished_total = 0
        finished_failed = 0

        def make_progress_cb() -> labels_llm.ProgressCb:
            def cb(p: dict) -> None:
                job.progress.classified = finished_classified + p.get("classified", 0)
                job.progress.failed = finished_failed + p.get("failed", 0)
                job.progress.total = finished_total + p.get("total", 0)
                job.progress.skipped_existing = p.get("skipped_existing", 0)
                job.progress.skipped_rule = p.get("skipped_rule", 0)
                if "last_label" in p:
                    job.progress.last_label = p["last_label"]
                if "last_error" in p:
                    job.progress.last_error = p["last_error"]
            return cb

        for char, partner in targets:
            if job._cancel.is_set():
                job.state = "cancelled"
                break
            job.progress.current_partner = f"{char} / {partner}"
            try:
                messages = list(logs_store.read_messages(char, partner))
            except logs_store.LogDirError as exc:
                job.progress.last_error = str(exc)
                continue
            summary = labels_llm.classify_messages(
                char,
                partner,
                messages,
                lab_settings,
                labels_conn,
                cancel=job._cancel,
                on_progress=make_progress_cb(),
                skip_existing=not job.overwrite,
            )
            finished_classified += summary["classified"]
            finished_failed += summary["failed"]
            finished_total += summary["total"]
            # Re-sync the job's snapshot since the next conversation
            # starts from zero in the inner classifier.
            job.progress.classified = finished_classified
            job.progress.failed = finished_failed
            job.progress.total = finished_total
            if summary.get("cancelled"):
                job.state = "cancelled"
                break
        if job.state == "running":
            # A run that managed to talk to the LLM zero times but
            # accumulated failures is a connection/config problem
            # masquerading as success — promote to "failed" so the UI
            # treats it as such. Use the last per-message error as the
            # explanation since the worker itself didn't throw.
            if finished_classified == 0 and finished_failed > 0:
                job.state = "failed"
                if job.error is None:
                    last = job.progress.last_error
                    job.error = (
                        f"All {finished_failed} message(s) failed: {last}"
                        if last
                        else f"All {finished_failed} message(s) failed."
                    )
            else:
                job.state = "done"
    except Exception as exc:  # noqa: BLE001 — top-level worker guard
        job.error = repr(exc)
        job.state = "failed"
    finally:
        job.finished_at = time.time()
        # Persist a tombstone before closing the labels connection so
        # the Settings → Labels history view survives sidecar restarts.
        # Best-effort: a failed insert here must not mask a real job error.
        try:
            labels_store.record_job_history(
                labels_conn,
                id=job.id,
                scope=job.scope,
                state=job.state,
                classified=job.progress.classified,
                failed=job.progress.failed,
                total=job.progress.total,
                started_at=job.created_at,
                finished_at=job.finished_at,
                error=job.error,
            )
        except Exception:  # noqa: BLE001 — history is cosmetic
            pass
        settings_conn.close()
        labels_conn.close()


def start(scope: dict, *, overwrite: bool = False) -> Job:
    job = registry().create(scope, overwrite=overwrite)
    thread = threading.Thread(target=_run_job, args=(job,), daemon=True)
    job._thread = thread
    thread.start()
    return job
