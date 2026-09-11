"""Optional bearer token on the MCP endpoints.

Off by default, and that default is deliberate. The endpoints are
loopback-only and every other local process can already reach the REST
API unauthenticated, so a token adds nothing against an attacker who
is already running code as this user — it would be security theatre
that costs every client a config step.

It exists for the case where it does help: a shared machine, or a
sandboxed tool the user wants to keep out. The user switches it on in
Settings → MCP, copies the token into their client's headers, and can
revoke it.
"""

from __future__ import annotations

import hmac
import secrets

import settings as settings_store

#: Settings key holding the token. Absent or empty means no auth.
KEY_MCP_AUTH_TOKEN = "mcp.auth_token"


def current_token() -> str | None:
    """The configured token, or None when auth is off."""
    conn = settings_store.connect()
    try:
        value = settings_store.get(conn, KEY_MCP_AUTH_TOKEN)
    finally:
        conn.close()
    return value or None


def generate() -> str:
    """Issue a new token, replacing any existing one."""
    token = secrets.token_urlsafe(32)
    conn = settings_store.connect()
    try:
        settings_store.set_value(conn, KEY_MCP_AUTH_TOKEN, token)
    finally:
        conn.close()
    return token


def revoke() -> None:
    """Turn auth back off. Clients using the old token stop working."""
    conn = settings_store.connect()
    try:
        settings_store.clear(conn, KEY_MCP_AUTH_TOKEN)
    finally:
        conn.close()


def check(authorization: str | None) -> bool:
    """Whether a request may proceed.

    True when auth is off. Otherwise the `Authorization` header has to
    carry the token as a bearer. Compared with `compare_digest` so the
    check takes the same time regardless of how much of the token is
    right.
    """
    expected = current_token()
    if not expected:
        return True
    if not authorization:
        return False
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return False
    return hmac.compare_digest(value.strip(), expected)
