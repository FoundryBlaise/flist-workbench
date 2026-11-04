"""Jobs: poll and cancel long work by id, whatever its kind
(`services.jobs`). The routes that start one answer with its id."""

from fastapi import APIRouter

from starlette.responses import StreamingResponse

from services import jobs, sse
from wire import Job, WireModel, event_stream

router = APIRouter()


class JobList(WireModel):
    """Every job the sidecar remembers: running ones, and finished ones
    for a few minutes."""

    jobs: list[Job]


@router.get("/jobs")
def jobs_list() -> JobList:
    return JobList.model_validate({"jobs": [j.to_dict() for j in jobs.registry().list()]})


@router.get("/jobs/{job_id}")
def job_get(job_id: str) -> Job:
    return Job.model_validate(jobs.registry().get(job_id).to_dict())


@router.delete("/jobs/{job_id}")
def job_cancel(job_id: str) -> Job:
    """Ask a job to stop; it stops where it next checks. Answers the
    job as it stands, with `cancel_requested` set unless it had already
    finished."""
    return Job.model_validate(jobs.registry().cancel(job_id).to_dict())


@router.get(
    "/jobs/{job_id}/events",
    response_class=StreamingResponse,
    responses=event_stream(
        "A Pull's or Back up all's events: first `job` (the job as "
        "`GET /jobs/{job_id}` answers it), then each event it sent and "
        "sends, ending with `done`, `error` (`{stage, code, message, "
        "details}`) or `cancelled`."
    ),
)
async def job_events(job_id: str) -> StreamingResponse:
    """Follow a Pull or Back up all as server-sent events: the `job`,
    every event it has sent so far, then each new one until it ends.
    How a reopened progress view picks up a running job; closing the
    stream leaves the job running."""
    return sse.follow(jobs.registry().get(job_id))
