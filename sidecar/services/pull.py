"""Pulling a character's profile and images down from F-list.

Lifted out of the `/flist/character/{name}/pull` route, which was the
only place this lived. The MCP `pull_character` tool needs the same
sequence — ticket, fetch, Live, images — and reimplementing
a 300-line orchestration against a rate-limited API twice is how the
two drift apart.

`run()` yields `(event, data)` pairs. The REST route frames them as
server-sent events for the renderer; the MCP tool reports progress and
keeps the final summary. Nothing here writes to f-list.net: the only
outbound calls are `getApiTicket.php`, `character-data.php` and the
static image GETs.
"""

from __future__ import annotations

import re
import sys
from typing import Any, AsyncIterator

from starlette.concurrency import run_in_threadpool

import archive_errors
import archive_images
import archive_live
import archive_registry
import flist_activity
import flist_api
import settings as settings_store

from . import events, image_trash, sse

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

#: Event names `run()` can yield, in the order a successful pull emits
#: them. `error` can replace any of them and ends the stream.
EVENTS = (
    "queued",    # waiting on the pull lock; concurrent pulls serialise
    "ticket",    # acquiring or refreshing the F-list ticket
    "fetching",  # calling character-data.php
    "images",    # {total, downloaded, failed} — the image batch starts
    "image",     # {index, total, image_id} — per image
    "done",      # {character_id, changed, image_count, ...}
    "error",     # {stage, code, message, details} (`sse.error`)
)


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
# images and wait for the character's lock, and the event loop serves
# the window and MCP meanwhile.


def _store_live(cid: str, payload: dict[str, Any]) -> bool:
    """Write a fetched profile as Live, stamped with the fetch time, and
    say whether it differs from the Live it replaces (the fetch time
    left out). One step under the character's lock."""
    import time as _t

    with archive_registry.character_lock(cid):
        changed = _differs_from_live(cid, payload)
        live_payload = dict(payload)
        live_payload["fetched_at"] = int(_t.time())
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
    except Exception:  # noqa: BLE001 — best-effort
        pass


def _seal(
    cid: str, image_list: list[dict[str, str]], started_at: int
) -> dict[str, Any]:
    """Repair the gallery, mark the manifest finished and report the
    Pull's status."""
    import time as _t

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
        cid,
        image_list,
        started_at=started_at,
        finished_at=int(_t.time()),
    )
    return archive_images.compute_pull_status(cid)


