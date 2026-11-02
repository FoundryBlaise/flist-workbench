import asyncio
import dataclasses
import json
import os
import sys
from contextlib import asynccontextmanager
from dataclasses import asdict
from http import HTTPStatus
from typing import Any, AsyncIterator, Literal

from fastapi import (
    Body,
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Request,
    Response,
)
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

import aliases as aliases_store
import backup_origin
import character_archive
import eicons as eicons_catalog
import flist_activity
import flist_api
import foreign_cache
import labels as labels_store
import restore as restore_svc
import rag as rag_settings
import rag_embed
import rag_jobs
import rag_lexical
import rag_query
import rag_store
import settings as settings_store
import workbench_mcp
import workbench_migration
from archive_errors import (
    InvalidWorkbenchPayload,
    NoWorkbench,
    WorkbenchConflict,
)
from refusals import InvalidFileName, LogNameRefused, Refusal
from routers import flist_session, health, live, lookups, pull_backups, workbench
from services import avatars, label_rollup, local_access, password_idle
from services import render as render_service
from services import backup_all as backup_all_service
from services import backup_trash as backup_trash_service
from services import label_trash as label_trash_service
from services import events as event_bus
from services import foreign as foreign_service
from services import image_import as image_import_service
from services import image_trash as image_trash_service
from services import pull as pull_service
from logs import (
    LogDirError,
    data_dir,
    find_contacts,
    list_characters,
    list_partners,
    read_messages,
    search_all_partners,
    search_messages,
)


# Tests (and anyone running the sidecar air-gapped) set this to skip
# the one startup step that blocks on the network: the eicon catalog
# warm-up fetches from xariah.net when no disk cache exists.
OFFLINE_STARTUP = os.environ.get("FLIST_WORKBENCH_OFFLINE_STARTUP") == "1"

# The port Electron spawns the sidecar on. Fixed at 27384 by default —
# the browser extension and every MCP client config hardcode it too.
SIDECAR_PORT = int(os.environ.get("SIDECAR_PORT", "27384"))


