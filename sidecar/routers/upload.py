"""Upload: the userscript ZIP, and the paired browser extension.

The extension's own routes take its pairing token
(`_require_restore_auth`); pairing itself is accepted from the app
window.
"""

import asyncio
import sys
from typing import Any

from fastapi import APIRouter, Depends, Header, Response
from pydantic import BaseModel

import archive_images
import archive_registry
import archive_workbench
import restore as restore_svc
from archive_errors import CharacterNotFound, NoLive
from refusals import BackupNotFound, InvalidRequest, NotPaired
from services import pull as pull_service

router = APIRouter()


@router.get("/flist/character/{character_id}/export.zip")
def flist_character_export_zip(character_id: str) -> Response:
    """Build the userscript-compatible restore ZIP (Tier 6).

    Bundles `character.json` + every image referenced by the
    Workbench's gallery + the avatar. The renderer triggers a
    download by navigating to this URL, so the response stamps a
    `Content-Disposition: attachment` with a filename derived from
    the character name.

    The export modal shows the Workbench's counts, so this is the
    Workbench too: what the user reviewed is what they upload. Live is
    the fallback only for a character that has no Workbench yet.
    """
    import zip_serialise

    # One step under the character's lock: the gallery the zip packs is
    # the one the payload names, not one a repair renamed in between.
    with archive_registry.character_lock(character_id):
        working = archive_workbench.export_payload(character_id)
        if working is None:
            raise NoLive("no Workbench or Live to export")
        name_for_file = "character"
        char = working.get("character")
        if isinstance(char, dict):
            nm = char.get("name")
            if isinstance(nm, str) and nm:
                name_for_file = nm
        avatar_path = (
            archive_images.avatar_path_for(name_for_file)
            if name_for_file != "character"
            else None
        )
        data = zip_serialise.build_zip(
            character_id,
            working,
            images_dir=archive_images.images_dir(character_id),
            avatar_path=avatar_path,
        )
    import time as _t

    download_name = (
        f"flist_{_safe_filename_part(name_for_file)}_{int(_t.time() * 1000)}.zip"
    )
    return Response(
        content=data,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{download_name}"'
        },
    )


def _safe_filename_part(name: str) -> str:
    """Lower-risk Content-Disposition filename component. F-list permits
    Unicode names; downloaders on Windows reject some characters in
    attachment filenames, so we replace anything outside an ASCII safe
    set with `_` and trim to a sensible length."""
    import re as _re

    cleaned = _re.sub(r"[^A-Za-z0-9._-]+", "_", name.strip()) or "character"
    return cleaned[:64]


class _PairAcceptBody(BaseModel):
    handshake_id: str


class _PreRestoreSnapshotBody(BaseModel):
    character: str
    payload: dict[str, Any]


class _RestoreDoneBody(BaseModel):
    character: str | None = None


def _require_restore_auth(
    x_workbench_auth: str | None = Header(default=None),
    x_workbench_extension_version: str | None = Header(default=None),
) -> str:
    if not restore_svc.auth_token_valid(x_workbench_auth):
        raise NotPaired()
    restore_svc.note_extension_version(x_workbench_extension_version)
    return x_workbench_auth  # type: ignore[return-value]


@router.post("/restore/handshake")
def restore_handshake_begin() -> dict[str, str]:
    return restore_svc.begin_handshake()


@router.get("/restore/handshake-status")
def restore_handshake_status(handshake_id: str) -> dict[str, str]:
    return restore_svc.handshake_status(handshake_id)


@router.get("/restore/handshake/pending")
def restore_handshake_pending() -> dict[str, Any]:
    return {"pending": restore_svc.list_pending_handshakes()}


@router.post("/restore/handshake/accept")
def restore_handshake_accept(body: _PairAcceptBody) -> dict[str, Any]:
    return restore_svc.accept_handshake(body.handshake_id)


@router.post("/restore/handshake/reject")
def restore_handshake_reject(body: _PairAcceptBody) -> dict[str, Any]:
    return restore_svc.reject_handshake(body.handshake_id)


@router.delete("/restore/token")
def restore_token_revoke() -> dict[str, bool]:
    restore_svc.revoke_token()
    return {"ok": True}


@router.get("/pairing")
def pairing_status() -> dict[str, bool]:
    """Whether the browser extension is paired, for Settings → Security.

    Outside `/restore/` on purpose: it answers the app window only
    (launch secret), never the extension, and never returns the token.
    """
    return {"paired": restore_svc.is_paired()}


@router.get("/restore/extension")
def restore_extension_seen() -> dict[str, Any]:
    """Which extension version the browser is running, as of its last
    authenticated call. `version` is null until it has made one."""
    return restore_svc.extension_seen()


