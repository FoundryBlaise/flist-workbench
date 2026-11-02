"""Idle password watchdog.

When set to >0, drops the cached F-list password from RAM after that
many seconds of no user-initiated /flist/* activity (ticket itself
stays until natural expiry). When 0 (the default), the password lives
in RAM for the lifetime of the sidecar process so the 23-min
auto-refresh keeps signing the user in transparently — F-list tickets
last 30 min, and forcing a manual re-sign every half hour breaks any
long working session.

The original 10-min default was a defensive "forgotten window
overnight" measure, but once the user opts into keychain-backed saved
credentials the password is already durable on disk, so dropping it
from RAM no longer changes the threat model — it just guarantees the
next pull/refresh fails with "invalid ticket". Users on shared
workstations can re-enable by setting
FLIST_WORKBENCH_PASSWORD_IDLE_SEC=600 (or any positive value).
"""

import asyncio
import os

import flist_activity
import flist_api

IDLE_PASSWORD_TIMEOUT_SEC = int(
    os.environ.get("FLIST_WORKBENCH_PASSWORD_IDLE_SEC", "0")
)
_PASSWORD_WATCHDOG_INTERVAL_SEC = 60


async def start_watchdog() -> None:
    """Periodically drop the cached F-list password after idle. Disabled
    when IDLE_PASSWORD_TIMEOUT_SEC is 0 (the default) — the password is
    needed in RAM for the 23-min ticket auto-refresh, and the keychain
    already provides cross-launch persistence."""
    if IDLE_PASSWORD_TIMEOUT_SEC <= 0:
        print(
            "[flist] password idle watchdog disabled "
            "(FLIST_WORKBENCH_PASSWORD_IDLE_SEC=0); "
            "ticket auto-refresh stays armed for the session lifetime",
            flush=True,
        )
        return

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
