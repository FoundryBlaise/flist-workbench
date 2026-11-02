"""Jobs: poll and cancel long work by id, whatever its kind
(`services.jobs`). The routes that start one answer with its id."""

from fastapi import APIRouter

from services import jobs

router = APIRouter()


@router.get("/jobs")
def jobs_list() -> dict:
    return {"jobs": [j.to_dict() for j in jobs.registry().list()]}


@router.get("/jobs/{job_id}")
def job_get(job_id: str) -> dict:
    return jobs.registry().get(job_id).to_dict()


@router.delete("/jobs/{job_id}")
def job_cancel(job_id: str) -> dict:
    """Ask a job to stop; it stops where it next checks. Answers the
    job as it stands, with `cancel_requested` set unless it had already
    finished."""
    return jobs.registry().cancel(job_id).to_dict()
