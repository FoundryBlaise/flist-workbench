"""Upload: the userscript ZIP, and the paired browser extension.

The extension's own routes take its pairing token
(`_require_pairing`); pairing itself is accepted from the app
window. Their paths say `/restore/` and `snapshot` because the released
extension calls them so; they move only with an extension release that
knows new ones (services/upload.py).
"""

from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, Response
from pydantic import BaseModel

import archive_images
import archive_registry
import archive_workbench
from archive_errors import CharacterNotFound, NoLive
from refusals import BackupNotFound, InvalidRequest, NotPaired
from services import events
from services import pull as pull_service
from services import upload as upload_service
from wire import WireModel, binary

router = APIRouter()

#: Who the extension's writes are attributed to on the event bus.
EXTENSION = "extension"


@router.get(
    "/flist/character/{character_id}/export.zip",
    response_class=Response,
    responses=binary("application/zip", "The Upload ZIP, as an attachment."),
)
def flist_character_export_zip(character_id: str) -> Response:
    """Build the userscript-compatible Upload ZIP (Tier 6).

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


# ---- what the pairing and extension routes answer ----------------------
#
# The released extension reads these answers; the models describe them
# as they are and do not change them (ADR 0002).


class PairingHandshake(WireModel):
    """A pairing the extension started: it keeps `token` and polls the
    handshake's status until the window accepts it."""

    handshake_id: str
    token: str


class PairingHandshakeStatus(WireModel):
    status: Literal["pending", "accepted", "rejected", "expired"]


class PendingHandshake(WireModel):
    """A pairing waiting for the window's accept. `fingerprint` is a
    short form of the token, for the user to compare."""

    handshake_id: str
    fingerprint: str
    created_at: float


class PendingHandshakes(WireModel):
    pending: list[PendingHandshake]


class HandshakeAnswered(WireModel):
    ok: Literal[True]


class HandshakeUnknown(WireModel):
    """The handshake expired or never existed."""

    ok: Literal[False]
    error: Literal["expired_or_unknown"]


class PairingRevoked(WireModel):
    ok: bool


class PairingStatus(WireModel):
    paired: bool


class ExtensionSeen(WireModel):
    """The extension version as of its last paired call; both null
    until it has made one since the sidecar started."""

    version: str | None
    seen_at: float | None


class UploadCharacter(WireModel):
    """An archived character the extension can take Upload sources from."""

    name: str
    character_id: str


class UploadSourceWorkbench(WireModel):
    """The Workbench as an Upload source. `kind` is "set" because
    extension 0.1.1 finds the Workbench by it."""

    id: Literal["workbench"]
    kind: Literal["set"]
    label: str
    created_at: str | None
    image_count: int
    upload_refused: None


class UploadSourceBackup(WireModel):
    """A Backup as an Upload source. `kind` "pre-restore" is the
    extension's name for a Backup taken before an Upload; `backup_kind`
    is the Backup list's `kind`. `upload_refused` says why it cannot be
    uploaded, or is null."""

    id: str
    kind: Literal["backup", "pre-restore"]
    label: str
    created_at: str | None
    image_count: int
    backup_kind: str | None
    name: str | None
    upload_refused: str | None


class PreUploadBackupKept(WireModel):
    """The Backup taken before an Upload; `snapshot_id` is the
    extension's name for its file name."""

    ok: Literal[True]
    snapshot_id: str
    path: str
    bytes: int


class PreUploadBackupNotKept(WireModel):
    ok: Literal[False]
    error: Literal["unknown_character"]


class ImageIdsDeferred(WireModel):
    character: str
    deferred: bool


class PullScheduled(WireModel):
    scheduled: bool
    character: str
    delay_seconds: float


class UploadDone(WireModel):
    ok: bool


def _handshake_answer(answer: dict[str, Any]) -> HandshakeAnswered | HandshakeUnknown:
    if answer["ok"]:
        return HandshakeAnswered.model_validate(answer)
    return HandshakeUnknown.model_validate(answer)


def _upload_source(source: dict[str, Any]) -> UploadSourceWorkbench | UploadSourceBackup:
    if source["kind"] == "set":
        return UploadSourceWorkbench.model_validate(source)
    return UploadSourceBackup.model_validate(source)


class HandshakeAnswerRequest(BaseModel):
    handshake_id: str


class PreUploadBackupRequest(BaseModel):
    character: str
    payload: dict[str, Any]


class UploadDoneRequest(BaseModel):
    character: str | None = None


def _require_pairing(
    x_workbench_auth: str | None = Header(default=None),
    x_workbench_extension_version: str | None = Header(default=None),
) -> str:
    if not upload_service.auth_token_valid(x_workbench_auth):
        raise NotPaired()
    upload_service.note_extension_version(x_workbench_extension_version)
    return x_workbench_auth  # type: ignore[return-value]


@router.post("/restore/handshake")
def handshake_begin() -> PairingHandshake:
    return PairingHandshake.model_validate(upload_service.begin_handshake())


@router.get("/restore/handshake-status")
def handshake_status(handshake_id: str) -> PairingHandshakeStatus:
    return PairingHandshakeStatus.model_validate(
        upload_service.handshake_status(handshake_id)
    )


