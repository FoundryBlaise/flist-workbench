import json
import os
from dataclasses import asdict
from typing import Any, Literal

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

import aliases as aliases_store
import character_archive
import documents
import flist_activity
import flist_api
import labels as labels_store
import labels_jobs
import labels_llm
import system as system_probe
import rag as rag_settings
import rag_chat
import rag_embed
import rag_expand
import rag_jobs
import rag_lexical
import rag_query
import rag_store
import settings as settings_store
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

app = FastAPI(title="F-list Workbench sidecar", version="0.0.0")

# The renderer runs in Electron at file:// or http://localhost:<vite>.
# Allow any local origin in dev; tighten in Phase 8 packaging.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# Password is dropped from RAM after this many seconds of no user-
# initiated /flist/* activity. Ticket itself stays until natural F-list
# TTL — only auto-refresh is disabled, so the user can finish what
# they were doing but a forgotten window doesn't keep the password warm
# overnight. The renderer's /flist/session poll is excluded from
# touch-counting below so it can't trivially defeat the timer.
IDLE_PASSWORD_TIMEOUT_SEC = int(
    os.environ.get("FLIST_WORKBENCH_PASSWORD_IDLE_SEC", "600")
)
_PASSWORD_WATCHDOG_INTERVAL_SEC = 60


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
    backgrounded Workbench window can't keep the password cached
    just by polling or auditing.
    """
    path = request.url.path
    if path.startswith("/flist/") and (path, request.method) not in _TOUCH_EXEMPT_PATHS:
        flist_api.ticket_store().touch()
    return await call_next(request)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": app.version}


@app.get("/profile/{name}")
async def profile(name: str) -> dict:
    """Public profile fetch routed through the F-list JSON API.

    Replaces the previous HTML scrape (`flist.fetch_profile`). The shape
    returned here matches the old `Profile.to_dict()` so existing
    renderer code in EditorPane's "Fetch profile" button still works
    against it. Requires an active sign-in — 401 surfaces a "Sign in to
    F-list first" CTA in the renderer.
    """
    try:
        payload = await flist_api.fetch_character_data(name)
    except flist_api.TicketRequired as exc:
        raise HTTPException(
            status_code=401, detail="not signed in to F-list"
        ) from exc
    except flist_api.AuthFailure as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except flist_api.FlistApiError as exc:
        msg = str(exc).lower()
        if "no such character" in msg or "not found" in msg:
            raise HTTPException(
                status_code=404, detail=f"character not found: {name}"
            ) from exc
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    resolved_name = payload.get("name") or name
    # F-list serves descriptions with literal CRLF / CR line endings.
    # CodeMirror tolerates them but our contentEditable PreviewPane +
    # BBCode→HTML transformer render them as visible artifacts. Match
    # what the old HTML-scrape path did (flist.parse_profile) and
    # normalise to LF for editor consumers.
    description = (payload.get("description") or "").replace("\r\n", "\n").replace("\r", "\n")
    inlines_raw = payload.get("inlines")
    inlines: dict[str, dict] = {}
    if isinstance(inlines_raw, dict):
        for k, v in inlines_raw.items():
            if isinstance(v, dict):
                inlines[str(k)] = v

    # Stats are rendered as a key:value list in the editor's profile
    # pane. We resolve infotag IDs → labels via the cached mapping list
    # so the user sees "Age: 28" instead of "info_1: 28".
    stats: dict[str, str] = {}
    infotags = payload.get("infotags")
    if isinstance(infotags, dict) and infotags:
        try:
            mapping = await flist_api.fetch_mapping_list(
                character_archive.cache_root() / "mapping-list.json"
            )
            stats = _resolve_infotag_stats(infotags, mapping)
        except flist_api.FlistApiError:
            # Mapping fetch failure is non-fatal for description-lookup
            # — surface raw infotag IDs so the user still gets the
            # BBCode they came for.
            stats = {f"info_{k}": str(v) for k, v in infotags.items()}

    return {
        "name": resolved_name,
        "avatar_url": flist_api.avatar_url(resolved_name),
        "bbcode": description,
        "stats": stats,
        "inlines": inlines,
    }


def _resolve_infotag_stats(
    infotags: dict, mapping: dict
) -> dict[str, str]:
    """Resolve `{infotag_id: value}` → `{label: human_value}` using the
    mapping list. Enum infotags have list IDs as values; we look up the
    list-item label too."""
    out: dict[str, str] = {}
    infotag_meta = {}
    raw_infotags = mapping.get("infotags")
    if isinstance(raw_infotags, list):
        for entry in raw_infotags:
            if isinstance(entry, dict) and entry.get("id") is not None:
                infotag_meta[str(entry["id"])] = entry
    listitems_meta: dict[str, str] = {}
    raw_listitems = mapping.get("listitems")
    if isinstance(raw_listitems, list):
        for entry in raw_listitems:
            if isinstance(entry, dict) and entry.get("id") is not None:
                listitems_meta[str(entry["id"])] = entry.get("value", "")
    for raw_id, raw_value in infotags.items():
        meta = infotag_meta.get(str(raw_id))
        label = (meta or {}).get("name") or f"info_{raw_id}"
        text = str(raw_value)
        # Enum-type infotags: value is a listitem id whose label lives
        # in `listitems[*].value`.
        if (meta or {}).get("type") == "list":
            text = listitems_meta.get(text, text)
        out[label] = text
    return out


# ---- flist archive ---------------------------------------------------


class FlistSignInRequest(BaseModel):
    account: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)


@app.post("/flist/session")
async def flist_session_create(body: FlistSignInRequest) -> dict:
    """Trade (account, password) for an F-list session ticket.

    The ticket is held in sidecar RAM only (`flist_api.TicketStore`).
    The password is held too — see flist_api docstring for why — but
    neither value crosses this endpoint boundary. Renderer gets back
    the character list and an expiry hint.

    Schedules a fire-and-forget avatar warm-up for every account
    character so the picker has avatars ready by the time the user
    opens it (instead of waiting for 30+ lazy fetches to serialise
    through the CDN rate limiter).
    """
    import asyncio as _asyncio

    try:
        result = await flist_api.acquire_ticket(
            body.account.strip(), body.password
        )
    except flist_api.AuthFailure as exc:
        flist_activity.record(
            "sign-in-failed",
            account=body.account.strip(),
            error=str(exc),
        )
        # Pass F-list's error string through verbatim — see Tier 1
        # decision in PHASE7_TIER1_PLAN.md.
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    names = [c["name"] for c in result["characters"] if c.get("name")]
    flist_activity.record(
        "sign-in",
        account=body.account.strip(),
        character_count=len(names),
    )
    if names:
        _asyncio.create_task(_prefetch_avatars(names))
    return result


async def _prefetch_avatars(names: list[str]) -> None:
    """Best-effort warm-up of the avatar cache.

    Each missing avatar goes through the CDN rate limiter (2 req/s),
    so a 33-character account finishes in ~15s. Already-cached avatars
    are skipped instantly. Errors swallowed silently — the lazy fetch
    on `/flist/avatar/{name}` retries on demand if a download flaked.
    """
    import asyncio
    import httpx

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(30.0, connect=10.0),
        headers={"User-Agent": flist_api.USER_AGENT},
        follow_redirects=True,
    ) as client:

        async def one(name: str) -> None:
            try:
                dest = character_archive.avatar_path_for(name)
            except ValueError:
                return
            if dest.exists():
                return
            try:
                await flist_api.download_to(
                    flist_api.avatar_url(name), dest, client=client
                )
            except Exception:  # noqa: BLE001 — best-effort warmup
                pass

        await asyncio.gather(*(one(n) for n in names), return_exceptions=True)


@app.post("/flist/avatars/prefetch")
async def flist_avatars_prefetch() -> dict:
    """Explicit re-trigger of the avatar warm-up.

    Useful if a sign-in race left some avatars un-cached, or if F-list
    avatars changed on the user's side and we want to refresh the whole
    set. Fires immediately, returns the scheduled count, downloads
    happen in the background.
    """
    import asyncio as _asyncio

    chars = flist_api.ticket_store().characters()
    names = [c["name"] for c in chars if c.get("name")]
    if names:
        _asyncio.create_task(_prefetch_avatars(names))
    return {"scheduled": len(names)}


@app.delete("/flist/session")
async def flist_session_delete() -> dict:
    status = flist_api.ticket_store().status()
    flist_api.ticket_store().clear()
    flist_activity.record(
        "sign-out",
        account=status.get("account"),
    )
    return {"signed_out": True}


@app.get("/flist/activity")
async def flist_activity_snapshot() -> dict:
    """In-memory append-only audit log of F-list operations (sign-in,
    ticket refresh, per-character pull stages, idle password clear,
    sign-out). Closes the trust-question gap surfaced by the
    2026-05-30 UX subagent review — see UX F4 in
    REVIEW_2026-05-30_post_tier1_polish.md."""
    return flist_activity.snapshot()


@app.get("/flist/session")
async def flist_session_get() -> dict:
    """Footer chip polls this every 60s for session age + hourly count.
    Stateless — never refreshes the ticket on its own; refresh happens
    on the next ticket-requiring action.

    Also reports `password_idle_seconds_remaining` so the renderer can
    surface a "session will be cleared in Nm" warning before the
    watchdog drops the cached password (UX gap from the 2026-05-30 QA
    verification of P0-C).
    """
    store = flist_api.ticket_store()
    status = store.status()
    status["api_hourly_count"] = flist_api.api_rate_limiter().hourly_count()
    if status.get("active") and status.get("password_cached"):
        idle = store.idle_seconds()
        remaining = max(0, int(IDLE_PASSWORD_TIMEOUT_SEC - idle))
        status["password_idle_seconds_remaining"] = remaining
    else:
        status["password_idle_seconds_remaining"] = None
    return status


@app.get("/flist/characters")
async def flist_characters() -> dict:
    """Roster union: account roster (if signed in) + archived characters
    + characters with local F-Chat logs. Each entry carries flags so the
    picker can render status badges.
    """
    account_chars = flist_api.ticket_store().characters()
    log_chars: list[str] = []
    try:
        log_chars = [c.name for c in list_characters()]
    except LogDirError:
        pass
    rows = character_archive.merge_roster(account_chars, log_chars)
    # Annotate every has_archive row with its on-disk pull integrity so
    # the picker / F-list zone can surface "incomplete — N missing" for
    # archives where a prior pull was interrupted or had image failures.
    # Cheap: each call is one dir-walk under images/.
    for row in rows:
        if row.get("has_archive") and row.get("id") is not None:
            row["pull_status"] = character_archive.compute_pull_status(row["id"])
    return {"characters": rows}


@app.get("/flist/mapping-list")
async def flist_mapping_list() -> dict:
    try:
        mapping = await flist_api.fetch_mapping_list(
            character_archive.cache_root() / "mapping-list.json"
        )
    except flist_api.TicketRequired as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except flist_api.FlistApiError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return mapping


def _character_id_from_payload(payload: dict) -> str:
    cid = payload.get("id")
    if cid is None:
        raise HTTPException(status_code=502, detail="API response missing character id")
    return str(cid)


@app.post("/flist/character/{name}/pull")
async def flist_character_pull(name: str) -> StreamingResponse:
    """Pull live character data + images for `name`.

    SSE events:
      queued     → waiting on pull_lock (concurrent pulls serialise)
      ticket     → acquiring / refreshing ticket
      fetching   → calling character-data.php
      images     → {total, downloaded, failed} starting image batch
      image      → {index, total, image_id} per-image progress
      done       → {character_id, image_count, backup_path?}
      error      → {stage, message}
    """

    async def producer():
        # Send queued event immediately so the renderer's row badge can
        # flip to "queued" before the lock is acquired.
        yield _sse_event("queued", {"name": name})
        flist_activity.record("pull-start", name=name)
        async with flist_api.pull_lock():
            client = flist_api._default_client()
            try:
                yield _sse_event("ticket", {})
                try:
                    await flist_api.ensure_fresh_ticket(client=client)
                except flist_api.TicketRequired as exc:
                    yield _sse_event(
                        "error", {"stage": "ticket", "message": str(exc)}
                    )
                    return
                except flist_api.AuthFailure as exc:
                    yield _sse_event(
                        "error", {"stage": "ticket", "message": str(exc)}
                    )
                    return

                yield _sse_event("fetching", {"name": name})
                try:
                    payload = await flist_api.fetch_character_data(
                        name, client=client
                    )
                except flist_api.FlistApiError as exc:
                    yield _sse_event(
                        "error", {"stage": "fetching", "message": str(exc)}
                    )
                    return

                try:
                    cid = _character_id_from_payload(payload)
                except HTTPException as exc:
                    yield _sse_event(
                        "error", {"stage": "fetching", "message": exc.detail}
                    )
                    return

                # Stamp fetch time and write Live before any image work
                # — so even if image downloads fail, the user has the
                # JSON and can retry the gallery later.
                import time as _t
                live_payload = dict(payload)
                live_payload["fetched_at"] = int(_t.time())
                character_archive.write_live(cid, live_payload)

                # Avatar — deterministic URL, no rate-limit-bucket cost
                # against the API. Fire-and-forget; failures are
                # non-fatal.
                try:
                    await flist_api.download_to(
                        flist_api.avatar_url(name),
                        character_archive.avatar_path_for(name),
                        client=client,
                    )
                except flist_api.FlistApiError:
                    pass
                except ValueError:
                    pass

                images = payload.get("images")
                image_list: list[dict] = []
                if isinstance(images, list):
                    for img in images:
                        if not isinstance(img, dict):
                            continue
                        image_id = img.get("image_id") or img.get("id")
                        ext = img.get("extension")
                        if image_id is None or not ext:
                            continue
                        image_list.append(
                            {"image_id": str(image_id), "extension": str(ext)}
                        )

                total = len(image_list)
                # Record what this pull intends to fetch before downloading
                # anything. If the user's PC sleeps / crashes / loses
                # network mid-loop, the manifest's `finished_at=None` is
                # the marker compute_pull_status uses to surface "Pull
                # incomplete — N missing" on next launch.
                import time as _t
                pull_started_at = int(_t.time())
                character_archive.write_pull_state(
                    cid,
                    image_list,
                    started_at=pull_started_at,
                    finished_at=None,
                )
                yield _sse_event(
                    "images", {"total": total, "downloaded": 0, "failed": 0}
                )

                downloaded = 0
                failed = 0
                for i, img in enumerate(image_list, start=1):
                    image_id = img["image_id"]
                    ext = img["extension"]
                    url = (
                        f"{flist_api.STATIC_BASE}/images/charimage/"
                        f"{image_id}.{ext}"
                    )
                    try:
                        dest = character_archive.image_path(cid, image_id, ext)
                    except ValueError:
                        failed += 1
                        yield _sse_event(
                            "image",
                            {
                                "index": i,
                                "total": total,
                                "image_id": image_id,
                                "ok": False,
                                "error": "unsafe filename",
                            },
                        )
                        continue
                    if dest.exists():
                        # Already on disk from a prior pull. Skip the
                        # download but still emit progress so the UI
                        # ticks forward.
                        downloaded += 1
                        yield _sse_event(
                            "image",
                            {
                                "index": i,
                                "total": total,
                                "image_id": image_id,
                                "ok": True,
                                "cached": True,
                            },
                        )
                        continue
                    try:
                        await flist_api.download_to(url, dest, client=client)
                        downloaded += 1
                        yield _sse_event(
                            "image",
                            {
                                "index": i,
                                "total": total,
                                "image_id": image_id,
                                "ok": True,
                            },
                        )
                    except flist_api.FlistApiError as exc:
                        failed += 1
                        yield _sse_event(
                            "image",
                            {
                                "index": i,
                                "total": total,
                                "image_id": image_id,
                                "ok": False,
                                "error": str(exc),
                            },
                        )

                # Seal the manifest: finished_at marks the loop ran to
                # completion (success or with per-image failures). The
                # absence of this write is what compute_pull_status uses
                # to distinguish "interrupted" from "partial".
                character_archive.write_pull_state(
                    cid,
                    image_list,
                    started_at=pull_started_at,
                    finished_at=int(_t.time()),
                )
                pull_status = character_archive.compute_pull_status(cid)
                flist_activity.record(
                    "pull-done",
                    name=payload.get("name") or name,
                    character_id=cid,
                    image_count=downloaded,
                    image_failed=failed,
                    status=pull_status["status"],
                    missing=len(pull_status["missing_image_ids"]),
                )
                yield _sse_event(
                    "done",
                    {
                        "character_id": cid,
                        "name": payload.get("name") or name,
                        "image_count": downloaded,
                        "image_failed": failed,
                        "pull_status": pull_status["status"],
                        "pull_missing": len(pull_status["missing_image_ids"]),
                    },
                )
            except flist_api.RateLimited as exc:
                # Specific catch so the renderer gets a human-readable
                # message + a "rate-limited" stage instead of an
                # `unknown / RateLimited(...)` repr. The hourly cap is
                # the most likely place this fires inside a long pull.
                flist_activity.record(
                    "pull-error", name=name, stage="rate-limited",
                    error=str(exc),
                )
                yield _sse_event(
                    "error", {"stage": "rate-limited", "message": str(exc)}
                )
            except flist_api.AuthFailure as exc:
                # Auto-refresh during the pull could trip on a password
                # the user changed elsewhere. Surface cleanly.
                flist_activity.record(
                    "pull-error", name=name, stage="ticket", error=str(exc),
                )
                yield _sse_event(
                    "error", {"stage": "ticket", "message": str(exc)}
                )
            except flist_api.FlistApiError as exc:
                # Any other F-list error past the early stages — still
                # better than a class-repr to the user.
                flist_activity.record(
                    "pull-error", name=name, stage="fetching", error=str(exc),
                )
                yield _sse_event(
                    "error", {"stage": "fetching", "message": str(exc)}
                )
            except Exception as exc:  # noqa: BLE001 — last-resort
                flist_activity.record(
                    "pull-error", name=name, stage="unknown", error=repr(exc),
                )
                yield _sse_event(
                    "error", {"stage": "unknown", "message": repr(exc)}
                )
            finally:
                await client.aclose()

    return StreamingResponse(
        producer(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/flist/character/{character_id}/backup")
async def flist_character_backup(character_id: str) -> dict:
    """Snapshot the current Live into `backups/<unix>.json`. 409 if no
    Live exists yet."""
    try:
        return character_archive.save_backup(character_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/flist/character/{character_id}/live")
async def flist_character_live(character_id: str) -> dict:
    payload = character_archive.read_live(character_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="no Live snapshot yet")
    return payload


@app.get("/flist/character/{character_id}/backups")
async def flist_character_backups(character_id: str) -> dict:
    return {
        "character_id": character_id,
        "backups": character_archive.list_backups(character_id),
    }


@app.get("/flist/character/{character_id}/backups/{filename}")
async def flist_character_backup_read(character_id: str, filename: str) -> dict:
    payload = character_archive.read_backup(character_id, filename)
    if payload is None:
        raise HTTPException(status_code=404, detail="backup not found")
    return payload


@app.get("/flist/character/{character_id}/images/{filename}")
async def flist_character_image(character_id: str, filename: str) -> FileResponse:
    # Validate filename shape so a hostile renderer call can't path-
    # traverse out of the images directory.
    import re as _re
    if not _re.match(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$", filename):
        raise HTTPException(status_code=400, detail="invalid image filename")
    path = character_archive.images_dir(character_id) / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="image not found")
    return FileResponse(path)


@app.get("/flist/character/{character_id}/inlines/{filename}")
async def flist_character_inline(character_id: str, filename: str) -> FileResponse:
    import re as _re
    if not _re.match(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$", filename):
        raise HTTPException(status_code=400, detail="invalid inline filename")
    path = character_archive.inlines_dir(character_id) / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="inline not found")
    return FileResponse(path)


_PLACEHOLDER_AVATAR_SIZE = 5827  # bytes returned by F-list when a name has no avatar


def _cleanup_placeholder_avatars() -> int:
    """One-time cache cleanup at sidecar startup.

    Early Tier-1 sidecars built the wrong avatar URL (underscores
    instead of spaces), so F-list always returned its 5827-byte
    "no avatar" placeholder and we cached those PNGs to disk. After
    the URL fix landed, the cached placeholders kept tripping the
    placeholder-size check in /flist/avatar/{name} and serving 404
    even for characters that DO have a real avatar. Deleting any
    file matching the placeholder size lets the next request
    re-fetch through the fixed URL.

    Idempotent — after the first run there's nothing left to delete.
    """
    avatars = character_archive.avatars_root()
    if not avatars.exists():
        return 0
    deleted = 0
    for entry in avatars.iterdir():
        try:
            if entry.is_file() and entry.stat().st_size == _PLACEHOLDER_AVATAR_SIZE:
                entry.unlink()
                deleted += 1
        except OSError:
            continue
    return deleted


@app.on_event("startup")
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


@app.on_event("startup")
async def _avatar_cleanup_on_startup() -> None:
    count = _cleanup_placeholder_avatars()
    if count > 0:
        print(
            f"[flist] cleaned {count} placeholder avatars from cache "
            "(left over from pre-URL-fix sidecar)",
            flush=True,
        )


@app.on_event("startup")
async def _password_idle_watchdog() -> None:
    """Periodically drop the cached F-list password after idle. Ticket
    is preserved so any in-flight session completes naturally."""
    import asyncio

    async def _loop() -> None:
        while True:
            try:
                await asyncio.sleep(_PASSWORD_WATCHDOG_INTERVAL_SEC)
                store = flist_api.ticket_store()
                if store.clear_password_if_idle(IDLE_PASSWORD_TIMEOUT_SEC):
                    flist_activity.record(
                        "password-idle-clear",
                        idle_seconds=int(IDLE_PASSWORD_TIMEOUT_SEC),
                    )
                    print(
                        "[flist] idle password timeout — cached password "
                        "dropped (ticket left in place until natural expiry)",
                        flush=True,
                    )
            except Exception as exc:  # noqa: BLE001
                # Don't let a transient hiccup kill the watchdog.
                print(f"[flist] password watchdog error: {exc!r}", flush=True)

    asyncio.create_task(_loop())


@app.get("/flist/avatar/{name}")
async def flist_avatar(name: str) -> FileResponse:
    """Serve a cached avatar from `<userdata>/avatars/`. Fetches on
    miss; avatars are public so this works signed-out too.

    F-list returns a 5827-byte placeholder PNG (HTTP 200) for any name
    without an uploaded avatar — there's no 404 path. We detect that
    by size and surface a real 404 so the renderer's `onError` fires
    and the initial-circle fallback renders instead of an alien
    placeholder graphic.
    """
    try:
        dest = character_archive.avatar_path_for(name)
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
    if size == _PLACEHOLDER_AVATAR_SIZE:
        # F-list's "no avatar" placeholder. Keep the cached file (it's
        # tiny and avoids re-fetching the same placeholder on every
        # request) but surface 404 so the renderer's onError fires and
        # the initial-circle fallback renders.
        raise HTTPException(status_code=404, detail="no avatar uploaded")
    return FileResponse(dest)


@app.get("/logs/characters")
def logs_characters() -> dict:
    try:
        return {"characters": [asdict(c) for c in list_characters()]}
    except LogDirError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/logs/partners")
def logs_partners(char: str) -> dict:
    try:
        entries = list_partners(char)
    except LogDirError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"character": char, "partners": [asdict(e) for e in entries]}


@app.get("/logs/messages")
def logs_messages(char: str, partner: str, offset: int = 0, limit: int | None = None) -> dict:
    try:
        messages = list(read_messages(char, partner, offset=offset, limit=limit))
    except LogDirError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    # Resolve each message's IC/OOC/Unlabeled label live — labels are
    # rule-on-read, so settings changes (e.g. threshold) take effect
    # immediately without rebuilding the DB.
    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    try:
        lab_settings = labels_store.load_settings(settings_conn)
        # Folding label rows from any linked alternate names — labels
        # written under "Daemon Enariel" pre-rename still apply when
        # the user opens the merged "Ashvalia" conversation.
        alias_group = aliases_store.all_names_for(labels_conn, char, partner)
        by_hash = labels_store.labels_for_partner(
            labels_conn, char, partner, partner_aliases=alias_group
        )
        failures = labels_store.failures_for_partner(
            labels_conn, char, partner, partner_aliases=alias_group
        )
        for m in messages:
            h = labels_store.msg_hash(m)
            # Send the hash so the renderer can call /labels/override
            # without re-implementing sha1(ts|speaker|raw) client-side.
            m["hash"] = h
            row = by_hash.get(h)
            fail = failures.get(h)
            m["label"] = labels_store.resolve(
                m, row, lab_settings, failed=fail is not None,
            )
            if row is not None:
                m["label_source"] = row["source"]
                # Surface the model's own reason string in the badge
                # tooltip so the user can audit why a label was chosen.
                if row["reason"]:
                    m["label_reason"] = row["reason"]
                # Carry the prior snapshot so the UI can show "LLM had
                # said IC; you changed it to OOC" on manual overrides.
                if row["prior_label"] is not None:
                    m["prior_label"] = row["prior_label"]
                    m["prior_source"] = row["prior_source"]
            elif fail is not None:
                # Surface the classifier's error so the badge tooltip
                # explains *why* this message is Failed.
                m["label_source"] = "failed"
                m["label_error"] = fail["error"]
            # Otherwise no source is attached — the UI infers "rule
            # or unlabeled" from absence of label_source.
    finally:
        settings_conn.close()
        labels_conn.close()

    return {"character": char, "partner": partner, "offset": offset, "messages": messages}


@app.get("/logs/search")
def logs_search(char: str, partner: str, q: str) -> dict:
    try:
        hits = search_messages(char, partner, q)
    except LogDirError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"character": char, "partner": partner, "query": q, "hits": hits}


@app.get("/logs/search_all")
def logs_search_all(char: str, q: str, limit_per_partner: int = 50) -> dict:
    try:
        return search_all_partners(char, q, limit_per_partner=limit_per_partner)
    except LogDirError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/logs/contacts")
def logs_contacts(name: str) -> dict:
    return find_contacts(name)


# ---- labels -------------------------------------------------------------


@app.get("/labels/stats")
def labels_stats(char: str, partner: str) -> dict:
    try:
        messages = list(read_messages(char, partner))
    except LogDirError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
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
        "failed": counts[labels_store.LABEL_FAILED],
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
    try:
        entries = list_partners(char)
    except LogDirError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

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
                    "failed": counts[labels_store.LABEL_FAILED],
                    "total": sum(counts.values()),
                    "log_mtime": log_mtime if log_mtime > 0 else None,
                    "last_label_at": last_label,
                }
            )
    finally:
        settings_conn.close()
        labels_conn.close()
    return {"character": char, "partners": out}


class ClassifyJobRequest(BaseModel):
    # All optional. {} = classify every character × every partner.
    # {character: X} = all partners for character X. {character: X,
    # partner: Y} = a single conversation.
    character: str | None = None
    partner: str | None = None
    # When true, ignore the skip-existing guard and re-classify every
    # message in scope — useful after a prompt or model change. Manual
    # overrides are NOT preserved; the LLM verdict replaces them.
    overwrite: bool = False


class TestConnectionRequest(BaseModel):
    # All optional — when omitted we pull from saved settings. The
    # renderer typically posts the current edit-state so the user can
    # test before saving.
    llm_endpoint: str | None = None
    llm_model: str | None = None
    llm_api_key: str | None = None
    system_prompt: str | None = None


@app.post("/labels/test-connection")
def labels_test_connection(body: TestConnectionRequest) -> dict:
    """One canned classification roundtrip so the user can validate
    endpoint / model / prompt without launching a real job.

    Returns latency + raw model output + parsed JSON (if any). All
    failure modes return 200 with `ok=false` and a structured `error`
    so the UI can show actionable feedback without HTTP-error parsing.
    """
    import time as _time
    from urllib.error import HTTPError, URLError

    import labels_llm

    settings_conn = settings_store.connect()
    try:
        saved = labels_store.load_settings(settings_conn)
    finally:
        settings_conn.close()

    endpoint = body.llm_endpoint or saved.llm_endpoint
    model = body.llm_model or saved.llm_model
    api_key = body.llm_api_key if body.llm_api_key is not None else saved.llm_api_key
    prompt = body.system_prompt or saved.system_prompt

    # Realistic test message: an IC-shaped paragraph long enough that
    # the resolver wouldn't have rule-skipped it, so the model has
    # something coherent to classify. Older two-word probes ("hello
    # there") confused the classifier into returning empty content.
    # IC-shaped paragraph long enough that the resolver wouldn't have
    # rule-skipped it, so the model has something coherent to classify.
    # Speaker uses a canonical fantasy name (Witcher) to avoid any
    # overlap with real F-list characters in the user's corpus.
    canned_user = (
        ">>> ZIELNACHRICHT <<<\n"
        "[01-15 22:13 | 312 chars] Triss: She turned slowly, her gaze settling on him with a "
        "measured calm that belied the storm of thoughts behind her eyes. The candlelight caught "
        "the silver threads woven through her cloak as she spoke, voice low and deliberate. \"You "
        "knew this moment would come, didn't you? You've been waiting for it.\"\n"
        ">>> ENDE ZIELNACHRICHT <<<"
    )
    # Cold-start inference on a 20B+ model can take 30–60 s on first
    # call. 90 s gives the model room without making "endpoint is
    # actually unreachable" feel like an eternity. Trade-off chosen
    # deliberately — faster models will return in 1–3 s.
    test_timeout = 90.0
    started = _time.monotonic()
    try:
        content = labels_llm.call_llm(
            endpoint, model, api_key, prompt, canned_user, timeout=test_timeout
        )
    except HTTPError as exc:
        return {
            "ok": False,
            "error": f"HTTP {exc.code}: {exc.reason}",
            "elapsed_ms": int((_time.monotonic() - started) * 1000),
        }
    except URLError as exc:
        return {
            "ok": False,
            "error": f"connection failed: {exc.reason}",
            "elapsed_ms": int((_time.monotonic() - started) * 1000),
        }
    except TimeoutError as exc:
        return {
            "ok": False,
            "error": (
                f"timed out after {int(test_timeout)} s — the model may be cold-loading. "
                f"Try again, or pick a smaller model. ({exc})"
            ),
            "elapsed_ms": int((_time.monotonic() - started) * 1000),
        }
    except Exception as exc:  # noqa: BLE001 — surface to UI
        return {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "elapsed_ms": int((_time.monotonic() - started) * 1000),
        }
    elapsed_ms = int((_time.monotonic() - started) * 1000)
    if not content.strip():
        return {
            "ok": False,
            "elapsed_ms": elapsed_ms,
            "raw": "",
            "parsed": None,
            "error": (
                "model returned empty content. The system prompt may be incompatible "
                "with this model, or the model needs more time to warm up — retry once."
            ),
        }
    parsed = labels_llm.parse_label(content)
    return {
        "ok": parsed is not None,
        "elapsed_ms": elapsed_ms,
        "raw": content[:400],
        "parsed": parsed,
        "error": None if parsed is not None else "model output did not contain a valid {label, reason} JSON object",
    }


# ---- rag (settings-side; ingest endpoints land in 4.6) ----------------


class RagTestEmbeddingRequest(BaseModel):
    # All optional — when omitted we pull from saved settings. The
    # renderer typically posts the current edit-state so the user can
    # test before saving, mirroring /labels/test-connection.
    embed_endpoint: str | None = None
    embed_model: str | None = None
    embed_api_key: str | None = None
    embed_query_prefix: str | None = None
    embed_document_prefix: str | None = None


@app.post("/rag/test-embedding")
def rag_test_embedding(body: RagTestEmbeddingRequest) -> dict:
    """One canned embedding roundtrip — validates endpoint + model +
    that the model is actually loaded in LM Studio / equivalent.

    Returns latency + dimension on success; ok=false + structured
    error string on failure. Same 200-always shape as
    /labels/test-connection so the UI can render either with one path.
    """
    import time as _time

    saved = rag_settings.load_settings()
    # Only the embedding-side fields are overridable from this endpoint
    # — chat / rerank / retrieval tunables ride on saved settings to
    # keep the test surface tight.
    merged = rag_settings.RagSettings(
        embed_endpoint=body.embed_endpoint or saved.embed_endpoint,
        embed_model=body.embed_model or saved.embed_model,
        embed_api_key=(
            body.embed_api_key if body.embed_api_key is not None else saved.embed_api_key
        ),
        embed_query_prefix=(
            body.embed_query_prefix
            if body.embed_query_prefix is not None
            else saved.embed_query_prefix
        ),
        embed_document_prefix=(
            body.embed_document_prefix
            if body.embed_document_prefix is not None
            else saved.embed_document_prefix
        ),
        chat_endpoint=saved.chat_endpoint,
        chat_model=saved.chat_model,
        chat_api_key=saved.chat_api_key,
        chat_system_prompt=saved.chat_system_prompt,
        rerank_model=saved.rerank_model,
        rerank_candidates=saved.rerank_candidates,
        top_k=saved.top_k,
        neighbors=saved.neighbors,
        rerank_min_ratio=saved.rerank_min_ratio,
        hybrid_enabled=saved.hybrid_enabled,
        hybrid_bm25_candidates=saved.hybrid_bm25_candidates,
        multiquery_enabled=saved.multiquery_enabled,
        multiquery_variants=saved.multiquery_variants,
        chat_num_ctx=saved.chat_num_ctx,
        chat_embed_keep_alive=saved.chat_embed_keep_alive,
        chunk_max_chars=saved.chunk_max_chars,
        chunk_soft_split_chars=saved.chunk_soft_split_chars,
        chunk_overlap_msgs=saved.chunk_overlap_msgs,
    )

    # 60 s probe budget: cold-loading a 768-dim model in LM Studio
    # takes 15–30 s; loaded-already returns in <1 s. 60 s leaves a
    # cushion without making "endpoint unreachable" feel forever.
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


class RagTestChatRequest(BaseModel):
    """Override-or-saved fields for one canned chat probe.

    Same overlay-on-saved pattern as RagTestEmbeddingRequest and
    TestConnectionRequest: the renderer typically sends the current
    edit-state from the form so the user can validate before saving.
    """
    chat_endpoint: str | None = None
    chat_model: str | None = None
    chat_api_key: str | None = None
    chat_system_prompt: str | None = None


@app.post("/rag/test-chat")
def rag_test_chat(body: RagTestChatRequest) -> dict:
    """One non-streaming chat completion to validate endpoint + model.

    Mirrors /labels/test-connection: 200-always shape with ok/elapsed_ms
    /raw/error so the UI can render either result with one path. We
    deliberately bypass rag_chat.stream_chat (streaming + tools, wrong
    cost surface for a probe) and reuse labels_llm.call_llm with a tiny
    "say hi" exchange.
    """
    import time as _time
    from urllib.error import HTTPError, URLError

    import labels_llm

    saved = rag_settings.load_settings()
    endpoint = body.chat_endpoint or saved.chat_endpoint
    model = body.chat_model or saved.chat_model
    api_key = body.chat_api_key if body.chat_api_key is not None else saved.chat_api_key
    system_prompt = (
        body.chat_system_prompt
        if body.chat_system_prompt is not None
        else saved.chat_system_prompt
    )

    # Canned probe: a single instruction-following exchange. We
    # explicitly ask for a short reply so cold-start latency dominates
    # over generation time — the test should reflect "is the endpoint
    # alive" not "is the model fast at writing prose".
    canned_user = (
        "Reply with the single word 'ready' (lowercase, no quotes, "
        "no punctuation) so the test harness can confirm the model is "
        "answering instructions."
    )
    test_timeout = 90.0
    started = _time.monotonic()
    try:
        content = labels_llm.call_llm(
            endpoint,
            model,
            api_key,
            system_prompt,
            canned_user,
            max_tokens=64,
            timeout=test_timeout,
        )
    except HTTPError as exc:
        return {
            "ok": False,
            "error": f"HTTP {exc.code}: {exc.reason}",
            "raw": "",
            "elapsed_ms": int((_time.monotonic() - started) * 1000),
        }
    except URLError as exc:
        return {
            "ok": False,
            "error": f"connection failed: {exc.reason}",
            "raw": "",
            "elapsed_ms": int((_time.monotonic() - started) * 1000),
        }
    except TimeoutError as exc:
        return {
            "ok": False,
            "error": (
                f"timed out after {int(test_timeout)} s — the model may be "
                f"cold-loading. Try again, or pick a smaller model. ({exc})"
            ),
            "raw": "",
            "elapsed_ms": int((_time.monotonic() - started) * 1000),
        }
    except Exception as exc:  # noqa: BLE001 — surface to UI
        return {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "raw": "",
            "elapsed_ms": int((_time.monotonic() - started) * 1000),
        }
    elapsed_ms = int((_time.monotonic() - started) * 1000)
    if not content.strip():
        return {
            "ok": False,
            "elapsed_ms": elapsed_ms,
            "raw": "",
            "error": (
                "model returned empty content. The system prompt may be "
                "incompatible with this model, or the model needs more "
                "time to warm up — retry once."
            ),
        }
    return {
        "ok": True,
        "elapsed_ms": elapsed_ms,
        "raw": content[:400],
        "error": None,
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
    if body.partner and not body.character:
        raise HTTPException(status_code=400, detail="partner requires character")
    scope: dict = {}
    if body.character:
        scope["character"] = body.character
    if body.partner:
        scope["partner"] = body.partner
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


class RagQueryScope(BaseModel):
    character: str | None = None
    partner: str | None = None
    partners: list[str] | None = None


class RagQueryRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    scope: RagQueryScope | None = None
    # Per-request overrides — the chat panel exposes these via slash
    # commands (/top, /neighbors). Server clamps the same way the
    # settings loader does so a runaway /top 9999 doesn't try to
    # retrieve thousands of chunks.
    top_k: int | None = None
    neighbors: int | None = None


class TalkMessage(BaseModel):
    # OpenAI-shaped chat message. The renderer rebuilds the full history
    # on every Talk turn so the server stays stateless — easier than
    # storing per-tab conversation state we'd then have to expire.
    role: Literal["system", "user", "assistant"]
    content: str = Field(max_length=8000)


class RagTalkRequest(BaseModel):
    # The full history including the latest user turn. Renderer enforces
    # an upper bound on length so a runaway loop can't blow context.
    messages: list[TalkMessage] = Field(min_length=1, max_length=80)
    # Optional system message override. Empty / unset → no system
    # message; Talk mode is intentionally free-form, no grounding prompt.
    system: str | None = None


def _sse_event(event: str, data: dict | str) -> bytes:
    """Format one SSE message. Reuses the OpenAI streaming convention:
    each event has an `event:` name + a JSON `data:` payload, separated
    by a blank line.
    """
    if isinstance(data, str):
        payload = data
    else:
        payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n".encode("utf-8")


@app.post("/rag/query")
def rag_query_stream(body: RagQueryRequest) -> StreamingResponse:
    """SSE stream: 'token' events with per-delta content, then a 'done'
    event carrying the citation list. Errors emit an 'error' event and
    close the stream so the renderer can render a single failure pill
    rather than parsing HTTP non-2xx.

    Pipeline runs synchronously up to the LLM call (cheap), then yields
    deltas as the LLM streams. Citations are computed up-front from the
    retrieval hits — they don't depend on the LLM's response, so the
    final `done` event has them ready the instant the stream completes.
    """
    rag_set = rag_settings.load_settings()
    scope = body.scope.model_dump(exclude_none=True) if body.scope else None
    # Expand a single-partner scope into the full alias group so
    # queries scoped to "Ashvalia" also pull chunks indexed under the
    # pre-rename name "Daemon Enariel". Skips the expansion when scope
    # is character-only / cross-RP — those don't filter by partner.
    if scope and scope.get("character") and scope.get("partner") and not scope.get("partners"):
        alias_conn = aliases_store.connect()
        try:
            group = aliases_store.all_names_for(
                alias_conn, scope["character"], scope["partner"]
            )
        finally:
            alias_conn.close()
        if len(group) > 1:
            # Move from single-partner filter to multi-partner filter;
            # rag_store._scope_to_filter handles both shapes.
            scope = {
                "character": scope["character"],
                "partners": group,
            }
    top_k = body.top_k if body.top_k is not None else rag_set.top_k
    neighbors = body.neighbors if body.neighbors is not None else rag_set.neighbors
    # Clamp the same way the settings loader does — overrides shouldn't
    # be able to do what saved settings can't.
    top_k = max(1, min(50, int(top_k)))
    neighbors = max(0, min(5, int(neighbors)))

    def producer():
        # Phase 1: retrieval. Failures here are visible to the user
        # immediately as an `error` SSE event — no partial LLM stream.
        try:
            # Multi-query expansion runs OUTSIDE the RagStore context so
            # the chat LLM call doesn't hold the embedded-Qdrant file
            # lock open longer than necessary. Failure here is logged +
            # ignored — the original question still drives retrieval.
            query_variants: list[str] = []
            if rag_set.multiquery_enabled:
                try:
                    query_variants = rag_expand.expand_query(
                        body.question,
                        n=rag_set.multiquery_variants,
                        rag_set=rag_set,
                    )
                except Exception:  # noqa: BLE001 — expansion never breaks chat
                    query_variants = []
                if query_variants:
                    yield _sse_event(
                        "expanded",
                        {"variants": query_variants},
                    )

            with rag_store.RagStore() as store:
                if not store.collection_exists():
                    yield _sse_event(
                        "error",
                        {
                            "stage": "retrieval",
                            "message": (
                                "no RAG index yet — run Logs → Ingest before asking."
                            ),
                        },
                    )
                    return

                # Open the lexical store only when hybrid is enabled.
                # Skipping the connect() avoids a labels.db handle on
                # the most common "dense-only" path.
                lex: rag_lexical.LexicalStore | None = None
                if rag_set.hybrid_enabled:
                    lex = rag_lexical.LexicalStore()
                    # Backfill safety net: a user who enabled hybrid
                    # after an existing ingest has an empty FTS5 table
                    # while Qdrant has thousands of chunks. Rebuilding
                    # from payloads is a few seconds and avoids the "I
                    # turned it on and got no hits" surprise.
                    try:
                        if lex.count() == 0 and store.count() > 0:
                            rag_lexical.backfill_from_qdrant(store, lex)
                    except Exception:  # noqa: BLE001 — backfill is best-effort
                        pass
                try:
                    result = rag_query.run_query(
                        body.question,
                        scope=scope,
                        store=store,
                        rag_set=rag_set,
                        rerank_model=rag_set.rerank_model,
                        rerank_candidates=rag_set.rerank_candidates,
                        top_k=top_k,
                        neighbors=neighbors,
                        rerank_min_ratio=rag_set.rerank_min_ratio,
                        lex=lex,
                        hybrid_bm25_candidates=rag_set.hybrid_bm25_candidates,
                        query_variants=query_variants,
                        system_prompt=rag_set.chat_system_prompt,
                    )
                except rag_embed.EmbedError as exc:
                    yield _sse_event(
                        "error", {"stage": "embed", "message": str(exc)}
                    )
                    return
                finally:
                    if lex is not None:
                        lex.close()
                citations = rag_query.citation_payload(result.hits)

            # Phase 1.5: tell the renderer what we retrieved before any
            # LLM tokens arrive — useful so the citation chip strip can
            # render while the answer streams.
            yield _sse_event(
                "retrieved",
                {
                    "hit_count": len(citations),
                    "rerank_applied": result.rerank_applied,
                    "rerank_model": result.rerank_model,
                    "embed_model": result.embed_model,
                    "hybrid_applied": result.hybrid_applied,
                    "hybrid_lexical_hits": result.hybrid_lexical_hits,
                },
            )

            # Phase 2: stream the LLM answer.
            try:
                for delta in rag_chat.stream_chat(
                    rag_set.chat_endpoint,
                    rag_set.chat_model,
                    rag_set.chat_api_key,
                    result.messages,
                    num_ctx=rag_set.chat_num_ctx or None,
                ):
                    yield _sse_event("token", {"content": delta})
            except rag_chat.ChatError as exc:
                yield _sse_event(
                    "error", {"stage": "chat", "message": str(exc)}
                )
                return

            yield _sse_event("done", {"citations": citations})
        except Exception as exc:  # noqa: BLE001 — last-resort: don't bring down the stream silently
            yield _sse_event(
                "error", {"stage": "unknown", "message": repr(exc)}
            )

    return StreamingResponse(
        producer(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/rag/talk")
def rag_talk_stream(body: RagTalkRequest) -> StreamingResponse:
    """SSE stream: free-form chat with no retrieval, no citations.

    Counterpart to /rag/query. The renderer routes user "Talk mode"
    turns here when the user wants to brainstorm / draft / chat with
    the model without dragging the log corpus into the prompt. Same
    chat endpoint + model as the grounded path (rag_set.chat_*) so
    Talk and Question share the user's one configured LLM.

    Emits only `token`, `done`, and `error` events — no `retrieved`
    or `expanded`. `done` carries an empty `citations: []` so the
    renderer's existing handler shape works either way.
    """
    rag_set = rag_settings.load_settings()
    # Build the message list. A system message (if provided) goes first;
    # then the renderer-supplied history verbatim. We deliberately do
    # NOT inject the grounding system prompt that /rag/query uses —
    # Talk mode is supposed to feel like a vanilla chat surface.
    messages: list[dict] = []
    if body.system and body.system.strip():
        messages.append({"role": "system", "content": body.system.strip()})
    for m in body.messages:
        messages.append({"role": m.role, "content": m.content})

    def producer():
        try:
            for delta in rag_chat.stream_chat(
                rag_set.chat_endpoint,
                rag_set.chat_model,
                rag_set.chat_api_key,
                messages,
                num_ctx=rag_set.chat_num_ctx or None,
            ):
                yield _sse_event("token", {"content": delta})
            yield _sse_event("done", {"citations": []})
        except rag_chat.ChatError as exc:
            yield _sse_event("error", {"stage": "chat", "message": str(exc)})
        except Exception as exc:  # noqa: BLE001 — last-resort, mirror /rag/query
            yield _sse_event(
                "error", {"stage": "unknown", "message": repr(exc)}
            )

    return StreamingResponse(
        producer(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


# ---- labels jobs (continued) ------------------------------------------


@app.post("/labels/classify", status_code=202)
def labels_classify_start(body: ClassifyJobRequest) -> dict:
    if body.partner and not body.character:
        raise HTTPException(status_code=400, detail="partner requires character")
    scope: dict = {}
    if body.character:
        scope["character"] = body.character
    if body.partner:
        scope["partner"] = body.partner
    job = labels_jobs.start(scope, overwrite=body.overwrite)
    return job.to_dict()


@app.get("/labels/jobs")
def labels_jobs_list() -> dict:
    return {"jobs": [j.to_dict() for j in labels_jobs.registry().list()]}


@app.get("/labels/jobs/{job_id}")
def labels_job_get(job_id: str) -> dict:
    job = labels_jobs.registry().get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job: {job_id}")
    return job.to_dict()


@app.delete("/labels/jobs/{job_id}")
def labels_job_cancel(job_id: str) -> dict:
    ok = labels_jobs.registry().cancel(job_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"unknown job: {job_id}")
    return {"id": job_id, "cancel_requested": True}


class LabelOverride(BaseModel):
    character: str
    partner: str
    hash: str
    ts: int
    speaker: str
    # label=None / missing deletes the row (revert to rule / Unlabeled).
    label: str | None = None


class LabelsClearRequest(BaseModel):
    character: str
    partner: str


@app.get("/labels/failure-log")
def labels_failure_log() -> dict:
    """Where the classify failure JSONL lives + whether it has anything yet.

    The renderer hands the path to Electron's shell.openPath so the
    user can inspect / forward the file to a model for debugging. We
    don't stream contents over HTTP — these can grow long, and the OS
    text viewer is the right tool.
    """
    path = labels_llm.failure_log_path()
    exists = path.exists()
    size = path.stat().st_size if exists else 0
    return {"path": str(path), "exists": exists, "byte_size": size}


@app.post("/labels/clear")
def labels_clear(body: LabelsClearRequest) -> dict:
    """Delete every label (LLM + manual) for one conversation.

    Used by the renderer's "Reset all labels" context-menu action.
    After this returns, the resolver falls back to rule-on-read for
    every message in that conversation.
    """
    conn = labels_store.connect()
    try:
        alias_group = aliases_store.all_names_for(
            conn, body.character, body.partner
        )
        deleted = labels_store.delete_labels_for_partner(
            conn,
            body.character,
            body.partner,
            partner_aliases=alias_group,
        )
    finally:
        conn.close()
    return {
        "character": body.character,
        "partner": body.partner,
        "deleted": deleted,
    }


@app.post("/labels/clear-all")
def labels_clear_all() -> dict:
    """Wipe every row from labels + label_failures across all characters.

    The Settings → Labels "Reset all labels…" button calls this. After
    it returns, every message in every conversation falls back to
    rule-on-read — manual overrides are gone too. There is no undo;
    the renderer must confirm before invoking this.
    """
    conn = labels_store.connect()
    try:
        labels_cur = conn.execute("DELETE FROM labels")
        failures_cur = conn.execute("DELETE FROM label_failures")
        conn.commit()
        return {
            "labels_deleted": labels_cur.rowcount,
            "failures_deleted": failures_cur.rowcount,
        }
    finally:
        conn.close()


@app.get("/labels/job-history")
def labels_job_history(limit: int = 50) -> dict:
    """Recent finished classify runs, newest first.

    Persisted across sidecar restarts unlike the live JobRegistry —
    the renderer's Settings → Labels history panel queries this on
    open and after every classify completion.
    """
    limit = max(1, min(200, limit))
    conn = labels_store.connect()
    try:
        rows = labels_store.list_job_history(conn, limit=limit)
    finally:
        conn.close()
    return {"jobs": rows, "limit": limit}


@app.get("/labels/rollup")
def labels_rollup() -> dict:
    """Aggregate IC/OOC/Unlabeled/Failed counts across every character.

    Walks every (character × partner) log under the configured data
    directory; for large corpora this is a few seconds the first time
    Settings opens. Used by the Labels rollup pane to show one-glance
    state ("3,402 IC · 18,720 OOC · …").
    """
    try:
        characters = list_characters()
    except LogDirError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    totals = {
        labels_store.LABEL_IC: 0,
        labels_store.LABEL_OOC: 0,
        labels_store.LABEL_UNLABELED: 0,
        labels_store.LABEL_FAILED: 0,
    }
    # Track manual-override count separately — it's a useful "how much
    # of this did I curate" signal independent of IC/OOC totals.
    manual_overrides = int(
        labels_conn.execute(
            "SELECT COUNT(*) FROM labels WHERE source = 'manual'"
        ).fetchone()[0]
        or 0
    )
    try:
        lab_settings = labels_store.load_settings(settings_conn)
        for char in characters:
            try:
                entries = list_partners(char.name)
            except LogDirError:
                continue
            for entry in entries:
                try:
                    messages = list(read_messages(char.name, entry.name))
                except LogDirError:
                    continue
                alias_group = aliases_store.all_names_for(
                    labels_conn, char.name, entry.name
                )
                counts = labels_store.stats(
                    labels_conn,
                    char.name,
                    entry.name,
                    messages,
                    lab_settings,
                    partner_aliases=alias_group,
                )
                for k, v in counts.items():
                    totals[k] = totals.get(k, 0) + v
    finally:
        settings_conn.close()
        labels_conn.close()
    total = sum(totals.values())
    return {
        "ic": totals[labels_store.LABEL_IC],
        "ooc": totals[labels_store.LABEL_OOC],
        "unlabeled": totals[labels_store.LABEL_UNLABELED],
        "failed": totals[labels_store.LABEL_FAILED],
        "manual": manual_overrides,
        "total": total,
        "character_count": len(characters),
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
    # Empty strings restore the default for any of these — see
    # labels.load_settings() for the fallback policy. None means "leave
    # untouched". threshold_chars below 1 is clamped silently.
    threshold_chars: int | None = None
    llm_endpoint: str | None = None
    llm_model: str | None = None
    llm_api_key: str | None = None
    system_prompt: str | None = None
    context_before: int | None = None
    context_after: int | None = None


class RagSettingsUpdate(BaseModel):
    # Same convention as LabelsSettingsUpdate: empty string clears
    # (falls back to default on read), None leaves untouched. Prefixes
    # are special — an empty string for them is a real value (not a
    # default), but we still accept it as "clear" since the default
    # also happens to be empty.
    embed_endpoint: str | None = None
    embed_model: str | None = None
    embed_api_key: str | None = None
    embed_query_prefix: str | None = None
    embed_document_prefix: str | None = None
    # Chat / query-time fields. None = untouched; "" = reset to default.
    # Numeric fields are int|None — empty string isn't meaningful for an
    # int. The renderer just sends None when the user wants the default.
    chat_endpoint: str | None = None
    chat_model: str | None = None
    chat_api_key: str | None = None
    chat_system_prompt: str | None = None
    rerank_model: str | None = None
    rerank_candidates: int | None = None
    top_k: int | None = None
    neighbors: int | None = None
    # Quality / fusion tunables. bool fields use None = untouched
    # (omitted from request); float for the rerank threshold ratio.
    rerank_min_ratio: float | None = None
    hybrid_enabled: bool | None = None
    hybrid_bm25_candidates: int | None = None
    multiquery_enabled: bool | None = None
    multiquery_variants: int | None = None
    chat_num_ctx: int | None = None
    # Empty string clears the override and lets the server default fire
    # (Ollama: ~5 min keep_alive). Free-text so users can write Ollama's
    # duration grammar verbatim ("30s", "1m", "0").
    chat_embed_keep_alive: str | None = None
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
            "llm_endpoint": lab.llm_endpoint,
            "llm_model": lab.llm_model,
            "llm_api_key": lab.llm_api_key,
            "system_prompt": lab.system_prompt,
            "context_before": lab.context_before,
            "context_after": lab.context_after,
            # Defaults exposed so the UI can show "(default)" hints and
            # offer a one-click reset without hardcoding them.
            "defaults": {
                "threshold_chars": labels_store.DEFAULT_THRESHOLD_CHARS,
                "llm_endpoint": labels_store.DEFAULT_LLM_ENDPOINT,
                "llm_model": labels_store.DEFAULT_LLM_MODEL,
                "llm_api_key": labels_store.DEFAULT_LLM_API_KEY,
                "system_prompt": labels_store.DEFAULT_SYSTEM_PROMPT,
                "context_before": labels_store.DEFAULT_CONTEXT_BEFORE,
                "context_after": labels_store.DEFAULT_CONTEXT_AFTER,
            },
            "prompt_presets": [
                {
                    "id": p.id,
                    "label": p.label,
                    "language": p.language,
                    "description": p.description,
                    "body": p.body,
                }
                for p in labels_store.PROMPT_PRESETS
            ],
        },
        "rag": {
            "embed_endpoint": rag.embed_endpoint,
            "embed_model": rag.embed_model,
            "embed_api_key": rag.embed_api_key,
            "embed_query_prefix": rag.embed_query_prefix,
            "embed_document_prefix": rag.embed_document_prefix,
            "chat_endpoint": rag.chat_endpoint,
            "chat_model": rag.chat_model,
            "chat_api_key": rag.chat_api_key,
            "chat_system_prompt": rag.chat_system_prompt,
            "rerank_model": rag.rerank_model,
            "rerank_candidates": rag.rerank_candidates,
            "top_k": rag.top_k,
            "neighbors": rag.neighbors,
            "rerank_min_ratio": rag.rerank_min_ratio,
            "hybrid_enabled": rag.hybrid_enabled,
            "hybrid_bm25_candidates": rag.hybrid_bm25_candidates,
            "multiquery_enabled": rag.multiquery_enabled,
            "multiquery_variants": rag.multiquery_variants,
            "chat_num_ctx": rag.chat_num_ctx,
            "chat_embed_keep_alive": rag.chat_embed_keep_alive,
            "chunk_max_chars": rag.chunk_max_chars,
            "chunk_soft_split_chars": rag.chunk_soft_split_chars,
            "chunk_overlap_msgs": rag.chunk_overlap_msgs,
            "defaults": {
                "embed_endpoint": rag_settings.DEFAULT_EMBED_ENDPOINT,
                "embed_model": rag_settings.DEFAULT_EMBED_MODEL,
                "embed_api_key": rag_settings.DEFAULT_EMBED_API_KEY,
                "embed_query_prefix": rag_settings.DEFAULT_EMBED_QUERY_PREFIX,
                "embed_document_prefix": rag_settings.DEFAULT_EMBED_DOCUMENT_PREFIX,
                "chat_endpoint": rag_settings.DEFAULT_CHAT_ENDPOINT,
                "chat_model": rag_settings.DEFAULT_CHAT_MODEL,
                "chat_api_key": rag_settings.DEFAULT_CHAT_API_KEY,
                # Expose the resolved English default so the UI can
                # show "Reset to default" without hardcoding it.
                "chat_system_prompt": _resolve_default_chat_prompt(),
                "rerank_model": rag_settings.DEFAULT_RERANK_MODEL,
                "rerank_candidates": rag_settings.DEFAULT_RERANK_CANDIDATES,
                "top_k": rag_settings.DEFAULT_TOP_K,
                "neighbors": rag_settings.DEFAULT_NEIGHBORS,
                "rerank_min_ratio": rag_settings.DEFAULT_RERANK_MIN_RATIO,
                "hybrid_enabled": rag_settings.DEFAULT_HYBRID_ENABLED,
                "hybrid_bm25_candidates": rag_settings.DEFAULT_HYBRID_BM25_CANDIDATES,
                "multiquery_enabled": rag_settings.DEFAULT_MULTIQUERY_ENABLED,
                "multiquery_variants": rag_settings.DEFAULT_MULTIQUERY_VARIANTS,
                "chat_num_ctx": rag_settings.DEFAULT_CHAT_NUM_CTX,
                "chat_embed_keep_alive": rag_settings.DEFAULT_CHAT_EMBED_KEEP_ALIVE,
                "chunk_max_chars": rag_settings.DEFAULT_CHUNK_MAX_CHARS,
                "chunk_soft_split_chars": rag_settings.DEFAULT_CHUNK_SOFT_SPLIT_CHARS,
                "chunk_overlap_msgs": rag_settings.DEFAULT_CHUNK_OVERLAP_MSGS,
            },
        },
    }


def _resolve_default_chat_prompt() -> str:
    # Lazy import — rag_query imports rag, rag imports rag_query in
    # its loader, so doing this at module top would cycle.
    from rag_query import DEFAULT_SYSTEM_PROMPT

    return DEFAULT_SYSTEM_PROMPT


class DiscoverModelsRequest(BaseModel):
    """Endpoint URL for one inference server to enumerate.

    The renderer sends the current text-field value (not the saved
    settings) so the user can discover before they hit Save. We don't
    require any of the other settings — just the URL the user typed.
    """
    endpoint: str


@app.post("/settings/discover-models")
def settings_discover_models(body: DiscoverModelsRequest) -> dict:
    """Enumerate models on an OpenAI-compatible or Ollama endpoint.

    Tries `<endpoint>/models` first (OpenAI shape — LM Studio, OpenAI
    itself, llamafile). Falls back to `<endpoint>/api/tags` (Ollama).
    Returns `{models: list[str], source: 'openai'|'ollama'|'unknown',
    error: str | None}`. 200-always — failure surfaces as ok=false-ish
    via empty `models` + populated `error`.

    Proxied through the sidecar (instead of the renderer fetching
    directly) because: (a) some configs of LM Studio omit CORS headers,
    so a browser-side fetch silently fails; (b) the sidecar already
    has the URL parsing + timeout patterns we want.
    """
    import time as _time
    from urllib.error import HTTPError, URLError
    from urllib.request import Request, urlopen

    endpoint = body.endpoint.strip()
    if not endpoint:
        return {"models": [], "source": "unknown", "error": "endpoint is empty"}

    # Short timeout — discovery runs on a user button click and the
    # right answer for "endpoint is wrong" is fast feedback, not a
    # 60 s wait. Cold-loaded models don't need to be ready to be
    # listed; the /models endpoint is metadata-only.
    timeout = 5.0
    base = endpoint.rstrip("/")

    def _try(url: str) -> tuple[int, str]:
        req = Request(url, headers={"Accept": "application/json"})
        with urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")

    started = _time.monotonic()
    # Order: /models then /api/tags. LM Studio and OpenAI answer
    # /models; Ollama answers /api/tags. Trying both in sequence is
    # cheap (5 s each worst-case) and avoids asking the user "is this
    # Ollama or OpenAI?".
    last_error: str | None = None
    for candidate, source in (
        (f"{base}/models", "openai"),
        (f"{base}/api/tags", "ollama"),
    ):
        try:
            _status, body_text = _try(candidate)
        except HTTPError as exc:
            # 404 from LM Studio means "no /models route" — keep trying
            # the Ollama URL. 401/403 means auth issue — surface and stop.
            if exc.code in (401, 403):
                last_error = f"HTTP {exc.code} from {candidate}: {exc.reason}"
                break
            last_error = f"HTTP {exc.code} from {candidate}"
            continue
        except URLError as exc:
            last_error = f"connection failed: {exc.reason}"
            continue
        except TimeoutError:
            last_error = f"timed out after {int(timeout)} s"
            continue
        except Exception as exc:  # noqa: BLE001 — surface to UI
            last_error = f"{type(exc).__name__}: {exc}"
            continue
        try:
            payload = json.loads(body_text)
        except json.JSONDecodeError:
            last_error = f"non-JSON response from {candidate}"
            continue
        models: list[str] = []
        if source == "openai":
            # OpenAI shape: {data: [{id: "...", ...}, ...]}
            data = payload.get("data") if isinstance(payload, dict) else None
            if isinstance(data, list):
                for entry in data:
                    if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                        models.append(entry["id"])
        else:
            # Ollama shape: {models: [{name: "...", ...}, ...]}
            data = payload.get("models") if isinstance(payload, dict) else None
            if isinstance(data, list):
                for entry in data:
                    if isinstance(entry, dict) and isinstance(entry.get("name"), str):
                        models.append(entry["name"])
        return {
            "models": sorted(set(models)),
            "source": source,
            "error": None,
            "elapsed_ms": int((_time.monotonic() - started) * 1000),
        }
    return {
        "models": [],
        "source": "unknown",
        "error": last_error or "no models endpoint responded",
        "elapsed_ms": int((_time.monotonic() - started) * 1000),
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

    return _settings_dict(conn)


def _apply_labels_update(conn, update: LabelsSettingsUpdate) -> None:
    """Persist each labels field that was supplied.

    Convention: empty string clears (falls back to default on read).
    None means "leave untouched". threshold_chars below 1 is clamped to
    1 — zero or negative would make every message OOC and is almost
    certainly a typo.
    """
    if update.threshold_chars is not None:
        n = max(1, int(update.threshold_chars))
        settings_store.set_value(conn, settings_store.KEY_LABELS_THRESHOLD_CHARS, str(n))
    if update.context_before is not None:
        # Clamp same as load_settings: 0..10. Higher is risky on small
        # context windows; lower than 0 is meaningless.
        n = max(0, min(10, int(update.context_before)))
        settings_store.set_value(conn, settings_store.KEY_LABELS_CONTEXT_BEFORE, str(n))
    if update.context_after is not None:
        n = max(0, min(10, int(update.context_after)))
        settings_store.set_value(conn, settings_store.KEY_LABELS_CONTEXT_AFTER, str(n))
    for field, key in (
        ("llm_endpoint", settings_store.KEY_LABELS_LLM_ENDPOINT),
        ("llm_model", settings_store.KEY_LABELS_LLM_MODEL),
        ("llm_api_key", settings_store.KEY_LABELS_LLM_API_KEY),
        ("system_prompt", settings_store.KEY_LABELS_SYSTEM_PROMPT),
    ):
        value = getattr(update, field)
        if value is None:
            continue
        if value == "":
            settings_store.clear(conn, key)
        else:
            settings_store.set_value(conn, key, value)


def _apply_rag_update(conn, update: RagSettingsUpdate) -> None:
    """Persist each RAG field that was supplied.

    Same convention as _apply_labels_update: None leaves the field
    untouched, empty string clears (falls back to default on read).
    """
    for field, key in (
        ("embed_endpoint", settings_store.KEY_RAG_EMBED_ENDPOINT),
        ("embed_model", settings_store.KEY_RAG_EMBED_MODEL),
        ("embed_api_key", settings_store.KEY_RAG_EMBED_API_KEY),
        ("embed_query_prefix", settings_store.KEY_RAG_EMBED_QUERY_PREFIX),
        ("embed_document_prefix", settings_store.KEY_RAG_EMBED_DOCUMENT_PREFIX),
        ("chat_endpoint", settings_store.KEY_RAG_CHAT_ENDPOINT),
        ("chat_model", settings_store.KEY_RAG_CHAT_MODEL),
        ("chat_api_key", settings_store.KEY_RAG_CHAT_API_KEY),
        ("chat_system_prompt", settings_store.KEY_RAG_CHAT_SYSTEM_PROMPT),
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
    if update.multiquery_enabled is not None:
        settings_store.set_value(
            conn,
            settings_store.KEY_RAG_MULTIQUERY_ENABLED,
            "1" if update.multiquery_enabled else "0",
        )
    if update.multiquery_variants is not None:
        n = max(2, min(5, int(update.multiquery_variants)))
        settings_store.set_value(conn, settings_store.KEY_RAG_MULTIQUERY_VARIANTS, str(n))
    if update.chat_num_ctx is not None:
        n = max(0, min(131072, int(update.chat_num_ctx)))
        settings_store.set_value(conn, settings_store.KEY_RAG_CHAT_NUM_CTX, str(n))
    if update.chat_embed_keep_alive is not None:
        # Free-text: Ollama accepts "30s" / "1m" / "0" / integer seconds.
        # Trim, clamp to a sane upper bound on length (no validation —
        # the server returns 400 if the grammar is wrong, which surfaces
        # to the user on the next chat query).
        raw = update.chat_embed_keep_alive.strip()[:32]
        settings_store.set_value(
            conn, settings_store.KEY_RAG_CHAT_EMBED_KEEP_ALIVE, raw
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


# ---- documents ----------------------------------------------------------


# Reopen a fresh connection per request so the dependency cleans up
# after itself. SQLite connections aren't safe to share across threads
# under FastAPI's default executor.
def _db():
    conn = documents.connect()
    try:
        yield conn
    finally:
        conn.close()


class DocCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    bbcode: str = ""
    inlines: dict[str, Any] = Field(default_factory=dict)


class DocRename(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class RevisionWrite(BaseModel):
    bbcode: str
    inlines: dict[str, Any] = Field(default_factory=dict)


def _doc_dict(doc: documents.Document) -> dict:
    return {
        "id": doc.id,
        "name": doc.name,
        "scratch": doc.scratch,
        "created_at": doc.created_at,
        "updated_at": doc.updated_at,
        "latest_revision_id": doc.latest_revision_id,
        "latest_char_count": doc.latest_char_count,
        "latest_created_at": doc.latest_created_at,
        "has_draft": doc.has_draft,
    }


# ---- system / setup ----------------------------------------------------


@app.get("/system/ollama-status")
def system_ollama_status() -> dict:
    """Synchronous probe used by the AI Setup wizard's first page.

    Returns {running, installed, version, models, error}. Fast (≤5 s)
    by design — the renderer treats this as instant feedback.
    """
    return system_probe.ollama_status().to_dict()


class OllamaPullRequest(BaseModel):
    name: str


@app.post("/system/ollama-pull")
def system_ollama_pull(body: OllamaPullRequest) -> StreamingResponse:
    """SSE stream of Ollama pull progress.

    Body: {name: "<model id>"}. The model id is whatever Ollama
    accepts on /api/pull — including `hf.co/<repo>/<model>:<tag>` paths.
    Emits one `progress` event per upstream NDJSON line, then `done`
    when Ollama reports `status:"success"`, or `error` on any failure.

    Cancel: if the renderer closes the SSE connection mid-stream, the
    underlying urlopen handle is GC'd which closes the HTTP socket;
    Ollama stops pulling and the partial blob stays on disk for resume.
    """

    name = body.name

    def gen():
        try:
            for evt in system_probe.ollama_pull_stream(name):
                # Pass through the raw fields the renderer renders against.
                yield _sse_event("progress", {
                    "status": evt.get("status", ""),
                    "digest": evt.get("digest"),
                    "completed": evt.get("completed"),
                    "total": evt.get("total"),
                })
                if evt.get("status") == "success":
                    yield _sse_event("done", {"model": name})
                    return
            # Stream ended without `success` — Ollama dropped us, but
            # didn't error. Surface that so the UI doesn't hang on the
            # last `progress` event.
            yield _sse_event(
                "error",
                {"message": "pull stream ended without success status"},
            )
        except Exception as exc:  # noqa: BLE001 — boundary
            # HTTPError / URLError / TimeoutError land here too. Wrap
            # them in the same SSE shape so the renderer has one path.
            yield _sse_event(
                "error",
                {"message": f"{type(exc).__name__}: {exc}"},
            )

    return StreamingResponse(gen(), media_type="text/event-stream")


def _rev_dict(rev: documents.Revision) -> dict:
    return {
        "id": rev.id,
        "doc_id": rev.doc_id,
        "bbcode": rev.bbcode,
        "inlines": rev.inlines,
        "char_count": rev.char_count,
        "created_at": rev.created_at,
    }


@app.get("/documents")
def documents_list(conn=Depends(_db)) -> dict:
    return {"documents": [_doc_dict(d) for d in documents.list_documents(conn)]}


@app.post("/documents", status_code=201)
def documents_create(body: DocCreate, conn=Depends(_db)) -> dict:
    try:
        doc = documents.create_document(conn, body.name, bbcode=body.bbcode, inlines=body.inlines)
    except documents.DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _doc_dict(doc)


@app.get("/documents/{doc_id}")
def documents_get(doc_id: int, conn=Depends(_db)) -> dict:
    try:
        doc = documents.get_document(conn, doc_id)
        current = documents.current_content(conn, doc_id)
    except documents.DocumentError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"document": _doc_dict(doc), "current": _rev_dict(current)}


@app.patch("/documents/{doc_id}")
def documents_rename(doc_id: int, body: DocRename, conn=Depends(_db)) -> dict:
    try:
        return _doc_dict(documents.rename_document(conn, doc_id, body.name))
    except documents.DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/documents/{doc_id}", status_code=204)
def documents_delete(doc_id: int, conn=Depends(_db)) -> None:
    try:
        documents.delete_document(conn, doc_id)
    except documents.DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/documents/{doc_id}/duplicate", status_code=201)
def documents_duplicate(doc_id: int, body: DocRename, conn=Depends(_db)) -> dict:
    try:
        return _doc_dict(documents.duplicate_document(conn, doc_id, body.name))
    except documents.DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/documents/{doc_id}/revisions")
def revisions_list(doc_id: int, conn=Depends(_db)) -> dict:
    try:
        revs = documents.list_revisions(conn, doc_id)
    except documents.DocumentError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    # The list view doesn't need the full BBCode body — drop it to keep
    # the payload tiny when there are hundreds of revisions.
    return {
        "doc_id": doc_id,
        "revisions": [
            {
                "id": r.id,
                "char_count": r.char_count,
                "created_at": r.created_at,
            }
            for r in revs
        ],
    }


@app.get("/documents/{doc_id}/revisions/{rev_id}")
def revisions_get(doc_id: int, rev_id: int, conn=Depends(_db)) -> dict:
    try:
        return _rev_dict(documents.get_revision(conn, doc_id, rev_id))
    except documents.DocumentError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/documents/{doc_id}/revisions", status_code=201)
def revisions_save(doc_id: int, body: RevisionWrite, conn=Depends(_db)) -> dict:
    try:
        return _rev_dict(documents.save_revision(conn, doc_id, body.bbcode, body.inlines))
    except documents.DocumentError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.put("/documents/{doc_id}/draft", status_code=204)
def drafts_save(doc_id: int, body: RevisionWrite, conn=Depends(_db)) -> None:
    try:
        documents.save_draft(conn, doc_id, body.bbcode, body.inlines)
    except documents.DocumentError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.delete("/documents/{doc_id}/draft", status_code=204)
def drafts_discard(doc_id: int, conn=Depends(_db)) -> None:
    documents.discard_draft(conn, doc_id)


# Entry point for the PyInstaller-frozen build. In dev we run via
# `uv run uvicorn server:app` which imports `app` directly, so this
# block is unreached. The packaged Electron app spawns sidecar.exe
# (this script frozen) and reads SIDECAR_PORT from the environment.
if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("SIDECAR_PORT", "8770"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
