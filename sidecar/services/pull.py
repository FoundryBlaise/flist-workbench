"""Pulling a character's profile and images down from F-list.

Lifted out of the `/flist/character/{name}/pull` route, which was the
only place this lived. The MCP `pull_character` tool needs the same
sequence — ticket, fetch, Live, images — and reimplementing
a 300-line orchestration against a rate-limited API twice is how the
two drift apart.

A Pull runs as a job (`services.jobs`), one per character: `start()`
answers with the job at once, and a second Pull of the same character
while one runs is refused `character_busy`. `start_when_free()` is the
Pull the extension asks for after a save on f-list.net: it waits its
turn instead. The job is not tied to
whoever started it: the REST route's progress stream and the MCP tool
only follow it, and only a cancel by job id stops it.

`run()` is the job's work and yields `(event, data)` pairs; the job
keeps them for whoever follows. Back up all pulls each character with
the same steps (`store_live`, `pull_images`). Nothing here writes to
f-list.net: the only outbound calls are `getApiTicket.php`,
`character-data.php` and the static image GETs.
"""

from __future__ import annotations

import asyncio
import contextvars
import re
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any, AsyncIterator

from starlette.concurrency import run_in_threadpool

import archive_errors
import archive_images
import archive_live
import archive_registry
import flist_activity
import flist_api
from refusals import INTERNAL_ERROR, CharacterBusy, JobNotFound

from . import events, image_trash, jobs, sse

#: The job kind of a Pull.
KIND = "pull"

#: The job resource that holds every character: Back up all holds it.
#: A Pull holds one character, `character:<id>` (`resource`).
CHARACTERS = "character"

#: F-list ids are integers in practice, but the value becomes a
#: directory name under `<userdata>/characters/`, so the shape is
#: whitelisted rather than trusted.
_CHARACTER_ID_RE = re.compile(r"^[0-9]{1,12}$")


class UnsafeCharacterId(ValueError):
    """A character-data.php response carried an id we won't use as a
    path segment."""


def character_id_from_payload(payload: dict[str, Any]) -> str:
    """Extract and validate the character id from a character-data.php
    response. Defence in depth: without this, a hostile or buggy
    upstream value could escape the archive root."""
    cid = payload.get("id")
    if cid is None:
        raise UnsafeCharacterId("API response missing character id")
    cid_str = str(cid)
    if not _CHARACTER_ID_RE.fullmatch(cid_str):
        raise UnsafeCharacterId(
            f"API response carries unsafe character id: {cid_str!r}"
        )
    return cid_str


def resource(character_id: int | str) -> str:
    """The job resource of one character."""
    return f"{CHARACTERS}:{character_id}"


def resource_for_name(name: str) -> str:
    """The job resource of the character a Pull by `name` will write.

    The id is only certain once F-list answered, but the account's
    character list and the archive's registry know it for every
    character a Pull is normally asked for. A name neither knows (a
    first Pull of a character from elsewhere) is held by its name, so
    two Pulls of it still refuse each other."""
    for entry in flist_api.ticket_store().characters():
        if isinstance(entry, dict) and archive_registry.same_character_name(
            entry.get("name"), name
        ) and entry.get("id") is not None:
            return resource(entry["id"])
    for cid, entry in archive_registry.load_registry().items():
        if archive_registry.same_character_name(entry.get("name"), name):
            return resource(cid)
    return resource(f"name:{name.strip().lower()}")


#: Event names `run()` can yield.
TICKET = "ticket"  # acquiring or refreshing the F-list ticket
FETCHING = "fetching"  # calling character-data.php
IMAGES = "images"  # {total, downloaded, failed}: the image batch starts
IMAGE = "image"  # {index, total, image_id}: per image

#: In the order a successful pull emits them; `jobs.DONE` carries
#: {character_id, changed, image_count, ...}. `jobs.ERROR` ({stage,
#: code, message, details}, `sse.error`) can replace any of them and
#: ends the stream; the job adds `jobs.CANCELLED` when a cancel stopped it.
EVENTS = (TICKET, FETCHING, IMAGES, IMAGE, jobs.DONE, jobs.ERROR)


def start(name: str) -> jobs.Job:
    """Start a Pull of `name` as a job. Raises `CharacterBusy` while
    another job holds the character."""
    name = name.strip()

    async def work() -> AsyncIterator[tuple[str, dict[str, Any]]]:
        async for item in run(name):
            yield item

    return jobs.registry().start_stream(
        KIND,
        resource_for_name(name),
        work,
        busy=CharacterBusy,
        params={"name": name},
        progress={"stage": "queued"},
        observe=_observe,
    )


