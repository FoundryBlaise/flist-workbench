"""A character's images: `images/<image_id>.<ext>`, `inlines/` and avatars.

Also the pull manifest (`pull_state.json`, what a Pull meant to fetch),
and the gallery upkeep that keeps the Workbench's gallery and the files
in step: dedupe, repair and adopting the ids F-list gave uploads.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any, Iterable

import archive_live
import archive_registry
import archive_workbench
import atomic_write
from refusals import InvalidFileName

PULL_STATE_FILENAME = "pull_state.json"


def images_dir(character_id: int | str) -> Path:
    p = archive_registry.character_dir(character_id) / "images"
    p.mkdir(parents=True, exist_ok=True)
    return p


def inlines_dir(character_id: int | str) -> Path:
    p = archive_registry.character_dir(character_id) / "inlines"
    p.mkdir(parents=True, exist_ok=True)
    return p


# ---- image storage ----------------------------------------------------


# Whitelist for safe filename segments. The pre-dot section must have
# at least one non-`.` character, which is what excludes `.` and `..`
# (both would otherwise satisfy `[A-Za-z0-9_.-]+`). Without this, the
# inline_path("..") case resolved to the parent directory — caught by
# the test_inline_path_rejects_unsafe_basename test added 2026-05-30.
_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$")

# `<image_id>.<ext>` filename in `images/`. image_id is digits for F-list
# images, `local-<8 hex>` for pool-only user uploads not yet on F-list.
# Always used with fullmatch.
_IMAGE_ID_RE = re.compile(r"[A-Za-z0-9_-]+")
_IMAGE_FILE_RE = re.compile(r"([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)")


def require_image_filename(filename: str) -> None:
    """Refuse a name that is not `<image_id>.<ext>` (an image, a trashed
    file, an inline), before any path is built from it. A caller hears
    400 `invalid_file_name`."""
    if not isinstance(filename, str) or not _IMAGE_FILE_RE.fullmatch(filename):
        raise InvalidFileName("invalid image filename")


def require_image_id(image_id: str) -> None:
    """Refuse an image id that could not be the stem of an image file
    name. A caller hears 400 `invalid_file_name`."""
    if not isinstance(image_id, str) or not _IMAGE_ID_RE.fullmatch(image_id):
        raise InvalidFileName("invalid image_id")


# ---- pull integrity manifest -----------------------------------------


def pull_state_path(character_id: int | str) -> Path:
    return archive_registry.character_dir(character_id) / PULL_STATE_FILENAME


def write_pull_state(
    character_id: int | str,
    expected_image_ids: Iterable[dict[str, Any]],
    started_at: int,
    finished_at: int | None,
) -> None:
    """Record the manifest of what a pull attempted. Written twice per
    pull — once at the start of the image loop with `finished_at=None`,
    once at the end with `finished_at=<unix>`. A `None` finished_at on
    next launch means the pull was killed mid-flight (sleep, crash,
    network drop) — `compute_pull_status` surfaces that to the renderer.

    expected_image_ids: list of {"image_id": str, "extension": str}
    """
    normalized: list[dict[str, str]] = []
    for entry in expected_image_ids:
        if not isinstance(entry, dict):
            continue
        iid = entry.get("image_id")
        ext = entry.get("extension")
        if iid and ext:
            normalized.append({"image_id": str(iid), "extension": str(ext)})
    archive_registry._atomic_write_json(
        pull_state_path(character_id),
        {
            "started_at": started_at,
            "finished_at": finished_at,
            "expected_image_ids": normalized,
        },
    )


def read_pull_state(character_id: int | str) -> dict[str, Any] | None:
    p = pull_state_path(character_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _images_present_ids(character_id: int | str) -> set[str]:
    """F-list image_ids currently present in `images/`. Synthetic
    `local-*` ids are excluded — they're user uploads the userscript
    hasn't restored to F-list yet, not part of the F-list mirror that
    compute_pull_status reconciles against."""
    out: set[str] = set()
    d = images_dir(character_id)
    if not d.exists():
        return out
    for p in d.iterdir():
        if not p.is_file():
            continue
        m = _IMAGE_FILE_RE.fullmatch(p.name)
        if not m:
            continue
        iid = m.group(1)
        if iid.startswith("local-"):
            continue
        out.add(iid)
    return out


def compute_pull_status(character_id: int | str) -> dict[str, Any]:
    """Reconcile manifest with disk and return a renderer-ready status.

    status:
      'never_pulled' — no live.json yet
      'unknown'      — live.json exists but no manifest (pre-fix archive)
      'interrupted'  — manifest's finished_at is null (killed mid-pull)
      'partial'      — finished_at set but some expected images aren't on disk
      'complete'     — finished_at set and every expected image is present
    """
    live = archive_live.read_live(character_id)
    if live is None:
        return {
            "status": "never_pulled",
            "missing_image_ids": [],
            "expected": 0,
            "present": 0,
            "last_attempt_ts": None,
        }
    state = read_pull_state(character_id)
    present_ids = _images_present_ids(character_id)
    if state is None:
        # Legacy archive — no manifest. Best-guess from live.json's image
        # list; treat as complete if disk matches, partial otherwise. Means
        # users with archives from before this commit still get the warning
        # surfaced if their previous pull was actually incomplete.
        expected = _expected_from_live(live)
        missing = [e for e in expected if e["image_id"] not in present_ids]
        return {
            "status": "complete" if not missing else "partial",
            "missing_image_ids": missing,
            "expected": len(expected),
            "present": len(expected) - len(missing),
            "last_attempt_ts": live.get("fetched_at"),
        }
    expected = state.get("expected_image_ids") or []
    expected = [e for e in expected if isinstance(e, dict) and e.get("image_id") and e.get("extension")]
    missing = [e for e in expected if str(e["image_id"]) not in present_ids]
    finished_at = state.get("finished_at")
    started_at = state.get("started_at")
    last_attempt_ts = finished_at or started_at or live.get("fetched_at")
    if finished_at is None:
        status = "interrupted"
    elif missing:
        status = "partial"
    else:
        status = "complete"
    return {
        "status": status,
        "missing_image_ids": missing,
        "expected": len(expected),
        "present": len(expected) - len(missing),
        "last_attempt_ts": last_attempt_ts,
    }


def _expected_from_live(live: dict[str, Any]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for img in (live.get("images") or []):
        if not isinstance(img, dict):
            continue
        iid = img.get("image_id") or img.get("id")
        ext = img.get("extension")
        if iid and ext:
            out.append({"image_id": str(iid), "extension": str(ext)})
    return out


def image_path(character_id: int | str, image_id: str, ext: str) -> Path:
    """`images/<image_id>.<ext>`. Both parts are validated against a
    conservative whitelist so a hostile filename in a payload can't
    escape the character's archive directory."""
    if not _SAFE_NAME_RE.fullmatch(image_id):
        raise ValueError(f"unsafe image_id: {image_id!r}")
    if not _SAFE_NAME_RE.fullmatch(ext):
        raise ValueError(f"unsafe extension: {ext!r}")
    return images_dir(character_id) / f"{image_id}.{ext}"


