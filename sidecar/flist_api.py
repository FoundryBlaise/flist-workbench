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
import weakref
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

# A model driving the foreign-profile viewer over MCP shares the same
# 200/hour ceiling as the user's own pulls, and a model that decides to
# walk someone's friend list can empty it in three minutes. It gets a
# quarter of the budget: enough to look things up, not enough to leave
# the user unable to pull their own character.
MCP_HOURLY_SHARE = 0.25
MCP_PER_HOUR = int(HARD_PER_HOUR * MCP_HOURLY_SHARE)


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

# The foreign-profile viewer loads a gallery the way a chat client
# does, and the prior art is unambiguous about what that costs.
# F-Chat 3.0 renders a character's gallery as plain <img> tags with no
# pacing whatsoever (site/character_page/images.vue), and Horizon
# throttles only the JSON API — `throat(2)` in chat/profile_api.ts, a
# *concurrency* cap of two on character-data.php — while never
# touching CDN images at all. Nobody rate-limits static.f-list.net,
# because the developer policy's budget is about the API.
#
# So the viewer is not paced per second. It is capped on concurrency,
# which is the shape Horizon uses and the shape a browser would have
# imposed by itself. Workbench only needs a cap at all because its
# images go through the sidecar to be cached on disk: that turns what
# a browser would run as six parallel connections into a queue behind
# one gate, and without a cap a fifty-image profile would open fifty
# sockets at once.
#
# The 2/s lane above stays where it belongs — on the *sweep* paths
# (a pull, the backup-all run walking forty characters), where nothing
# is waiting on any single image and being a good neighbour costs the
# user nothing.
FOREIGN_IMAGE_CONCURRENCY = 8

#: Effectively no pacing: the foreign image gate below does the
#: limiting, and `download_to` insists on some limiter or other.
_UNPACED_LIMITER = RateLimiter(per_second=1000.0, per_hour_cap=10_000_000)

#: One semaphore per event loop. asyncio primitives bind to the loop
#: that first awaits them, and the test suite runs a fresh loop per
#: case; a single module-level semaphore would be bound to a dead one.
#: Loops are weak-referenceable, so finished loops drop out by
#: themselves.
_FOREIGN_IMAGE_GATES: "weakref.WeakKeyDictionary[Any, asyncio.Semaphore]" = (
    weakref.WeakKeyDictionary()
)


def unpaced_limiter() -> RateLimiter:
    return _UNPACED_LIMITER


def foreign_image_gate() -> asyncio.Semaphore:
    """Concurrency cap for foreign gallery downloads."""
    loop = asyncio.get_event_loop()
    gate = _FOREIGN_IMAGE_GATES.get(loop)
    if gate is None:
        gate = asyncio.Semaphore(FOREIGN_IMAGE_CONCURRENCY)
        _FOREIGN_IMAGE_GATES[loop] = gate
    return gate


#: A long-lived, pooled client for the viewer's gallery fetches.
#:
#: `download_to` builds a throwaway `AsyncClient` when it is handed
#: none, which means a fresh TCP connection and a fresh TLS handshake
#: for every single image. That is fine for a pull, where the 2/s
#: pacing dominates anyway — and ruinous for a gallery the user is
#: watching fill: measured against static.f-list.net, twelve images
#: took 3.5 s with a client each and 0.73 s through one pooled client,
#: a 4.8x difference that is almost entirely handshakes. Keeping the
#: connections alive is what a browser does, and it is why the same
#: gallery feels instant in a chat client.
_FOREIGN_CDN_CLIENTS: "weakref.WeakKeyDictionary[Any, httpx.AsyncClient]" = (
    weakref.WeakKeyDictionary()
)