def start_when_free(name: str, *, delay: float) -> None:
    """Start a Pull of `name` after `delay` seconds, once no job holds
    the character: the Pull after the user saved on f-list.net.

    Holds nothing while it waits, so a Pull the user starts meanwhile
    runs at once, and a busy character (a Pull, Back up all) only
    delays this one: it starts when that job has finished. Returns at
    once; the waiting is done on a thread of its own, in a copy of the
    caller's context (`events.origin`)."""
    context = contextvars.copy_context()
    threading.Thread(
        target=context.run,
        args=(_start_when_free, name, delay),
        daemon=True,
        name=f"pull-when-free-{name}",
    ).start()


def _start_when_free(name: str, delay: float) -> None:
    time.sleep(delay)
    while True:
        try:
            start(name)
            return
        except CharacterBusy as busy:
            holder = busy.details["job_id"]
        try:
            job = jobs.registry().get(holder)
        except JobNotFound:  # finished and forgotten already
            continue
        while not job.finished:
            time.sleep(jobs.POLL_SECONDS)


def _observe(job: jobs.Job, event: str, data: dict[str, Any]) -> None:
    """Sum the Pull up in `job.progress`: where it is, and how many
    images of how many it has been through."""
    progress = dict(job.progress)
    progress["stage"] = event
    if event == IMAGES:
        progress.update(images_total=data.get("total", 0), images_done=0)
    elif event == IMAGE:
        progress["images_done"] = data.get("index", 0)
    elif event == jobs.DONE:
        progress["character_id"] = data.get("character_id")
    job.progress = progress


def _differs_from_live(cid: str, payload: dict[str, Any]) -> bool:
    """Whether a freshly fetched profile differs from the stored Live.
    No Live yet counts as a change."""
    try:
        live = archive_live.read_live(cid)
    except archive_errors.CharacterNotFound:
        live = None
    if live is None:
        return True
    return archive_live.live_content_hash(payload) != archive_live.live_content_hash(live)


# The disk steps of a Pull, each run in the threadpool: they hash
# images and wait for the character's lock, and the job's event loop
# goes on taking a cancel meanwhile.


def _store_live(cid: str, payload: dict[str, Any]) -> bool:
    """Write a fetched profile as Live, stamped with the fetch time, and
    say whether it differs from the Live it replaces (the fetch time
    left out). One step under the character's lock."""
    with archive_registry.character_lock(cid):
        changed = _differs_from_live(cid, payload)
        live_payload = dict(payload)
        live_payload["fetched_at"] = int(time.time())
        archive_live.write_live(cid, live_payload)
    return changed


def clear_stale_siblings(cid: str, image_id: str, target_name: str) -> bool:
    """Move any stale-ext sibling of `image_id` to the Trash, so a
    downloaded .jpg doesn't sit next to an old .png and the old bytes
    stay recoverable. Only png/jpg/gif siblings are touched; debris like
    a temp file from an in-flight write is left alone. Says whether the
    image itself is already cached."""
    images_dir_path = archive_images.images_dir(cid)
    for sibling in images_dir_path.glob(f"{image_id}.*"):
        if sibling.name == target_name:
            continue
        if sibling.suffix.lstrip(".").lower() not in {"png", "jpg", "jpeg", "gif"}:
            continue
        try:
            image_trash.trash_pool_file(cid, sibling)
        except OSError:
            pass
    return (images_dir_path / target_name).exists()


def _store_image(cid: str, image_id: str, ext: str, data: bytes) -> None:
    """Write a downloaded image, then fold away a local upload of the
    same bytes."""
    archive_images.write_character_image(cid, image_id, ext, data)
    # If the user uploaded these exact bytes locally before pushing
    # them to F-list, the local-<sha8> file is still on disk and would
    # show up as a phantom pool entry. Collapse the duplicate.
    try:
        archive_images.dedupe_local_after_pull(cid, image_id, data)
    except Exception:  # noqa: BLE001, S110 — best-effort
        pass


