"""Long work as jobs: one model for every kind.

Starting long work answers with a job id at once; status and cancel go
by that id, with the same calls whatever the kind (an ingest, a Pull, a
Back up all). So a caller, a model over MCP included, learns one
pattern instead of one per operation.

A job holds one resource (the Index, a character) and at most one job
holds a resource at a time: a second start on a held resource is
refused with that resource's busy refusal (`refusals.ResourceBusy`),
naming the job that holds it. Short work that must not overlap a job
(wiping the Index) holds the resource the same way, through `hold`.

Jobs run on their own thread and are not tied to the client connection
that started them: closing a window or a stream does not stop one, only
`cancel` does, and only where the work checks for it.

Job state lives in memory. Finished jobs are forgotten after a few
minutes, and none survive a restart: an id from before one is unknown
(`refusals.JobNotFound`).
"""

from __future__ import annotations

import contextlib
import contextvars
import dataclasses
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Literal

from refusals import JobNotFound, Refusal, ResourceBusy

log = logging.getLogger(__name__)

JobState = Literal["pending", "running", "done", "cancelled", "failed"]
FINISHED: tuple[JobState, ...] = ("done", "cancelled", "failed")

#: How long a finished job stays pollable.
RETENTION_SECONDS = 300.0

#: The `code` of a job that stopped on something nothing expected, as
#: the REST surface answers a 500.
INTERNAL_ERROR = "internal_error"


@dataclass(eq=False)
class Job:
    """One piece of long work.

    `params` is what it was started with, `progress` what it has done so
    far (a dataclass or a dict, kind-specific), `result` what it
    produced once done, and `error` why it failed, in the one error
    shape `{code, message, details}`.
    """

    id: str
    kind: str
    resource: str
    params: dict[str, Any] = field(default_factory=dict)
    progress: Any = field(default_factory=dict)
    state: JobState = "pending"
    result: dict[str, Any] | None = None
    error: dict[str, Any] | None = None
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)

    @property
    def cancel_requested(self) -> bool:
        return self._cancel.is_set()

    @property
    def finished(self) -> bool:
        return self.state in FINISHED

    def fail(self, code: str, message: str, **details: Any) -> None:
        """Stop as failed with `{code, message, details}`."""
        self.error = {"code": code, "message": message, "details": details}
        self.state = "failed"

    def to_dict(self) -> dict[str, Any]:
        progress = self.progress
        if dataclasses.is_dataclass(progress):
            progress = dataclasses.asdict(progress)
        return {
            "id": self.id,
            "kind": self.kind,
            "resource": self.resource,
            "state": self.state,
            "params": self.params,
            "progress": dict(progress or {}),
            "result": self.result,
            "error": self.error,
            "cancel_requested": self.cancel_requested,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
        }


class JobRegistry:
    def __init__(self, retention_seconds: float = RETENTION_SECONDS) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self.retention_seconds = retention_seconds

    def start(
        self,
        kind: str,
        resource: str,
        work: Callable[[Job], dict[str, Any] | None],
        *,
        busy: type[ResourceBusy],
        params: dict[str, Any] | None = None,
        progress: Any = None,
        on_finish: Callable[[Job], None] | None = None,
    ) -> Job:
        """Run `work(job)` on its own thread as a job holding `resource`.

        Raises `busy` when another job holds the resource. `work` returns
        the job's result; it may stop early with `job.fail(...)` or by
        setting `job.state = "cancelled"` after `job.cancel_requested`.
        A refusal it raises becomes the job's error; anything else
        becomes `internal_error`. The thread runs in a copy of the
        caller's context, so events it publishes keep the caller's
        origin (`services.events.origin`). `on_finish(job)` runs once the
        job has finished and let go of the resource.
        """
        job = self._claim(kind, resource, busy, params, progress)
        context = contextvars.copy_context()
        thread = threading.Thread(
            target=context.run, args=(self._run, job, work, on_finish), daemon=True,
            name=f"job-{kind}-{job.id}",
        )
        thread.start()
        return job

    @contextlib.contextmanager
    def hold(
        self, kind: str, resource: str, *, busy: type[ResourceBusy]
    ) -> Iterator[Job]:
        """Hold `resource` for short work done in the caller's thread,
        as a job of `kind`: refused with `busy` while another job holds
        it, and a job started meanwhile is refused the same way."""
        job = self._claim(kind, resource, busy, None, None)
        job.state = "running"
        try:
            yield job
        except Refusal as exc:
            job.error = exc.body()
            job.state = "failed"
            raise
        except Exception as exc:
            job.fail(INTERNAL_ERROR, f"{type(exc).__name__}: {exc}")
            raise
        else:
            job.state = "done"
        finally:
            job.finished_at = time.time()

    def get(self, job_id: str) -> Job:
        """The job with this id. Raises `JobNotFound` for an id this
        sidecar does not know: never issued, forgotten after it
        finished, or issued before a restart."""
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            raise JobNotFound(
                f"Unknown job {job_id!r}. Jobs are kept in memory: a finished "
                "one is forgotten after a few minutes, and none survive a "
                "restart of Workbench.",
                details={"job_id": job_id},
            )
        return job

    def list(self) -> list[Job]:
        with self._lock:
            return list(self._jobs.values())

    def cancel(self, job_id: str) -> Job:
        """Ask a job to stop. The work stops where it next checks; a
        finished job stays as it ended. Raises `JobNotFound` like `get`."""
        job = self.get(job_id)
        if not job.finished:
            job._cancel.set()
        return job

    def active(self, resource: str) -> Job | None:
        """The job holding `resource`, if one does."""
        with self._lock:
            return self._active_locked(resource)

    def _active_locked(self, resource: str) -> Job | None:
        for job in self._jobs.values():
            if job.resource == resource and not job.finished:
                return job
        return None

    def _claim(
        self,
        kind: str,
        resource: str,
        busy: type[ResourceBusy],
        params: dict[str, Any] | None,
        progress: Any,
    ) -> Job:
        with self._lock:
            self._sweep_locked()
            holder = self._active_locked(resource)
            if holder is not None:
                raise busy(holder.id, holder.kind, holder.resource)
            job = Job(
                id=uuid.uuid4().hex[:12],
                kind=kind,
                resource=resource,
                params=dict(params or {}),
                progress=progress if progress is not None else {},
            )
            self._jobs[job.id] = job
        return job

    def _run(
        self,
        job: Job,
        work: Callable[[Job], dict[str, Any] | None],
        on_finish: Callable[[Job], None] | None,
    ) -> None:
        job.state = "running"
        try:
            result = work(job)
        except Refusal as exc:
            job.error = exc.body()
            job.state = "failed"
        except Exception as exc:  # noqa: BLE001 — a job's top-level guard
            log.exception("job %s (%s) failed", job.id, job.kind)
            job.fail(INTERNAL_ERROR, f"{type(exc).__name__}: {exc}")
        else:
            job.result = result
            if job.state == "running":
                job.state = "done"
        finally:
            job.finished_at = time.time()
        if on_finish is not None:
            try:
                on_finish(job)
            except Exception:  # noqa: BLE001 — the job itself is over
                log.exception("job %s (%s): on_finish failed", job.id, job.kind)

    def _sweep_locked(self) -> None:
        now = time.time()
        stale = [
            jid
            for jid, j in self._jobs.items()
            if j.finished_at is not None and (now - j.finished_at) > self.retention_seconds
        ]
        for jid in stale:
            del self._jobs[jid]


_registry = JobRegistry()


def registry() -> JobRegistry:
    return _registry
