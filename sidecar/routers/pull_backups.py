"""Pull, Backups and Back up all.

Pull and Back up all run as jobs (`services.jobs`) and stream their
progress as server-sent events; the work itself lives in
`services/pull.py` and `services/backup_all.py`.
"""

from typing import Any, Literal

from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

import archive_backups
import archive_workbench
import backup_origin
from refusals import BackupNotFound, BackupNotWritten, NotTrashed
from services import backup_all as backup_all_service
from services import backup_trash as backup_trash_service
from services import jobs
from services import pull as pull_service
from services import sse
from wire import BackupAllEvents, Job, PullEvents, WireModel, binary, event_stream

router = APIRouter()

BackupSource = Literal["live", "workbench"]
BackupOccasion = Literal[
    "manual", "before-upload", "before-restore", "before-replace", "migration", "backup-all"
]


class Backup(WireModel):
    """One Backup as the Backup list shows it (`list_zip_backups`).
    `kind` is the older provenance the extension sorts by, as the
    Backup's `backup-meta.json` records it ("unknown" without one);
    `source` and `occasion` are "unknown" and null for a Backup from
    before they were recorded. `holds_profile` is false for the Backup
    the move to one Workbench made, which can only be downloaded.
    `name` is the user's rename, null until there is one."""

    filename: str
    created_at: int
    size: int
    kind: str
    source: BackupSource | Literal["unknown"]
    occasion: BackupOccasion | None
    holds_profile: bool
    name: str | None


class BackupList(WireModel):
    character_id: str
    backups: list[Backup]


class BackupSaved(WireModel):
    saved: Literal[True]
    path: str
    filename: str
    created_at: int
    size: int
    kind: str
    source: BackupSource
    occasion: BackupOccasion


class BackupNotSaved(WireModel):
    """Nothing written: the newest Backup already holds this content,
    or the character has no Live to back up."""

    saved: Literal[False]
    reason: Literal["unchanged", "no_live"]


class BackupPayload(WireModel):
    """A Backup's profile, for browsing it read-only. `meta` is its
    `backup-meta.json`, null for a Backup without one."""

    payload: dict[str, Any]
    filename: str
    meta: dict[str, Any] | None


def _job_answers(events: type[BaseModel]) -> dict[int | str, dict[str, Any]]:
    """What a Pull or Back up all answers: the progress stream (its
    `events`), or with `wait=false` the job."""
    return {
        **event_stream("The job, then its progress events until it ends.", events),
        202: {"model": Job, "description": "The job, started (`wait=false`)."},
    }


@router.post(
    "/flist/character/{name}/pull",
    response_model=None,
    response_class=StreamingResponse,
    responses=_job_answers(PullEvents),
)
def flist_character_pull(name: str, wait: bool = True) -> Response:
    """Pull live character data + images for `name`, as a job.

    Answers with the job's progress as an SSE stream (`sse.follow`),
    or with `wait=false` the job itself (202), to follow later through
    `/jobs/{id}/events`. Closing the stream leaves the Pull running;
    `DELETE /jobs/{id}` cancels it. 409 `character_busy` while another
    job holds the character. The work lives in `services/pull.py`, so
    the MCP `pull_character` tool runs exactly the same job; event
    names and payloads are documented there.
    """
    return _answer(pull_service.start(name), wait)


def _answer(job: jobs.Job, wait: bool) -> Response:
    if not wait:
        # Through the model, so the schema's `Job` is what goes out.
        job_answer = Job.model_validate(job.to_dict()).model_dump(mode="json")
        return JSONResponse(job_answer, status_code=202)
    return sse.follow(job)


@router.post("/flist/character/{character_id}/zip-backup")
def flist_character_zip_backup(
    character_id: str,
    force: bool = True,
) -> BackupSaved | BackupNotSaved:
    """A manual Backup: pack the character's Workbench into a
    userscript-restoreable ZIP at `backups/<ISO>.zip`, recorded as
    `source: workbench, occasion: manual`, so the user can park their
    work. Live needs no manual Backup: Back up all and every Upload keep
    it.

    `force=True` is the default because the explicit right-click asked
    for an artefact in hand and dedup would be surprising. A `kind`
    query parameter, which older windows sent, is ignored.
    """
    try:
        result = archive_backups.save_zip_backup(
            character_id,
            source=backup_origin.WORKBENCH,
            occasion=backup_origin.MANUAL,
            force=force,
        )
    except FileNotFoundError as exc:
        # A file the Backup needed went away while it was packed.
        raise BackupNotWritten(str(exc)) from exc
    if result["saved"]:
        return BackupSaved.model_validate(result)
    return BackupNotSaved.model_validate(result)


