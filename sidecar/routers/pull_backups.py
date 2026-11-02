"""Pull, Backups and Back up all.

Pull and Back up all stream their progress as server-sent events; the
work itself lives in `services/pull.py` and `services/backup_all.py`.
"""

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

import archive_backups
import archive_workbench
import backup_origin
from refusals import Refusal
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
        raise HTTPException(status_code=409, detail=str(exc)) from exc


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
        raise HTTPException(status_code=404, detail="backup not found") from exc
    except OSError as exc:
        raise HTTPException(
            status_code=500, detail=f"could not move backup to the Trash: {exc}"
        ) from exc


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
    try:
        archive_backups.rename_zip_backup(character_id, filename, body.name)
    except Refusal:
        # A bad backup name answers as itself, not as a bad set name.
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="backup not found") from exc
    # Return the freshly-read entry so the client can patch its row.
    for row in archive_backups.list_zip_backups(character_id):
        if row["filename"] == filename:
            return row
    raise HTTPException(status_code=404, detail="backup not found")


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
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="backup not found")
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

    Older backups predate the `working.json` write and return 410
    Gone with an explanation — the user retries Back-up-now and the
    next browse works. We deliberately don't try to invert
    character.json on the fly; it's a multi-stage lossy reshape and
    not worth the complexity for the v1 ship.
    """
    import zipfile

    archive_backups.require_backup_filename(filename)
    p = archive_backups.backups_dir(character_id) / filename
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="backup not found")
    archive_backups.require_backup_holds_profile(character_id, filename)
    meta: dict | None = None
    try:
        with zipfile.ZipFile(p, "r") as zf:
            try:
                raw = zf.read("working.json").decode("utf-8")
            except KeyError as exc:
                raise HTTPException(
                    status_code=410,
                    detail=(
                        "This backup predates Browse support. Click "
                        "Back up now on the character and the new "
                        "backup will be browsable."
                    ),
                ) from exc
            # Optional backup-meta.json — embedded since 2026-06-17.
            # Older backups don't have it; the Browse-backup viewer
            # falls back to "unknown" provenance.
            try:
                meta_raw = zf.read("backup-meta.json").decode("utf-8")
                parsed = json.loads(meta_raw)
                if isinstance(parsed, dict):
                    meta = parsed
            except (KeyError, ValueError):
                meta = None
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=500, detail="corrupt backup file") from exc
    try:
        payload = json.loads(raw)
    except ValueError as exc:
        raise HTTPException(
            status_code=500, detail="backup working.json is not valid JSON"
        ) from exc
    if isinstance(payload, dict):
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
