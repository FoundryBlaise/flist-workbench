"""A character's images and inlines, and the Trash.

The Trash routes cover all three kinds it holds: images, Backups and
cleared Labels, per character and, for Labels, across all of them.
"""

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

import archive_images
import archive_registry
from refusals import ImageNotFound, InvalidFileName, InvalidRequest, TooLarge, UnsupportedType
from services import backup_trash as backup_trash_service
from services import image_import as image_import_service
from services import image_trash as image_trash_service
from services import label_trash as label_trash_service

router = APIRouter()


@router.get("/flist/character/{character_id}/images/{filename}")
def flist_character_image(character_id: str, filename: str) -> FileResponse:
    """Serve `images/<image_id>.<ext>`. The filename shape is validated
    against the safe-name regex so a hostile renderer call can't path-
    traverse out of the images directory."""
    archive_images.require_image_filename(filename)
    path = archive_images.images_dir(character_id) / filename
    if not path.exists():
        raise ImageNotFound("image not found")
    return FileResponse(path)


@router.get("/flist/character/{character_id}/images")
def flist_character_images_list(character_id: str) -> dict:
    """List the files in `images/`. Each row: `{image_id, extension,
    size, added_at}`. Renderer pairs these with description/sort_order
    from the Workbench to decide which are on the profile vs. in the
    pool view."""
    return {
        "character_id": character_id,
        "images": archive_images.list_character_images(character_id),
    }


@router.get("/flist/character/{character_id}/image/{image_id}")
def flist_character_image_by_id(
    character_id: str, image_id: str
) -> FileResponse:
    """Serve `images/<image_id>.<ext>` without the renderer having to
    know the extension. Tries the supported set in order; 404 when none
    exists. Lets the gallery render thumbnails reliably without a
    separate round-trip to look up extensions."""
    archive_images.require_image_id(image_id)
    d = archive_images.images_dir(character_id)
    for ext in ("png", "jpg", "gif"):
        candidate = d / f"{image_id}.{ext}"
        if candidate.exists():
            return FileResponse(candidate)
    raise ImageNotFound("image not found")


@router.post("/flist/character/{character_id}/images")
async def flist_character_image_upload(
    character_id: str, request: Request
) -> dict:
    """Upload an image into `images/` under a `local-<sha8>` synthetic
    id. The body is the raw image bytes; the server sniffs magic bytes
    to decide the extension (Content-Type is never trusted). The
    uploaded image lands in the renderer's Pool view by default — it
    only appears on-profile after the user moves it via a Workbench
    gallery edit.

    Idempotent — identical bytes always produce the same `local-<sha8>`
    id and skip re-writing the file."""
    body = await request.body()
    if not body:
        raise InvalidRequest(("body",), "empty body")
    if len(body) > 16 * 1024 * 1024:
        # F-list itself caps images well below this; the bound is here
        # to keep a hostile body from blocking the loop on disk write.
        raise TooLarge("image too large")
    # Off the loop: matching the bytes against the pool hashes every
    # image the character holds.
    row = await run_in_threadpool(archive_images.add_uploaded_image, character_id, body)
    if row is None:
        raise UnsupportedType("unsupported image type (png/jpg/gif only)")
    return row


@router.post("/flist/character/{character_id}/images/repair")
def flist_character_images_repair(character_id: str) -> dict:
    """Put the gallery back together when entries have lost their bytes.

    Called when the Images tab opens. A slot pointing at a file that is
    gone renders as a black placeholder, and — worse — drops out of the
    restore ZIP, which the extension reads as "delete this from the
    profile". Users lost images on f-list.net that way, so this runs on
    its own rather than waiting to be found in a menu.

    Cheap: it hashes the character's own image files and nothing else.
    """
    return archive_images.repair_gallery(character_id)


@router.delete("/flist/character/{character_id}/images/{image_id}")
def flist_character_image_remove(
    character_id: str, image_id: str
) -> dict:
    """Move `images/<image_id>.<ext>` into the character's trash, where
    it can be restored until the trash is emptied. The renderer drops
    any gallery row pointing at it."""
    result = image_trash_service.trash_images(character_id, [image_id])
    if not result["trashed"]:
        raise ImageNotFound("image not found")
    return {"trashed": True, "image_id": image_id}


class _ImageIdsBody(BaseModel):
    image_ids: list[str]


@router.post("/flist/character/{character_id}/images/trash")
def flist_character_images_trash(character_id: str, body: _ImageIdsBody) -> dict:
    """Move several pool files into the trash at once."""
    return image_trash_service.trash_images(character_id, body.image_ids)


# Not under /images/: that prefix is taken by the `{filename}` route.
@router.get("/flist/character/{character_id}/image-references")
def flist_character_image_references(character_id: str) -> dict:
    """Where each image id is still used — the Workbench, Live and
    Backups — so the window can warn before trashing one."""
    return image_import_service.references(character_id)