def foreign_cdn_client() -> httpx.AsyncClient:
    """The pooled client for foreign gallery images.

    Per event loop, like the gate above, because an httpx client binds
    its connection pool to the loop that first used it. Never closed:
    it lives as long as the sidecar, which is the point.
    """
    loop = asyncio.get_event_loop()
    client = _FOREIGN_CDN_CLIENTS.get(loop)
    if client is None or client.is_closed:
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=10.0),
            headers={"User-Agent": USER_AGENT},
            follow_redirects=True,
            limits=httpx.Limits(
                max_connections=FOREIGN_IMAGE_CONCURRENCY,
                max_keepalive_connections=FOREIGN_IMAGE_CONCURRENCY,
            ),
        )
        _FOREIGN_CDN_CLIENTS[loop] = client
    return client


def api_rate_limiter() -> RateLimiter:
    return _LIMITER


def cdn_rate_limiter() -> RateLimiter:
    return _CDN_LIMITER


@dataclass
class HourlyBudget:
    """A rolling 1-hour counter with no pacing of its own.

    Sits *in front of* the shared `RateLimiter` rather than beside it:
    a second limiter would impose a second per-second sleep and pace
    MCP calls at half speed for no reason. This only answers "has this
    caller had its share this hour", and the real limiter still does
    the pacing and still enforces the hard 200.
    """

    cap: int
    label: str = "caller"
    _calls: list[float] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def _prune(self, now: float) -> None:
        cutoff = now - 3600.0
        while self._calls and self._calls[0] < cutoff:
            self._calls.pop(0)

    def charge(self) -> None:
        """Record one call, or raise `RateLimited` if the share is
        spent. Callers charge *before* the request so a burst of
        concurrent calls can't all pass the check."""
        with self._lock:
            now = time.monotonic()
            self._prune(now)
            if len(self._calls) >= self.cap:
                raise RateLimited(
                    f"{self.label} has used its hourly share of the F-list "
                    f"API ({self.cap} requests). The Workbench window is "
                    "not affected; this budget refills as the hour rolls on."
                )
            self._calls.append(now)

    def refund(self) -> None:
        """Give back the most recent charge — for a call that never
        reached F-list (a cache hit decided late, a validation error)."""
        with self._lock:
            if self._calls:
                self._calls.pop()

    def remaining(self) -> int:
        with self._lock:
            self._prune(time.monotonic())
            return max(0, self.cap - len(self._calls))


_MCP_CHARACTER_BUDGET = HourlyBudget(cap=MCP_PER_HOUR, label="MCP")


def mcp_character_budget() -> HourlyBudget:
    """The share of `character-data.php` calls an MCP client may spend
    per hour. The Workbench window charges nothing against it."""
    return _MCP_CHARACTER_BUDGET


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


def _social_names(raw: Any, keys: tuple[str, ...]) -> list[str]:
    """Pull character names out of one of `getApiTicket.php`'s social
    lists. Tries `keys` in order on each row and accepts a bare string
    too — the endpoint has changed these shapes before (see the
    `new_character_list` note above) and a viewer that silently shows
    an empty list is worse than one that copes."""
    out: list[str] = []
    seen: set[str] = set()
    rows: list[Any]
    if isinstance(raw, list):
        rows = raw
    elif isinstance(raw, dict):
        rows = list(raw.values())
    else:
        return out
    for row in rows:
        name: Any = None
        if isinstance(row, str):
            name = row
        elif isinstance(row, dict):
            for key in keys:
                if isinstance(row.get(key), str) and row[key].strip():
                    name = row[key]
                    break
        if not isinstance(name, str):
            continue
        name = name.strip()
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        out.append(name)
    out.sort(key=str.lower)
    return out


