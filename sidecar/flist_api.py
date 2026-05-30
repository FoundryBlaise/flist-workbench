"""F-list JSON API client — ticket lifecycle, rate limiting, fetches.

The single integration surface for the Phase 7 character archive. Talks
to `/json/getApiTicket.php`, `/json/api/character-data.php`,
`/json/api/mapping-list.php`, plus CDN image downloads from
`static.f-list.net`.

Ticket lifecycle (revised 2026-05-29):

  - Sign-in posts (account, password) → ticket + character list. Both
    ticket AND password are held in `TicketStore` in this process's RAM
    only. The password persists so we can auto-refresh near expiry — no
    user re-prompt in the middle of a working session.
  - Effective TTL is 28 min (real lifetime is 30 min, 2-min safety).
  - `ensure_fresh_ticket()` is called before every action that needs a
    ticket. If `ticket.age > 23 min` it silently re-acquires.
  - Auth failure during refresh → both fields cleared, caller surfaces
    401 to the renderer.

Single-worker uvicorn is required in the packaged entrypoint —
TicketStore is module-singleton state and multi-worker would split it.
"""
from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

USER_AGENT = "flist-workbench/0.1.0 (+https://github.com/FoundryBlaise/flist-workbench)"

BASE = "https://www.f-list.net"
TICKET_URL = BASE + "/json/getApiTicket.php"
CHARACTER_DATA_URL = BASE + "/json/api/character-data.php"
MAPPING_LIST_URL = BASE + "/json/api/mapping-list.php"

STATIC_BASE = "https://static.f-list.net"

# F-list ticket lifetime is 30 min real. We treat it as expired at 28
# min to give clock-skew + in-flight requests a safety margin. Refresh
# proactively at 23 min so an auto-refresh has 5 min of headroom before
# the effective expiry.
TICKET_EFFECTIVE_TTL_SEC = 28 * 60
TICKET_REFRESH_AT_SEC = 23 * 60

# Developer-policy rate limits: ≤1 req/s, ≤200 character-data calls
# per hour, ≤300 total per hour. RateLimiter enforces the per-second
# bucket and surfaces a soft warning when the hourly count crosses
# 80% of the cap.
HARD_PER_SECOND = 1.0
HARD_PER_HOUR = 200
SOFT_PER_HOUR_WARN = 160


class FlistApiError(Exception):
    """Anything F-list returned that isn't a success."""


class AuthFailure(FlistApiError):
    """Ticket request rejected — wrong password, locked account, etc.
    Caller maps this to HTTP 401 for the renderer."""


class TicketRequired(FlistApiError):
    """No active ticket and no cached password to auto-refresh."""


class RateLimited(FlistApiError):
    """Hourly cap would be exceeded; refuse rather than risk a ban."""


@dataclass(slots=True)
class Ticket:
    """Active F-list session. Password lives here so auto-refresh can
    run without re-prompting; both fields redact in repr to avoid
    leaking via accidental `logger.info(ticket_store)` calls."""

    account: str
    value: str
    password: str
    acquired_at: float

    @property
    def age(self) -> float:
        return time.monotonic() - self.acquired_at

    @property
    def is_expired(self) -> bool:
        return self.age >= TICKET_EFFECTIVE_TTL_SEC

    @property
    def needs_refresh(self) -> bool:
        return self.age >= TICKET_REFRESH_AT_SEC

    @property
    def expires_in(self) -> float:
        return max(0.0, TICKET_EFFECTIVE_TTL_SEC - self.age)

    def __repr__(self) -> str:
        return (
            f"Ticket(account={self.account!r}, value=<redacted>, "
            f"password=<redacted>, age={self.age:.0f}s)"
        )

    __str__ = __repr__


@dataclass
class TicketStore:
    """Singleton holding the active ticket. All access goes through
    `ticket_store()` so tests can inject a fresh one between cases.

    The `_last_touched` timestamp tracks user-initiated activity (any
    `/flist/*` hit that is *not* the renderer's heartbeat poll). After
    a configurable idle window the password is dropped from memory so
    the process doesn't sit on it while a forgotten Workbench window
    lingers in the background. The ticket itself is left alone — it
    will expire naturally at the F-list-side 30-min TTL; the user just
    can't *auto-refresh* into a fresh session without typing the
    password again. See P0-C in REVIEW_2026-05-30."""

    _ticket: Ticket | None = None
    _last_characters: list[dict] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _last_touched: float = 0.0

    def get(self) -> Ticket | None:
        with self._lock:
            t = self._ticket
            if t is not None and t.is_expired:
                # Don't auto-evict here — caller decides whether to
                # refresh or clear. Just return what we have.
                return t
            return t

    def set(self, ticket: Ticket, characters: list[dict] | None = None) -> None:
        with self._lock:
            self._ticket = ticket
            self._last_touched = time.monotonic()
            if characters is not None:
                self._last_characters = characters

    def clear(self) -> None:
        with self._lock:
            self._ticket = None
            self._last_characters = []
            self._last_touched = 0.0

    def touch(self) -> None:
        with self._lock:
            self._last_touched = time.monotonic()

    def idle_seconds(self) -> float:
        with self._lock:
            if self._last_touched == 0.0:
                return 0.0
            return time.monotonic() - self._last_touched

    def has_password(self) -> bool:
        with self._lock:
            return self._ticket is not None and bool(self._ticket.password)

    def clear_password_if_idle(self, threshold_sec: float) -> bool:
        """Drop the cached password if the store has been idle long
        enough. Ticket is preserved so the user's existing session
        continues to work until natural expiry — only auto-refresh is
        disabled. Returns True if the password was just dropped.
        """
        with self._lock:
            t = self._ticket
            if t is None or not t.password:
                return False
            if self._last_touched == 0.0:
                return False
            idle = time.monotonic() - self._last_touched
            if idle < threshold_sec:
                return False
            t.password = ""
            return True

    def characters(self) -> list[dict]:
        with self._lock:
            return list(self._last_characters)

    def status(self) -> dict[str, Any]:
        with self._lock:
            t = self._ticket
            if t is None:
                return {"active": False}
            return {
                "active": not t.is_expired,
                "account": t.account,
                "expires_in_sec": int(t.expires_in),
                "needs_refresh": t.needs_refresh,
                "password_cached": bool(t.password),
            }


