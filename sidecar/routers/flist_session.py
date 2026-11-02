"""The F-list session, the account's characters and their avatars."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import archive_images
import archive_registry
import flist_activity
import flist_api
from logs import LogDirError, list_characters
from services import avatars, password_idle
from services import foreign as foreign_service

router = APIRouter()


class FlistSignInRequest(BaseModel):
    account: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)


@router.post("/flist/session")
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
                dest = archive_images.avatar_path_for(name)
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


@router.post("/flist/avatars/prefetch")
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


@router.delete("/flist/session")
async def flist_session_delete() -> dict:
    status = flist_api.ticket_store().status()
    flist_api.ticket_store().clear()
    # Bookmarks and friends are account-scoped and memoised for ten
    # minutes. Leaving them would show the next account who signs in
    # the previous one's contacts.
    foreign_service.reset_social_cache()
    flist_activity.record(
        "sign-out",
        account=status.get("account"),
    )
    return {"signed_out": True}


@router.get("/flist/activity")
async def flist_activity_snapshot() -> dict:
    """In-memory append-only audit log of F-list operations (sign-in,
    ticket refresh, per-character pull stages, idle password clear,
    sign-out). Closes the trust-question gap surfaced by the
    2026-05-30 UX subagent review — see UX F4 in
    REVIEW_2026-05-30_post_tier1_polish.md."""
    return flist_activity.snapshot()


@router.get("/flist/session")
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
    if (
        password_idle.IDLE_PASSWORD_TIMEOUT_SEC > 0
        and status.get("active")
        and status.get("password_cached")
    ):
        idle = store.idle_seconds()
        remaining = max(0, int(password_idle.IDLE_PASSWORD_TIMEOUT_SEC - idle))
        status["password_idle_seconds_remaining"] = remaining
    else:
        # Idle watchdog disabled (or no active session) — never surface
        # a countdown; renderer suppresses its "stay signed in" warning
        # when this field is null.
        status["password_idle_seconds_remaining"] = None
    return status


@router.get("/flist/characters")
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
    rows = archive_registry.merge_roster(account_chars, log_chars)
    # Annotate every has_archive row with its on-disk pull integrity so
    # the picker / F-list zone can surface "incomplete — N missing" for
    # archives where a prior pull was interrupted or had image failures.
    # Cheap: each call is one dir-walk under images/.
    for row in rows:
        if row.get("has_archive") and row.get("id") is not None:
            row["pull_status"] = archive_images.compute_pull_status(row["id"])
    return {"characters": rows}


@router.get("/flist/mapping-list")
async def flist_mapping_list(force: bool = False) -> dict:
    cache_path = archive_registry.cache_root() / "mapping-list.json"
    try:
        mapping = await flist_api.fetch_mapping_list(cache_path, force=force)
    except flist_api.TicketRequired as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except flist_api.FlistApiError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    # Decorate with cache metadata so the renderer can drive the staleness
    # chip (§2.4) without a second filesystem peek. `_etag` is the cache
    # key for the resolver memo (§3 step 3); `_fetched_at` is the file
    # mtime in unix seconds.
    try:
        st = cache_path.stat()
        fetched_at: int | None = int(st.st_mtime)
    except OSError:
        fetched_at = None
    etag: str | None = None
    try:
        import hashlib

        etag = hashlib.sha256(cache_path.read_bytes()).hexdigest()
    except OSError:
        pass
    return {**mapping, "_etag": etag, "_fetched_at": fetched_at}


@router.get("/flist/avatar/{name}")
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
        dest = archive_images.avatar_path_for(name)
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
        # F-list's "no avatar" placeholder. Keep the cached file (it's
        # tiny and avoids re-fetching the same placeholder on every
        # request) but surface 404 so the renderer's onError fires and
        # the initial-circle fallback renders.
        raise HTTPException(status_code=404, detail="no avatar uploaded")
    return FileResponse(dest)