def inline_path(character_id: int | str, basename: str) -> Path:
    """`inlines/<basename>`. The basename is the CDN URL's last segment
    (typically `<sha1>.<ext>`); validated against the safe-name regex."""
    if not _SAFE_NAME_RE.fullmatch(basename):
        raise ValueError(f"unsafe inline name: {basename!r}")
    return inlines_dir(character_id) / basename


# ---- per-character images/ (unified store, image_id-keyed) -----------

# F-list only accepts these on upload, so the image store mirrors that
# whitelist — the userscript would reject anything else on restore.
_IMAGE_EXTS = frozenset({"png", "jpg", "jpeg", "gif"})


def normalise_image_ext(ext: str) -> str:
    """Lowercase + jpeg→jpg + whitelist check. Raises ValueError on
    anything outside `{png, jpg, gif}`. Public so the server's pull loop
    can normalise raw extensions from F-list without reaching into a
    private."""
    e = ext.lower().lstrip(".")
    if e == "jpeg":
        e = "jpg"
    if e not in {"png", "jpg", "gif"}:
        raise ValueError(f"unsupported image extension: {ext!r}")
    return e


def _hash_bytes(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


def detect_image_ext(data: bytes) -> str | None:
    """Sniff PNG/JPEG/GIF magic bytes and return the canonical extension
    ('png'/'jpg'/'gif'). Returns None when the bytes don't match any
    supported format — callers should reject the upload."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        return "gif"
    return None


def list_character_images(character_id: int | str) -> list[dict[str, Any]]:
    """Walk `images/` and return one row per file: `{image_id, extension,
    size, added_at}`. `added_at` is the file mtime (unix seconds) so the
    renderer can sort the Pool pane newest-first. The renderer pairs
    these rows with `description`/`sort_order` from the Workbench to
    decide which are on the profile vs. in the pool view.

    Side-effect: collapses any `local-<sha8>` files whose bytes match an
    existing real-id file. Idempotent — a no-op once the disk is clean.
    A `pool/` folder left by v0.0.3 or older stays untouched."""
    collapse_local_duplicates(character_id)
    out: list[dict[str, Any]] = []
    d = images_dir(character_id)
    if not d.exists():
        return out
    for entry in d.iterdir():
        if not entry.is_file():
            continue
        m = _IMAGE_FILE_RE.fullmatch(entry.name)
        if not m:
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        out.append(
            {
                "image_id": m.group(1),
                "extension": m.group(2).lower(),
                "size": stat.st_size,
                "added_at": int(stat.st_mtime),
            }
        )
    out.sort(key=lambda r: r["image_id"])
    return out


def write_character_image(
    character_id: int | str,
    image_id: str,
    ext: str,
    data: bytes,
) -> None:
    """Atomically write `data` to `images/<image_id>.<ext>`. Idempotent
    — re-calling with the same id+ext overwrites in place (pull loop
    relies on this for re-pulls). `image_id` and `ext` are validated
    against the safe-name regex; `ext` is normalised (jpeg → jpg)."""
    if not _SAFE_NAME_RE.fullmatch(image_id):
        raise ValueError(f"unsafe image_id: {image_id!r}")
    ext_n = normalise_image_ext(ext)
    atomic_write.write_bytes(images_dir(character_id) / f"{image_id}.{ext_n}", data)


def find_image_with_sha(
    character_id: int | str, sha: str
) -> Path | None:
    """Return the first file in `images/` whose bytes hash to `sha`, or
    None. Cheap pre-filter on the sha-prefix in the filename (real
    F-list ids won't match by accident, but `local-<sha8>` files will);
    falls back to a full directory scan with byte-comparison for real-id
    files since their basenames don't carry the sha. Best-effort — any
    OSError on a single entry is skipped, not raised."""
    d = images_dir(character_id)
    if not d.exists():
        return None
    for entry in d.iterdir():
        if not entry.is_file():
            continue
        if not _IMAGE_FILE_RE.fullmatch(entry.name):
            continue
        try:
            if entry.stat().st_size == 0:
                continue
            if file_sha256(entry) == sha:
                return entry
        except OSError:
            continue
    return None


#: (path, size, mtime_ns) -> sha256. A batch import checks every new
#: file against the whole folder; without this each check re-reads and
#: re-hashes every image on disk. Keyed on size and mtime so a file
#: rewritten in place is hashed again.
_sha_cache: dict[tuple[str, int, int], str] = {}


def file_sha256(path: Path) -> str:
    """sha256 of a file's bytes, cached per (path, size, mtime). Raises
    OSError like `read_bytes` would."""
    stat = path.stat()
    key = (str(path), stat.st_size, stat.st_mtime_ns)
    cached = _sha_cache.get(key)
    if cached is not None:
        return cached
    digest = _hash_bytes(path.read_bytes())
    _sha_cache[key] = digest
    return digest


def collapse_local_duplicates(character_id: int | str) -> int:
    """Fold every `local-<sha8>` image whose bytes match a real-id file
    into that real id, in the character's Workbench.

    The cure for an archive where the same picture sits in the pool
    twice — once as the file that came from F-list, once as the local
    upload it was made from. Returns how many locals were folded in.

    Idempotent, and best-effort: a single unreadable file is skipped
    rather than failing the sweep.
    """
    d = images_dir(character_id)
    if not d.exists():
        return 0

    by_sha: dict[str, str] = {}
    locals_: list[tuple[str, str]] = []
    for entry in sorted(d.iterdir()):
        if not entry.is_file():
            continue
        m = _IMAGE_FILE_RE.fullmatch(entry.name)
        if not m:
            continue
        image_id = m.group(1)
        try:
            sha = _hash_bytes(entry.read_bytes())
        except OSError:
            continue
        if image_id.startswith("local-"):
            locals_.append((image_id, sha))
        else:
            by_sha.setdefault(sha, image_id)

    mapping = {
        local_id: by_sha[sha] for local_id, sha in locals_ if sha in by_sha
    }
    if not mapping:
        return 0
    # Maintenance triggered by a read (the Images tab listing), which is
    # still not the window writing: attribute it like the repair, or the
    # listing itself silently invalidates open windows' etags.
    from services import events  # lazy, same reason as archive_registry._publish

    with events.origin("internal:image-dedupe"):
        result = adopt_flist_image_ids(character_id, mapping)
    return len(result["renamed"]) + len(result["dropped_duplicate"])


def dedupe_local_after_pull(
    character_id: int | str,
    pulled_image_id: str,
    pulled_bytes: bytes,
) -> str | None:
    """A freshly-pulled image turns out to be bytes the user uploaded
    here first. Hand the gallery over to the real F-list id and drop the
    local copy, so the picture stops appearing in the pool and on the
    profile at once.

    This used to patch a file the gallery no longer lived in and then
    unlink the local file regardless of whether the patch had landed,
    so the patch never landed and the unlink always ran. Every pull after an upload therefore cut a gallery
    entry loose from its bytes, and the image turned into a black
    placeholder on the profile. The file removal was called a cure for
    "image shows in both panes"; it was, and it caused something worse.

    Returns the local id that was folded in, or None.
    """
    if pulled_image_id.startswith("local-"):
        return None
    full = _hash_bytes(pulled_bytes)
    sha8 = full[:8]
    d = images_dir(character_id)
    matched: Path | None = None
    for c in sorted(d.glob(f"local-{sha8}.*")):
        if not c.is_file() or not _IMAGE_FILE_RE.fullmatch(c.name):
            continue
        try:
            if _hash_bytes(c.read_bytes()) == full:
                matched = c
                break
        except OSError:
            continue
    if matched is None:
        return None

    local_id = f"local-{sha8}"
    from services import events  # lazy, same reason as archive_registry._publish

    with events.origin("internal:dedupe-after-pull"):
        result = adopt_flist_image_ids(character_id, {local_id: pulled_image_id})
    if result["renamed"] or result["dropped_duplicate"]:
        return local_id
    return None


def add_uploaded_image(
    character_id: int | str,
    data: bytes,
) -> dict[str, Any] | None:
    """Save user-uploaded bytes under `images/local-<sha8>.<ext>`.
    Extension is sniffed from magic bytes — Content-Type is never
    trusted. Returns the metadata row (`{image_id, extension, size,
    added_at, deduplicated}`) or None when the bytes don't match a
    supported format. `deduplicated` says no new file was written.
    Idempotent — identical bytes always produce the same `local-<sha8>`
    and the file is written only when missing.

    If a byte-identical file already exists in `images/` (regardless of
    whether it's keyed by a real F-list id or a prior `local-<sha8>`),
    return that file's row instead of minting a parallel copy. Prevents
    the "same image shows twice in pool" symptom when a user re-uploads
    bytes that came from an earlier F-list pull."""
    ext = detect_image_ext(data)
    if ext is None:
        return None
    sha = _hash_bytes(data)
    existing = find_image_with_sha(character_id, sha)
    if existing is not None:
        try:
            stat = existing.stat()
            m = _IMAGE_FILE_RE.fullmatch(existing.name)
            return {
                "image_id": m.group(1) if m else existing.stem,
                "extension": (m.group(2).lower() if m else ext),
                "size": stat.st_size,
                "added_at": int(stat.st_mtime),
                "deduplicated": True,
            }
        except OSError:
            pass
    image_id = f"local-{sha[:8]}"
    target = images_dir(character_id) / f"{image_id}.{ext}"
    if not target.exists():
        atomic_write.write_bytes(target, data)
    try:
        stat = target.stat()
        added_at = int(stat.st_mtime)
        size = stat.st_size
    except OSError:
        added_at = int(time.time())
        size = len(data)
    return {
        "image_id": image_id,
        "extension": ext,
        "size": size,
        "added_at": added_at,
        "deduplicated": False,
    }


def repair_gallery(character_id: int | str) -> dict[str, Any]:
    """Public entry: run the repair with its writes attributed.

    A repair runs after pulls and before backups — nobody clicked
    anything in a window, so a repair's set-rewrite is a second party's
    write as far as every open window is concerned. Unattributed it
    carried the default `ui` origin and was dropped by exactly the
    filter meant for echoes of the window's own writes; each window
    kept a dead etag and the next save looked like a conflict with
    "someone else". The name here is what tells those apart.
    """
    from services import events  # lazy, same reason as archive_registry._publish

    with events.origin("internal:gallery-repair"):
        return _repair_gallery(character_id)


def _repair_gallery(character_id: int | str) -> dict[str, Any]:
    """Put a character's gallery back together when its entries have
    lost their bytes.

    Three things go wrong, and all three show the same way — a black
    placeholder where a picture should be:

    1. An entry points at `local-<sha8>` whose file is gone. That id is
       not arbitrary: it is the first eight hex of the sha256 of the
       bytes. So the same picture, sitting on disk under the id F-list
       gave it, can be found by hashing what is there — no guessing and
       no download.
    2. The same image id appears in several slots. One picture cannot
       be in three places on a profile; the extras are dropped and the
       first keeps its position.
    3. An entry points at an id with no file and no hash to match. It
       cannot be resolved here and is reported, not deleted — throwing
       away the user's slot order on a hunch is worse than a gap they
       can see.

    Idempotent and cheap enough to run whenever the Images tab opens:
    it hashes the character's own image files, nothing else.
    """
    images = images_dir(character_id)
    sha8_to_id: dict[str, str] = {}
    present: set[str] = set()
    full_hash: dict[str, str] = {}
    if images.exists():
        for entry in sorted(images.iterdir()):
            if not entry.is_file():
                continue
            m = _IMAGE_FILE_RE.fullmatch(entry.name)
            if not m:
                continue
            image_id = m.group(1)
            present.add(image_id)
            if image_id.startswith("local-"):
                continue
            try:
                digest = _hash_bytes(entry.read_bytes())
            except OSError:
                continue
            full_hash[image_id] = digest
            sha8_to_id.setdefault(digest[:8], image_id)

    # What F-list actually has. An upload gives a picture a new id, so
    # after the extension deletes and re-uploads a gallery, the ids the
    # Workbench holds are dead: the same bytes now live under a new
    # id, which shows up in the pool while the profile pane still lists
    # the old one. The same image, on both sides at once.
    live = archive_live.read_live(character_id)
    live_ids: set[str] = set()
    if isinstance(live, dict):
        for row in live.get("images") or []:
            if isinstance(row, dict):
                rid = row.get("image_id") or row.get("id")
                if rid:
                    live_ids.add(str(rid))
    # Only usable as evidence when we have actually pulled: an empty
    # Live means "we don't know", not "nothing is on the profile".
    superseded: dict[str, str] = {}
    if live_ids:
        by_digest_live = {
            digest: image_id
            for image_id, digest in full_hash.items()
            if image_id in live_ids
        }
        for image_id, digest in full_hash.items():
            if image_id in live_ids:
                continue
            replacement = by_digest_live.get(digest)
            if replacement is not None:
                superseded[image_id] = replacement

    relinked: list[dict[str, str]] = []
    duplicates_removed: list[str] = []
    unresolved: list[str] = []
    workbench_rewritten = False

    bench = archive_workbench.read_workbench(character_id)
    gallery = bench.payload.get("images") if bench is not None else None
    if bench is not None and isinstance(gallery, list):
        payload = bench.payload

        kept: list[Any] = []
        seen: set[str] = set()
        touched = False
        for row in gallery:
            if not isinstance(row, dict):
                kept.append(row)
                continue
            image_id = str(row.get("image_id") or "")

            if image_id not in present and image_id.startswith("local-"):
                match = sha8_to_id.get(image_id[len("local-"):])
                if match is not None:
                    relinked.append({"from": image_id, "to": match})
                    row["image_id"] = match
                    image_id = match
                    touched = True
            elif image_id in superseded:
                # The bytes are still on the profile, under the id the
                # re-upload gave them. Follow them.
                match = superseded[image_id]
                relinked.append({"from": image_id, "to": match})
                row["image_id"] = match
                image_id = match
                touched = True

            if image_id in seen:
                duplicates_removed.append(image_id)
                touched = True
                continue
            seen.add(image_id)

            if image_id not in present:
                unresolved.append(image_id)
            kept.append(row)

        if touched:
            payload["images"] = kept
            try:
                archive_workbench.write_workbench(character_id, payload, expected_etag=bench.etag)
                workbench_rewritten = True
            except archive_workbench.EtagMismatch:
                # Saved meanwhile; the next repair looks again.
                pass

    # The files left behind by the re-upload: byte-identical to one
    # F-list has, under an id it no longer knows. Keeping them would
    # leave the picture sitting in the pool for good, so they go to
    # the Trash, where repair can never destroy them.
    from services import image_trash  # lazy: image_trash imports this module

    stale_removed: list[str] = []
    for old_id in superseded:
        try:
            for entry in images.glob(f"{old_id}.*"):
                if not _IMAGE_FILE_RE.fullmatch(entry.name):
                    continue  # an interrupted write's temp file
                if entry.is_file() and image_trash.trash_pool_file(character_id, entry):
                    stale_removed.append(old_id)
        except OSError:
            continue

    return {
        "relinked": relinked,
        "duplicates_removed": duplicates_removed,
        "stale_removed": stale_removed,
        "unresolved": sorted(set(unresolved)),
        "workbench_rewritten": workbench_rewritten,
        "repaired": bool(relinked or duplicates_removed or stale_removed),
    }


def adopt_flist_image_ids(
    character_id: int | str,
    mapping: dict[str, str],
) -> dict[str, Any]:
    """Rename `local-<sha8>` images to the ids F-list gave them.

    An image the user uploads here is keyed by a hash of its bytes,
    because it has no F-list id yet — it exists nowhere but this
    machine. After the extension uploads it, F-list mints a real id,
    and until the archive learns it the two sides cannot recognise the
    same picture: every restore deletes the whole gallery and uploads
    it again, and every pull leaves a byte-identical twin on disk under
    the other name.

    The extension knows the pairing the moment it uploads, so it tells
    us, and this is where the archive takes it on:

    - the Workbench's gallery row moves to the new id;
    - `images/local-<sha8>.<ext>` becomes `images/<new id>.<ext>`, or
      is simply dropped when a pull already fetched the same bytes
      under that name. When that name holds other bytes, the local
      file goes to the Trash (`trashed`) instead: only a byte-identical
      twin is deleted.

    Backups are untouched: they are self-contained ZIPs carrying their
    own copy of the bytes, and rewriting history inside them would make
    a backup no longer a record of what was.

    Idempotent. Ids that aren't `local-`, aren't on disk, or don't
    appear in any gallery are reported back rather than silently
    skipped, so a caller can tell the difference between "nothing to do"
    and "that didn't work".
    """
    renamed: list[dict[str, str]] = []
    dropped_duplicate: list[str] = []
    trashed: list[str] = []
    unknown: list[str] = []

    images = images_dir(character_id)
    on_disk: dict[str, str] = {}
    if images.exists():
        for entry in images.iterdir():
            if not entry.is_file():
                continue
            m = _IMAGE_FILE_RE.fullmatch(entry.name)
            if m:
                on_disk[m.group(1)] = m.group(2).lower()

    resolved: dict[str, str] = {}
    for old_id, new_id in mapping.items():
        old_id, new_id = str(old_id).strip(), str(new_id).strip()
        if not old_id.startswith("local-") or not new_id:
            unknown.append(old_id)
            continue
        if not _SAFE_NAME_RE.fullmatch(new_id) or not _SAFE_NAME_RE.fullmatch(old_id):
            unknown.append(old_id)
            continue
        ext = on_disk.get(old_id)
        if ext is None:
            # Already adopted on an earlier run, or never here.
            unknown.append(old_id)
            continue
        resolved[old_id] = new_id

        src = image_path(character_id, old_id, ext)
        dst = image_path(character_id, new_id, on_disk.get(new_id, ext))
        if dst.exists() and file_sha256(dst) == file_sha256(src):
            # A pull fetched the same picture under its F-list name.
            # One copy is enough.
            src.unlink(missing_ok=True)
            dropped_duplicate.append(old_id)
        elif dst.exists():
            # Other bytes under the F-list id (F-list re-encoded the
            # upload, or the pairing is wrong): ours is no duplicate,
            # so it goes to the Trash rather than away for good.
            from services import image_trash

            image_trash.trash_pool_file(character_id, src)
            trashed.append(old_id)
        else:
            src.replace(dst)
            renamed.append({"from": old_id, "to": new_id})

    workbench_rewritten = False
    bench = archive_workbench.read_workbench(character_id) if resolved else None
    gallery = bench.payload.get("images") if bench is not None else None
    if bench is not None and isinstance(gallery, list):
        touched = False
        for row in gallery:
            if not isinstance(row, dict):
                continue
            current = str(row.get("image_id") or "")
            if current in resolved:
                row["image_id"] = resolved[current]
                touched = True
        if touched:
            try:
                archive_workbench.write_workbench(
                    character_id, bench.payload, expected_etag=bench.etag
                )
                workbench_rewritten = True
            except archive_workbench.EtagMismatch:
                pass

    return {
        "renamed": renamed,
        "dropped_duplicate": dropped_duplicate,
        "trashed": trashed,
        "unknown": unknown,
        "workbench_rewritten": workbench_rewritten,
    }


def avatar_path_for(name: str) -> Path:
    """`<userdata>/avatars/<lowercase_name>.png` for ASCII-only names;
    `<userdata>/avatars/<sha1>.png` for names containing Unicode or
    other characters outside `[A-Za-z0-9_.-]`.

    F-list allows Unicode in character names (e.g. "Café Noir"), but
    we want a filesystem-safe filename — never trust the name to be
    Windows-NTFS-clean. The sha1 fallback covers the long tail without
    ever raising ValueError, which previously made /flist/avatar/{name}
    return HTTP 400 for any non-ASCII character.
    """
    import hashlib

    slug = name.strip().lower().replace(" ", "_")
    if _SAFE_NAME_RE.fullmatch(slug):
        return archive_registry.avatars_root() / f"{slug}.png"
    # Hash the original (case-preserving + space-preserving) name so
    # two characters that only differ in casing land on distinct paths
    # — matches the merge_roster behaviour of keying by lowercase only
    # for collision rather than identity.
    digest = hashlib.sha1(name.strip().lower().encode("utf-8")).hexdigest()
    return archive_registry.avatars_root() / f"{digest}.png"