@asynccontextmanager
async def sidecar_lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Sidecar startup work, in the order the four former
    `@app.on_event("startup")` hooks ran.

    This has to be a lifespan rather than `on_event` because the MCP
    sub-app mounted at `/mcp` needs its session manager started, and
    FastAPI silently ignores every `on_event` handler as soon as a
    lifespan is present. The startup routines themselves live next to
    the code they belong to; the steps below only name and sequence
    them.
    """
    import asyncio as _asyncio

    local_access.require_configured()
    event_bus.bind_loop(_asyncio.get_running_loop())
    if not OFFLINE_STARTUP:
        await _eicons_warm_up()
    await _hydrate_activity_log_on_startup()
    await _avatar_cleanup_on_startup()
    await _adopt_old_pre_upload_backups_on_startup()
    workbench_migration.migrate_all()
    await _password_idle_watchdog()
    async with workbench_mcp.session_manager_lifespan(_MCP_SERVERS):
        yield


async def _eicons_warm_up() -> None:
    """Warm the eicon catalog. Sequenced by `sidecar_lifespan`."""
    await eicons_catalog.start()


async def _hydrate_activity_log_on_startup() -> None:
    """Load the on-disk redacted activity log into the in-memory
    buffer so a restart-after-incident still surfaces audit context
    in the Help → F-list Activity Log modal."""
    loaded = flist_activity.hydrate_from_disk()
    if loaded > 0:
        print(
            f"[flist] hydrated {loaded} activity events from disk",
            flush=True,
        )


async def _avatar_cleanup_on_startup() -> None:
    count = avatars.cleanup_placeholder_avatars()
    if count > 0:
        print(
            f"[flist] cleaned {count} placeholder avatars from cache "
            "(left over from pre-URL-fix sidecar)",
            flush=True,
        )


async def _adopt_old_pre_upload_backups_on_startup() -> None:
    count = character_archive.adopt_old_pre_upload_backups()
    if count > 0:
        print(
            f"[flist] {count} Backups taken before an Upload by an earlier "
            "version are now in the Backup list",
            flush=True,
        )


async def _password_idle_watchdog() -> None:
    await password_idle.start_watchdog()


# Sub-servers keyed by mount suffix: "" (everything), "character"
# (profile editing only) and "logs" (logs, labels, retrieval). Small
# local models choke on a 75-tool list, so the narrow ones exist as
# separate endpoints over the same implementations.
_MCP_SERVERS = workbench_mcp.build_mcp_servers()


def _known_character(request: Request) -> None:
    """Every route with a `{character_id}` names a character the archive
    already holds. Only the Pull, keyed by name, brings one in.

    Checked before the route's own parameters and body, so an unknown
    id is refused the same way however complete the request is, and
    before anything could create a folder for it.
    """
    character_id = request.path_params.get("character_id")
    if character_id is None:
        return
    character_archive.character_dir(character_id)


app = FastAPI(
    title="F-list Workbench sidecar",
    dependencies=[Depends(_known_character)],
    # Electron passes its own version when it spawns us, so /health
    # reports what the user actually installed. Standalone runs
    # (tests, a bare `uv run`) have no app around to ask.
    version=os.environ.get("FLIST_WORKBENCH_VERSION") or "0.0.0-dev",
    lifespan=sidecar_lifespan,
)

# For `/mcp-info`, which describes the endpoints mounted below.
app.state.mcp_servers = _MCP_SERVERS
app.state.sidecar_port = SIDECAR_PORT

workbench_mcp.mount(app, _MCP_SERVERS)


_TOUCH_EXEMPT_PATHS = {
    # Renderer's heartbeat poll — would defeat the idle timer trivially.
    ("/flist/session", "GET"),
    # Audit-log fetch — reading the log is not session work; if the
    # user only opens the activity modal, they're auditing, not using.
    # (QA verification pass 2026-05-30 explicitly flagged this.)
    ("/flist/activity", "GET"),
}


@app.middleware("http")
async def _flist_touch_middleware(request, call_next):
    """Mark TicketStore as touched on any user-initiated /flist/*
    request. Heartbeat polls and audit-log reads are excluded so a
    backgrounded app window can't keep the password cached
    just by polling or auditing.
    """
    path = request.url.path
    if path.startswith("/flist/") and (path, request.method) not in _TOUCH_EXEMPT_PATHS:
        flist_api.ticket_store().touch()
    return await call_next(request)


# Added last, so it is the outermost layer: a refused request touches
# nothing above. CORS is answered there too, per caller.
app.add_middleware(local_access.LocalAccessGuard, port=SIDECAR_PORT)


@app.exception_handler(Refusal)
async def _refusal(_request: Request, exc: Refusal) -> JSONResponse:
    """Wherever a typed refusal is raised (a hostile character id, a
    bad file name, a missing Log), the caller hears it as
    `{code, message}` rather than as a 500."""
    return JSONResponse(status_code=exc.status, content=exc.body())


@app.exception_handler(StarletteHTTPException)
async def _http_exception(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
    """Refusals not yet raised as a typed `Refusal` still answer in the
    `{code, message}` shape.

    `detail` stays in the body as it was, because the app window reads
    structured details from it (an etag conflict, a cross-character
    confirmation). A detail that carries its own `code` keeps it; any
    other gets a generic `http_<status>`.
    """
    detail = exc.detail
    code = f"http_{exc.status_code}"
    try:
        message = HTTPStatus(exc.status_code).phrase
    except ValueError:
        message = "refused"
    if isinstance(detail, str):
        message = detail
    elif isinstance(detail, dict):
        if isinstance(detail.get("code"), str):
            code = detail["code"]
        for key in ("message", "detail"):
            if isinstance(detail.get(key), str):
                message = detail[key]
                break
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": code, "message": message, "detail": detail},
        headers=getattr(exc, "headers", None),
    )


@app.exception_handler(RequestValidationError)
async def _invalid_request(_request: Request, exc: RequestValidationError) -> JSONResponse:
    """A request FastAPI could not bind (a missing query parameter, a
    body of the wrong shape). `detail` keeps FastAPI's error list."""
    errors = jsonable_encoder(exc.errors())
    first = errors[0] if errors else {}
    where = ".".join(str(part) for part in first.get("loc", ()))
    message = f"{where}: {first.get('msg', 'invalid request')}" if where else "invalid request"
    return JSONResponse(
        status_code=422,
        content={"code": "invalid_request", "message": message, "detail": errors},
    )


@app.get("/flist/character/{character_id}/images/{filename}")
async def flist_character_image(character_id: str, filename: str) -> FileResponse:
    """Serve `images/<image_id>.<ext>`. The filename shape is validated
    against the safe-name regex so a hostile renderer call can't path-
    traverse out of the images directory."""
    character_archive.require_image_filename(filename)
    path = character_archive.images_dir(character_id) / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="image not found")
    return FileResponse(path)


@app.get("/flist/character/{character_id}/images")
async def flist_character_images_list(character_id: str) -> dict:
    """List the files in `images/`. Each row: `{image_id, extension,
    size, added_at}`. Renderer pairs these with description/sort_order
    from the Workbench to decide which are on the profile vs. in the
    pool view."""
    return {
        "character_id": character_id,
        "images": character_archive.list_character_images(character_id),
    }


@app.get("/flist/character/{character_id}/image/{image_id}")
async def flist_character_image_by_id(
    character_id: str, image_id: str
) -> FileResponse:
    """Serve `images/<image_id>.<ext>` without the renderer having to
    know the extension. Tries the supported set in order; 404 when none
    exists. Lets the gallery render thumbnails reliably without a
    separate round-trip to look up extensions."""
    character_archive.require_image_id(image_id)
    d = character_archive.images_dir(character_id)
    for ext in ("png", "jpg", "gif"):
        candidate = d / f"{image_id}.{ext}"
        if candidate.exists():
            return FileResponse(candidate)
    raise HTTPException(status_code=404, detail="image not found")


@app.post("/flist/character/{character_id}/images")
async def flist_character_image_upload(
    character_id: str, request: Request
) -> dict:
    """Upload an image into `images/` under a `local-<sha8>` synthetic
    id. The body is the raw image bytes; the server sniffs magic bytes
    to decide the extension (Content-Type is never trusted). The
    uploaded image lands in the renderer's Pool view by default — it
    only appears on-profile after the user moves it via a Workbench
    gallery edit.

    Idempotent — identical bytes always produce the same `local-<sha8>`
    id and skip re-writing the file."""
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="empty body")
    if len(body) > 16 * 1024 * 1024:
        # F-list itself caps images well below this; the bound is here
        # to keep a hostile body from blocking the loop on disk write.
        raise HTTPException(status_code=413, detail="image too large")
    row = character_archive.add_uploaded_image(character_id, body)
    if row is None:
        raise HTTPException(
            status_code=415,
            detail="unsupported image type (png/jpg/gif only)",
        )
    return row


@app.post("/flist/character/{character_id}/images/repair")
async def flist_character_images_repair(character_id: str) -> dict:
    """Put the gallery back together when entries have lost their bytes.

    Called when the Images tab opens. A slot pointing at a file that is
    gone renders as a black placeholder, and — worse — drops out of the
    restore ZIP, which the extension reads as "delete this from the
    profile". Users lost images on f-list.net that way, so this runs on
    its own rather than waiting to be found in a menu.

    Cheap: it hashes the character's own image files and nothing else.
    """
    return character_archive.repair_gallery(character_id)


@app.delete("/flist/character/{character_id}/images/{image_id}")
async def flist_character_image_remove(
    character_id: str, image_id: str
) -> dict:
    """Move `images/<image_id>.<ext>` into the character's trash, where
    it can be restored until the trash is emptied. The renderer drops
    any gallery row pointing at it."""
    result = image_trash_service.trash_images(character_id, [image_id])
    if not result["trashed"]:
        raise HTTPException(status_code=404, detail="image not found")
    return {"trashed": True, "image_id": image_id}


class _ImageIdsBody(BaseModel):
    image_ids: list[str]


@app.post("/flist/character/{character_id}/images/trash")
async def flist_character_images_trash(character_id: str, body: _ImageIdsBody) -> dict:
    """Move several pool files into the trash at once."""
    return image_trash_service.trash_images(character_id, body.image_ids)


# Not under /images/: that prefix is taken by the `{filename}` route.
@app.get("/flist/character/{character_id}/image-references")
async def flist_character_image_references(character_id: str) -> dict:
    """Where each image id is still used — the Workbench, Live and
    Backups — so the window can warn before trashing one."""
    return image_import_service.references(character_id)


@app.get("/flist/character/{character_id}/trash")
async def flist_character_trash_list(character_id: str) -> dict:
    return {
        "character_id": character_id,
        "items": image_trash_service.list_trash(character_id),
        "backups": backup_trash_service.list_backups(character_id),
        "labels": label_trash_service.list_labels(_trash_owner(character_id)),
    }


@app.get("/flist/character/{character_id}/trash/{filename}")
async def flist_character_trash_file(character_id: str, filename: str) -> FileResponse:
    """Serve a trashed file, for the trash view's thumbnails."""
    character_archive.require_image_filename(filename)
    if filename.endswith(".json"):
        # The trash's own metadata sits next to the files.
        raise InvalidFileName("invalid image filename")
    path = image_trash_service.trash_dir(character_id) / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="image not found")
    return FileResponse(path)


@app.post("/flist/character/{character_id}/trash/restore")
async def flist_character_trash_restore(character_id: str, body: _ImageIdsBody) -> dict:
    """Put trashed files back into the pool (not onto the profile)."""
    return image_trash_service.restore_images(character_id, body.image_ids)


class _TrashIdsBody(BaseModel):
    ids: list[str]


@app.post("/flist/character/{character_id}/trash/backups/restore")
async def flist_character_trash_backups_restore(
    character_id: str, body: _TrashIdsBody
) -> dict:
    """Put trashed Backups back in the Backup list, under their names."""
    return backup_trash_service.restore_backups(character_id, body.ids)


def _trash_owner(character_id: str) -> str:
    """The name this character's cleared Labels are kept under, for the
    Trash routes. The id is checked first, as every Trash route checks
    it: an unsafe one is refused with `invalid_character_id` (400), one
    the archive does not hold with `character_not_found` (404). A
    character without a name owns no cleared Labels: its listing shows
    none and a restore or purge finds none (`""` matches no entry)."""
    character_archive.character_dir(character_id)
    return character_archive.character_name(character_id) or ""


@app.post("/flist/character/{character_id}/trash/labels/restore")
async def flist_character_trash_labels_restore(
    character_id: str, body: _TrashIdsBody
) -> dict:
    """Put cleared Labels back. A message labelled again since keeps
    its newer Label and is reported under `skipped`."""
    return label_trash_service.restore(_trash_owner(character_id), body.ids)


# Deleting for good is the window's alone: the MCP layer has no tool for
# it, so a model can never make a picture, a Backup or cleared Labels
# unrecoverable.
@app.post("/flist/character/{character_id}/trash/purge")
async def flist_character_trash_purge(character_id: str, body: _ImageIdsBody) -> dict:
    return image_trash_service.purge_images(character_id, body.image_ids)


@app.post("/flist/character/{character_id}/trash/backups/purge")
async def flist_character_trash_backups_purge(
    character_id: str, body: _TrashIdsBody
) -> dict:
    return backup_trash_service.purge_backups(character_id, body.ids)


@app.post("/flist/character/{character_id}/trash/labels/purge")
async def flist_character_trash_labels_purge(
    character_id: str, body: _TrashIdsBody
) -> dict:
    return label_trash_service.purge(_trash_owner(character_id), body.ids)


@app.delete("/flist/character/{character_id}/trash")
async def flist_character_trash_empty(character_id: str) -> dict:
    """Empty the whole Trash: images, Backups and cleared Labels."""
    owner = _trash_owner(character_id)
    return {
        "purged": image_trash_service.empty_trash(character_id)
        + backup_trash_service.empty(character_id)
        + label_trash_service.empty(owner)
    }


@app.get("/flist/character/{character_id}/export.zip")
async def flist_character_export_zip(character_id: str) -> Response:
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

    working = character_archive.export_payload(character_id)
    if working is None:
        raise HTTPException(
            status_code=404,
            detail="no Workbench or Live to export",
        )
    name_for_file = "character"
    char = working.get("character")
    if isinstance(char, dict):
        nm = char.get("name")
        if isinstance(nm, str) and nm:
            name_for_file = nm
    avatar_path = (
        character_archive.avatar_path_for(name_for_file)
        if name_for_file != "character"
        else None
    )
    data = zip_serialise.build_zip(
        character_id,
        working,
        images_dir=character_archive.images_dir(character_id),
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


@app.get("/flist/character/{character_id}/inlines/{filename}")
async def flist_character_inline(character_id: str, filename: str) -> FileResponse:
    character_archive.require_image_filename(filename)
    path = character_archive.inlines_dir(character_id) / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="inline not found")
    return FileResponse(path)


# ---- foreign profiles (read-only viewer) ------------------------------
#
# Somebody else's profile, cached under `<userdata>/foreign/` and never
# under `characters/`. There is deliberately no route here that writes
# into the archive: no Workbench, no Backup, no export.
# The viewer reads.


_FOREIGN_STATUS = {
    "validation_failed": 400,
    "not_signed_in": 401,
    "not_found": 404,
    "no_logs": 503,
    "rate_limited": 429,
    "flist_error": 502,
}


def _foreign_http(exc: foreign_service.ForeignError) -> HTTPException:
    return HTTPException(
        status_code=_FOREIGN_STATUS.get(exc.code, 500),
        detail={"code": exc.code, "message": exc.message},
    )


@app.get("/foreign/search")
async def foreign_search(source: str, q: str = "") -> dict:
    """Candidate names from one of the viewer's three sources.

    `bookmarks` and `friends` come off the F-list account (one API
    call, memoised); `logs` walks the local F-Chat log directories and
    costs nothing; `name` echoes the typed string back because F-list
    has no character search to call.
    """
    try:
        return await foreign_service.search(q, source)
    except foreign_service.ForeignError as exc:
        raise _foreign_http(exc) from exc


@app.get("/foreign/character/{name}")
async def foreign_character(name: str, refresh: bool = False) -> dict:
    """One foreign profile. Served from cache while it is under the
    24-hour TTL; `refresh=true` is the viewer's reload button."""
    try:
        return await foreign_service.get_profile(name, refresh=refresh)
    except foreign_service.ForeignError as exc:
        raise _foreign_http(exc) from exc


@app.get("/foreign/character/{name}/avatar")
async def foreign_character_avatar(name: str) -> FileResponse:
    """The profile's avatar, cached inside its own foreign folder.

    Kept out of `<userdata>/avatars/`, which the account picker treats
    as "characters this user has". Same placeholder detection as
    `/flist/avatar/{name}` so the renderer falls back to an initial
    circle instead of showing F-list's grey stand-in.
    """
    try:
        dest = foreign_cache.avatar_path(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not dest.exists():
        try:
            await flist_api.download_to(flist_api.avatar_url(name), dest)
        except flist_api.FlistApiError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
    try:
        size = dest.stat().st_size
    except OSError:
        size = -1
    if size == avatars.PLACEHOLDER_SIZE:
        raise HTTPException(status_code=404, detail="no avatar uploaded")
    return FileResponse(dest)


@app.get("/foreign/character/{name}/image/{image_id}")
async def foreign_character_image(name: str, image_id: str) -> FileResponse:
    """A gallery image, downloaded on first request and cached after.

    Lazy on purpose: a profile can list fifty images and fetching the
    set up front would turn opening a profile into a half-minute
    wait. The id must appear in the cached profile's own gallery —
    that is what stops this route being a general-purpose proxy for
    anything on the CDN.
    """
    character_archive.require_image_id(image_id)
    profile = foreign_cache.read_profile(name)
    if profile is None:
        raise HTTPException(status_code=404, detail="profile not cached")
    cached = foreign_cache.find_image(name, image_id)
    if cached is not None:
        return FileResponse(cached)
    gallery = foreign_service.gallery_index(profile)
    raw_ext = gallery.get(image_id)
    if raw_ext is None:
        raise HTTPException(
            status_code=404, detail="image is not in this profile's gallery"
        )
    try:
        ext = character_archive.normalise_image_ext(raw_ext)
    except ValueError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc
    url = f"{flist_api.STATIC_BASE}/images/charimage/{image_id}.{ext}"
    dest = foreign_cache.image_path(name, image_id, ext)
    try:
        # Concurrency-capped, not paced, and down a pooled connection
        # that stays open between images. See FOREIGN_IMAGE_CONCURRENCY.
        async with flist_api.foreign_image_gate():
            await flist_api.download_to(
                url,
                dest,
                client=flist_api.foreign_cdn_client(),
                rate_limiter=flist_api.unpaced_limiter(),
            )
    except flist_api.FlistApiError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return FileResponse(dest)

@app.get("/logs/characters")
def logs_characters() -> dict:
    try:
        return {"characters": [asdict(c) for c in list_characters()]}
    except LogDirError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/logs/partners")
def logs_partners(char: str) -> dict:
    entries = list_partners(char)
    return {"character": char, "partners": [asdict(e) for e in entries]}


@app.get("/logs/messages")
def logs_messages(char: str, partner: str, offset: int = 0, limit: int | None = None) -> dict:
    messages = list(read_messages(char, partner, offset=offset, limit=limit))

    # Resolve each message's IC/OOC/Unlabeled label live — labels are
    # rule-on-read, so settings changes (e.g. threshold) take effect
    # immediately without rebuilding the DB.
    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    try:
        lab_settings = labels_store.load_settings(settings_conn)
        # Folding label rows from any linked alternate names — labels
        # written under "Daelan Envale" pre-rename still apply when
        # the user opens the merged "Asmira" conversation.
        alias_group = aliases_store.all_names_for(labels_conn, char, partner)
        by_hash = labels_store.labels_for_partner(
            labels_conn, char, partner, partner_aliases=alias_group
        )
        for m in messages:
            h = labels_store.msg_hash(m)
            # Send the hash so the renderer can call /labels/override
            # without re-implementing sha1(ts|speaker|raw) client-side.
            m["hash"] = h
            row = by_hash.get(h)
            m["label"] = labels_store.resolve(m, row, lab_settings)
            if row is not None:
                m["label_source"] = row["source"]
                # Surface the labeller's own reason string in the badge
                # tooltip so the user can audit why a label was chosen.
                if row["reason"]:
                    m["label_reason"] = row["reason"]
                # Carry the prior snapshot so the UI can show "the model
                # said IC; you changed it to OOC" on manual overrides.
                if row["prior_label"] is not None:
                    m["prior_label"] = row["prior_label"]
                    m["prior_source"] = row["prior_source"]
            # Otherwise no source is attached — the UI infers "rule
            # or unlabeled" from absence of label_source.
    finally:
        settings_conn.close()
        labels_conn.close()

    return {"character": char, "partner": partner, "offset": offset, "messages": messages}


@app.get("/logs/search")
def logs_search(char: str, partner: str, q: str) -> dict:
    hits = search_messages(char, partner, q)
    return {"character": char, "partner": partner, "query": q, "hits": hits}


@app.get("/logs/search_all")
def logs_search_all(char: str, q: str, limit_per_partner: int = 50) -> dict:
    return search_all_partners(char, q, limit_per_partner=limit_per_partner)


@app.get("/logs/contacts")
def logs_contacts(name: str) -> dict:
    return find_contacts(name)


# ---- labels -------------------------------------------------------------


# ---- rendering (the app draws, the sidecar hands it on) ----------------


@app.get("/render/requests")
async def render_next_request(timeout: float = 25.0) -> dict:
    """The app's long-poll for something to draw.

    Answering this is also how the app says "I am here": a tool asking
    for a picture checks that before it waits, so a model gets told the
    window is closed instead of sitting through a timeout.
    """
    req = await render_service.next_request(
        timeout=max(1.0, min(60.0, timeout))
    )
    return {"request": req.to_json() if req is not None else None}


@app.post("/render/result/{request_id}")
async def render_deliver(request_id: str, request: Request) -> dict:
    """The finished PNG, straight from the app's offscreen capture."""
    png = await request.body()
    if not png:
        raise HTTPException(status_code=422, detail="empty body")
    mime = request.headers.get("content-type") or "image/png"
    if mime not in ("image/png", "image/jpeg"):
        raise HTTPException(status_code=415, detail=f"unsupported type {mime}")
    delivered = render_service.deliver(request_id, png, mime)
    return {"delivered": delivered, "bytes": len(png), "mime": mime}


@app.post("/render/failed/{request_id}")
async def render_fail(request_id: str, body: dict | None = None) -> dict:
    """The app could not draw this one — say why rather than let the
    caller sit out the timeout."""
    message = (body or {}).get("message") or "the window could not render it"
    return {"reported": render_service.fail(request_id, str(message))}


@app.get("/labels/stats")
def labels_stats(char: str, partner: str) -> dict:
    messages = list(read_messages(char, partner))
    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    try:
        lab_settings = labels_store.load_settings(settings_conn)
        alias_group = aliases_store.all_names_for(labels_conn, char, partner)
        counts = labels_store.stats(
            labels_conn,
            char,
            partner,
            messages,
            lab_settings,
            partner_aliases=alias_group,
        )
    finally:
        settings_conn.close()
        labels_conn.close()
    return {
        "character": char,
        "partner": partner,
        "ic": counts[labels_store.LABEL_IC],
        "ooc": counts[labels_store.LABEL_OOC],
        "unlabeled": counts[labels_store.LABEL_UNLABELED],
        "total": sum(counts.values()),
    }


@app.get("/labels/stats-all")
def labels_stats_all(char: str) -> dict:
    """Batch labels stats for every partner of a character.

    The sidebar uses this to render per-partner coverage pips without
    firing one request per row. Reuses the same resolver as
    /labels/stats so a partner's per-row counts always match the
    detailed view. Linked aliases are folded into their primary partner.

    Also returns `log_mtime` (latest of all alias-group log files) and
    `last_label_at` (newest labels.updated_at across the same alias
    group). A stale partner is one where log_mtime > last_label_at —
    log activity arrived after the last classify run for that
    conversation.
    """
    entries = list_partners(char)

    base = data_dir() / char / "logs"
    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    out: list[dict] = []
    try:
        lab_settings = labels_store.load_settings(settings_conn)
        for entry in entries:
            try:
                messages = list(read_messages(char, entry.name))
            except LogDirError:
                # Partner present in the directory listing but unreadable
                # (deleted between calls, permission denied) — skip silently
                # so a single bad file doesn't 500 the whole sidebar.
                continue
            alias_group = aliases_store.all_names_for(
                labels_conn, char, entry.name
            )
            counts = labels_store.stats(
                labels_conn,
                char,
                entry.name,
                messages,
                lab_settings,
                partner_aliases=alias_group,
            )
            # Walk every on-disk file in the alias group for the mtime
            # high-water mark. A folded partner only counts stale when
            # ANY of its underlying files moved after the last label.
            log_mtime = 0.0
            for member in alias_group or [entry.name]:
                p = base / member
                try:
                    log_mtime = max(log_mtime, p.stat().st_mtime)
                except OSError:
                    continue
            last_label = labels_store.max_label_time(
                labels_conn,
                char,
                entry.name,
                partner_aliases=alias_group,
            )
            out.append(
                {
                    "partner": entry.name,
                    "ic": counts[labels_store.LABEL_IC],
                    "ooc": counts[labels_store.LABEL_OOC],
                    "unlabeled": counts[labels_store.LABEL_UNLABELED],
                                "total": sum(counts.values()),
                    "log_mtime": log_mtime if log_mtime > 0 else None,
                    "last_label_at": last_label,
                }
            )
    finally:
        settings_conn.close()
        labels_conn.close()
    return {"character": char, "partners": out}


class RagTestEmbeddingRequest(BaseModel):
    # Optional — omitted means "the saved model". Kept so a model can be
    # tried before it is saved.
    embed_model: str | None = None


@app.post("/rag/test-embedding")
def rag_test_embedding(body: RagTestEmbeddingRequest) -> dict:
    """One canned embedding — validates that the model loads and says
    what dimension it produces.

    Returns latency + dimension on success; ok=false + structured
    error string on failure. Same 200-always shape as
    /labels/test-connection so the UI can render either with one path.
    """
    import time as _time

    saved = rag_settings.load_settings()
    merged = (
        dataclasses.replace(saved, embed_model=body.embed_model)
        if body.embed_model
        else saved
    )

    # First call downloads the model and deserialises the ONNX graph;
    # after that it is milliseconds.
    test_timeout = 60.0
    started = _time.monotonic()
    try:
        dimension, _vec = rag_embed.probe(merged, timeout=test_timeout)
    except rag_embed.EmbedError as exc:
        return {
            "ok": False,
            "error": str(exc),
            "dimension": None,
            "model": merged.embed_model,
            "elapsed_ms": int((_time.monotonic() - started) * 1000),
        }
    except Exception as exc:  # noqa: BLE001 — surface to UI
        return {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "dimension": None,
            "model": merged.embed_model,
            "elapsed_ms": int((_time.monotonic() - started) * 1000),
        }
    return {
        "ok": True,
        "error": None,
        "dimension": dimension,
        "model": merged.embed_model,
        "elapsed_ms": int((_time.monotonic() - started) * 1000),
    }


class RagIngestRequest(BaseModel):
    # Same scope shape as ClassifyJobRequest. {} = every char × every
    # partner; {character: X} = all partners for X; {character: X,
    # partner: Y} = one conversation.
    character: str | None = None
    partner: str | None = None
    # Default off — OOC chunks pollute retrieval for "what happened in
    # this RP" questions. Power users can flip this in a future
    # Settings → RAG advanced toggle.
    include_ooc: bool = False
    # The renderer sends true after the user confirms wiping the
    # collection because the embedding model changed. Without
    # confirmation we refuse to silently corrupt the index.
    force_rewipe: bool = False


@app.post("/rag/ingest", status_code=202)
def rag_ingest_start(body: RagIngestRequest) -> dict:
    # The same resolver MCP ingest_logs uses: any case, and a partner's
    # alias reaches its conversation. An unknown name is refused instead
    # of indexing nothing.
    from workbench_mcp._context import ToolError, resolve_ingest_scope

    try:
        scope = resolve_ingest_scope(body.character, body.partner)
    except ToolError as exc:
        raise LogNameRefused(exc.message, code=exc.code) from exc
    job = rag_jobs.start(
        scope, include_ooc=body.include_ooc, force_rewipe=body.force_rewipe
    )
    return job.to_dict()


@app.get("/rag/jobs")
def rag_jobs_list() -> dict:
    return {"jobs": [j.to_dict() for j in rag_jobs.registry().list()]}


@app.get("/rag/jobs/{job_id}")
def rag_job_get(job_id: str) -> dict:
    job = rag_jobs.registry().get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job: {job_id}")
    return job.to_dict()


@app.delete("/rag/jobs/{job_id}")
def rag_job_cancel(job_id: str) -> dict:
    ok = rag_jobs.registry().cancel(job_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"unknown job: {job_id}")
    return {"id": job_id, "cancel_requested": True}


@app.post("/rag/wipe")
def rag_wipe() -> dict:
    """Drop the local Qdrant collection and clear the manifest.

    Pure delete — no re-ingest, no probe. Use this when you want to
    forget everything and rebuild on your own schedule (e.g. after
    changing chunking settings without immediately re-embedding 80k
    messages). The next /rag/ingest starts cold.
    """
    with rag_store.RagStore() as store:
        store.wipe()
    rag_store.clear_manifest()
    with rag_lexical.LexicalStore() as lex:
        lex.wipe()
    return {"wiped": True}


@app.post("/rag/lexical/rebuild")
def rag_lexical_rebuild() -> dict:
    """Rebuild the BM25 lexical index from the existing Qdrant chunks.

    Avoids a full re-ingest when the dense store is up-to-date but the
    lexical mirror is stale (e.g. after a chunking-config change that
    only required re-embedding once, or after upgrading from a pre-
    hybrid install). Returns the number of chunks indexed.
    """
    with rag_store.RagStore() as store:
        if not store.collection_exists():
            raise HTTPException(
                status_code=409,
                detail=(
                    "No chunks indexed yet — run Ingest first. The lexical "
                    "index mirrors the dense store and has nothing to copy."
                ),
            )
        with rag_lexical.LexicalStore() as lex:
            # Wipe first so the rebuild is authoritative — otherwise a
            # chunk_id that was removed from Qdrant since the last build
            # would stay in FTS.
            lex.wipe()
            indexed = rag_lexical.backfill_from_qdrant(store, lex)
    return {"indexed": indexed}


@app.get("/rag/status")
def rag_status() -> dict:
    """Snapshot of the local vector store + manifest.

    Used by the renderer's Settings → RAG panel to show "indexed: N
    chunks for model X (dim 768)" and by the Ingest dialog as a sanity
    check before a re-ingest. Cheap — one Qdrant count + one SQLite
    read.
    """
    manifest = rag_store.read_manifest()
    chunk_count = 0
    if manifest.embed_dimension is not None:
        # Only open the store when a manifest exists — otherwise the
        # bare /rag/status from a fresh install would create an empty
        # collection on disk for no reason.
        try:
            with rag_store.RagStore() as store:
                chunk_count = store.count() if store.collection_exists() else 0
        except Exception:  # noqa: BLE001 — status must always answer
            chunk_count = 0
    return {
        "embed_model": manifest.embed_model,
        "embed_dimension": manifest.embed_dimension,
        "last_ingest_at": manifest.last_ingest_at,
        "chunk_count": chunk_count,
    }


class LabelOverride(BaseModel):
    character: str
    partner: str
    hash: str
    ts: int
    speaker: str
    # label=None / missing deletes the row (revert to rule / Unlabeled).
    label: str | None = None


class LabelOverrideItem(BaseModel):
    hash: str
    ts: int
    speaker: str


class LabelOverrideMany(BaseModel):
    character: str
    partner: str
    items: list[LabelOverrideItem]
    # label=None deletes the rows (revert to rule / Unlabeled).
    label: str | None = None


class LabelsClearRequest(BaseModel):
    character: str
    partner: str


@app.post("/labels/clear")
def labels_clear(body: LabelsClearRequest) -> dict:
    """Delete every label (LLM + manual) for one conversation.

    Used by the renderer's "Reset all labels" context-menu action.
    After this returns, the resolver falls back to rule-on-read for
    every message in that conversation. The cleared Labels go to the
    character's Trash first (`trash_id`), where Restore puts them back.
    """
    cleared = label_trash_service.clear(body.character, body.partner)
    return {
        "character": body.character,
        "partner": body.partner,
        **cleared,
    }


@app.get("/labels/trash")
def labels_trash_list() -> dict:
    """Every cleared-Labels entry in the Trash, newest first, for
    Settings → Labels. Unlike a character's Trash view this includes a
    Log character with no Workbench, and one whose Log name matches no
    character in the list."""
    return {"labels": label_trash_service.list_labels(None)}


@app.post("/labels/trash/restore")
def labels_trash_restore(body: _TrashIdsBody) -> dict:
    """Put cleared Labels back, whichever character they were cleared
    for. A message labelled again since keeps its newer Label and is
    reported under `skipped`."""
    return label_trash_service.restore(None, body.ids)


@app.post("/labels/trash/purge")
def labels_trash_purge(body: _TrashIdsBody) -> dict:
    """Delete cleared Labels for good. The window's call only: MCP has
    no tool for it."""
    return label_trash_service.purge(None, body.ids)


@app.post("/labels/clear-all")
def labels_clear_all() -> dict:
    """Wipe every stored IC/OOC verdict across all characters.

    The Settings → Labels "Reset all labels…" button calls this. After
    it returns, every message in every conversation falls back to
    rule-on-read — manual overrides are gone too. Each character's
    cleared Labels go to its Trash first, as one entry per character;
    the renderer still confirms before invoking this.
    """
    cleared = label_trash_service.clear_all()
    return {"labels_deleted": cleared["deleted"], "trash_ids": cleared["trash_ids"]}


@app.get("/labels/rollup")
def labels_rollup() -> dict:
    """Aggregate IC/OOC/Unlabeled counts across every character.

    Walks every (character × partner) log under the configured data
    directory; for large corpora this is a few seconds the first time
    Settings opens. Used by the Labels rollup pane to show one-glance
    state ("3,402 IC · 18,720 OOC · …").
    """
    try:
        return label_rollup.rollup()
    except LogDirError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


class LabelsFillUnlabeled(BaseModel):
    character: str
    partner: str
    label: str


class LabelsDeleteHashes(BaseModel):
    character: str
    partner: str
    hashes: list[str]


@app.post("/labels/fill-unlabeled")
def labels_fill_unlabeled(body: LabelsFillUnlabeled) -> dict:
    """Give every still-Unlabeled message in one conversation the same
    verdict.

    For a conversation the user knows is pure IC (or pure OOC) end to
    end. Walking it batch by batch through a connected model buys
    nothing when they already know the answer.

    Deliberately narrow: messages that already carry a verdict keep it,
    and messages the rules decide keep resolving through the rules. So
    this can add labels but never overwrite a model's or the user's
    own. The response carries every hash written, which is what makes
    the undo exact.
    """
    if body.label not in (labels_store.LABEL_IC, labels_store.LABEL_OOC):
        raise HTTPException(
            status_code=400,
            detail=f"label must be IC or OOC, got {body.label!r}",
        )
    messages = list(read_messages(body.character, body.partner))
    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    try:
        lab_settings = labels_store.load_settings(settings_conn)
        alias_group = aliases_store.all_names_for(
            labels_conn, body.character, body.partner
        )
        # Written under the alias group's primary, like every other
        # label, so a later rename does not orphan them.
        primary = aliases_store.primary_for(
            labels_conn, body.character, body.partner
        )
        result = labels_store.fill_unlabeled(
            labels_conn,
            body.character,
            primary,
            messages,
            lab_settings,
            body.label,
            partner_aliases=alias_group,
        )
    finally:
        settings_conn.close()
        labels_conn.close()
    return {"character": body.character, "partner": body.partner, **result}


@app.post("/labels/delete-hashes")
def labels_delete_hashes(body: LabelsDeleteHashes) -> dict:
    """Remove named labels and nothing else — the undo for
    `/labels/fill-unlabeled`. Distinct from `/labels/clear`, which
    drops every verdict in the conversation including a model's."""
    conn = labels_store.connect()
    try:
        removed = labels_store.delete_labels_by_hash(
            conn,
            body.hashes,
            character=body.character,
            partner=body.partner,
        )
    finally:
        conn.close()
    return {
        "character": body.character,
        "partner": body.partner,
        "deleted": removed,
    }


@app.post("/labels/override")
def labels_override(body: LabelOverride) -> dict:
    conn = labels_store.connect()
    try:
        if body.label is None:
            removed = labels_store.delete_label(conn, body.hash)
            return {"hash": body.hash, "deleted": removed, "label": None}
        if body.label not in (labels_store.LABEL_IC, labels_store.LABEL_OOC):
            raise HTTPException(
                status_code=400,
                detail=f"label must be IC or OOC, got {body.label!r}",
            )
        # Write labels under the alias group's canonical primary so
        # the partner column stays consistent post-rename. Lookup is
        # alias-aware (labels_for_partner expands the group) so old
        # rows under the alias name still resolve.
        primary = aliases_store.primary_for(conn, body.character, body.partner)
        labels_store.upsert_label(
            conn,
            hash=body.hash,
            character=body.character,
            partner=primary,
            ts=body.ts,
            speaker=body.speaker,
            label=body.label,
            source="manual",
            reason="manual override",
        )
        row = conn.execute(
            "SELECT label, source, prior_label, prior_source FROM labels WHERE hash = ?",
            (body.hash,),
        ).fetchone()
        return {
            "hash": body.hash,
            "label": row["label"],
            "source": row["source"],
            "prior_label": row["prior_label"],
            "prior_source": row["prior_source"],
        }
    finally:
        conn.close()


@app.post("/labels/override-many")
def labels_override_many(body: LabelOverrideMany) -> dict:
    """`/labels/override` for the log view's multi-select: one verdict,
    or a reset, for any set of messages in one conversation."""
    if body.label is not None and body.label not in (
        labels_store.LABEL_IC,
        labels_store.LABEL_OOC,
    ):
        raise HTTPException(
            status_code=400,
            detail=f"label must be IC or OOC, got {body.label!r}",
        )
    conn = labels_store.connect()
    try:
        if body.label is None:
            changed = labels_store.delete_labels_by_hash(
                conn,
                [i.hash for i in body.items],
                character=body.character,
                partner=body.partner,
            )
        else:
            # Canonical alias primary, as in /labels/override.
            primary = aliases_store.primary_for(conn, body.character, body.partner)
            changed = labels_store.upsert_labels_many(
                conn,
                [(i.hash, i.ts, i.speaker) for i in body.items],
                character=body.character,
                partner=primary,
                label=body.label,
            )
    finally:
        conn.close()
    return {
        "character": body.character,
        "partner": body.partner,
        "label": body.label,
        "changed": changed,
    }


# ---- aliases ------------------------------------------------------------


class AliasAdd(BaseModel):
    character: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=200)
    primary_name: str = Field(min_length=1, max_length=200)


@app.get("/aliases")
def aliases_list(char: str) -> dict:
    """Return {primary_name: [member names…]} for one character.

    Empty dict when the character has no linked partners. Renderer
    uses this to decide whether to render alias hints on each partner
    row.
    """
    conn = aliases_store.connect()
    try:
        groups = aliases_store.list_groups(conn, char)
    finally:
        conn.close()
    return {"character": char, "groups": groups}


@app.post("/aliases", status_code=201)
def aliases_add(body: AliasAdd) -> dict:
    """Link `name` to `primary_name` for `character`. Idempotent;
    handles chain consolidation (linking A→B then A→C ends with both
    A and B pointing at C, never building a multi-hop chain)."""
    conn = aliases_store.connect()
    try:
        aliases_store.add_alias(conn, body.character, body.name, body.primary_name)
        group = aliases_store.all_names_for(conn, body.character, body.primary_name)
    finally:
        conn.close()
    return {
        "character": body.character,
        "primary_name": body.primary_name,
        "group": group,
    }


@app.delete("/aliases")
def aliases_remove(char: str, name: str) -> dict:
    """Drop one name from its alias group."""
    conn = aliases_store.connect()
    try:
        removed = aliases_store.remove_alias(conn, char, name)
    finally:
        conn.close()
    return {"character": char, "name": name, "removed": removed}


@app.delete("/aliases/group")
def aliases_unlink_group(char: str, primary: str) -> dict:
    """Drop every member of an alias group at once."""
    conn = aliases_store.connect()
    try:
        deleted = aliases_store.unlink_group(conn, char, primary)
    finally:
        conn.close()
    return {"character": char, "primary": primary, "deleted": deleted}


# ---- settings -----------------------------------------------------------


def _settings_db():
    conn = settings_store.connect()
    try:
        yield conn
    finally:
        conn.close()


class LabelsSettingsUpdate(BaseModel):
    # Only the rule threshold is left — the classifier's endpoint,
    # model, prompt and context window went away with the in-app LLM.
    # None means "leave untouched"; below 1 is clamped silently.
    threshold_chars: int | None = None


class RagSettingsUpdate(BaseModel):
    # Same convention as LabelsSettingsUpdate: empty string clears
    # (falls back to default on read), None leaves untouched. Prefixes
    # are special — an empty string for them is a real value (not a
    # default), but we still accept it as "clear" since the default
    # also happens to be empty.
    # "local" (in-process ONNX) or "endpoint" (OpenAI-compatible server).
    embed_model: str | None = None
    # Retrieval fields. None = untouched; "" = reset to default.
    # Numeric fields are int|None — empty string isn't meaningful for an
    # int. The renderer just sends None when the user wants the default.
    rerank_model: str | None = None
    rerank_candidates: int | None = None
    top_k: int | None = None
    neighbors: int | None = None
    # Quality / fusion tunables. bool fields use None = untouched
    # (omitted from request); float for the rerank threshold ratio.
    rerank_min_ratio: float | None = None
    hybrid_enabled: bool | None = None
    hybrid_bm25_candidates: int | None = None
    chunk_max_chars: int | None = None
    chunk_soft_split_chars: int | None = None
    chunk_overlap_msgs: int | None = None


class SettingsUpdate(BaseModel):
    # Allow null to clear the override; absent fields are left
    # untouched. Empty string is treated as "unset" for symmetry with
    # the directory picker's "no folder selected" state.
    fchat_data_dir: str | None = None
    labels: LabelsSettingsUpdate | None = None
    rag: RagSettingsUpdate | None = None
    # Folders MCP's import_image may read from. Only this endpoint — the
    # window — sets them; the MCP settings tool can read but not change.
    image_import_roots: list[str] | None = None


def _settings_dict(conn) -> dict:
    import logs

    env_pinned = bool(os.environ.get("FCHAT_DATA_DIR"))
    stored = settings_store.get(conn, settings_store.KEY_FCHAT_DATA_DIR)
    # `effective` is what the sidecar will actually read from on the
    # next /logs request — useful for the UI to display the live path
    # regardless of where the override came from.
    lab = labels_store.load_settings(conn)
    rag = rag_settings.load_settings(conn)
    return {
        "fchat_data_dir": stored,
        "fchat_data_dir_effective": str(logs.data_dir()),
        # Surface whether the env var is forcing the value — the UI
        # should disable the picker in that case so the user isn't
        # surprised by their setting being ignored.
        "fchat_data_dir_env_locked": env_pinned,
        "labels": {
            "threshold_chars": lab.threshold_chars,
            # Defaults exposed so the UI can show "(default)" hints and
            # offer a one-click reset without hardcoding them.
            "defaults": {
                "threshold_chars": labels_store.DEFAULT_THRESHOLD_CHARS,
            },
        },
        "rag": {
            "embed_model": rag.embed_model,
            "rerank_model": rag.rerank_model,
            "rerank_candidates": rag.rerank_candidates,
            "top_k": rag.top_k,
            "neighbors": rag.neighbors,
            "rerank_min_ratio": rag.rerank_min_ratio,
            "hybrid_enabled": rag.hybrid_enabled,
            "hybrid_bm25_candidates": rag.hybrid_bm25_candidates,
            "chunk_max_chars": rag.chunk_max_chars,
            "chunk_soft_split_chars": rag.chunk_soft_split_chars,
            "chunk_overlap_msgs": rag.chunk_overlap_msgs,
            "defaults": {
                "embed_model": rag_settings.DEFAULT_EMBED_MODEL,
                "rerank_model": rag_settings.DEFAULT_RERANK_MODEL,
                "rerank_candidates": rag_settings.DEFAULT_RERANK_CANDIDATES,
                "top_k": rag_settings.DEFAULT_TOP_K,
                "neighbors": rag_settings.DEFAULT_NEIGHBORS,
                "rerank_min_ratio": rag_settings.DEFAULT_RERANK_MIN_RATIO,
                "hybrid_enabled": rag_settings.DEFAULT_HYBRID_ENABLED,
                "hybrid_bm25_candidates": rag_settings.DEFAULT_HYBRID_BM25_CANDIDATES,
                "chunk_max_chars": rag_settings.DEFAULT_CHUNK_MAX_CHARS,
                "chunk_soft_split_chars": rag_settings.DEFAULT_CHUNK_SOFT_SPLIT_CHARS,
                "chunk_overlap_msgs": rag_settings.DEFAULT_CHUNK_OVERLAP_MSGS,
            },
        },
        "image_import_roots": [
            str(p) for p in image_import_service.import_roots(conn)
        ],
    }


class DiscoverModelsRequest(BaseModel):
    """No fields — kept so the route keeps its POST shape."""


@app.post("/settings/discover-models")
def settings_discover_models(body: DiscoverModelsRequest) -> dict:
    """The embedding models that can be selected.

    This used to enumerate whatever an inference server had loaded.
    Embedding runs in-process now, so the honest answer is fastembed's
    own catalogue — with the dimension, download size and licence, since
    those are what the choice actually turns on. Licence matters:
    the catalogue mixes apache-2.0 and MIT with cc-by-nc-4.0.
    """
    import rag_embed_local

    try:
        models = rag_embed_local.available_models()
    except Exception as exc:  # noqa: BLE001 — surfaces in the UI
        return {"models": [], "source": "local", "error": str(exc)}
    return {
        "models": sorted(models, key=lambda m: m["model"]),
        "source": "local",
        "error": None,
    }


@app.get("/settings")
def settings_get(conn=Depends(_settings_db)) -> dict:
    return _settings_dict(conn)


@app.put("/settings")
def settings_update(body: SettingsUpdate, conn=Depends(_settings_db)) -> dict:
    if body.fchat_data_dir is not None:
        value = body.fchat_data_dir.strip()
        if value:
            # Reject obviously bogus paths up front so the UI gets a
            # clean 400 rather than a "characters: []" reply later.
            from pathlib import Path

            p = Path(value).expanduser()
            if not p.exists() or not p.is_dir():
                raise HTTPException(
                    status_code=400,
                    detail=f"directory does not exist: {value}",
                )
            settings_store.set_value(conn, settings_store.KEY_FCHAT_DATA_DIR, str(p))
        else:
            settings_store.clear(conn, settings_store.KEY_FCHAT_DATA_DIR)

    if body.labels is not None:
        _apply_labels_update(conn, body.labels)

    if body.rag is not None:
        _apply_rag_update(conn, body.rag)

    if body.image_import_roots is not None:
        try:
            image_import_service.save_import_roots(conn, body.image_import_roots)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return _settings_dict(conn)


def _apply_labels_update(conn, update: LabelsSettingsUpdate) -> None:
    """Persist each labels field that was supplied.

    None means "leave untouched". threshold_chars below 1 is clamped to
    1 — zero or negative would make every message OOC and is almost
    certainly a typo.
    """
    if update.threshold_chars is not None:
        n = max(1, int(update.threshold_chars))
        settings_store.set_value(conn, settings_store.KEY_LABELS_THRESHOLD_CHARS, str(n))


def _apply_rag_update(conn, update: RagSettingsUpdate) -> None:
    """Persist each RAG field that was supplied.

    Same convention as _apply_labels_update: None leaves the field
    untouched, empty string clears (falls back to default on read).
    """
    for field, key in (
        ("embed_model", settings_store.KEY_RAG_EMBED_MODEL),
        ("rerank_model", settings_store.KEY_RAG_RERANK_MODEL),
    ):
        value = getattr(update, field)
        if value is None:
            continue
        if value == "":
            settings_store.clear(conn, key)
        else:
            settings_store.set_value(conn, key, value)

    # Numeric fields: int|None. Clamp + store as string.
    if update.rerank_candidates is not None:
        n = max(1, min(200, int(update.rerank_candidates)))
        settings_store.set_value(conn, settings_store.KEY_RAG_RERANK_CANDIDATES, str(n))
    if update.top_k is not None:
        n = max(1, min(50, int(update.top_k)))
        settings_store.set_value(conn, settings_store.KEY_RAG_TOP_K, str(n))
    if update.neighbors is not None:
        n = max(0, min(5, int(update.neighbors)))
        settings_store.set_value(conn, settings_store.KEY_RAG_NEIGHBORS, str(n))
    if update.rerank_min_ratio is not None:
        # Stored as the literal float string ("0.5"); _coerce_float on
        # read handles the parse + clamp.
        ratio = max(0.0, min(1.0, float(update.rerank_min_ratio)))
        settings_store.set_value(conn, settings_store.KEY_RAG_RERANK_MIN_RATIO, str(ratio))
    if update.hybrid_enabled is not None:
        # Bools stored as "1" / "0" so the settings table stays TEXT.
        settings_store.set_value(
            conn,
            settings_store.KEY_RAG_HYBRID_ENABLED,
            "1" if update.hybrid_enabled else "0",
        )
    if update.hybrid_bm25_candidates is not None:
        n = max(1, min(200, int(update.hybrid_bm25_candidates)))
        settings_store.set_value(
            conn, settings_store.KEY_RAG_HYBRID_BM25_CANDIDATES, str(n)
        )
    if update.chunk_max_chars is not None:
        n = max(500, min(20000, int(update.chunk_max_chars)))
        settings_store.set_value(conn, settings_store.KEY_RAG_CHUNK_MAX_CHARS, str(n))
    if update.chunk_soft_split_chars is not None:
        # Clamp against the saved (or just-saved) max to keep
        # soft_split < max — same invariant the loader enforces.
        # Re-read so an in-same-request max change is honoured.
        max_raw = settings_store.get(conn, settings_store.KEY_RAG_CHUNK_MAX_CHARS)
        try:
            cur_max = int(max_raw) if max_raw else rag_settings.DEFAULT_CHUNK_MAX_CHARS
        except (TypeError, ValueError):
            cur_max = rag_settings.DEFAULT_CHUNK_MAX_CHARS
        n = max(400, min(max(500, cur_max - 100), int(update.chunk_soft_split_chars)))
        settings_store.set_value(conn, settings_store.KEY_RAG_CHUNK_SOFT_SPLIT_CHARS, str(n))
    if update.chunk_overlap_msgs is not None:
        n = max(0, min(5, int(update.chunk_overlap_msgs)))
        settings_store.set_value(conn, settings_store.KEY_RAG_CHUNK_OVERLAP_MSGS, str(n))


# ---- browser-extension pairing -----------------------------------------


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
        raise HTTPException(status_code=401, detail="not_paired")
    restore_svc.note_extension_version(x_workbench_extension_version)
    return x_workbench_auth  # type: ignore[return-value]


@app.post("/restore/handshake")
def restore_handshake_begin() -> dict[str, str]:
    return restore_svc.begin_handshake()


@app.get("/restore/handshake-status")
def restore_handshake_status(handshake_id: str) -> dict[str, str]:
    return restore_svc.handshake_status(handshake_id)


@app.get("/restore/handshake/pending")
def restore_handshake_pending() -> dict[str, Any]:
    return {"pending": restore_svc.list_pending_handshakes()}


@app.post("/restore/handshake/accept")
def restore_handshake_accept(body: _PairAcceptBody) -> dict[str, Any]:
    return restore_svc.accept_handshake(body.handshake_id)


@app.post("/restore/handshake/reject")
def restore_handshake_reject(body: _PairAcceptBody) -> dict[str, Any]:
    return restore_svc.reject_handshake(body.handshake_id)


@app.delete("/restore/token")
def restore_token_revoke() -> dict[str, bool]:
    restore_svc.revoke_token()
    return {"ok": True}


@app.get("/pairing")
def pairing_status() -> dict[str, bool]:
    """Whether the browser extension is paired, for Settings → Security.

    Outside `/restore/` on purpose: it answers the app window only
    (launch secret), never the extension, and never returns the token.
    """
    return {"paired": restore_svc.is_paired()}


@app.get("/restore/extension")
def restore_extension_seen() -> dict[str, Any]:
    """Which extension version the browser is running, as of its last
    authenticated call. `version` is null until it has made one."""
    return restore_svc.extension_seen()


@app.get("/restore/characters")
def restore_characters(
    _auth: str = Depends(_require_restore_auth),
) -> list[dict[str, Any]]:
    return restore_svc.list_archived_characters()


@app.get("/restore/snapshots")
def restore_snapshots(
    character: str,
    _auth: str = Depends(_require_restore_auth),
) -> list[dict[str, Any]]:
    return restore_svc.list_snapshots(character)


@app.get("/restore/snapshot/{snapshot_id}")
def restore_snapshot(
    snapshot_id: str,
    character: str,
    _auth: str = Depends(_require_restore_auth),
) -> Response:
    data = restore_svc.fetch_snapshot_zip(character, snapshot_id)
    if data is None:
        raise HTTPException(status_code=404, detail="snapshot_not_found")
    return Response(content=data, media_type="application/zip")


@app.post("/restore/snapshot/fresh")
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


class _RestoreImageIdsBody(BaseModel):
    character: str
    #: `local-<sha8>` -> the id F-list minted for it on upload.
    mapping: dict[str, str]


@app.post("/restore/image-ids")
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
        raise HTTPException(status_code=422, detail="character is required")
    character_id = restore_svc._character_id_for_name(name)
    if character_id is None:
        raise HTTPException(status_code=404, detail="unknown character")
    return {"character": name, "deferred": True}


@app.post("/restore/saved")
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
        raise HTTPException(status_code=422, detail="character is required")
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


@app.post("/restore/done")
def restore_done(
    body: _RestoreDoneBody,
    _auth: str = Depends(_require_restore_auth),
) -> dict[str, bool]:
    return {"ok": True}


for _area in (
    health,
    lookups,
    flist_session,
    pull_backups,
    live,
    workbench,
):
    app.include_router(_area.router)


# Entry point for the PyInstaller-frozen build. In dev we run via
# `uv run uvicorn server:app` which imports `app` directly, so this
# block is unreached. The packaged Electron app spawns sidecar.exe
# (this script frozen) and reads SIDECAR_PORT from the environment.
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=SIDECAR_PORT, log_level="info")
