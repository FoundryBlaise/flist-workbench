"""A character's images and inlines, and the Trash.

The Trash routes cover all three kinds it holds: images, Backups and
cleared Labels, per character and, for Labels, across all of them.
"""

from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, RootModel
from starlette.concurrency import run_in_threadpool

import archive_images
import archive_registry
from refusals import ImageNotFound, InvalidFileName, InvalidRequest, TooLarge, UnsupportedType
from services import backup_trash as backup_trash_service
from services import image_import as image_import_service
from services import image_trash as image_trash_service
from services import label_trash as label_trash_service
from wire import WireModel, image

router = APIRouter()


class PoolImage(WireModel):
    """An image file in the character's Pool."""

    image_id: str
    extension: str
    size: int
    #: The file's mtime, unix seconds.
    added_at: int


class Pool(WireModel):
    character_id: str
    images: list[PoolImage]


class UploadedImage(WireModel):
    """The Pool image an upload landed as. `deduplicated`: the Pool
    already held these bytes, and this is that file."""

    image_id: str
    extension: str
    size: int
    added_at: int
    deduplicated: bool


class Relinked(WireModel):
    from_: str = Field(alias="from")
    to: str


class GalleryRepair(WireModel):
    """What putting the gallery back together changed."""

    relinked: list[Relinked]
    duplicates_removed: list[str]
    stale_removed: list[str]
    unresolved: list[str]
    workbench_rewritten: bool
    repaired: bool


class ImageTrashed(WireModel):
    trashed: Literal[True]
    image_id: str


class TrashedImage(WireModel):
    """An image just moved into the Trash."""

    trash_id: str
    image_id: str
    extension: str
    deleted_at: int
    #: 'ui' or 'mcp'.
    deleted_by: str | None
    size: int
    sha256: str
    source_name: str | None


class ImagesDeleted(WireModel):
    """Images deleted: their files went to the Trash (`trashed`), and
    those the Workbench's gallery showed came off it (`off_gallery`).
    `etag` is the Workbench's new one; null when the gallery was left
    alone."""

    trashed: list[TrashedImage]
    not_found: list[str]
    off_gallery: list[str]
    etag: str | None


class ImageReference(WireModel):
    """Where an image id is still used beyond the Pool: the Workbench's
    gallery, Live, and how many Backups keep it (each with its own copy
    of the bytes), with the newest of them. `migration_backup`: the
    older copies from before the upgrade name it; that Backup holds
    JSON only, no copy of the bytes, and is not counted in `backups`."""

    workbench: bool
    live: bool
    backups: int
    newest_backup: str | None
    migration_backup: bool


class ImageReferences(RootModel[dict[str, ImageReference]]):
    """Every image id mentioned anywhere, and where."""


class TrashItem(WireModel):
    """An image file in a character's Trash."""

    #: Names this entry for put-back and purge: the image id, unless the
    #: Trash holds several files under that id (a Pull replaced one).
    trash_id: str
    image_id: str
    extension: str
    filename: str
    size: int
    deleted_at: int
    #: 'ui' or 'mcp'; null for a file that got there without an index entry.
    deleted_by: str | None
    source_name: str | None


class TrashedBackup(WireModel):
    """A deleted Backup in a character's Trash."""

    #: Its file name in the Trash; what put-back and purge take.
    id: str
    #: Its file name in the Backup list, where a put-back returns it.
    filename: str
    #: The user-set name it had, kept for the put-back.
    name: str | None
    size: int
    deleted_at: int
    deleted_by: str | None


class TrashedLabels(WireModel):
    """Labels cleared in one go, kept in the Trash."""

    #: What put-back and purge take.
    id: str
    #: The Log character they were cleared for; null for Labels whose
    #: messages were in none of the Logs when every Label was reset.
    character: str | None
    #: The conversation cleared; null when every conversation was.
    partner: str | None
    #: How many Labels the entry holds.
    count: int
    deleted_at: int
    deleted_by: str | None


class Trash(WireModel):
    """A character's Trash: images, Backups and cleared Labels."""

    character_id: str
    items: list[TrashItem]
    backups: list[TrashedBackup]
    labels: list[TrashedLabels]


class PutBackImage(WireModel):
    """An image back in the Pool. `deduplicated`: the Pool already held
    these bytes (under `image_id`), so the Trash's copy was dropped."""

    image_id: str
    deduplicated: bool
    from_: str = Field(alias="from")


