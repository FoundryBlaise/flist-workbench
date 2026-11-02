"""Pull, Backups and Back up all.

Pull and Back up all stream their progress as server-sent events; the
work itself lives in `services/pull.py` and `services/backup_all.py`.
"""

from fastapi import APIRouter
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

import archive_backups
import archive_workbench
import backup_origin
from refusals import BackupNotFound, BackupNotWritten, NotTrashed
from services import backup_all as backup_all_service
from services import backup_trash as backup_trash_service
from services import pull as pull_service
from services import sse

router = APIRouter()


@router.post("/flist/character/{name}/pull")
async def flist_character_pull(name: str) -> StreamingResponse:
    """Pull live character data + images for `name`, as an SSE stream.

    The orchestration lives in `services/pull.py` so the MCP
    `pull_character` tool runs exactly the same sequence; this only
    frames its events for the renderer. Event names and payloads are
    documented there.
    """

    async def producer():
        async for event, data in pull_service.run(name):
            yield sse.event(event, data)

    return StreamingResponse(
        producer(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/flist/character/{character_id}/zip-backup")
async def flist_character_zip_backup(
    character_id: str,
    force: bool = True,
) -> dict:
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
        return archive_backups.save_zip_backup(
            character_id,
            source=backup_origin.WORKBENCH,
            occasion=backup_origin.MANUAL,
            force=force,
        )
    except FileNotFoundError as exc:
        # A file the Backup needed went away while it was packed.
        raise BackupNotWritten(str(exc)) from exc


@router.get("/flist/character/{character_id}/zip-backups")
async def flist_character_zip_backups(character_id: str) -> dict:
    return {
        "character_id": character_id,
        "backups": archive_backups.list_zip_backups(character_id),
    }


@router.delete(
    "/flist/character/{character_id}/zip-backups/{filename}",
    status_code=204,
)
async def flist_character_zip_backup_delete(
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


class _ZipBackupRename(BaseModel):
    name: str


@router.patch("/flist/character/{character_id}/zip-backups/{filename}")
async def flist_character_zip_backup_rename(
    character_id: str, filename: str, body: _ZipBackupRename
) -> dict:
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
            return row
    raise BackupNotFound("no such Backup")


@router.get(
    "/flist/character/{character_id}/zip-backups/{filename}/download"
)
async def flist_character_zip_backup_download(
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
async def flist_character_zip_backup_payload(
    character_id: str, filename: str
) -> dict:
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
    return {"payload": payload, "filename": filename, "meta": meta}


@router.post("/flist/backup-all")
async def flist_backup_all() -> StreamingResponse:
    """Back up every character on the signed-in account, as an SSE
    stream.

    The sweep lives in `services/backup_all.py` so the MCP
    `backup_all_characters` tool runs the same one; this only frames
    its events for the renderer. Event names and payloads are
    documented there.
    """

    async def producer():
        async for event, data in backup_all_service.run():
            yield sse.event(event, data)

    return StreamingResponse(
        producer(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )
