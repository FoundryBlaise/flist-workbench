"""Bringing image files from elsewhere on this machine into a
character's image folder (the pool), for the MCP import tools.

The window's own upload hands the sidecar bytes the user dropped in.
Here a tool names a path instead, so the first question is whether it
may read that path at all: only folders the user listed under
Settings → Security qualify, and only the window can change that list.
A model that could widen its own reach would make the list pointless.

Everything else follows the upload path: the format is judged by the
bytes, identical bytes are stored once, and the id is `local-<sha8>`
until a pull proves the picture is on the profile under an F-list id.
The source file is only ever read.

Nothing here talks to f-list.net.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import character_archive
import settings as settings_store

#: F-list's upload limits, as the user reports them: under 2.0 MB and
#: under 4000 px on either side. A file over them is still imported —
#: the user may want to shrink it later — but the result says so.
MAX_UPLOAD_BYTES = 2_000_000
MAX_SIDE_PX = 4000

#: Refuse to read anything larger. No profile image comes near this,
#: and reading a stray video into memory helps nobody.
MAX_SOURCE_BYTES = 50 * 1024 * 1024

JPEG_QUALITY = 95

META_FILENAME = "image_meta.json"

_meta_lock = threading.Lock()


class ImportRefused(Exception):
    """A source that cannot be imported, with a stable code the MCP
    layer turns into a ToolError."""

    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.details = details


# --------------------------------------------------------------------
# Allowed folders
# --------------------------------------------------------------------


def import_roots(conn: Any = None) -> list[Path]:
    """The folders imports may read from, as stored. Empty when the user
    has not set any."""
    own = conn is None
    conn = conn or settings_store.connect()
    try:
        raw = settings_store.get(conn, settings_store.KEY_IMAGE_IMPORT_ROOTS)
    finally:
        if own:
            conn.close()
    if not raw:
        return []
    try:
        values = json.loads(raw)
    except ValueError:
        return []
    if not isinstance(values, list):
        return []
    return [Path(v) for v in values if isinstance(v, str) and v.strip()]


def save_import_roots(conn: Any, roots: list[str]) -> list[str]:
    """Validate and store the folder list. Raises ValueError naming the
    first entry that is not an existing absolute directory."""
    cleaned: list[str] = []
    seen: set[str] = set()
    for value in roots:
        text = str(value or "").strip()
        if not text:
            continue
        p = Path(text).expanduser()
        if not p.is_absolute():
            raise ValueError(f"not an absolute path: {text}")
        if not p.is_dir():
            raise ValueError(f"directory does not exist: {text}")
        key = os.path.normcase(str(p.resolve()))
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(str(p))
    if cleaned:
        settings_store.set_value(
            conn, settings_store.KEY_IMAGE_IMPORT_ROOTS, json.dumps(cleaned)
        )
    else:
        settings_store.clear(conn, settings_store.KEY_IMAGE_IMPORT_ROOTS)
    return cleaned


def _inside(path: Path, root: Path) -> bool:
    try:
        root_real = root.resolve()
    except OSError:
        return False
    a = os.path.normcase(str(path))
    b = os.path.normcase(str(root_real))
    try:
        return os.path.commonpath([a, b]) == b
    except ValueError:
        # Different drives.
        return False


def check_source(source_path: str, roots: list[Path]) -> Path:
    """Resolve `source_path` and make sure it is a file inside one of
    `roots`. Symlinks and `..` are resolved first, so neither can step
    outside a cleared folder. Whether a file exists is only reported for
    paths inside one; outside, every refusal reads the same."""
    raw = str(source_path or "").strip()
    if not raw:
        raise ImportRefused("source_path_missing", "No source path given.")
    p = Path(raw).expanduser()
    if not p.is_absolute():
        raise ImportRefused(
            "source_path_not_absolute",
            f"'{raw}' is not an absolute path.",
        )
    if not roots:
        raise ImportRefused(
            "no_import_folders",
            "No folders are cleared for importing images. The user adds "
            "them in the Workbench window under Settings → Security; "
            "there is no tool for it on purpose.",
        )
    try:
        real = p.resolve()
    except (OSError, RuntimeError) as exc:
        raise ImportRefused("source_not_found", f"Cannot resolve '{raw}'.") from exc
    if not any(_inside(real, root) for root in roots):
        raise ImportRefused(
            "source_not_allowed",
            f"'{raw}' is outside the folders cleared for importing images.",
            allowed=[str(r) for r in roots],
        )
    if not real.is_file():
        raise ImportRefused("source_not_found", f"No file at '{raw}'.")
    return real


# --------------------------------------------------------------------
# Reading and checking one source
# --------------------------------------------------------------------


@dataclass
class PreparedImage:
    """A source read into memory and checked, not yet stored."""

    source_name: str
    data: bytes
    extension: str
    width: int | None
    height: int | None
    warnings: list[str] = field(default_factory=list)
    converted: bool = False


def dimensions(source: bytes | Path) -> tuple[int | None, int | None]:
    """Width and height from the image header, or (None, None) when it
    cannot be read as an image. A path is opened lazily: only the header
    is read."""
    try:
        from PIL import Image
    except ImportError:
        return None, None
    try:
        with Image.open(io.BytesIO(source) if isinstance(source, bytes) else source) as img:
            width, height = img.size
            return int(width), int(height)
    except Exception:  # noqa: BLE001 - a header we can't read has no size
        return None, None


def limit_warnings(nbytes: int, width: int | None, height: int | None) -> list[str]:
    out: list[str] = []
    if nbytes >= MAX_UPLOAD_BYTES:
        out.append("over_2mb")
    if (width or 0) >= MAX_SIDE_PX or (height or 0) >= MAX_SIDE_PX:
        out.append("over_4000px")
    return out


def to_jpeg(data: bytes) -> tuple[bytes | None, str | None]:
    """Re-encode as JPEG at quality 95. Returns (bytes, None), or (None,
    reason) when converting would change what the picture is: an
    animation would lose its frames, and transparency would have to be
    painted over with a colour nobody chose."""
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return None, "conversion_unavailable"
    try:
        with Image.open(io.BytesIO(data)) as img:
            if getattr(img, "n_frames", 1) > 1:
                return None, "not_converted_animated"
            if _has_visible_transparency(img):
                return None, "not_converted_transparency"
            icc = img.info.get("icc_profile")
            upright = ImageOps.exif_transpose(img)
            rgb = upright.convert("RGB")
            out = io.BytesIO()
            save_kwargs: dict[str, Any] = {"quality": JPEG_QUALITY, "optimize": True}
            if icc:
                save_kwargs["icc_profile"] = icc
            rgb.save(out, "JPEG", **save_kwargs)
            return out.getvalue(), None
    except Exception:  # noqa: BLE001 - keep the original rather than fail the import
        return None, "conversion_failed"


def _has_visible_transparency(img: Any) -> bool:
    if img.mode in ("RGBA", "LA", "PA"):
        alpha = img.getchannel("A")
    elif img.mode == "P" and "transparency" in img.info:
        alpha = img.convert("RGBA").getchannel("A")
    else:
        return False
    low, _high = alpha.getextrema()
    return low < 255


def prepare(
    source_path: str, *, roots: list[Path], convert_to_jpeg: bool = False
) -> PreparedImage:
    """Read and check one source. Nothing is written."""
    path = check_source(source_path, roots)
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ImportRefused("source_unreadable", f"Cannot read '{source_path}'.") from exc
    if size > MAX_SOURCE_BYTES:
        raise ImportRefused(
            "source_too_large",
            f"{path.name} is {size // (1024 * 1024)} MB; imports stop at "
            f"{MAX_SOURCE_BYTES // (1024 * 1024)} MB.",
        )
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise ImportRefused("source_unreadable", f"Cannot read '{source_path}'.") from exc
    ext = character_archive.detect_image_ext(data)
    if ext is None:
        raise ImportRefused(
            "not_an_image",
            f"{path.name} is not a PNG, JPEG or GIF. The format is judged "
            "by the file's content, not its name.",
        )
    width, height = dimensions(data)
    warnings = limit_warnings(len(data), width, height)
    converted = False
    if convert_to_jpeg and warnings:
        jpeg, reason = to_jpeg(data)
        if reason:
            warnings.append(reason)
        elif jpeg is not None and len(jpeg) < len(data):
            data, ext, converted = jpeg, "jpg", True
            width, height = dimensions(data)
            warnings = limit_warnings(len(data), width, height)
        else:
            warnings.append("jpeg_not_smaller")
    return PreparedImage(
        source_name=path.name,
        data=data,
        extension=ext,
        width=width,
        height=height,
        warnings=warnings,
        converted=converted,
    )


def store(character_id: int | str, prepared: PreparedImage) -> dict[str, Any]:
    """Put prepared bytes into the character's image folder (or find the
    identical file already there) and remember where they came from."""
    row = character_archive.add_uploaded_image(character_id, prepared.data)
    if row is None:
        # prepare() already sniffed the format; this is a disk problem.
        raise ImportRefused("store_failed", f"Could not store {prepared.source_name}.")
    sha = hashlib.sha256(prepared.data).hexdigest()
    record_source(character_id, sha, prepared.source_name)
    return {**row, "sha256": sha}


# --------------------------------------------------------------------
# Where a file came from
#
# Keyed by the sha256 of the stored bytes, not by image id: the id of an
# upload changes when a pull hands it over to F-list's id, the bytes do
# not.
# --------------------------------------------------------------------


def _meta_path(character_id: int | str) -> Path:
    return character_archive.character_dir(character_id) / META_FILENAME


def read_meta(character_id: int | str) -> dict[str, dict[str, Any]]:
    p = _meta_path(character_id)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def record_source(character_id: int | str, sha: str, source_name: str) -> None:
    """Remember the name a file was imported under. The first name wins:
    importing the same bytes again under another name changes nothing."""
    with _meta_lock:
        meta = read_meta(character_id)
        if sha in meta and meta[sha].get("source_name"):
            return
        meta[sha] = {"source_name": source_name, "imported_at": int(time.time())}
        p = _meta_path(character_id)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(p)


# --------------------------------------------------------------------
# Where an image is still used
# --------------------------------------------------------------------


def _image_ids(payload: dict[str, Any] | None) -> set[str]:
    rows = (payload or {}).get("images")
    if not isinstance(rows, list):
        return set()
    out: set[str] = set()
    for row in rows:
        if isinstance(row, dict):
            image_id = row.get("image_id") or row.get("id")
            if image_id is not None:
                out.add(str(image_id))
    return out


def references(character_id: int | str) -> dict[str, dict[str, Any]]:
    """For every image id mentioned anywhere: which working sets carry
    it, whether the live profile does, and in how many pull snapshots it
    appears (with the newest). Backups are left out: each ZIP carries its
    own copy of the bytes, so nothing in one depends on the pool."""

    def empty() -> dict[str, Any]:
        return {"working_sets": [], "live": False, "snapshots": 0, "newest_snapshot": None}

    out: dict[str, dict[str, Any]] = defaultdict(empty)
    for meta in character_archive.list_sets(character_id):
        payload = character_archive.read_set_payload(character_id, meta.id)
        for image_id in _image_ids(payload):
            out[image_id]["working_sets"].append(meta.name)
    for image_id in _image_ids(character_archive.read_live(character_id)):
        out[image_id]["live"] = True
    try:
        snapshots = character_archive.list_snapshots(character_id)
    except OSError:
        snapshots = []
    for snap in snapshots:  # newest first
        payload = character_archive.read_snapshot(character_id, snap["filename"])
        for image_id in _image_ids(payload):
            entry = out[image_id]
            entry["snapshots"] += 1
            if entry["newest_snapshot"] is None:
                entry["newest_snapshot"] = snap["filename"]
    return dict(out)
