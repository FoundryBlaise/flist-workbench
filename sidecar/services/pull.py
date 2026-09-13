"""Pulling a character's profile and images down from F-list.

Lifted out of the `/flist/character/{name}/pull` route, which was the
only place this lived. The MCP `pull_character` tool needs the same
sequence — ticket, fetch, images, snapshot, backup — and reimplementing
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
from typing import Any, AsyncIterator

import character_archive
import flist_activity
import flist_api
import settings as settings_store

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
    if not _CHARACTER_ID_RE.match(cid_str):
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
    "done",      # {character_id, image_count, backup_path?}
    "error",     # {stage, message}
)


async def run(name: str) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Pull `name`'s profile. Yields `(event, data)`; see EVENTS."""
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
            except flist_api.TicketRequired as exc:
                yield (
                    "error", {"stage": "ticket", "message": str(exc)}
                )
                return
            except flist_api.AuthFailure as exc:
                yield (
                    "error", {"stage": "ticket", "message": str(exc)}
                )
                return

            yield ("fetching", {"name": name})
            try:
                payload = await flist_api.fetch_character_data(
                    name, client=client
                )
            except flist_api.FlistApiError as exc:
                yield (
                    "error", {"stage": "fetching", "message": str(exc)}
                )
                return

            try:
                cid = character_id_from_payload(payload)
            except UnsafeCharacterId as exc:
                yield (
                    "error", {"stage": "fetching", "message": exc.detail}
                )
                return

            # Stamp fetch time and write Live before any image work
            # — so even if image downloads fail, the user has the
            # JSON and can retry the gallery later.
            import time as _t
            live_payload = dict(payload)
            live_payload["fetched_at"] = int(_t.time())
            character_archive.write_live(cid, live_payload)

            # Forever-history: auto-snapshot the Live JSON if the
            # F-list content actually changed since the last
            # snapshot. `fetched_at` is excluded from the dedup
            # hash so a no-op pull doesn't bloat the snapshot
            # folder. Snapshots are a few KB each and never pruned
            # — explicit owner decision: every change archived.
            # (Distinct from the ZIP "backup" written by Tools →
            # Back up all, which includes images.)
            try:
                snapshot_result = character_archive.save_snapshot_if_changed(cid)
            except OSError as exc:
                snapshot_result = {"saved": False, "reason": f"oserror: {exc}"}
            if snapshot_result.get("saved"):
                yield (
                    "snapshot",
                    {
                        "saved": True,
                        "filename": snapshot_result.get("filename"),
                        "created_at": snapshot_result.get("created_at"),
                    },
                )

            # Avatar — deterministic URL, no rate-limit-bucket cost
            # against the API. Fire-and-forget; failures are
            # non-fatal.
            try:
                await flist_api.download_to(
                    flist_api.avatar_url(name),
                    character_archive.avatar_path_for(name),
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
            character_archive.write_pull_state(
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
            images_dir_path = character_archive.images_dir(cid)
            downloaded = 0
            cached = 0
            failed = 0
            for i, img in enumerate(image_list, start=1):
                image_id = img["image_id"]
                raw_ext = img["extension"]
                try:
                    ext = character_archive.normalise_image_ext(raw_ext)
                except ValueError:
                    ext = raw_ext.lower().lstrip(".")
                target = images_dir_path / f"{image_id}.{ext}"
                # Remove any stale-ext sibling for the same image_id
                # so a downloaded .jpg doesn't sit next to an old .png.
                # Only touch png/jpg/gif siblings — leave debris like
                # .tmp from an in-flight write alone.
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
                    character_archive.write_character_image(
                        cid, image_id, ext, data
                    )
                    # If the user uploaded these exact bytes locally
                    # before pushing them to F-list, the local-<sha8>
                    # file is still on disk and would show up as a
                    # phantom pool entry. Collapse the duplicate.
                    try:
                        character_archive.dedupe_local_after_pull(
                            cid, image_id, data
                        )
                    except Exception:  # noqa: BLE001 — best-effort
                        pass
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
            # image_id not referenced by working.json's gallery is
            # "in the pool"). The working copy's gallery is the only
            # source of truth for what shows on-profile, and only
            # the explicit pool-delete UI removes bytes.

            # Seal the manifest: finished_at marks the loop ran to
            # completion (success or with per-image failures). The
            # absence of this write is what compute_pull_status uses
            # to distinguish "interrupted" from "partial".
            character_archive.write_pull_state(
                cid,
                image_list,
                started_at=pull_started_at,
                finished_at=int(_t.time()),
            )
            pull_status = character_archive.compute_pull_status(cid)
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
            yield (
                "error", {"stage": "rate-limited", "message": str(exc)}
            )
        except flist_api.AuthFailure as exc:
            # Auto-refresh during the pull could trip on a password
            # the user changed elsewhere. Surface cleanly.
            flist_activity.record(
                "pull-error", name=name, stage="ticket", error=str(exc),
            )
            yield (
                "error", {"stage": "ticket", "message": str(exc)}
            )
        except flist_api.FlistApiError as exc:
            # Any other F-list error past the early stages — still
            # better than a class-repr to the user.
            flist_activity.record(
                "pull-error", name=name, stage="fetching", error=str(exc),
            )
            yield (
                "error", {"stage": "fetching", "message": str(exc)}
            )
        except Exception as exc:  # noqa: BLE001 — last-resort
            flist_activity.record(
                "pull-error", name=name, stage="unknown", error=repr(exc),
            )
            yield (
                "error", {"stage": "unknown", "message": repr(exc)}
            )
        finally:
            await client.aclose()


