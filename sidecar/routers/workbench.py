"""The Workbench: read, save, Restore from a Backup, reset to Live."""

from typing import Any

from fastapi import APIRouter, Body, Header
from pydantic import BaseModel

import archive_backups
import archive_live
import archive_workbench
from archive_errors import (
    InvalidWorkbenchPayload,
    NoWorkbench,
    WorkbenchConflict,
)
from refusals import BackupNotFound, InvalidRequest

router = APIRouter()


class _LoadBackupBody(BaseModel):
    """Restore a Backup into the Workbench.

    `back_up_first` is still accepted from older windows and ignored:
    the Workbench is always kept as a Backup first (ADR 0003).
    """

    filename: str
    back_up_first: bool = True


@router.get("/flist/character/{character_id}/workbench")
def flist_character_workbench(character_id: str, create: bool = True) -> dict:
    """The character's one editable copy, created from Live if needed:
    `{workbench: {name, created_at, updated_at}}`.

    `create=false` answers "is there one yet" without making it so,
    which is what a read-only render wants.
    """
    if create:
        archive_workbench.read_workbench(character_id, create=True)
    info = archive_workbench.workbench_info(character_id)
    if info is None:
        # Two different nothings, and the window renders them
        # differently: a character never pulled has nothing to copy
        # from, while one merely not edited yet gets the row that
        # offers to start.
        reason = (
            "no_live"
            if archive_live.read_live(character_id) is None
            else "not_created_yet"
        )
        return {"workbench": None, "reason": reason}
    return {"workbench": info.to_dict()}


@router.get("/flist/character/{character_id}/workbench/payload")
def flist_character_workbench_payload_get(
    character_id: str, create: bool = True
) -> dict:
    """The Workbench payload and the etag a save must send back.

    Made from Live when the character has none yet, and then `created`
    says so: that copy holds nobody's edits. `create=false` reads
    without making one (404 `no_workbench`).
    """
    read = archive_workbench.read_workbench(character_id, create=create)
    if read is None:
        raise NoWorkbench(character_id)
    return {"payload": read.payload, "etag": read.etag, "created": read.created}


@router.put("/flist/character/{character_id}/workbench/payload")
def flist_character_workbench_payload_put(
    character_id: str,
    payload: dict[str, Any] = Body(...),
    if_match: str | None = Header(default=None, alias="If-Match"),
) -> dict:
    """Save the whole Workbench, against the etag the caller read.

    No `If-Match` is a write by something that never read what it is
    replacing: refused with 409 `etag_required`, like a stale etag
    (409 `etag_mismatch`). A window that had seeded its editor from
    Live once flattened a long draft down to the published text this
    way, one keystroke at a time. Both carry the current etag.
    """
    try:
        etag = archive_workbench.write_workbench(
            character_id, payload, expected_etag=if_match
        )
    except archive_workbench.EtagRequired as exc:
        raise WorkbenchConflict(
            "etag_required",
            "Read the Workbench and send its etag as If-Match; a write "
            "that has not seen the current contents would overwrite them.",
            exc.current_etag,
        ) from exc
    except archive_workbench.EtagMismatch as exc:
        raise WorkbenchConflict(
            "etag_mismatch",
            "The Workbench changed since it was read.",
            exc.current_etag,
        ) from exc
    except ValueError as exc:
        raise InvalidWorkbenchPayload(str(exc)) from exc
    return {"etag": etag}


def _filename_required(where: str) -> InvalidRequest:
    return InvalidRequest((where, "filename"), "filename is required")


@router.post("/flist/character/{character_id}/workbench/load-backup")
def flist_character_workbench_load_backup(
    character_id: str, body: _LoadBackupBody
) -> dict:
    """Restore: replace the Workbench contents with a Backup's.

    The Workbench it replaces is saved as a `before-restore` Backup
    first, always; `backed_up_first` names it (null when there was no
    Workbench yet). When that Backup cannot be written, nothing is
    replaced and the caller hears 500 `workbench_not_kept`.

    `live_diverged` is reported back rather than enforced. A backup can
    be older than the profile now on F-list, and loading it anyway is a
    legitimate thing to want — the window says so and lets the user
    decide.
    """
    filename = (body.filename or "").strip()
    if not filename:
        raise _filename_required("body")
    # A bad name is refused as such, not as an unreadable Backup.
    archive_backups.require_backup_filename(filename)

    replaced = archive_backups.load_zip_backup_into_workbench(character_id, filename)

    info = archive_workbench.workbench_info(character_id)
    return {
        "workbench": info.to_dict() if info is not None else None,
        "payload": replaced.payload,
        "etag": replaced.etag,
        "loaded": filename,
        "backed_up_first": replaced.kept,
    }


@router.post("/flist/character/{character_id}/workbench/reset-to-live")
def flist_character_workbench_reset_to_live(character_id: str) -> dict:
    """Reset to Live: the Workbench becomes a fresh copy of Live.

    Done here rather than in the window so the Workbench it replaces is
    saved as a `before-restore` Backup first, whoever asks; that Backup
    is `backed_up_first` (null when there was no Workbench yet). When it
    cannot be written nothing is replaced: 500 `workbench_not_kept`. A
    character never pulled has no Live: 404 `no_live`.

    Answers with the new payload and its etag, which the window adopts
    as the Workbench it saves over next.
    """
    replaced = archive_backups.reset_workbench_to_live(character_id)
    return {
        "payload": replaced.payload,
        "etag": replaced.etag,
        "backed_up_first": replaced.kept,
    }


@router.get("/flist/character/{character_id}/workbench/load-backup/preflight")
def flist_character_workbench_load_preflight(
    character_id: str, filename: str
) -> dict:
    """What the confirm dialog needs to say before overwriting the bench.

    Answers two questions the user cannot see for themselves: whether
    the bench currently holds anything that is not already in Live, and
    whether F-list has moved on since the backup was taken.
    """
    filename = (filename or "").strip()
    if not filename:
        raise _filename_required("query")
    entry = next(
        (
            e
            for e in archive_backups.list_zip_backups(character_id)
            if e.get("filename") == filename
        ),
        None,
    )
    if entry is None:
        raise BackupNotFound("no such Backup")

    bench = archive_workbench.read_workbench(character_id)
    bench_has_edits = bench is not None and bool(bench.payload.get("_overlay"))

    # "Diverged" means the profile on F-list was pulled after this
    # backup was taken, so the backup is not a picture of what is up
    # there now. Cheap and honest: a timestamp comparison, not a diff.
    live_pulled_at = None
    live = archive_live.read_live(character_id)
    if isinstance(live, dict):
        fetched = live.get("fetched_at")
        if isinstance(fetched, (int, float)):
            live_pulled_at = int(fetched)
    created_at = entry.get("created_at")
    live_diverged = bool(
        live_pulled_at is not None
        and isinstance(created_at, (int, float))
        and live_pulled_at > int(created_at)
    )

    return {
        "filename": filename,
        "backup_created_at": created_at,
        "live_pulled_at": live_pulled_at,
        "live_diverged": live_diverged,
        "workbench_has_edits": bench_has_edits,
    }