class ImagesPutBack(WireModel):
    restored: list[PutBackImage]
    not_found: list[str]
    #: Trash ids left in the Trash: the Pool holds other bytes under
    #: every name they could come back as.
    conflicts: list[str]


class BackupsPutBack(WireModel):
    #: The Backups' file names in the Backup list.
    restored: list[str]
    not_found: list[str]
    conflicts: list[str]


class PutBackLabels(WireModel):
    """One cleared-Labels entry put back. A message labelled again
    since keeps its newer Label; its hash is under `skipped`."""

    id: str
    restored: int
    skipped: list[str]


class LabelsPutBack(WireModel):
    restored: list[PutBackLabels]
    not_found: list[str]


class TrashPurged(WireModel):
    """What was deleted for good from the Trash, by the id it had there."""

    purged: list[str]
    not_found: list[str]


class TrashEmptied(WireModel):
    #: How many entries were deleted for good.
    purged: int


class LabelsTrash(WireModel):
    labels: list[TrashedLabels]


@router.get(
    "/flist/character/{character_id}/images/{filename}",
    response_class=FileResponse,
    responses=image("An image file in the Pool."),
)
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
def flist_character_images_list(character_id: str) -> Pool:
    """List the files in `images/`. Each row: `{image_id, extension,
    size, added_at}`. Renderer pairs these with description/sort_order
    from the Workbench to decide which are on the profile vs. in the
    Pool view."""
    return Pool.model_validate(
        {
            "character_id": character_id,
            "images": archive_images.list_character_images(character_id),
        }
    )


@router.get(
    "/flist/character/{character_id}/image/{image_id}",
    response_class=FileResponse,
    responses=image("The Pool's image file of that id."),
)
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
) -> UploadedImage:
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
    return UploadedImage.model_validate(row)


@router.post("/flist/character/{character_id}/images/repair")
def flist_character_images_repair(character_id: str) -> GalleryRepair:
    """Put the gallery back together when entries have lost their bytes.

    Called when the Images tab opens. A slot pointing at a file that is
    gone renders as a black placeholder, and — worse — drops out of the
    restore ZIP, which the extension reads as "delete this from the
    profile". Users lost images on f-list.net that way, so this runs on
    its own rather than waiting to be found in a menu.

    Cheap: it hashes the character's own image files and nothing else.
    """
    return GalleryRepair.model_validate(archive_images.repair_gallery(character_id))


@router.delete("/flist/character/{character_id}/images/{image_id}")
def flist_character_image_remove(
    character_id: str, image_id: str
) -> ImageTrashed:
    """Delete one image: off the Workbench's gallery if it is there,
    and into the character's Trash, where it can be restored until the
    Trash is emptied. The same as the batch route below."""
    result = image_trash_service.delete_images(character_id, [image_id])
    if not result["trashed"]:
        raise ImageNotFound("image not found")
    return ImageTrashed(trashed=True, image_id=image_id)


class _ImageIdsBody(BaseModel):
    image_ids: list[str]


@router.post("/flist/character/{character_id}/images/trash")
def flist_character_images_trash(character_id: str, body: _ImageIdsBody) -> ImagesDeleted:
    """Delete images, whether in the gallery or only in the Pool: the
    window's delete, and the same function MCP's `trash_images` calls.
    A gallery image is taken off the Workbench's gallery first; the
    answer's `etag` is the Workbench's new one (None when the gallery
    was left alone), which the window saves its next edit over."""
    return ImagesDeleted.model_validate(image_trash_service.delete_images(character_id, body.image_ids))


# Not under /images/: that prefix is taken by the `{filename}` route.
@router.get("/flist/character/{character_id}/image-references")
def flist_character_image_references(character_id: str) -> ImageReferences:
    """Where each image id is still used — the Workbench, Live and
    Backups — so the window can warn before trashing one."""
    return ImageReferences.model_validate(image_import_service.references(character_id))


@router.get("/flist/character/{character_id}/trash")
def flist_character_trash_list(character_id: str) -> Trash:
    return Trash.model_validate(
        {
        "character_id": character_id,
            "items": image_trash_service.list_trash(character_id),
            "backups": backup_trash_service.list_backups(character_id),
            "labels": label_trash_service.list_labels(_trash_owner(character_id)),
        }
    )


@router.get(
    "/flist/character/{character_id}/trash/{filename}",
    response_class=FileResponse,
    responses=image("An image file in the Trash."),
)
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