async def fetch_social_lists(
    *,
    client: httpx.AsyncClient | None = None,
) -> dict[str, list[str]]:
    """The signed-in account's bookmarks and friends.

    F-list has no standalone endpoint for these — they ride along on
    `getApiTicket.php`, which the sign-in path deliberately asks to
    leave them off (`no_friends` / `no_bookmarks`) because nothing
    needed them and they make every ticket refresh heavier. The
    foreign-profile viewer needs them, so it mints one ticket that
    carries them and skips the character list instead.

    The fresh ticket replaces the stored one rather than being thrown
    away: it is strictly newer, and if F-list ever invalidates older
    tickets on issue, keeping the newest is the safe direction. The
    cached character list is left alone — `no_characters` means this
    response has none, and `set(characters=None)` preserves it.

    Costs one call against the hourly API budget.
    """
    store = ticket_store()
    current = store.get()
    if current is None or not current.password:
        raise TicketRequired(
            "No F-list session with a cached password — sign in again "
            "to read your bookmarks and friends."
        )
    payload = await _post_json(
        TICKET_URL,
        {
            "account": current.account,
            "password": current.password,
            "no_characters": "true",
        },
        client=client,
    )
    ticket_value = payload.get("ticket")
    if isinstance(ticket_value, str) and ticket_value:
        store.set(
            Ticket(
                account=current.account,
                value=ticket_value,
                password=current.password,
                acquired_at=time.monotonic(),
            )
        )
    bookmarks = _social_names(payload.get("bookmarks"), ("name", "character"))
    # A friendship row names both ends; the far end is the one the
    # user might want to look at. `source_name` is kept as a fallback
    # for a shape that only carries one side.
    friends = _social_names(
        payload.get("friends"), ("dest_name", "name", "source_name")
    )
    own = {c.get("name", "").lower() for c in store.characters()}
    friends = [f for f in friends if f.lower() not in own]
    return {"bookmarks": bookmarks, "friends": friends}


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
    force: bool = False,
) -> dict[str, Any]:
    """Cached mapping-list. Refresh every week — F-list rarely changes
    these but we still want occasional drift to land. `force=True` skips
    the TTL check; renderer uses it from the staleness chip ↻ and the
    Unknown-field "Refresh mapping list" CTA.

    Stale-cache fallback: F-list mapping data drifts very slowly (new
    kinks/infotags ship a few times a year at most), so once we've
    fetched a cache file the renderer should never have to wait on a
    fresh ticket to render the kink picker / diff. When a refresh would
    have run (force or TTL exceeded) and we can't get a ticket OR the
    F-list API errors out, fall back to whatever's on disk if anything
    is there — the picker stays usable, the staleness chip still shows
    `_fetched_at` so the user knows it's old. Force-refresh requested
    by the user only raises if there's no cached file to fall back on,
    so even an explicit refresh degrades gracefully into "stayed on the
    last known good copy"."""
    import json

    def _read_cache() -> dict[str, Any] | None:
        if not cache_path.exists():
            return None
        try:
            return json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    now = time.time()
    if not force and cache_path.exists():
        age = now - cache_path.stat().st_mtime
        if age < ttl_sec:
            cached = _read_cache()
            if cached is not None:
                return cached
    try:
        # mapping-list.php is a PUBLIC F-list endpoint (per the F-list
        # API wiki and the fact that it's just a static map of
        # infotag categories + kink ids → names). Passing
        # account/ticket here was a leftover from copying the
        # character-data.php call shape, but it was actively harmful:
        # KinksPane mounts before sign-in completes, fires
        # loadMapping, sidecar called ensure_fresh_ticket which
        # raised TicketRequired (no session yet) → mapping fetch
        # 401'd → empty kink picker. Calling without auth lets the
        # mapping load on first launch and stays in cache for a week.
        payload = await _post_json(MAPPING_LIST_URL, {}, client=client)
    except FlistApiError:
        cached = _read_cache()
        if cached is not None:
            return cached
        raise
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


async def fetch_bytes(
    url: str,
    *,
    client: httpx.AsyncClient | None = None,
    rate_limiter: RateLimiter | None = None,
) -> bytes:
    """Fetch `url` and return its raw bytes. Subject to the same CDN
    rate limiter as `download_to`; lets a caller hash/route the bytes
    in-memory before deciding where (or whether) to write."""
    rl = rate_limiter or _CDN_LIMITER
    own = client is None
    c = client or _default_client()
    try:
        await rl.acquire()
        res = await c.get(url)
        if res.status_code >= 400:
            raise FlistApiError(f"HTTP {res.status_code} fetching {url}")
        return res.content
    finally:
        if own:
            await c.aclose()