@router.get("/flist/character/{character_id}/trash")
def flist_character_trash_list(character_id: str) -> dict:
    return {
        "character_id": character_id,
        "items": image_trash_service.list_trash(character_id),
        "backups": backup_trash_service.list_backups(character_id),
        "labels": label_trash_service.list_labels(_trash_owner(character_id)),
    }


@router.get("/flist/character/{character_id}/trash/{filename}")
def flist_character_trash_file(character_id: str, filename: str) -> FileResponse:
    """Serve a trashed file, for the trash view's thumbnails."""
    archive_images.require_image_filename(filename)
    if filename.endswith(".json"):
        # The trash's own metadata sits next to the files.
        raise InvalidFileName("invalid image filename")
    path = image_trash_service.trash_dir(character_id) / filename
    if not path.exists():
        raise ImageNotFound("image not found")
    return FileResponse(path)


@router.post("/flist/character/{character_id}/trash/restore")
def flist_character_trash_restore(character_id: str, body: _ImageIdsBody) -> dict:
    """Put trashed files back into the pool (not onto the profile)."""
    return image_trash_service.restore_images(character_id, body.image_ids)


class _TrashIdsBody(BaseModel):
    ids: list[str]


@router.post("/flist/character/{character_id}/trash/backups/restore")
def flist_character_trash_backups_restore(
    character_id: str, body: _TrashIdsBody
) -> dict:
    """Put trashed Backups back in the Backup list, under their names."""
    return backup_trash_service.restore_backups(character_id, body.ids)


def _trash_owner(character_id: str) -> str:
    """The name this character's cleared Labels are kept under, for the
    Trash routes. The id is checked first, as every Trash route checks
    it: an unsafe one is refused with `invalid_character_id` (400), one
    the archive does not hold with `character_not_found` (404). A
    character without a name owns no cleared Labels: its listing shows
    none and a restore or purge finds none (`""` matches no entry)."""
    archive_registry.character_dir(character_id)
    return archive_registry.character_name(character_id) or ""


@router.post("/flist/character/{character_id}/trash/labels/restore")
def flist_character_trash_labels_restore(
    character_id: str, body: _TrashIdsBody
) -> dict:
    """Put cleared Labels back. A message labelled again since keeps
    its newer Label and is reported under `skipped`."""
    return label_trash_service.restore(_trash_owner(character_id), body.ids)


# Deleting for good is the window's alone: the MCP layer has no tool for
# it, so a model can never make a picture, a Backup or cleared Labels
# unrecoverable.
@router.post("/flist/character/{character_id}/trash/purge")
def flist_character_trash_purge(character_id: str, body: _ImageIdsBody) -> dict:
    return image_trash_service.purge_images(character_id, body.image_ids)


@router.post("/flist/character/{character_id}/trash/backups/purge")
def flist_character_trash_backups_purge(
    character_id: str, body: _TrashIdsBody
) -> dict:
    return backup_trash_service.purge_backups(character_id, body.ids)


@router.post("/flist/character/{character_id}/trash/labels/purge")
def flist_character_trash_labels_purge(
    character_id: str, body: _TrashIdsBody
) -> dict:
    return label_trash_service.purge(_trash_owner(character_id), body.ids)


@router.delete("/flist/character/{character_id}/trash")
def flist_character_trash_empty(character_id: str) -> dict:
    """Empty the whole Trash: images, Backups and cleared Labels."""
    owner = _trash_owner(character_id)
    return {
        "purged": image_trash_service.empty_trash(character_id)
        + backup_trash_service.empty(character_id)
        + label_trash_service.empty(owner)
    }


@router.get("/flist/character/{character_id}/inlines/{filename}")
def flist_character_inline(character_id: str, filename: str) -> FileResponse:
    archive_images.require_image_filename(filename)
    path = archive_images.inlines_dir(character_id) / filename
    if not path.exists():
        raise ImageNotFound("inline not found")
    return FileResponse(path)


@router.get("/labels/trash")
def labels_trash_list() -> dict:
    """Every cleared-Labels entry in the Trash, newest first, for
    Settings → Labels. Unlike a character's Trash view this includes a
    Log character with no Workbench, and one whose Log name matches no
    character in the list."""
    return {"labels": label_trash_service.list_labels(None)}


@router.post("/labels/trash/restore")
def labels_trash_restore(body: _TrashIdsBody) -> dict:
    """Put cleared Labels back, whichever character they were cleared
    for. A message labelled again since keeps its newer Label and is
    reported under `skipped`."""
    return label_trash_service.restore(None, body.ids)


@router.post("/labels/trash/purge")
def labels_trash_purge(body: _TrashIdsBody) -> dict:
    """Delete cleared Labels for good. The window's call only: MCP has
    no tool for it."""
    return label_trash_service.purge(None, body.ids)