@router.get("/restore/characters")
def restore_characters(
    _auth: str = Depends(_require_restore_auth),
) -> list[dict[str, Any]]:
    return restore_svc.list_archived_characters()


@router.get("/restore/snapshots")
def restore_snapshots(
    character: str,
    _auth: str = Depends(_require_restore_auth),
) -> list[dict[str, Any]]:
    return restore_svc.list_snapshots(character)


@router.get("/restore/snapshot/{snapshot_id}")
def restore_snapshot(
    snapshot_id: str,
    character: str,
    _auth: str = Depends(_require_restore_auth),
) -> Response:
    data = restore_svc.fetch_snapshot_zip(character, snapshot_id)
    if data is None:
        raise BackupNotFound("no such Backup")
    return Response(content=data, media_type="application/zip")


@router.post("/restore/snapshot/fresh")
def restore_snapshot_fresh(
    body: _PreRestoreSnapshotBody,
    _auth: str = Depends(_require_restore_auth),
) -> dict[str, Any]:
    return restore_svc.write_pre_restore_snapshot(body.character, body.payload)


class _RestoreSavedBody(BaseModel):
    character: str
    #: Seconds to wait before pulling. The extension reports the click
    #: on F-list's save button, which is a moment before the POST has
    #: been processed; pulling instantly would fetch the profile as it
    #: was.
    delay_seconds: float = 5.0


def _character_required() -> InvalidRequest:
    return InvalidRequest(("body", "character"), "character is required")


class _RestoreImageIdsBody(BaseModel):
    character: str
    #: `local-<sha8>` -> the id F-list minted for it on upload.
    mapping: dict[str, str]


@router.post("/restore/image-ids")
def restore_image_ids(
    body: _RestoreImageIdsBody,
    _auth: str = Depends(_require_restore_auth),
) -> dict[str, Any]:
    """The extension reporting what F-list called our uploads — noted, not applied.

    An image uploaded in the app is keyed by a hash of its bytes, because
    it has no F-list id until someone uploads it. The extension learns
    the real id at that moment and used to hand it over here, with the
    archive renaming files and rewriting set payloads on the spot.

    It no longer acts on that report. The upload happens during Import —
    before the user has pressed Save, before F-list's profile actually
    contains the picture. Renaming local files for an id the profile may
    never get turned uploads into dangling gallery rows and vanished
    images: the rename had already destroyed the only copy of the bytes,
    and a subsequent pull (which reflects the real profile) had nothing
    left to fold back in.

    The same folding still happens — at the moment it is true. A saved
    profile re-pulls; `dedupe_local_after_pull` matches each pulled
    image's bytes against the local upload and moves the gallery over to
    the real id then, and `collapse_local_duplicates` catches any pair
    that ended up side by side on disk when the Images tab lists them.
    Same cure, applied when the diagnosis holds.
    """
    name = body.character.strip()
    if not name:
        raise _character_required()
    character_id = restore_svc._character_id_for_name(name)
    if character_id is None:
        raise CharacterNotFound(name)
    return {"character": name, "deferred": True}


@router.post("/restore/saved")
async def restore_saved(
    body: _RestoreSavedBody,
    _auth: str = Depends(_require_restore_auth),
) -> dict[str, Any]:
    """The user pressed Save on f-list.net — re-pull so Live matches
    what is published again.

    Live is the only thing this touches. The pull writes live.json and
    the images; the Workbench must come through untouched: the user
    may well have gone on editing it while the upload happened, and
    quietly replacing their draft with what they just published would
    be the rudest possible interpretation of "restore finished".

    Returns immediately. A pull takes seconds and the extension has a
    page to get on with; it is fire-and-forget by design, and the
    renderer hears about the result over the event stream like any
    other pull.
    """
    name = body.character.strip()
    if not name:
        raise _character_required()
    delay = max(0.0, min(60.0, float(body.delay_seconds)))

    async def pull_later() -> None:
        if delay:
            await asyncio.sleep(delay)
        try:
            async for _event, _data in pull_service.run(name):
                pass
        except Exception as exc:  # noqa: BLE001 - background task
            print(f"post-save pull failed for {name}: {exc}", file=sys.stderr)

    asyncio.get_running_loop().create_task(pull_later())
    return {"scheduled": True, "character": name, "delay_seconds": delay}


@router.post("/restore/done")
def restore_done(
    body: _RestoreDoneBody,
    _auth: str = Depends(_require_restore_auth),
) -> dict[str, bool]:
    return {"ok": True}