@router.post("/flist/character/{character_id}/trash/put-back")
def flist_character_trash_put_back(character_id: str, body: _ImageIdsBody) -> ImagesPutBack:
    """Put trashed files back into the Pool (not onto the profile)."""
    return ImagesPutBack.model_validate(image_trash_service.restore_images(character_id, body.image_ids))


class _TrashIdsBody(BaseModel):
    ids: list[str]


@router.post("/flist/character/{character_id}/trash/backups/put-back")
def flist_character_trash_backups_put_back(
    character_id: str, body: _TrashIdsBody
) -> BackupsPutBack:
    """Put trashed Backups back in the Backup list, under their names."""
    return BackupsPutBack.model_validate(backup_trash_service.restore_backups(character_id, body.ids))


def _trash_owner(character_id: str) -> str:
    """The name this character's cleared Labels are kept under, for the
    Trash routes. The id is checked first, as every Trash route checks
    it: an unsafe one is refused with `invalid_character_id` (400), one
    the archive does not hold with `character_not_found` (404). A
    character without a name owns no cleared Labels: its listing shows
    none and a put-back or purge finds none (`""` matches no entry)."""
    archive_registry.character_dir(character_id)
    return archive_registry.character_name(character_id) or ""


@router.post("/flist/character/{character_id}/trash/labels/put-back")
def flist_character_trash_labels_put_back(
    character_id: str, body: _TrashIdsBody
) -> LabelsPutBack:
    """Put cleared Labels back. A message labelled again since keeps
    its newer Label and is reported under `skipped`."""
    return LabelsPutBack.model_validate(label_trash_service.restore(_trash_owner(character_id), body.ids))


# Deleting for good is the window's alone: the MCP layer has no tool for
# it, so a model can never make a picture, a Backup or cleared Labels
# unrecoverable.
@router.post("/flist/character/{character_id}/trash/purge")
def flist_character_trash_purge(character_id: str, body: _ImageIdsBody) -> TrashPurged:
    return TrashPurged.model_validate(image_trash_service.purge_images(character_id, body.image_ids))


@router.post("/flist/character/{character_id}/trash/backups/purge")
def flist_character_trash_backups_purge(
    character_id: str, body: _TrashIdsBody
) -> TrashPurged:
    return TrashPurged.model_validate(backup_trash_service.purge_backups(character_id, body.ids))


@router.post("/flist/character/{character_id}/trash/labels/purge")
def flist_character_trash_labels_purge(
    character_id: str, body: _TrashIdsBody
) -> TrashPurged:
    return TrashPurged.model_validate(label_trash_service.purge(_trash_owner(character_id), body.ids))


@router.delete("/flist/character/{character_id}/trash")
def flist_character_trash_empty(character_id: str) -> TrashEmptied:
    """Empty the whole Trash: images, Backups and cleared Labels."""
    owner = _trash_owner(character_id)
    return TrashEmptied(
        purged=image_trash_service.empty_trash(character_id)
        + backup_trash_service.empty(character_id)
        + label_trash_service.empty(owner)
    )


@router.get(
    "/flist/character/{character_id}/inlines/{filename}",
    response_class=FileResponse,
    responses=image("An inline image file of the profile."),
)
def flist_character_inline(character_id: str, filename: str) -> FileResponse:
    archive_images.require_image_filename(filename)
    path = archive_images.inlines_dir(character_id) / filename
    if not path.exists():
        raise ImageNotFound("inline not found")
    return FileResponse(path)


@router.get("/labels/trash")
def labels_trash_list() -> LabelsTrash:
    """Every cleared-Labels entry in the Trash, newest first, for
    Settings → Labels. Unlike a character's Trash view this includes a
    Log character with no Workbench, and one whose Log name matches no
    character in the list."""
    return LabelsTrash.model_validate({"labels": label_trash_service.list_labels(None)})


@router.post("/labels/trash/put-back")
def labels_trash_put_back(body: _TrashIdsBody) -> LabelsPutBack:
    """Put cleared Labels back, whichever character they were cleared
    for. A message labelled again since keeps its newer Label and is
    reported under `skipped`."""
    return LabelsPutBack.model_validate(label_trash_service.restore(None, body.ids))


@router.post("/labels/trash/purge")
def labels_trash_purge(body: _TrashIdsBody) -> TrashPurged:
    """Delete cleared Labels for good. The window's call only: MCP has
    no tool for it."""
    return TrashPurged.model_validate(label_trash_service.purge(None, body.ids))
