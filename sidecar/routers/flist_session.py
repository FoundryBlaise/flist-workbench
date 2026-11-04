"""The F-list session, the account's characters and their avatars."""

from typing import Literal

from fastapi import APIRouter
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, SerializerFunctionWrapHandler, model_serializer

import archive_images
import archive_registry
import flist_activity
import flist_api
from logs import LogDirError, list_characters
from refusals import FlistRefused, NoAvatar
from services import avatars, password_idle
from services import foreign as foreign_service
from wire import MISSING, WireModel, binary

router = APIRouter()


class FlistSignInRequest(BaseModel):
    account: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)


class AccountCharacter(WireModel):
    """A character on the signed-in F-list account. `id` is F-list's
    character id when it gave one."""

    name: str
    id: int | str | None


class SignedIn(WireModel):
    characters: list[AccountCharacter]
    expires_in_sec: int
    account: str


class AvatarPrefetchScheduled(WireModel):
    scheduled: int


class SignedOut(WireModel):
    signed_out: Literal[True]


class FlistActivityEvent(WireModel):
    """One F-list operation: when (`t`), what (`kind`), and the fields
    that kind records."""

    model_config = ConfigDict(extra="allow")

    t: float
    kind: str


class FlistActivity(WireModel):
    """The in-memory record of F-list operations this run, oldest first."""

    started_at: float
    event_count: int
    max_events: int
    events: list[FlistActivityEvent]


class FlistSession(WireModel):
    """The F-list session the sidecar holds. Signed out, it is only
    `active` (false), `api_hourly_count` and a null countdown."""

    active: bool
    account: str | MISSING = MISSING
    expires_in_sec: int | MISSING = MISSING
    needs_refresh: bool | MISSING = MISSING
    #: True while the sidecar still holds the password for refreshing
    #: the ticket; false once the idle watchdog dropped it.
    password_cached: bool | MISSING = MISSING
    api_hourly_count: int
    #: Seconds until the idle watchdog drops the password; null when
    #: nothing is held or the watchdog is off.
    password_idle_seconds_remaining: int | None


class MissingImage(WireModel):
    image_id: str
    extension: str


class PullStatus(WireModel):
    """Whether a character's last Pull got every image."""

    status: Literal["never_pulled", "unknown", "interrupted", "partial", "complete"]
    missing_image_ids: list[MissingImage]
    expected: int
    present: int
    last_attempt_ts: int | float | None


class RosterEntry(WireModel):
    """A character the picker lists: on the account, kept in the app, or
    with Logs, and which of those."""

    name: str
    id: int | str | None
    on_account: bool
    has_archive: bool
    has_logs: bool
    last_pulled_at: int | float | None
    #: How many Backups the character has.
    backup_count: int
    #: Only for a character the app keeps (`has_archive`).
    pull_status: PullStatus | MISSING = MISSING


class Roster(WireModel):
    characters: list[RosterEntry]


class MappingList(WireModel):
    """F-list's mapping list (kinks, infotags and their groups, list
    items) as F-list sent it, then two keys of the sidecar's: the
    cached file's sha256 (`_etag`) and when it was fetched
    (`_fetched_at`, unix seconds)."""

    model_config = ConfigDict(extra="allow")

    etag: str | None = Field(alias="_etag")
    fetched_at: int | None = Field(alias="_fetched_at")

    @model_serializer(mode="wrap")
    def _flist_keys_first(self, handler: SerializerFunctionWrapHandler):
        # Extras serialise after the declared fields; on the wire
        # F-list's keys come first. (No return annotation: one would
        # replace the model's schema with the annotation's.)
        out = handler(self)
        extra = self.__pydantic_extra__ or {}
        return {**{k: v for k, v in out.items() if k in extra}, **{k: v for k, v in out.items() if k not in extra}}


@router.post("/flist/session")
async def flist_session_create(body: FlistSignInRequest) -> SignedIn:
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
        raise FlistRefused("sign_in_failed", str(exc)) from exc
    names = [c["name"] for c in result["characters"] if c.get("name")]
    flist_activity.record(
        "sign-in",
        account=body.account.strip(),
        character_count=len(names),
    )
    if names:
        _asyncio.create_task(_prefetch_avatars(names))
    return SignedIn.model_validate(result)


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
            except Exception:  # noqa: BLE001, S110 — best-effort warmup
                pass

        await asyncio.gather(*(one(n) for n in names), return_exceptions=True)


@router.post("/flist/avatars/prefetch")
async def flist_avatars_prefetch() -> AvatarPrefetchScheduled:
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
    return AvatarPrefetchScheduled(scheduled=len(names))


@router.delete("/flist/session")
async def flist_session_delete() -> SignedOut:
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
    return SignedOut(signed_out=True)


@router.get("/flist/activity")
async def flist_activity_snapshot() -> FlistActivity:
    """In-memory append-only audit log of F-list operations (sign-in,
    ticket refresh, per-character pull stages, idle password clear,
    sign-out). Closes the trust-question gap surfaced by the
    2026-05-30 UX subagent review — see UX F4 in
    REVIEW_2026-05-30_post_tier1_polish.md."""
    return FlistActivity.model_validate(flist_activity.snapshot())


@router.get("/flist/session")
async def flist_session_get() -> FlistSession:
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
    return FlistSession.model_validate(status)


@router.get("/flist/characters")
def flist_characters() -> Roster:
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
    return Roster.model_validate({"characters": rows})


@router.get("/flist/mapping-list")
async def flist_mapping_list(force: bool = False) -> MappingList:
    cache_path = archive_registry.cache_root() / "mapping-list.json"
    try:
        mapping = await flist_api.fetch_mapping_list(cache_path, force=force)
    except flist_api.FlistApiError as exc:
        raise flist_api.refusal(exc) from exc
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
    return MappingList.model_validate({**mapping, "_etag": etag, "_fetched_at": fetched_at})


@router.get(
    "/flist/avatar/{name}",
    response_class=FileResponse,
    responses=binary("image/png", "The avatar F-list has for the character."),
)
async def flist_avatar(name: str) -> FileResponse:
    """Serve a cached avatar from `<userdata>/avatars/`. Fetches on
    miss; avatars are public so this works signed-out too.

    F-list returns a 5827-byte placeholder PNG (HTTP 200) for any name
    without an uploaded avatar — there's no 404 path. We detect that
    by size and surface a real 404 so the renderer's `onError` fires
    and the initial-circle fallback renders instead of an alien
    placeholder graphic.
    """
    dest = archive_images.avatar_path_for(name)
    if not dest.exists():
        try:
            await flist_api.download_to(flist_api.avatar_url(name), dest)
        except flist_api.FlistApiError as exc:
            raise NoAvatar(str(exc)) from exc
    try:
        size = dest.stat().st_size
    except OSError:
        size = -1
    if size == avatars.PLACEHOLDER_SIZE:
        # F-list's "no avatar" placeholder. Keep the cached file (it's
        # tiny and avoids re-fetching the same placeholder on every
        # request) but surface 404 so the renderer's onError fires and
        # the initial-circle fallback renders.
        raise NoAvatar("no avatar uploaded")
    return FileResponse(dest)