@router.get("/restore/handshake/pending")
def handshake_pending() -> PendingHandshakes:
    return PendingHandshakes(
        pending=[
            PendingHandshake.model_validate(h)
            for h in upload_service.list_pending_handshakes()
        ]
    )


@router.post("/restore/handshake/accept")
def handshake_accept(body: HandshakeAnswerRequest) -> HandshakeAnswered | HandshakeUnknown:
    return _handshake_answer(upload_service.accept_handshake(body.handshake_id))


@router.post("/restore/handshake/reject")
def handshake_reject(body: HandshakeAnswerRequest) -> HandshakeAnswered | HandshakeUnknown:
    return _handshake_answer(upload_service.reject_handshake(body.handshake_id))


@router.delete("/restore/token")
def pairing_token_revoke() -> PairingRevoked:
    upload_service.revoke_token()
    return PairingRevoked(ok=True)


@router.get("/pairing")
def pairing_status() -> PairingStatus:
    """Whether the browser extension is paired, for Settings → Security.

    Outside `/restore/` on purpose: it answers the app window only
    (launch secret), never the extension, and never returns the token.
    """
    return PairingStatus(paired=upload_service.is_paired())


@router.get("/restore/extension")
def extension_seen() -> ExtensionSeen:
    """Which extension version the browser is running, as of its last
    authenticated call. `version` is null until it has made one."""
    return ExtensionSeen.model_validate(upload_service.extension_seen())


@router.get("/restore/characters")
def upload_characters(
    _auth: str = Depends(_require_pairing),
) -> list[UploadCharacter]:
    return [
        UploadCharacter.model_validate(c)
        for c in upload_service.list_archived_characters()
    ]


@router.get("/restore/snapshots")
def upload_sources(
    character: str,
    _auth: str = Depends(_require_pairing),
) -> list[UploadSourceWorkbench | UploadSourceBackup]:
    return [_upload_source(s) for s in upload_service.list_upload_sources(character)]


@router.get(
    "/restore/snapshot/{snapshot_id}",
    response_class=Response,
    responses=binary("application/zip", "The Upload source's zip."),
)
def upload_source(
    snapshot_id: str,
    character: str,
    _auth: str = Depends(_require_pairing),
) -> Response:
    """One Upload source as a ZIP; `snapshot_id` is the id the source
    list gave it."""
    data = upload_service.fetch_upload_source(character, snapshot_id)
    if data is None:
        raise BackupNotFound("no such Backup")
    return Response(content=data, media_type="application/zip")


@router.post("/restore/snapshot/fresh")
def pre_upload_backup(
    body: PreUploadBackupRequest,
    _auth: str = Depends(_require_pairing),
) -> PreUploadBackupKept | PreUploadBackupNotKept:
    # The extension's writes are not the window's: attributed to the
    # default `ui`, the window would skip them as its own echo.
    with events.origin(EXTENSION):
        kept = upload_service.write_pre_upload_backup(body.character, body.payload)
    if kept["ok"]:
        return PreUploadBackupKept.model_validate(kept)
    return PreUploadBackupNotKept.model_validate(kept)


class UploadSavedRequest(BaseModel):
    character: str
    #: Seconds to wait before pulling. The extension reports the click
    #: on F-list's save button, which is a moment before the POST has
    #: been processed; pulling instantly would fetch the profile as it
    #: was.
    delay_seconds: float = 5.0


def _character_required() -> InvalidRequest:
    return InvalidRequest(("body", "character"), "character is required")


class UploadImageIdsRequest(BaseModel):
    character: str
    #: `local-<sha8>` -> the id F-list minted for it on upload.
    mapping: dict[str, str]


@router.post("/restore/image-ids")
def upload_image_ids(
    body: UploadImageIdsRequest,
    _auth: str = Depends(_require_pairing),
) -> ImageIdsDeferred:
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
    character_id = upload_service.character_id_for_name(name)
    if character_id is None:
        raise CharacterNotFound(name)
    return ImageIdsDeferred(character=name, deferred=True)


@router.post("/restore/saved")
async def upload_saved(
    body: UploadSavedRequest,
    _auth: str = Depends(_require_pairing),
) -> PullScheduled:
    """The user pressed Save on f-list.net — re-pull so Live matches
    what is published again.

    Live is the only thing this touches. The pull writes live.json and
    the images; the Workbench must come through untouched: the user
    may well have gone on editing it while the upload happened, and
    quietly replacing their draft with what they just published would
    be the rudest possible interpretation of "the Upload finished".

    Returns immediately. A pull takes seconds and the extension has a
    page to get on with; it is fire-and-forget by design, and the
    renderer hears about the result over the event stream like any
    other pull. The Pull is a job like any other once it starts
    (`services.pull.start_when_free`): after `delay_seconds`, and
    after any Pull or Back up all that holds the character then has
    finished. It holds nothing while it waits, so a Pull the user
    starts in the window meanwhile is not refused.
    """
    name = body.character.strip()
    if not name:
        raise _character_required()
    delay = max(0.0, min(60.0, float(body.delay_seconds)))
    with events.origin(EXTENSION):
        pull_service.start_when_free(name, delay=delay)
    return PullScheduled(scheduled=True, character=name, delay_seconds=delay)


@router.post("/restore/done")
def upload_done(
    body: UploadDoneRequest,
    _auth: str = Depends(_require_pairing),
) -> UploadDone:
    return UploadDone(ok=True)