def _seal(cid: str, images: list[dict[str, str]], started_at: int) -> None:
    """Repair the gallery, then mark the manifest finished."""
    # A pull is exactly when image ids change under us: the extension
    # deletes and re-uploads a gallery, F-list mints new ids, and what
    # we just downloaded is byte-identical to files we already hold
    # under ids the site has forgotten. Left alone, the Workbench keeps
    # naming the dead ones and the same picture shows in the pool and
    # on the profile at once. Repair compares bytes, so it recognises
    # them.
    try:
        archive_images.repair_gallery(cid)
    except Exception as exc:  # noqa: BLE001 — never fail a pull
        print(f"gallery repair after pull failed: {exc}", file=sys.stderr)

    # Seal the manifest: finished_at marks the loop ran to completion
    # (success or with per-image failures). The absence of this write
    # is what compute_pull_status uses to distinguish "interrupted"
    # from "partial".
    archive_images.write_pull_state(
        cid, images, started_at=started_at, finished_at=int(time.time())
    )


async def store_live(name: str, payload: dict[str, Any], *, client: Any) -> tuple[str, bool]:
    """Pull's Live step: write the fetched profile as Live, then the
    avatar. Returns the character id and whether F-list changed.

    Live is written before any image work, so even if image downloads
    fail, the user has the profile and can retry the gallery later.
    Raises `UnsafeCharacterId`."""
    cid = character_id_from_payload(payload)
    changed = await run_in_threadpool(_store_live, cid, payload)

    # Avatar — deterministic URL, no rate-limit-bucket cost against the
    # API. Failures are non-fatal.
    try:
        await flist_api.download_to(
            flist_api.avatar_url(name),
            archive_images.avatar_path_for(name),
            client=client,
        )
    except (flist_api.FlistApiError, ValueError):
        pass
    return cid, changed


def image_list(payload: dict[str, Any]) -> list[dict[str, str]]:
    """The gallery a character-data.php response names, as
    `{image_id, extension}` rows."""
    images = payload.get("images")
    out: list[dict[str, str]] = []
    if isinstance(images, list):
        for img in images:
            if not isinstance(img, dict):
                continue
            image_id = img.get("image_id") or img.get("id")
            ext = img.get("extension")
            if image_id is None or not ext:
                continue
            out.append({"image_id": str(image_id), "extension": str(ext)})
    return out


@dataclass
class ImageCounts:
    """What `pull_images` did, image by image."""

    downloaded: int = 0
    cached: int = 0
    failed: int = 0


