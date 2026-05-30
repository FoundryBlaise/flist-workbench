"""Sidecar flist_api tests.

Live HTTP is mocked via pytest-httpx so the suite runs offline. The
ticket-response fixture is the redacted shape F-list actually returns
for `getApiTicket.php?new_character_list=true` — captured 2026-05-30
to lock in the dict-keyed-by-name shape we got wrong on first attempt.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

import flist_api

FIXTURES = Path(__file__).parent / "fixtures"


def _ticket_response() -> dict:
    return json.loads(
        (FIXTURES / "get_api_ticket_response.json").read_text(encoding="utf-8")
    )


@pytest.fixture(autouse=True)
def reset_store():
    flist_api.ticket_store().clear()
    yield
    flist_api.ticket_store().clear()


def test_ticket_expiry_boundaries():
    t = flist_api.Ticket(
        account="acct", value="v", password="p", acquired_at=time.monotonic()
    )
    assert not t.is_expired
    assert not t.needs_refresh
    # Reach into acquired_at to fast-forward past the 23-min refresh
    # boundary without sleeping; both flags should flip on/off as
    # expected at the policy thresholds.
    t.acquired_at = time.monotonic() - (24 * 60)
    assert t.needs_refresh
    assert not t.is_expired
    t.acquired_at = time.monotonic() - (29 * 60)
    assert t.is_expired


def test_ticket_repr_redacts_secrets():
    t = flist_api.Ticket(
        account="acct", value="SECRET-TICKET", password="SECRET-PASS", acquired_at=0.0
    )
    s = repr(t)
    assert "SECRET-TICKET" not in s
    assert "SECRET-PASS" not in s
    assert "acct" in s
    assert "redacted" in s.lower()


def test_avatar_url_preserves_spaces():
    # F-list serves avatars at /images/avatar/<lowercased>.png with
    # literal spaces (URL-encoded as %20). The underscore variant
    # returns a placeholder PNG, not the real avatar.
    url = flist_api.avatar_url("Lady Amber Blaise")
    assert url.endswith("/images/avatar/lady%20amber%20blaise.png")


@pytest.mark.asyncio
async def test_acquire_ticket_parses_dict_character_list(httpx_mock):
    """The shape F-list actually returns for new_character_list=true:
    `characters` is a dict mapping name → id, not the list-of-objects
    the wiki suggested."""
    httpx_mock.add_response(
        url=flist_api.TICKET_URL,
        method="POST",
        json=_ticket_response(),
    )
    result = await flist_api.acquire_ticket("acct", "pw")
    names = [c["name"] for c in result["characters"]]
    assert names == ["Solo Name", "Test Character One", "Test Character Two"]
    ids = {c["name"]: c["id"] for c in result["characters"]}
    assert ids["Test Character One"] == 1000001
    assert ids["Solo Name"] == 1000003
    # Store should hold the same characters for /flist/characters to read.
    stored = flist_api.ticket_store().characters()
    assert [c["name"] for c in stored] == names


@pytest.mark.asyncio
async def test_acquire_ticket_tolerates_legacy_list_shape(httpx_mock):
    """If F-list ever flips the response back to a list-of-objects or
    a list-of-strings, the parser shouldn't silently produce zero
    entries — that was the original Tier 1 bug."""
    httpx_mock.add_response(
        url=flist_api.TICKET_URL,
        method="POST",
        json={
            "ticket": "T",
            "characters": [
                {"name": "Object Form", "id": 42},
                "Bare String Form",
            ],
            "error": "",
        },
    )
    result = await flist_api.acquire_ticket("acct", "pw")
    names = [c["name"] for c in result["characters"]]
    assert "Object Form" in names
    assert "Bare String Form" in names


@pytest.mark.asyncio
async def test_acquire_ticket_auth_failure_raises(httpx_mock):
    httpx_mock.add_response(
        url=flist_api.TICKET_URL,
        method="POST",
        json={"ticket": "", "error": "Invalid account name or password."},
    )
    with pytest.raises(flist_api.AuthFailure) as excinfo:
        await flist_api.acquire_ticket("acct", "wrong")
    # F-list's verbatim error string passes through — per Tier 1 decision
    # we don't paraphrase auth errors.
    assert "Invalid account name or password." in str(excinfo.value)


@pytest.mark.asyncio
async def test_ensure_fresh_ticket_refreshes_near_expiry(httpx_mock):
    # First sign-in puts a ticket in the store. Then we age it past
    # the 23-min refresh threshold; the next ensure_fresh_ticket call
    # should silently re-acquire using the cached password.
    httpx_mock.add_response(
        url=flist_api.TICKET_URL,
        method="POST",
        json=_ticket_response(),
    )
    await flist_api.acquire_ticket("acct", "pw")
    aged = flist_api.ticket_store().get()
    assert aged is not None
    aged.acquired_at = time.monotonic() - (24 * 60)
    # Second response for the refresh round-trip.
    httpx_mock.add_response(
        url=flist_api.TICKET_URL,
        method="POST",
        json=_ticket_response(),
    )
    refreshed = await flist_api.ensure_fresh_ticket()
    assert not refreshed.needs_refresh
    assert refreshed.account == "acct"


@pytest.mark.asyncio
async def test_ensure_fresh_ticket_no_session_raises():
    with pytest.raises(flist_api.TicketRequired):
        await flist_api.ensure_fresh_ticket()


def test_idle_password_clear_dropped_when_no_touch():
    # Sign-in seeds the touched timestamp. Roll the clock back past the
    # threshold without touching — the watchdog should clear password,
    # leave the ticket value intact, and report password_cached=False.
    store = flist_api.ticket_store()
    store.set(
        flist_api.Ticket(
            account="acct", value="t", password="pw", acquired_at=time.monotonic()
        )
    )
    assert store.has_password()
    # Force last_touched into the past so idle_seconds > threshold.
    store._last_touched = time.monotonic() - 1200
    dropped = store.clear_password_if_idle(threshold_sec=600)
    assert dropped is True
    assert not store.has_password()
    # Ticket survived — auto-refresh disabled but session still usable
    # until natural TTL.
    t = store.get()
    assert t is not None
    assert t.value == "t"
    assert t.account == "acct"


def test_idle_password_clear_noop_when_recent():
    store = flist_api.ticket_store()
    store.set(
        flist_api.Ticket(
            account="acct", value="t", password="pw", acquired_at=time.monotonic()
        )
    )
    # Just touched — shouldn't drop.
    assert store.clear_password_if_idle(threshold_sec=600) is False
    assert store.has_password()


def test_touch_resets_idle_after_clear_signin():
    store = flist_api.ticket_store()
    store.set(
        flist_api.Ticket(
            account="acct", value="t", password="pw", acquired_at=time.monotonic()
        )
    )
    store._last_touched = time.monotonic() - 1200
    # A user action (the middleware would have called touch()) resets
    # the timer — next idle check must not clear.
    store.touch()
    assert store.idle_seconds() < 1.0
    assert store.clear_password_if_idle(threshold_sec=600) is False


@pytest.mark.asyncio
async def test_ensure_fresh_ticket_no_password_returns_existing_until_expiry():
    # After idle watchdog clears the password, ensure_fresh_ticket should
    # NOT crash — it should return the ticket if still valid and raise
    # TicketRequired only once the ticket itself expires.
    store = flist_api.ticket_store()
    store.set(
        flist_api.Ticket(
            account="acct",
            value="t",
            password="",
            acquired_at=time.monotonic() - (24 * 60),  # past refresh threshold
        )
    )
    t = await flist_api.ensure_fresh_ticket()
    assert t.value == "t"
    # Now expire the ticket too.
    aged = store.get()
    assert aged is not None
    aged.acquired_at = time.monotonic() - (40 * 60)  # past TTL
    with pytest.raises(flist_api.TicketRequired):
        await flist_api.ensure_fresh_ticket()


def test_rate_limiter_hourly_cap():
    rl = flist_api.RateLimiter(per_second=1_000.0, per_hour_cap=3)
    # Pre-populate three calls in the rolling window; the next acquire
    # should raise rather than burst past the cap.
    now = time.monotonic()
    rl._hourly_calls.extend([now, now, now])
    import asyncio

    async def _try():
        await rl.acquire()

    with pytest.raises(flist_api.RateLimited):
        asyncio.run(_try())
