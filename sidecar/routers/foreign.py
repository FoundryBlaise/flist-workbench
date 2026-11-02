"""Foreign profiles: somebody else's profile, read-only.

Cached under `<userdata>/foreign/` and never under `characters/`. There
is deliberately no route here that writes into the archive: no
Workbench, no Backup, no export. The viewer reads.
"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

import archive_images
import flist_api
import foreign_cache
from services import avatars
from services import foreign as foreign_service

router = APIRouter()


_FOREIGN_STATUS = {
    "validation_failed": 400,
    "not_signed_in": 401,
    "not_found": 404,
    "no_logs": 503,
    "rate_limited": 429,
    "flist_error": 502,
}


def _foreign_http(exc: foreign_service.ForeignError) -> HTTPException:
    return HTTPException(
        status_code=_FOREIGN_STATUS.get(exc.code, 500),
        detail={"code": exc.code, "message": exc.message},
    )


@router.get("/foreign/search")
async def foreign_search(source: str, q: str = "") -> dict:
    """Candidate names from one of the viewer's three sources.

    `bookmarks` and `friends` come off the F-list account (one API
    call, memoised); `logs` walks the local F-Chat log directories and
    costs nothing; `name` echoes the typed string back because F-list
    has no character search to call.
    """
    try:
        return await foreign_service.search(q, source)
    except foreign_service.ForeignError as exc:
        raise _foreign_http(exc) from exc


@router.get("/foreign/character/{name}")
async def foreign_character(name: str, refresh: bool = False) -> dict:
    """One foreign profile. Served from cache while it is under the
    24-hour TTL; `refresh=true` is the viewer's reload button."""
    try:
        return await foreign_service.get_profile(name, refresh=refresh)
    except foreign_service.ForeignError as exc:
        raise _foreign_http(exc) from exc


@router.get("/foreign/character/{name}/avatar")
async def foreign_character_avatar(name: str) -> FileResponse:
    """The profile's avatar, cached inside its own foreign folder.

    Kept out of `<userdata>/avatars/`, which the account picker treats
    as "characters this user has". Same placeholder detection as
    `/flist/avatar/{name}` so the renderer falls back to an initial
    circle instead of showing F-list's grey stand-in.
    """
    try:
        dest = foreign_cache.avatar_path(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not dest.exists():
        try:
            await flist_api.download_to(flist_api.avatar_url(name), dest)
        except flist_api.FlistApiError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
    try:
        size = dest.stat().st_size
    except OSError:
        size = -1
    if size == avatars.PLACEHOLDER_SIZE:
        raise HTTPException(status_code=404, detail="no avatar uploaded")
    return FileResponse(dest)


@router.get("/foreign/character/{name}/image/{image_id}")
async def foreign_character_image(name: str, image_id: str) -> FileResponse:
    """A gallery image, downloaded on first request and cached after.

    Lazy on purpose: a profile can list fifty images and fetching the
    set up front would turn opening a profile into a half-minute
    wait. The id must appear in the cached profile's own gallery —
    that is what stops this route being a general-purpose proxy for
    anything on the CDN.
    """
    archive_images.require_image_id(image_id)
    profile = foreign_cache.read_profile(name)
    if profile is None:
        raise HTTPException(status_code=404, detail="profile not cached")
    cached = foreign_cache.find_image(name, image_id)
    if cached is not None:
        return FileResponse(cached)
    gallery = foreign_service.gallery_index(profile)
    raw_ext = gallery.get(image_id)
    if raw_ext is None:
        raise HTTPException(
            status_code=404, detail="image is not in this profile's gallery"
        )
    try:
        ext = archive_images.normalise_image_ext(raw_ext)
    except ValueError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc
    url = f"{flist_api.STATIC_BASE}/images/charimage/{image_id}.{ext}"
    dest = foreign_cache.image_path(name, image_id, ext)
    try:
        # Concurrency-capped, not paced, and down a pooled connection
        # that stays open between images. See FOREIGN_IMAGE_CONCURRENCY.
        async with flist_api.foreign_image_gate():
            await flist_api.download_to(
                url,
                dest,
                client=flist_api.foreign_cdn_client(),
                rate_limiter=flist_api.unpaced_limiter(),
            )
    except flist_api.FlistApiError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return FileResponse(dest)
