"""The bulk backup sweep: pull every character, ZIP what changed.

Lifted out of the `/flist/backup-all` route so the MCP
`backup_all_characters` tool runs the same sweep rather than a second
implementation of it. Like `services/pull.py`, `run()` yields
`(event, data)` pairs and each surface decides how to frame them.

The sweep is deliberately conservative with F-list's API: characters
are pulled one at a time under the same lock as a single pull, and a
character whose content hasn't changed since its last backup is
skipped rather than re-zipped.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from starlette.concurrency import run_in_threadpool

import aliases as aliases_store  # noqa: F401  (kept for parity with server)
import archive_backups
import archive_images
import archive_live
import backup_origin
import flist_activity
import flist_api
import zip_serialise

from . import sse
from . import pull as pull_service

#: Event names `run()` can yield. `error` is fatal and ends the sweep;
#: a per-character failure comes through as a `character` event with
#: `status: "error"` and the sweep continues.
EVENTS = (
    "start",      # {total}
    "queued",     # waiting on the pull lock
    "character",  # {name, status, filename?, message?, image_stats?}
    "done",       # {total, saved, unchanged, failed}
    "error",      # fatal: no session, expired ticket, ... `sse.error`
)


async def _pull_one_character_for_backup_all(
    name: str,
    *,
    client: Any,
) -> dict[str, Any]:
    """Single-character full pull (JSON + avatar + all gallery images)
    used by `/flist/backup-all`. Returns the resolved character id +
    a summary so the caller can log image stats; raises the underlying
    F-list errors so the bulk loop can decide whether to abort.

    Distinct from the per-character `/pull` endpoint's producer in
    that it doesn't emit SSE events — the bulk sweep streams a single
    coarse `character` event per character instead of per-image
    progress. (The full pull is still needed so the ZIP that follows
    can include every image the user has on F-list.)
    """
    payload = await flist_api.fetch_character_data(name, client=client)
    cid = pull_service.character_id_from_payload(payload)
    import time as _t

    live_payload = dict(payload)
    live_payload["fetched_at"] = int(_t.time())
    # Disk steps run in the threadpool, as the Pull's do: they wait for
    # the character's lock, and the event loop serves everyone else.
    await run_in_threadpool(archive_live.write_live, cid, live_payload)

    # Avatar — non-fatal.
    try:
        await flist_api.download_to(
            flist_api.avatar_url(name),
            archive_images.avatar_path_for(name),
            client=client,
        )
    except (flist_api.FlistApiError, ValueError):
        pass

    images = payload.get("images")
    image_list: list[dict[str, str]] = []
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

    pull_started_at = int(_t.time())
    await run_in_threadpool(
        archive_images.write_pull_state,
        cid,
        image_list,
        started_at=pull_started_at,
        finished_at=None,
    )

    downloaded = 0
    cached = 0
    failed_images = 0
    for img in image_list:
        image_id = img["image_id"]
        raw_ext = img["extension"]
        try:
            ext = archive_images.normalise_image_ext(raw_ext)
        except ValueError:
            ext = raw_ext.lower().lstrip(".")
        # Stale-ext cleanup is the per-character Pull's: the old file
        # goes to the Trash.
        if await run_in_threadpool(
            pull_service.clear_stale_siblings, cid, image_id, f"{image_id}.{ext}"
        ):
            cached += 1
            continue
        url = (
            f"{flist_api.STATIC_BASE}/images/charimage/"
            f"{image_id}.{ext}"
        )
        try:
            data = await flist_api.fetch_bytes(url, client=client)
            await run_in_threadpool(
                archive_images.write_character_image, cid, image_id, ext, data
            )
            downloaded += 1
        except (ValueError, flist_api.FlistApiError):
            failed_images += 1

    await run_in_threadpool(
        archive_images.write_pull_state,
        cid,
        image_list,
        started_at=pull_started_at,
        finished_at=int(_t.time()),
    )
    return {
        "character_id": cid,
        "total_images": len(image_list),
        "downloaded": downloaded,
        "cached": cached,
        "failed_images": failed_images,
    }


async def run() -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Back up every character on the signed-in account: pull it, then
    keep its Live as a Backup recorded as `source: live, occasion:
    backup-all` (kind `manual_bulk` for the extension). A character
    whose Live matches its newest Backup of Live is left as it is.
    """

    store = flist_api.ticket_store()
    roster = store.characters()
    if not roster:
        yield sse.error(
            "session", "not_signed_in", "not signed in to F-list — sign in first"
        )
        return

    yield ("start", {"total": len(roster)})
    saved = 0
    unchanged = 0
    failed = 0

    # `queued` mirrors the per-character pull protocol — if a
    # second window's backup-all (or a long ↻ Refresh) is already
    # holding pull_lock, the renderer's banner should reflect the
    # wait instead of looking frozen on `(0/N)`.
    yield ("queued", {})

    # One client for the entire sweep so we reuse the connection
    # pool. pull_lock makes individual per-character pulls
    # serialise behind this loop and vice versa.
    client = flist_api._default_client()
    unexpected: BaseException | None = None
    try:
        async with flist_api.pull_lock():
            try:
                await flist_api.ensure_fresh_ticket(client=client)
            except (flist_api.TicketRequired, flist_api.AuthFailure) as exc:
                yield sse.refused("ticket", flist_api.refusal(exc))
                return

            for entry in roster:
                # `characters()` returns plain dicts with name/id
                # keys (the F-list account-characters wire shape),
                # not dataclasses — attribute access would raise
                # AttributeError and silently end the stream.
                name = entry.get("name") if isinstance(entry, dict) else None
                if not isinstance(name, str) or not name:
                    continue
                yield (
                    "character",
                    {"name": name, "status": "fetching"},
                )
                try:
                    pull_result = await _pull_one_character_for_backup_all(
                        name, client=client
                    )
                except (
                    flist_api.TicketRequired,
                    flist_api.AuthFailure,
                    flist_api.RateLimited,
                ) as exc:
                    # Session-wide failure mid-sweep — pointless to
                    # keep iterating because every remaining char
                    # would hit the same wall. Emit a fatal error
                    # and abort.
                    stage = (
                        "rate-limited"
                        if isinstance(exc, flist_api.RateLimited)
                        else "ticket"
                    )
                    yield sse.refused(stage, flist_api.refusal(exc))
                    return
                except flist_api.FlistApiError as exc:
                    failed += 1
                    yield (
                        "character",
                        {
                            "name": name,
                            "status": "error",
                            "message": str(exc),
                        },
                    )
                    continue
                except pull_service.UnsafeCharacterId as exc:
                    # A bad upstream id — recoverable for this one
                    # character; the sweep carries on with the rest.
                    failed += 1
                    yield (
                        "character",
                        {
                            "name": name,
                            "status": "error",
                            "message": str(exc),
                        },
                    )
                    continue
                except OSError as exc:
                    failed += 1
                    yield (
                        "character",
                        {
                            "name": name,
                            "status": "error",
                            "message": f"disk: {exc}",
                        },
                    )
                    continue

                cid = pull_result["character_id"]
                image_stats = {
                    "total": pull_result["total_images"],
                    "downloaded": pull_result["downloaded"],
                    "cached": pull_result["cached"],
                    "failed": pull_result["failed_images"],
                }
                try:
                    # Live, as just pulled: Back up all keeps what was on
                    # F-list, whatever the Workbench holds.
                    # In the threadpool: it repairs the gallery and
                    # builds the zip under the character's lock.
                    result = await run_in_threadpool(
                        archive_backups.save_zip_backup,
                        cid,
                        source=backup_origin.LIVE,
                        occasion=backup_origin.BACKUP_ALL,
                        force=False,
                    )
                except OSError as exc:
                    failed += 1
                    yield (
                        "character",
                        {
                            "name": name,
                            "character_id": cid,
                            "status": "error",
                            "message": f"zip: {exc}",
                            "image_stats": image_stats,
                        },
                    )
                    continue

                if result.get("saved"):
                    saved += 1
                    yield (
                        "character",
                        {
                            "name": name,
                            "character_id": cid,
                            "status": "saved",
                            "filename": result.get("filename"),
                            "size": result.get("size"),
                            "image_stats": image_stats,
                        },
                    )
                else:
                    unchanged += 1
                    yield (
                        "character",
                        {
                            "name": name,
                            "character_id": cid,
                            "status": "unchanged",
                            "image_stats": image_stats,
                        },
                    )
    except Exception as exc:  # noqa: BLE001 — last-resort
        # Defensive: an unhandled error inside the producer would
        # otherwise let the SSE stream end without a terminal
        # event, leaving the renderer's banner stuck on phase=
        # 'running' forever. Surface anything we missed.
        unexpected = exc
    finally:
        await client.aclose()

    if unexpected is not None:
        yield sse.error("unknown", sse.INTERNAL_ERROR, repr(unexpected))
        return

    yield (
        "done",
        {
            "total": len(roster),
            "saved": saved,
            "unchanged": unchanged,
            "failed": failed,
        },
    )