async def pull_images(
    cid: str,
    images: list[dict[str, str]],
    counts: ImageCounts,
    *,
    client: Any,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Pull's image step: fetch every gallery image not yet on disk,
    then repair the gallery. Yields one `image` event per image and
    counts into `counts`. Pull and Back up all both run this.
    """
    total = len(images)
    # Record what this pull intends to fetch before downloading
    # anything. If the user's PC sleeps / crashes / loses network
    # mid-loop (or the Pull is cancelled), the manifest's
    # `finished_at=None` is the marker compute_pull_status uses to
    # surface "Pull incomplete — N missing" on next launch.
    started_at = int(time.time())
    await run_in_threadpool(
        archive_images.write_pull_state,
        cid,
        images,
        started_at=started_at,
        finished_at=None,
    )

    # Cache check is file existence in images/<image_id>.<ext>. No
    # manifest lookup, no hashing — if the file is there, the image is
    # cached. We normalise the extension first (jpeg→jpg) so the probe
    # matches what write_character_image actually stores, and clean up
    # any stale-ext file for the same image_id (F-list rarely changes
    # ext for an existing id, but a manual file replace can leave a
    # `.png` next to the `.jpg` we're about to download).
    for i, img in enumerate(images, start=1):
        image_id = img["image_id"]
        raw_ext = img["extension"]
        try:
            ext = archive_images.normalise_image_ext(raw_ext)
        except ValueError:
            ext = raw_ext.lower().lstrip(".")
        row = {"index": i, "total": total, "image_id": image_id}
        if await run_in_threadpool(clear_stale_siblings, cid, image_id, f"{image_id}.{ext}"):
            counts.cached += 1
            yield (IMAGE, {**row, "ok": True, "cached": True})
            continue
        url = f"{flist_api.STATIC_BASE}/images/charimage/{image_id}.{ext}"
        try:
            data = await flist_api.fetch_bytes(url, client=client)
            await run_in_threadpool(_store_image, cid, image_id, ext, data)
            counts.downloaded += 1
            yield (IMAGE, {**row, "ok": True})
        except (ValueError, flist_api.FlistApiError) as exc:
            # An unsupported extension counts like a download failure,
            # so the pull keeps going.
            counts.failed += 1
            yield (IMAGE, {**row, "ok": False, "error": str(exc)})

    # Under the v5 unified store, pulls no longer delete images/ files
    # that F-list dropped — the bytes stay on disk and surface in the
    # renderer's Pool view (any image_id not referenced by the
    # Workbench's gallery is "in the pool"). The Workbench's gallery is
    # the only source of truth for what shows on-profile, and only the
    # explicit pool-delete UI removes bytes.
    await run_in_threadpool(_seal, cid, images, started_at)


async def run(name: str) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Pull `name`'s profile. Yields `(event, data)`; see EVENTS.

    The window hears of the Pull once it ends: one event per thing it
    changed (Live, the pool, the roster), not one per picture."""
    with events.coalesced():
        async for item in _pull(name):
            yield item


async def _pull(name: str) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    flist_activity.record("pull-start", name=name)
    client = flist_api._default_client()
    try:
        yield (TICKET, {})
        try:
            await flist_api.ensure_fresh_ticket(client=client)
        except (flist_api.TicketRequired, flist_api.AuthFailure) as exc:
            yield sse.refused(TICKET, flist_api.refusal(exc))
            return

        yield (FETCHING, {"name": name})
        try:
            payload = await flist_api.fetch_character_data(name, client=client)
        except flist_api.FlistApiError as exc:
            yield sse.refused(FETCHING, flist_api.refusal(exc))
            return

        try:
            cid, changed = await store_live(name, payload, client=client)
        except UnsafeCharacterId as exc:
            yield sse.error(FETCHING, "invalid_character_id", str(exc))
            return

        images = image_list(payload)
        yield (IMAGES, {"total": len(images), "downloaded": 0, "failed": 0})
        counts = ImageCounts()
        async for item in pull_images(cid, images, counts, client=client):
            yield item

        pull_status = await run_in_threadpool(archive_images.compute_pull_status, cid)
        flist_activity.record(
            "pull-done",
            name=payload.get("name") or name,
            character_id=cid,
            image_count=counts.downloaded + counts.cached,
            image_downloaded=counts.downloaded,
            image_cached=counts.cached,
            image_failed=counts.failed,
            status=pull_status["status"],
            missing=len(pull_status["missing_image_ids"]),
        )
        yield (
            jobs.DONE,
            {
                "character_id": cid,
                "name": payload.get("name") or name,
                "changed": changed,
                "image_count": counts.downloaded + counts.cached,
                "image_downloaded": counts.downloaded,
                "image_cached": counts.cached,
                "image_failed": counts.failed,
                "pull_status": pull_status["status"],
                "pull_missing": len(pull_status["missing_image_ids"]),
            },
        )
    except flist_api.RateLimited as exc:
        # Specific catch so the renderer gets a human-readable message +
        # a "rate-limited" stage instead of an `unknown /
        # RateLimited(...)` repr. The hourly cap is the most likely
        # place this fires inside a long pull.
        flist_activity.record(
            "pull-error", name=name, stage="rate-limited", error=str(exc),
        )
        yield sse.refused("rate-limited", flist_api.refusal(exc))
    except flist_api.AuthFailure as exc:
        # Auto-refresh during the pull could trip on a password the
        # user changed elsewhere. Surface cleanly.
        flist_activity.record(
            "pull-error", name=name, stage="ticket", error=str(exc),
        )
        yield sse.refused(TICKET, flist_api.refusal(exc))
    except flist_api.FlistApiError as exc:
        # Any other F-list error past the early stages — still better
        # than a class-repr to the user.
        flist_activity.record(
            "pull-error", name=name, stage="fetching", error=str(exc),
        )
        yield sse.refused(FETCHING, flist_api.refusal(exc))
    except asyncio.CancelledError:
        # Cancelled by job id: what landed stays, and the manifest
        # without `finished_at` marks the Pull as interrupted.
        flist_activity.record(
            "pull-error", name=name, stage="cancelled", error="cancelled",
        )
        raise
    except Exception as exc:  # noqa: BLE001 — last-resort
        flist_activity.record(
            "pull-error", name=name, stage="unknown", error=repr(exc),
        )
        yield sse.error("unknown", INTERNAL_ERROR, repr(exc))
    finally:
        await client.aclose()