async def run(name: str) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Pull `name`'s profile. Yields `(event, data)`; see EVENTS.

    The window hears of the Pull once it ends: one event per thing it
    changed (Live, the pool, the roster), not one per picture."""
    with events.coalesced():
        async for item in _pull(name):
            yield item


async def _pull(name: str) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    # Send queued event immediately so the renderer's row badge can
    # flip to "queued" before the lock is acquired.
    yield ("queued", {"name": name})
    flist_activity.record("pull-start", name=name)
    async with flist_api.pull_lock():
        client = flist_api._default_client()
        try:
            yield ("ticket", {})
            try:
                await flist_api.ensure_fresh_ticket(client=client)
            except (flist_api.TicketRequired, flist_api.AuthFailure) as exc:
                yield sse.refused("ticket", flist_api.refusal(exc))
                return

            yield ("fetching", {"name": name})
            try:
                payload = await flist_api.fetch_character_data(
                    name, client=client
                )
            except flist_api.FlistApiError as exc:
                yield sse.refused("fetching", flist_api.refusal(exc))
                return

            try:
                cid = character_id_from_payload(payload)
            except UnsafeCharacterId as exc:
                yield sse.error("fetching", "invalid_character_id", str(exc))
                return

            # Stamp fetch time and write Live before any image work
            # — so even if image downloads fail, the user has the
            # JSON and can retry the gallery later. Whether F-list
            # changed is judged against the Live this replaces, with
            # the fetch time left out.
            changed = await run_in_threadpool(_store_live, cid, payload)

            # Avatar — deterministic URL, no rate-limit-bucket cost
            # against the API. Fire-and-forget; failures are
            # non-fatal.
            try:
                await flist_api.download_to(
                    flist_api.avatar_url(name),
                    archive_images.avatar_path_for(name),
                    client=client,
                )
            except flist_api.FlistApiError:
                pass
            except ValueError:
                pass

            images = payload.get("images")
            image_list: list[dict] = []
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

            total = len(image_list)
            # Record what this pull intends to fetch before downloading
            # anything. If the user's PC sleeps / crashes / loses
            # network mid-loop, the manifest's `finished_at=None` is
            # the marker compute_pull_status uses to surface "Pull
            # incomplete — N missing" on next launch.
            import time as _t
            pull_started_at = int(_t.time())
            await run_in_threadpool(
                archive_images.write_pull_state,
                cid,
                image_list,
                started_at=pull_started_at,
                finished_at=None,
            )
            yield (
                "images", {"total": total, "downloaded": 0, "failed": 0}
            )

            # Cache check is file existence in images/<image_id>.<ext>.
            # No manifest lookup, no hashing — if the file is there,
            # the image is cached. We normalise the extension first
            # (jpeg→jpg) so the probe matches what write_character_image
            # actually stores, and clean up any stale-ext file for the
            # same image_id (F-list rarely changes ext for an existing
            # id, but a manual file replace can leave a `.png` next to
            # the `.jpg` we're about to download).
            downloaded = 0
            cached = 0
            failed = 0
            for i, img in enumerate(image_list, start=1):
                image_id = img["image_id"]
                raw_ext = img["extension"]
                try:
                    ext = archive_images.normalise_image_ext(raw_ext)
                except ValueError:
                    ext = raw_ext.lower().lstrip(".")
                if await run_in_threadpool(
                    clear_stale_siblings, cid, image_id, f"{image_id}.{ext}"
                ):
                    cached += 1
                    yield (
                        "image",
                        {
                            "index": i,
                            "total": total,
                            "image_id": image_id,
                            "ok": True,
                            "cached": True,
                        },
                    )
                    continue
                url = (
                    f"{flist_api.STATIC_BASE}/images/charimage/"
                    f"{image_id}.{ext}"
                )
                try:
                    data = await flist_api.fetch_bytes(url, client=client)
                    await run_in_threadpool(_store_image, cid, image_id, ext, data)
                    downloaded += 1
                    yield (
                        "image",
                        {
                            "index": i,
                            "total": total,
                            "image_id": image_id,
                            "ok": True,
                        },
                    )
                except ValueError as exc:
                    # Unsupported extension — treat like a download
                    # failure so the pull keeps going.
                    failed += 1
                    yield (
                        "image",
                        {
                            "index": i,
                            "total": total,
                            "image_id": image_id,
                            "ok": False,
                            "error": str(exc),
                        },
                    )
                except flist_api.FlistApiError as exc:
                    failed += 1
                    yield (
                        "image",
                        {
                            "index": i,
                            "total": total,
                            "image_id": image_id,
                            "ok": False,
                            "error": str(exc),
                        },
                    )

            # Under the v5 unified store, pulls no longer delete
            # images/ files that F-list dropped — the bytes stay
            # on disk and surface in the renderer's Pool view (any
            # image_id not referenced by the Workbench's gallery is
            # "in the pool"). The Workbench's gallery is the only
            # source of truth for what shows on-profile, and only
            # the explicit pool-delete UI removes bytes.

            pull_status = await run_in_threadpool(
                _seal, cid, image_list, pull_started_at
            )
            flist_activity.record(
                "pull-done",
                name=payload.get("name") or name,
                character_id=cid,
                image_count=downloaded + cached,
                image_downloaded=downloaded,
                image_cached=cached,
                image_failed=failed,
                status=pull_status["status"],
                missing=len(pull_status["missing_image_ids"]),
            )
            yield (
                "done",
                {
                    "character_id": cid,
                    "name": payload.get("name") or name,
                    "changed": changed,
                    "image_count": downloaded + cached,
                    "image_downloaded": downloaded,
                    "image_cached": cached,
                    "image_failed": failed,
                    "pull_status": pull_status["status"],
                    "pull_missing": len(pull_status["missing_image_ids"]),
                },
            )
        except flist_api.RateLimited as exc:
            # Specific catch so the renderer gets a human-readable
            # message + a "rate-limited" stage instead of an
            # `unknown / RateLimited(...)` repr. The hourly cap is
            # the most likely place this fires inside a long pull.
            flist_activity.record(
                "pull-error", name=name, stage="rate-limited",
                error=str(exc),
            )
            yield sse.refused("rate-limited", flist_api.refusal(exc))
        except flist_api.AuthFailure as exc:
            # Auto-refresh during the pull could trip on a password
            # the user changed elsewhere. Surface cleanly.
            flist_activity.record(
                "pull-error", name=name, stage="ticket", error=str(exc),
            )
            yield sse.refused("ticket", flist_api.refusal(exc))
        except flist_api.FlistApiError as exc:
            # Any other F-list error past the early stages — still
            # better than a class-repr to the user.
            flist_activity.record(
                "pull-error", name=name, stage="fetching", error=str(exc),
            )
            yield sse.refused("fetching", flist_api.refusal(exc))
        except Exception as exc:  # noqa: BLE001 — last-resort
            flist_activity.record(
                "pull-error", name=name, stage="unknown", error=repr(exc),
            )
            yield sse.error("unknown", sse.INTERNAL_ERROR, repr(exc))
        finally:
            await client.aclose()