@router.get("/flist/character/{character_id}/zip-backups")
def flist_character_zip_backups(character_id: str) -> BackupList:
    return BackupList(
        character_id=character_id,
        backups=[Backup.model_validate(b) for b in archive_backups.list_zip_backups(character_id)],
    )


@router.delete(
    "/flist/character/{character_id}/zip-backups/{filename}",
    status_code=204,
)
def flist_character_zip_backup_delete(
    character_id: str, filename: str
) -> None:
    """Move a single Backup to the character's Trash, user-set name and
    all; it can be restored from there until the Trash is emptied.
    Filename validated against the ISO-basic format so a crafted `../`
    path moves nothing. 404 if the Backup isn't there."""
    archive_backups.require_backup_filename(filename)
    try:
        backup_trash_service.trash_backup(character_id, filename)
    except FileNotFoundError as exc:
        raise BackupNotFound("no such Backup") from exc
    except OSError as exc:
        raise NotTrashed(f"could not move backup to the Trash: {exc}") from exc


class BackupRenameRequest(BaseModel):
    name: str


@router.patch("/flist/character/{character_id}/zip-backups/{filename}")
def flist_character_zip_backup_rename(
    character_id: str, filename: str, body: BackupRenameRequest
) -> Backup:
    """Rename a single backup. The ZIP file itself isn't modified;
    the user-set name lives in a sidecar `_names.json` map next to
    the ZIPs. Empty-string name clears the entry (so the UI falls
    back to the timestamp-derived default). Returns the canonical
    entry for the renamed backup so the renderer can update its
    in-memory list without a separate /zip-backups re-fetch."""
    archive_backups.rename_zip_backup(character_id, filename, body.name)
    # Return the freshly-read entry so the client can patch its row.
    for row in archive_backups.list_zip_backups(character_id):
        if row["filename"] == filename:
            return Backup.model_validate(row)
    raise BackupNotFound("no such Backup")


@router.get(
    "/flist/character/{character_id}/zip-backups/{filename}/download",
    response_class=FileResponse,
    responses=binary("application/zip", "The Backup's zip, as it is on disk."),
)
def flist_character_zip_backup_download(
    character_id: str, filename: str
) -> FileResponse:
    """Stream the raw ZIP bytes for a saved backup. Used by Sidebar
    → Backups → right-click → Download ZIP… so the user can lift a
    backup off the machine without digging into %APPDATA%. Filename
    parsing must match the ISO-basic backup filename format; we
    reject anything else so this endpoint can't be turned into an
    arbitrary-file-read by crafting a `../` path."""
    archive_backups.require_backup_filename(filename)
    p = archive_backups.backups_dir(character_id) / filename
    if not p.is_file():
        raise BackupNotFound("no such Backup")
    return FileResponse(
        path=p,
        media_type="application/zip",
        filename=filename,
    )


@router.get(
    "/flist/character/{character_id}/zip-backups/{filename}/payload"
)
def flist_character_zip_backup_payload(
    character_id: str, filename: str
) -> BackupPayload:
    """Read the embedded working.json out of a ZIP backup for the
    read-only Browse Backup mode.

    Backups created since 2026-06-17 (the day this endpoint shipped)
    bundle a `working.json` file alongside the userscript-targeted
    `character.json`. We read the former so the renderer's editor
    tabs can render the rich internal shape (descriptions, kink
    overlay, custom-kink dict, etc.) without inverting the export
    reshape passes.

    Older backups predate the `working.json` write and answer 409
    `backup_too_old`, as Restore does. We deliberately don't try to invert
    character.json on the fly; it's a multi-stage lossy reshape and
    not worth the complexity for the v1 ship.
    """
    payload = archive_backups.read_backup_profile(character_id, filename)
    # Optional backup-meta.json — embedded since 2026-06-17. Older
    # Backups don't have it; the Browse-backup viewer falls back to
    # "unknown" provenance.
    meta = archive_backups.zip_backup_meta(character_id, filename) or None
    payload = archive_workbench.backup_payload(payload)
    return BackupPayload(payload=payload, filename=filename, meta=meta)


@router.post(
    "/flist/backup-all",
    response_model=None,
    response_class=StreamingResponse,
    responses=_job_answers(BackupAllEvents),
)
def flist_backup_all(wait: bool = True) -> Response:
    """Back up every character on the signed-in account, as a job.

    Answers like a Pull (`flist_character_pull`): the progress stream,
    or with `wait=false` the job. One Back up all at a time, and none
    while a Pull runs (409 `character_busy`). The sweep lives in
    `services/backup_all.py` so the MCP `backup_all_characters` tool
    runs the same one; event names and payloads are documented there.
    """
    return _answer(backup_all_service.start(), wait)
