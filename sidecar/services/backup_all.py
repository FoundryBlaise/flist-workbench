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

import aliases as aliases_store  # noqa: F401  (kept for parity with server)
import character_archive
import flist_activity
import flist_api
import settings as settings_store
import zip_serialise

from . import pull as pull_service

#: Event names `run()` can yield. `error` is fatal and ends the sweep;
#: a per-character failure comes through as a `character` event with
#: `status: "error"` and the sweep continues.
EVENTS = (
    "start",      # {total}
    "queued",     # waiting on the pull lock
    "character",  # {name, status, filename?, message?, image_stats?}
    "done",       # {total, saved, unchanged, failed}
    "error",      # fatal: no session, expired ticket, ...
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
    character_archive.write_live(cid, live_payload)
    # Auto-snapshot the JSON (cheap, separate from the ZIP).
    try:
        character_archive.save_snapshot_if_changed(cid)
    except OSError:
        pass

    # Avatar — non-fatal.
    try:
        await flist_api.download_to(
            flist_api.avatar_url(name),
            character_archive.avatar_path_for(name),
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
    character_archive.write_pull_state(
        cid, image_list, started_at=pull_started_at, finished_at=None
    )

    images_dir_path = character_archive.images_dir(cid)
    downloaded = 0
    cached = 0
    failed_images = 0
    for img in image_list:
        image_id = img["image_id"]
        raw_ext = img["extension"]
        try:
            ext = character_archive.normalise_image_ext(raw_ext)
        except ValueError:
            ext = raw_ext.lower().lstrip(".")
        target = images_dir_path / f"{image_id}.{ext}"
        # Stale-ext cleanup mirrors the per-character pull endpoint.
        for sibling in images_dir_path.glob(f"{image_id}.*"):
            if sibling.name == target.name:
                continue
            if sibling.suffix.lstrip(".").lower() not in {"png", "jpg", "jpeg", "gif"}:
                continue
            try:
                sibling.unlink()
            except OSError:
                pass
        if target.exists():
            cached += 1
            continue
        url = (
            f"{flist_api.STATIC_BASE}/images/charimage/"
            f"{image_id}.{ext}"
        )
        try:
            data = await flist_api.fetch_bytes(url, client=client)
            character_archive.write_character_image(cid, image_id, ext, data)
            downloaded += 1
        except (ValueError, flist_api.FlistApiError):
            failed_images += 1

    character_archive.write_pull_state(
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


def _record_scheduled_sweep_telemetry(
    *,
    started_at: int,
    finished_at: int,
    written: int,
    skipped: int,
    failed: int,
    source: str,
) -> None:
    """Persist the last-sweep summary so Settings → Backups can show
    'Last ran' + compute the next due date. Called by /flist/backup-all
    after a kind='scheduled' run completes.

    `source` is `'post_login'` (renderer's auto-fire after F-list
    sign-in detects the interval has elapsed) or `'manual'` (user
    pressed the Trigger button in Settings)."""
    conn = settings_store.connect()
    try:
        settings_store.set_value(
            conn,
            settings_store.KEY_BACKUPS_LAST_SWEEP_STARTED_AT,
            str(started_at),
        )
        settings_store.set_value(
            conn,
            settings_store.KEY_BACKUPS_LAST_SWEEP_FINISHED_AT,
            str(finished_at),
        )
        settings_store.set_value(
            conn,
            settings_store.KEY_BACKUPS_LAST_SWEEP_WRITTEN,
            str(written),
        )
        settings_store.set_value(
            conn,
            settings_store.KEY_BACKUPS_LAST_SWEEP_SKIPPED,
            str(skipped),
        )
        settings_store.set_value(
            conn,
            settings_store.KEY_BACKUPS_LAST_SWEEP_FAILED,
            str(failed),
        )
        settings_store.set_value(
            conn,
            settings_store.KEY_BACKUPS_LAST_SWEEP_SOURCE,
            source,
        )
    finally:
        conn.close()


async def run(
    kind: str = "manual_bulk", source: str = "manual"
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Back up every character on the signed-in account.

    `kind` tags each ZIP's backup-meta.json so the sidebar can bucket
    them: `manual_bulk` (Tools → Back up all) or `scheduled` (the
    post-sign-in sweep). A scheduled run also records sweep telemetry
    so Settings → Backups can show when it last ran.
    """
    import time as _time

    backup_kind = (
        kind if kind in ("manual_bulk", "scheduled") else "manual_bulk"
    )
    telemetry_source = (
        source if source in ("manual", "post_login") else "manual"
    )
    started_at = int(_time.time())


    store = flist_api.ticket_store()
    roster = store.characters()
    if not roster:
        yield (
            "error",
            {
                "stage": "session",
                "message": "not signed in to F-list — sign in first",
            },
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
                yield (
                    "error",
                    {"stage": "ticket", "message": str(exc)},
                )
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
                    yield (
                        "error",
                        {"stage": stage, "message": str(exc)},
                    )
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
                    result = character_archive.save_zip_backup(
                        cid, force=False, kind=backup_kind
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
        yield (
            "error",
            {"stage": "unknown", "message": repr(unexpected)},
        )
        return

    # Record sweep telemetry for kind=='scheduled' so Settings →
    # Backups can show 'Last ran' and compute the next due date.
    # Note this fires from the renderer's post-sign-in nudge (or
    # the Trigger button), so the next-due clock is anchored to
    # the time of the actual fresh-data sweep, not to some
    # cached-data lifespan event from sidecar boot.
    if backup_kind == "scheduled":
        try:
            _record_scheduled_sweep_telemetry(
                started_at=started_at,
                finished_at=int(_time.time()),
                written=saved,
                skipped=unchanged,
                failed=failed,
                source=telemetry_source,
            )
        except Exception as exc:  # noqa: BLE001
            print(
                f"[backups] failed to record sweep telemetry: {exc!r}",
                flush=True,
            )

    yield (
        "done",
        {
            "total": len(roster),
            "saved": saved,
            "unchanged": unchanged,
            "failed": failed,
        },
    )