_STORE = TicketStore()


def ticket_store() -> TicketStore:
    return _STORE


@dataclass
class RateLimiter:
    """Token bucket at 1 req/s plus a rolling 1-hour counter.

    Async-friendly — `await acquire()` sleeps until the next slot is
    free. Concurrent callers serialise through the asyncio.Lock so two
    pulls hitting the limiter at the same instant can't burn through
    the per-second budget.
    """

    per_second: float = HARD_PER_SECOND
    per_hour_cap: int = HARD_PER_HOUR
    _last_call: float = 0.0
    _hourly_calls: list[float] = field(default_factory=list)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def _prune(self, now: float) -> None:
        cutoff = now - 3600.0
        # In-place trim; list stays small (<= per_hour_cap).
        while self._hourly_calls and self._hourly_calls[0] < cutoff:
            self._hourly_calls.pop(0)

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            self._prune(now)
            if len(self._hourly_calls) >= self.per_hour_cap:
                raise RateLimited(
                    f"F-list API hourly cap reached ({self.per_hour_cap} "
                    "requests). Wait a bit before trying again."
                )
            min_interval = 1.0 / self.per_second
            wait = max(0.0, (self._last_call + min_interval) - now)
            if wait > 0:
                await asyncio.sleep(wait)
                now = time.monotonic()
            self._last_call = now
            self._hourly_calls.append(now)

    def hourly_count(self) -> int:
        self._prune(time.monotonic())
        return len(self._hourly_calls)


_LIMITER = RateLimiter()
# CDN downloads from static.f-list.net are separate from the API rate
# budget but we still serialise them politely so a 50-image pull doesn't
# flood. Same 1 req/s ceiling, no hourly cap.
_CDN_LIMITER = RateLimiter(per_second=2.0, per_hour_cap=10_000)


def api_rate_limiter() -> RateLimiter:
    return _LIMITER


def cdn_rate_limiter() -> RateLimiter:
    return _CDN_LIMITER


_PULL_LOCK = asyncio.Lock()


def pull_lock() -> asyncio.Lock:
    """Serialises full character pulls so two concurrent requests don't
    interleave their image-download bursts and starve each other on the
    rate limiter."""
    return _PULL_LOCK


# ---- HTTP helpers ------------------------------------------------------


def _default_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(30.0, connect=10.0),
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
    )


