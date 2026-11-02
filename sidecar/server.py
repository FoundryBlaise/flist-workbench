"""The sidecar app: lifespan, middleware, error handlers, and the
routers in `routers/` that make up the REST surface."""

import os
from contextlib import asynccontextmanager
from http import HTTPStatus
from typing import AsyncIterator

from fastapi import Depends, FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

import archive_backups
import archive_registry
import eicons as eicons_catalog
import flist_activity
import flist_api
import workbench_mcp
import workbench_migration
from refusals import Refusal
from routers import (
    aliases,
    flist_session,
    foreign,
    health,
    images_trash,
    index,
    labels,
    live,
    logs,
    lookups,
    pull_backups,
    render,
    settings,
    upload,
    workbench,
)
from services import avatars, local_access, password_idle
from services import events as event_bus


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
    count = archive_backups.adopt_old_pre_upload_backups()
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
    archive_registry.character_dir(character_id)


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


for _area in (
    health,
    lookups,
    flist_session,
    pull_backups,
    live,
    workbench,
    images_trash,
    upload,
    foreign,
    logs,
    render,
    labels,
    index,
    aliases,
    settings,
):
    app.include_router(_area.router)


# Entry point for the PyInstaller-frozen build. In dev we run via
# `uv run uvicorn server:app` which imports `app` directly, so this
# block is unreached. The packaged Electron app spawns sidecar.exe
# (this script frozen) and reads SIDECAR_PORT from the environment.
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=SIDECAR_PORT, log_level="info")
