"""The bulk backup sweep: pull every character, ZIP what changed.

Lifted out of the `/flist/backup-all` route so the MCP
`backup_all_characters` tool runs the same sweep rather than a second
implementation of it. Like a Pull (`services/pull.py`) it runs as a job:
`start()` answers with it, and `run()` is its work, yielding `(event,
data)` pairs the job keeps for whoever follows.

The job holds every character (`pull.CHARACTERS`): one Back up all at a
time, and none while a Pull runs, nor a Pull while it runs.

The sweep is deliberately conservative with F-list's API: characters
are pulled one at a time, each with Pull's own steps, and a character
whose content hasn't changed since its last backup is skipped rather
than re-zipped.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from starlette.concurrency import run_in_threadpool

import archive_backups
import backup_origin
import flist_api
from refusals import INTERNAL_ERROR, CharacterBusy

from . import events, jobs, sse
from . import pull as pull_service

#: The job kind of Back up all.
KIND = "backup-all"

#: Event names `run()` can yield.
START = "start"  # {total}
CHARACTER = "character"  # {name, status, filename?, message?, image_stats?}

#: `jobs.DONE` carries {total, saved, unchanged, failed, characters}.
#: `jobs.ERROR` is fatal (no session, expired ticket, ... `sse.error`)
#: and ends the sweep; a per-character failure comes through as a
#: CHARACTER event with `status: "error"` and the sweep continues. The
#: job adds `jobs.CANCELLED` when a cancel stopped it.
EVENTS = (START, CHARACTER, jobs.DONE, jobs.ERROR)


def start() -> jobs.Job:
    """Start Back up all as a job. Raises `CharacterBusy` while another
    Back up all or any Pull runs."""
    return jobs.registry().start_stream(
        KIND,
        pull_service.CHARACTERS,
        run,
        busy=CharacterBusy,
        progress={"total": 0, "done": 0, "saved": 0, "unchanged": 0, "failed": 0},
        observe=_observe,
    )


def _observe(job: jobs.Job, event: str, data: dict[str, Any]) -> None:
    """Sum the sweep up in `job.progress`: characters done of how many,
    by outcome, and the one being pulled."""
    progress = dict(job.progress)
    if event == START:
        progress["total"] = data.get("total", 0)
    elif event == CHARACTER:
        status = data.get("status")
        if status == "fetching":
            progress["current"] = data.get("name")
        else:
            progress["done"] = progress.get("done", 0) + 1
            key = {"saved": "saved", "unchanged": "unchanged"}.get(str(status), "failed")
            progress[key] = progress.get(key, 0) + 1
            progress["current"] = None
    job.progress = progress


async def _pull_one(name: str, *, client: Any) -> dict[str, Any]:
    """Pull one character with Pull's own steps (Live, then images),
    without its per-image events: the sweep reports one `character`
    event per character. Raises the F-list errors so the sweep can
    decide whether to go on."""
    payload = await flist_api.fetch_character_data(name, client=client)
    cid, _changed = await pull_service.store_live(name, payload, client=client)
    images = pull_service.image_list(payload)
    counts = pull_service.ImageCounts()
    async for _item in pull_service.pull_images(cid, images, counts, client=client):
        pass
    return {
        "character_id": cid,
        "image_stats": {
            "total": len(images),
            "downloaded": counts.downloaded,
            "cached": counts.cached,
            "failed": counts.failed,
        },
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

    yield (START, {"total": len(roster)})
    rows: list[dict[str, Any]] = []

    def row(data: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        rows.append(data)
        return (CHARACTER, data)

    # One client for the entire sweep so we reuse the connection pool.
    client = flist_api._default_client()
    unexpected: BaseException | None = None
    try:
        try:
            await flist_api.ensure_fresh_ticket(client=client)
        except (flist_api.TicketRequired, flist_api.AuthFailure) as exc:
            yield sse.refused(pull_service.TICKET, flist_api.refusal(exc))
            return

        for entry in roster:
            # `characters()` returns plain dicts with name/id keys (the
            # F-list account-characters wire shape), not dataclasses —
            # attribute access would raise AttributeError and silently
            # end the stream.
            name = entry.get("name") if isinstance(entry, dict) else None
            if not isinstance(name, str) or not name:
                continue
            yield (CHARACTER, {"name": name, "status": "fetching"})
            try:
                # Announced per character as each Pull ends, not per
                # picture and not all at the end of the sweep.
                with events.coalesced():
                    pulled = await _pull_one(name, client=client)
            except (
                flist_api.TicketRequired,
                flist_api.AuthFailure,
                flist_api.RateLimited,
            ) as exc:
                # Session-wide failure mid-sweep — pointless to keep
                # iterating because every remaining char would hit the
                # same wall. Emit a fatal error and abort.
                stage = (
                    "rate-limited"
                    if isinstance(exc, flist_api.RateLimited)
                    else "ticket"
                )
                yield sse.refused(stage, flist_api.refusal(exc))
                return
            except (flist_api.FlistApiError, pull_service.UnsafeCharacterId) as exc:
                # This character only (a bad upstream id included); the
                # sweep carries on with the rest.
                yield row({"name": name, "status": "error", "message": str(exc)})
                continue
            except OSError as exc:
                yield row({"name": name, "status": "error", "message": f"disk: {exc}"})
                continue

            cid = pulled["character_id"]
            image_stats = pulled["image_stats"]
            try:
                # Live, as just pulled: Back up all keeps what was on
                # F-list, whatever the Workbench holds. In the
                # threadpool: it repairs the gallery and builds the zip
                # under the character's lock.
                result = await run_in_threadpool(
                    archive_backups.save_zip_backup,
                    cid,
                    source=backup_origin.LIVE,
                    occasion=backup_origin.BACKUP_ALL,
                    force=False,
                )
            except OSError as exc:
                yield row(
                    {
                        "name": name,
                        "character_id": cid,
                        "status": "error",
                        "message": f"zip: {exc}",
                        "image_stats": image_stats,
                    }
                )
                continue

            if result.get("saved"):
                yield row(
                    {
                        "name": name,
                        "character_id": cid,
                        "status": "saved",
                        "filename": result.get("filename"),
                        "size": result.get("size"),
                        "image_stats": image_stats,
                    }
                )
            else:
                yield row(
                    {
                        "name": name,
                        "character_id": cid,
                        "status": "unchanged",
                        "image_stats": image_stats,
                    }
                )
    except Exception as exc:  # noqa: BLE001 — last-resort
        # Defensive: an unhandled error inside the sweep would otherwise
        # end the events without a terminal one, leaving the renderer's
        # banner stuck on phase='running' forever. Surface anything we
        # missed.
        unexpected = exc
    finally:
        await client.aclose()

    if unexpected is not None:
        yield sse.error("unknown", INTERNAL_ERROR, repr(unexpected))
        return

    def count(status: str) -> int:
        return sum(1 for r in rows if r["status"] == status)

    yield (
        jobs.DONE,
        {
            "total": len(roster),
            "saved": count("saved"),
            "unchanged": count("unchanged"),
            "failed": count("error"),
            "characters": rows,
        },
    )