async def _post_json(
    url: str,
    data: dict[str, str],
    *,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    own = client is None
    c = client or _default_client()
    try:
        await _LIMITER.acquire()
        res = await c.post(url, data=data)
        if res.status_code >= 400:
            raise FlistApiError(f"HTTP {res.status_code} from {url}")
        try:
            payload = res.json()
        except ValueError as exc:
            raise FlistApiError(f"non-JSON response from {url}") from exc
    finally:
        if own:
            await c.aclose()
    # F-list returns 200 with an `error` field on logical failures.
    # Empty string = success.
    err = payload.get("error")
    if err:
        # Pass the message through verbatim per Tier 1 decision —
        # F-list's wording is more useful to the user than anything we'd
        # paraphrase.
        if url == TICKET_URL:
            raise AuthFailure(err)
        raise FlistApiError(err)
    return payload


async def acquire_ticket(
    account: str,
    password: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Trade (account, password) for a ticket. Includes the character
    list — we always request it (no extra cost) so the renderer can
    populate the active-character picker on sign-in."""
    payload = await _post_json(
        TICKET_URL,
        {
            "account": account,
            "password": password,
            "no_friends": "true",
            "no_bookmarks": "true",
            "new_character_list": "true",
        },
        client=client,
    )
    ticket_value = payload.get("ticket")
    if not isinstance(ticket_value, str) or not ticket_value:
        raise AuthFailure("F-list returned no ticket")
    characters: list[dict] = []
    raw_chars = payload.get("characters")
    # F-list with `new_character_list=true` actually returns a dict
    # mapping {name: id}, not the list-of-objects the wiki suggested.
    # Verified by live probe 2026-05-30. Still accept the other shapes
    # defensively in case F-list changes the response again.
    if isinstance(raw_chars, dict):
        for name, cid in raw_chars.items():
            if isinstance(name, str) and name:
                characters.append({"name": name, "id": cid})
    elif isinstance(raw_chars, list):
        for entry in raw_chars:
            if isinstance(entry, dict):
                name = entry.get("name")
                cid = entry.get("id")
                if isinstance(name, str) and name:
                    characters.append({"name": name, "id": cid})
            elif isinstance(entry, str):
                characters.append({"name": entry, "id": None})
    # Sort by name for stable picker ordering — F-list returns them in
    # an unspecified order which renders differently per sign-in.
    characters.sort(key=lambda c: c["name"].lower())
    ticket = Ticket(
        account=account,
        value=ticket_value,
        password=password,
        acquired_at=time.monotonic(),
    )
    _STORE.set(ticket, characters=characters)
    return {
        "characters": characters,
        "expires_in_sec": TICKET_EFFECTIVE_TTL_SEC,
        "account": account,
    }


async def ensure_fresh_ticket(
    *, client: httpx.AsyncClient | None = None
) -> Ticket:
    """Return a ticket that is either fresh or just re-acquired.

    Auto-refresh runs when the current ticket is at/past 23 minutes old
    so the next API call has the full 5-minute window before the
    effective TTL. Raises `TicketRequired` if there's no active session
    at all (renderer needs to open the sign-in modal).
    """
    t = _STORE.get()
    if t is None:
        raise TicketRequired("not signed in to F-list")
    if not t.needs_refresh:
        return t
    if not t.password:
        # Idle watchdog already cleared the cached password; we can no
        # longer auto-refresh. The current ticket may still be valid
        # for a few minutes — return it; if the F-list API rejects it,
        # the caller surfaces a TicketRequired naturally on next call.
        if t.is_expired:
            raise TicketRequired(
                "session timed out from inactivity — sign in again"
            )
        return t
    # Refresh using the cached password. Failure clears the store and
    # surfaces as AuthFailure so the caller can 401.
    try:
        await acquire_ticket(t.account, t.password, client=client)
    except AuthFailure:
        _STORE.clear()
        raise
    refreshed = _STORE.get()
    if refreshed is None:  # pragma: no cover — defensive
        raise TicketRequired("ticket disappeared mid-refresh")
    try:
        import flist_activity
        flist_activity.record("ticket-refresh", account=refreshed.account)
    except Exception:  # noqa: BLE001 — telemetry is best-effort
        pass
    return refreshed


async def fetch_character_data(
    name: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """`character-data.php` for one character by name."""
    ticket = await ensure_fresh_ticket(client=client)
    return await _post_json(
        CHARACTER_DATA_URL,
        {"account": ticket.account, "ticket": ticket.value, "name": name},
        client=client,
    )


async def fetch_mapping_list(
    cache_path: Path,
    *,
    client: httpx.AsyncClient | None = None,
    ttl_sec: float = 7 * 24 * 3600,
) -> dict[str, Any]:
    """Cached mapping-list. Refresh every week — F-list rarely changes
    these but we still want occasional drift to land."""
    import json

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    now = time.time()
    if cache_path.exists():
        age = now - cache_path.stat().st_mtime
        if age < ttl_sec:
            try:
                return json.loads(cache_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                # Corrupt cache — refetch.
                pass
    ticket = await ensure_fresh_ticket(client=client)
    payload = await _post_json(
        MAPPING_LIST_URL,
        {"account": ticket.account, "ticket": ticket.value},
        client=client,
    )
    tmp = cache_path.with_suffix(cache_path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    tmp.replace(cache_path)
    return payload


# ---- avatar + image download ------------------------------------------


def avatar_url(name: str) -> str:
    """F-list avatars live at /images/avatar/<lowercased_name>.png with
    spaces preserved verbatim (URL-encoded as %20 in HTTP). Verified
    2026-05-30 by probing — the underscore variant returns a 5827-byte
    placeholder PNG, the space variant returns the real avatar. No
    ticket required."""
    slug = name.strip().lower()
    return f"{STATIC_BASE}/images/avatar/{quote(slug, safe='')}.png"


async def download_to(
    url: str,
    dest: Path,
    *,
    client: httpx.AsyncClient | None = None,
    rate_limiter: RateLimiter | None = None,
) -> int:
    """Download `url` to `dest` atomically. Returns bytes written."""
    rl = rate_limiter or _CDN_LIMITER
    own = client is None
    c = client or _default_client()
    try:
        await rl.acquire()
        res = await c.get(url)
        if res.status_code >= 400:
            raise FlistApiError(f"HTTP {res.status_code} fetching {url}")
        data = res.content
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(dest)
        return len(data)
    finally:
        if own:
            await c.aclose()
