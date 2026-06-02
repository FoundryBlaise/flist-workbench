"""On-disk archive store for F-list character backups.

Layout under `<userdata>/characters/<character_id>/`:

    live.json                        last fetched character-data + fetch ts
    backups/<unix>.json              snapshot of a previous Live
    images/<image_id>.<ext>          all on-disk image bytes (Pool view in
                                     the UI is whatever isn't currently in
                                     working.json's gallery)
    inlines/<sha1>.<ext>             inline images referenced in BBCode

`<image_id>` is digits for F-list-pulled images, `local-<sha8>` for user
uploads that haven't been restored to F-list yet. There's no separate
sha-keyed pool — bytes live in `images/` once, and the renderer treats
files not referenced by working.json's gallery as "in the pool" for the
UI. The only path that ever deletes bytes is an explicit user delete
from the pool view (DELETE /images/<image_id>); pulls overwrite the
same id in place, profile→pool moves are pure working.json edits.

Avatars sit one level up at `<userdata>/avatars/<lowercase_name>.png`
because they survive a character being deleted from the account.

`list_archived_characters()` walks `<userdata>/characters/` so a user
who signs out (or whose character was deleted from F-list) still sees
their archived data in the picker. Each entry carries `has_logs` and
`on_account` flags so the renderer can render status badges.
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import documents

CHARACTERS_DIRNAME = "characters"
AVATARS_DIRNAME = "avatars"
CACHE_DIRNAME = "cache"
LIVE_FILENAME = "live.json"
PULL_STATE_FILENAME = "pull_state.json"
WORKING_FILENAME = "working.json"

# v1 → v2 (Tier 3): added local: ids, _custom_kinks_order, tombstones.
# v2 → v3 (Tier 6 attempt 1): sha256-keyed gallery refs. Reverted in v4.
# v3 → v4 (Tier 6 attempt 2): gallery refs back to image_id, with `local-
#   <sha8>` synthetic ids for non-F-list uploads. Bytes still doubly-
#   stored in a sha-keyed pool/ dir.
# v4 → v5 (refinement): drop the sha-keyed pool/ directory entirely.
#   Bytes live once under `images/<image_id>.<ext>`; the renderer's "Pool"
#   pane is a view over files not referenced by working.json's gallery.
#   Migration: pool/<sha>.<ext> entries are moved into `images/` under
#   their first-known F-list id (if not already on disk) or under
#   `local-<sha8>`; pool/ + manifest.json are then removed.
# Writers stamp the current version; readers refuse files newer than v5
# and silently migrate v1..v4 in place.
WORKING_SCHEMA_VERSION = 5


class EtagMismatch(ValueError):
    """Raised by write_working when expected_etag != current on-disk etag.

    The PUT /working endpoint translates this into a 409 with the
    current etag so the renderer can show the refresh-or-overwrite modal
    (Tier 2 §8.1).
    """

    def __init__(self, current_etag: str | None) -> None:
        super().__init__("etag_mismatch")
        self.current_etag = current_etag


def root() -> Path:
    p = documents.user_data_dir() / CHARACTERS_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def avatars_root() -> Path:
    p = documents.user_data_dir() / AVATARS_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def cache_root() -> Path:
    p = documents.user_data_dir() / CACHE_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def character_dir(character_id: int | str) -> Path:
    p = root() / str(character_id)
    p.mkdir(parents=True, exist_ok=True)
    return p


def images_dir(character_id: int | str) -> Path:
    p = character_dir(character_id) / "images"
    p.mkdir(parents=True, exist_ok=True)
    return p


def inlines_dir(character_id: int | str) -> Path:
    p = character_dir(character_id) / "inlines"
    p.mkdir(parents=True, exist_ok=True)
    return p


def backups_dir(character_id: int | str) -> Path:
    p = character_dir(character_id) / "backups"
    p.mkdir(parents=True, exist_ok=True)
    return p


# ---- live + backup read/write -----------------------------------------


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """Atomic JSON write. Retries `Path.replace` once on OSError with a
    short jittered backoff — OneDrive / Dropbox-synced directories can
    return EBUSY for milliseconds when their sync agent has the target
    file open. The retry costs nothing on healthy filesystems and is
    the documented fix for the open question in PHASE7_TIER2_PLAN §1.3
    (QA P3-6).

    If the retry also fails, the leftover `.tmp` is unlinked so the
    archive directory doesn't accumulate orphan temp files
    (Round 1 verifier follow-up).
    """
    import random
    import time as _time

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    try:
        tmp.replace(path)
    except OSError:
        _time.sleep(0.05 + random.random() * 0.05)
        try:
            tmp.replace(path)
        except OSError:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise


def write_live(character_id: int | str, payload: dict[str, Any]) -> None:
    """Overwrite the Live snapshot. Caller is responsible for stamping
    `fetched_at` into the payload before calling."""
    _atomic_write_json(character_dir(character_id) / LIVE_FILENAME, payload)


def read_live(character_id: int | str) -> dict[str, Any] | None:
    p = character_dir(character_id) / LIVE_FILENAME
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save_backup(character_id: int | str) -> dict[str, Any]:
    """Snapshot the current Live into `backups/<unix>.json`.

    Returns `{path, created_at}` so the renderer can show the new entry
    without re-listing. Raises FileNotFoundError if there's no Live to
    snapshot.
    """
    live = read_live(character_id)
    if live is None:
        raise FileNotFoundError("no Live snapshot to back up")
    now = int(time.time())
    target = backups_dir(character_id) / f"{now}.json"
    # On the very-unlikely same-second collision, suffix with a counter.
    i = 1
    while target.exists():
        target = backups_dir(character_id) / f"{now}-{i}.json"
        i += 1
    _atomic_write_json(target, live)
    return {"path": str(target), "created_at": now, "filename": target.name}


_BACKUP_FILE_RE = re.compile(r"^(\d+)(?:-\d+)?\.json$")


def list_backups(character_id: int | str) -> list[dict[str, Any]]:
    """List backups newest first. Each entry: `{filename, created_at, size}`."""
    out: list[dict[str, Any]] = []
    p = backups_dir(character_id)
    for entry in p.iterdir():
        if not entry.is_file():
            continue
        m = _BACKUP_FILE_RE.match(entry.name)
        if not m:
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        out.append(
            {
                "filename": entry.name,
                "created_at": int(m.group(1)),
                "size": stat.st_size,
            }
        )
    out.sort(key=lambda r: r["created_at"], reverse=True)
    return out


def read_backup(character_id: int | str, filename: str) -> dict[str, Any] | None:
    if not _BACKUP_FILE_RE.match(filename):
        # Reject anything that doesn't match the on-disk filename shape
        # so a caller can't path-traverse out of backups/.
        return None
    p = backups_dir(character_id) / filename
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


# ---- working-copy (offline edits, persisted to working.json) ---------


def working_path(character_id: int | str) -> Path:
    return character_dir(character_id) / WORKING_FILENAME


def _file_sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    import hashlib

    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def working_etag(character_id: int | str) -> str | None:
    """SHA-256 of working.json bytes on disk. None when absent.

    Renderer holds this between GET and the next PUT and sends it as
    `If-Match`; PUT returns the new etag on success. Used to detect a
    second window racing the same file (Tier 2 §8.1).
    """
    return _file_sha256(working_path(character_id))


def _migrate_working_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """In-memory schema migration. v1 → v2 fills _custom_kinks_order
    from the dict; v2 → v4 drops any sha256-keyed images array (the
    short-lived v3 shape) since we can't infer image_ids from shas
    without re-querying F-list. v4 → v5 is a no-op on the payload (gallery
    refs are unchanged); the actual disk side-effect (pool/ → images/) is
    driven by `migrate_v4_pool_to_images` in `read_working`.
    """
    version = payload.get("_schema_version")
    if version is None:
        version = 1
        payload["_schema_version"] = 1
    if version == 1:
        ck = payload.get("custom_kinks")
        if isinstance(ck, dict) and "_custom_kinks_order" not in payload:
            payload["_custom_kinks_order"] = list(ck.keys())
    if isinstance(version, int) and version <= 3:
        # v3 stored images as [{sha256, description}]. We can't translate
        # back to image_ids without the API. Drop the array — caller
        # re-seeds from live.json on next open.
        payload.pop("images", None)
    if isinstance(version, int) and version < WORKING_SCHEMA_VERSION:
        payload["_schema_version"] = WORKING_SCHEMA_VERSION
    return payload


def read_working(character_id: int | str) -> dict[str, Any] | None:
    """Return the working-copy payload or None if absent.

    On a JSONDecodeError, the corrupt file is renamed with a unix-
    timestamp suffix (`working.json.corrupt-<unix>`) so the user keeps
    the bytes for forensics — mirrors `read_live`'s broader silent-None
    behaviour but recovers more information for a file the user is
    actively editing.
    """
    p = working_path(character_id)
    if not p.exists():
        return None
    try:
        raw = p.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        payload = json.loads(raw)
    except ValueError:
        # Quarantine the broken file; renderer falls back to a fresh
        # seed-from-Live on the next load.
        try:
            p.rename(p.with_name(f"{p.name}.corrupt-{int(time.time())}"))
        except OSError:
            pass
        return None
    if not isinstance(payload, dict):
        return None
    version = payload.get("_schema_version")
    if isinstance(version, int) and version > WORKING_SCHEMA_VERSION:
        # File was written by a newer build. Refuse rather than silently
        # mis-interpret a future shape (QA feedback BLOCK #4). The
        # renderer's working-load handler treats None as "no working
        # copy" and seeds from Live — the file on disk stays intact.
        print(
            f"[flist] refusing to load working.json v{version} "
            f"(this build understands up to v{WORKING_SCHEMA_VERSION}); "
            f"upgrade the app or open the file with a matching version",
            flush=True,
        )
        return None
    migrated = _migrate_working_payload(payload)
    # Write the migrated shape back to disk so the next read (and any
    # external tooling inspecting working.json) sees the canonical
    # current-version layout — otherwise a renderer that never edits
    # would carry the in-memory migration forever and the on-disk file
    # would stay behind. v4 → v5 also drives the pool/→images/ disk
    # migration: payload's shape doesn't change but the byte store
    # collapses to a single directory.
    if (
        isinstance(version, int)
        and version < WORKING_SCHEMA_VERSION
    ):
        try:
            _atomic_write_json(p, migrated)
        except OSError:
            pass
        if version <= 4:
            migrate_v4_pool_to_images(character_id)
    return migrated


_WORKING_TOP_LEVEL_KEYS = {
    "character",
    "settings",
    "infotags",
    "kinks",
    "custom_kinks",
    "images",
    "inlines",
}


def write_working(
    character_id: int | str,
    payload: dict[str, Any],
    *,
    expected_etag: str | None = None,
) -> str:
    """Persist `payload` atomically; return the new sha256 etag.

    When `expected_etag` is provided, the on-disk etag must match (or
    both must be None on a first write) or `EtagMismatch` is raised
    carrying the current etag. Schema-version + `_overlay` are required;
    at least one of the recognised top-level content keys must be
    present (defensive — catches a renderer regression silently writing
    an empty payload).
    """
    if not isinstance(payload, dict):
        raise ValueError("working payload must be a dict")
    payload = _migrate_working_payload(dict(payload))
    overlay = payload.get("_overlay")
    if not isinstance(overlay, list) or not all(isinstance(s, str) for s in overlay):
        raise ValueError("_overlay must be a list of strings")
    if not any(k in payload for k in _WORKING_TOP_LEVEL_KEYS):
        raise ValueError(
            "working payload must carry at least one of "
            f"{sorted(_WORKING_TOP_LEVEL_KEYS)}"
        )
    p = working_path(character_id)
    current = _file_sha256(p)
    if expected_etag is not None and current != expected_etag:
        raise EtagMismatch(current)
    _atomic_write_json(p, payload)
    new_etag = _file_sha256(p)
    assert new_etag is not None
    return new_etag


def delete_working(character_id: int | str) -> bool:
    """Remove working.json. Idempotent — returns whether it existed."""
    p = working_path(character_id)
    if not p.exists():
        return False
    try:
        p.unlink()
        return True
    except OSError:
        return False


# ---- image storage ----------------------------------------------------


# Whitelist for safe filename segments. The pre-dot section must have
# at least one non-`.` character, which is what excludes `.` and `..`
# (both would otherwise satisfy `[A-Za-z0-9_.-]+`). Without this, the
# inline_path("..") case resolved to the parent directory — caught by
# the test_inline_path_rejects_unsafe_basename test added 2026-05-30.
_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$")

# `<image_id>.<ext>` filename in `images/`. image_id is digits for F-list
# images, `local-<8 hex>` for pool-only user uploads not yet on F-list.
_IMAGE_FILE_RE = re.compile(r"^([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)$")


# ---- pull integrity manifest -----------------------------------------


def pull_state_path(character_id: int | str) -> Path:
    return character_dir(character_id) / PULL_STATE_FILENAME


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
    _atomic_write_json(
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
        m = _IMAGE_FILE_RE.match(p.name)
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
    live = read_live(character_id)
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
    if not _SAFE_NAME_RE.match(image_id):
        raise ValueError(f"unsafe image_id: {image_id!r}")
    if not _SAFE_NAME_RE.match(ext):
        raise ValueError(f"unsafe extension: {ext!r}")
    return images_dir(character_id) / f"{image_id}.{ext}"


def inline_path(character_id: int | str, basename: str) -> Path:
    """`inlines/<basename>`. The basename is the CDN URL's last segment
    (typically `<sha1>.<ext>`); validated against the safe-name regex."""
    if not _SAFE_NAME_RE.match(basename):
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


def _detect_image_ext_from_bytes(data: bytes) -> str | None:
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
    these rows with `description`/`sort_order` from working.json to
    decide which are on the profile vs. in the pool view.

    Side-effect: triggers the v4 → v5 pool migration if a legacy pool/
    directory is present. Idempotent — no-op once collapsed."""
    migrate_v4_pool_to_images(character_id)
    out: list[dict[str, Any]] = []
    d = images_dir(character_id)
    if not d.exists():
        return out
    for entry in d.iterdir():
        if not entry.is_file():
            continue
        m = _IMAGE_FILE_RE.match(entry.name)
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
    if not _SAFE_NAME_RE.match(image_id):
        raise ValueError(f"unsafe image_id: {image_id!r}")
    ext_n = normalise_image_ext(ext)
    target = images_dir(character_id) / f"{image_id}.{ext_n}"
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(target)


def add_uploaded_image(
    character_id: int | str,
    data: bytes,
) -> dict[str, Any] | None:
    """Save user-uploaded bytes under `images/local-<sha8>.<ext>`.
    Extension is sniffed from magic bytes — Content-Type is never
    trusted. Returns the metadata row (`{image_id, extension, size,
    added_at}`) or None when the bytes don't match a supported format.
    Idempotent — identical bytes always produce the same `local-<sha8>`
    and the file is written only when missing."""
    ext = _detect_image_ext_from_bytes(data)
    if ext is None:
        return None
    sha = _hash_bytes(data)
    image_id = f"local-{sha[:8]}"
    target = images_dir(character_id) / f"{image_id}.{ext}"
    if not target.exists():
        tmp = target.with_suffix(target.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(target)
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
    }


def remove_character_image(character_id: int | str, image_id: str) -> bool:
    """Delete `images/<image_id>.<ext>`. Permanent — there's no
    secondary pool to fall back on under the v5 model, which is why the
    renderer wraps every call to this in an explicit confirm dialog.
    Returns True iff a file was removed."""
    if not _SAFE_NAME_RE.match(image_id):
        return False
    d = images_dir(character_id)
    if not d.exists():
        return False
    for entry in d.iterdir():
        if not entry.is_file():
            continue
        m = _IMAGE_FILE_RE.match(entry.name)
        if not m or m.group(1) != image_id:
            continue
        try:
            entry.unlink()
            return True
        except OSError:
            return False
    return False


# ---- v4 → v5 pool migration ------------------------------------------

# v4 stored bytes twice: once under `images/<image_id>.<ext>` and once
# under `pool/<sha>.<ext>` with a sha→{image_ids[]} manifest. v5 keeps
# only the `images/` store; migration moves any pool-only bytes into
# `images/` under their first-known F-list id (or a `local-<sha8>`
# synthetic) and deletes the pool/ directory.

_LEGACY_POOL_DIRNAME = "pool"
_LEGACY_POOL_MANIFEST = "manifest.json"


def migrate_v4_pool_to_images(character_id: int | str) -> int:
    """One-shot disk migration from v4's `pool/<sha>` store to v5's
    unified `images/<image_id>` store. Returns the number of pool files
    promoted (informational; legacy archive with no pool/ returns 0).
    Idempotent — re-runs are no-ops once pool/ is gone.
    """
    cdir = character_dir(character_id)
    pool_d = cdir / _LEGACY_POOL_DIRNAME
    if not pool_d.exists():
        return 0
    manifest_path = pool_d / _LEGACY_POOL_MANIFEST
    manifest: dict[str, dict[str, Any]] = {}
    if manifest_path.exists():
        try:
            raw = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                manifest = {
                    k: v for k, v in raw.items()
                    if isinstance(k, str) and isinstance(v, dict)
                }
        except (OSError, ValueError):
            manifest = {}
    images_d = images_dir(character_id)
    promoted = 0
    seen_pool_files: set[str] = set()
    for sha, meta in manifest.items():
        ext_raw = meta.get("extension")
        if not isinstance(ext_raw, str):
            continue
        try:
            ext = normalise_image_ext(ext_raw)
        except ValueError:
            continue
        sha_file = pool_d / f"{sha}.{ext}"
        seen_pool_files.add(sha_file.name)
        if not sha_file.exists():
            continue
        image_ids_raw = meta.get("image_ids")
        image_ids: list[str] = (
            [str(x) for x in image_ids_raw if isinstance(x, (str, int))]
            if isinstance(image_ids_raw, list)
            else []
        )
        # If any of this sha's historical image_ids is already a file in
        # images/<id>.<ext>, the bytes are already preserved under that
        # id — skip rather than mint a redundant `local-<sha8>` copy.
        already_preserved = any(
            _SAFE_NAME_RE.match(iid) and (images_d / f"{iid}.{ext}").exists()
            for iid in image_ids
        )
        if already_preserved:
            continue
        chosen: str | None = None
        for iid in image_ids:
            if not _SAFE_NAME_RE.match(iid):
                continue
            chosen = iid
            break
        if chosen is None:
            chosen = f"local-{sha[:8]}"
        if not _SAFE_NAME_RE.match(chosen):
            continue
        target = images_d / f"{chosen}.{ext}"
        if not target.exists():
            try:
                target.write_bytes(sha_file.read_bytes())
                promoted += 1
            except OSError:
                continue
    # Also catch orphan files in pool/ that weren't in the manifest —
    # they only carry sha+ext, so they always land as `local-<sha8>`.
    for entry in list(pool_d.iterdir()):
        if not entry.is_file():
            continue
        if entry.name == _LEGACY_POOL_MANIFEST:
            continue
        if entry.name in seen_pool_files:
            continue
        stem = entry.stem
        ext_part = entry.suffix.lstrip(".")
        try:
            ext = normalise_image_ext(ext_part)
        except ValueError:
            continue
        if len(stem) < 8 or not _SAFE_NAME_RE.match(stem):
            continue
        chosen = f"local-{stem[:8]}"
        target = images_d / f"{chosen}.{ext}"
        if not target.exists():
            try:
                target.write_bytes(entry.read_bytes())
                promoted += 1
            except OSError:
                continue
    # Tear down pool/ — best-effort, leaves directory intact on errors.
    for entry in list(pool_d.iterdir()):
        try:
            entry.unlink()
        except OSError:
            pass
    try:
        pool_d.rmdir()
    except OSError:
        pass
    return promoted


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
    if _SAFE_NAME_RE.match(slug):
        return avatars_root() / f"{slug}.png"
    # Hash the original (case-preserving + space-preserving) name so
    # two characters that only differ in casing land on distinct paths
    # — matches the merge_roster behaviour of keying by lowercase only
    # for collision rather than identity.
    digest = hashlib.sha1(name.strip().lower().encode("utf-8")).hexdigest()
    return avatars_root() / f"{digest}.png"


# ---- roster ----------------------------------------------------------


def list_archived_characters() -> list[dict[str, Any]]:
    """Walk `<userdata>/characters/` and surface every directory that
    looks like a character archive. Each entry: `{id, name, last_pulled_at,
    backup_count}`. Name comes from the last Live snapshot if present —
    we never had a name without a Live, so missing-name is impossible in
    normal use.
    """
    out: list[dict[str, Any]] = []
    root_p = root()
    for entry in root_p.iterdir():
        if not entry.is_dir():
            continue
        cid = entry.name
        live = read_live(cid)
        if live is None:
            # No Live yet — directory created but pull never finished.
            # Skip so the picker doesn't surface broken rows.
            continue
        char = live.get("character") if isinstance(live, dict) else None
        if not isinstance(char, dict):
            # Could be the raw character-data shape too.
            char = live
        name = (
            char.get("name") if isinstance(char, dict) else None
        ) or live.get("name")
        backups = list_backups(cid)
        out.append(
            {
                "id": cid,
                "name": name,
                "last_pulled_at": live.get("fetched_at"),
                "backup_count": len(backups),
            }
        )
    out.sort(key=lambda r: (r["name"] or "").lower())
    return out


def merge_roster(
    account_characters: Iterable[dict[str, Any]] | None,
    log_characters: Iterable[str] | None,
) -> list[dict[str, Any]]:
    """Union of (F-list account roster) + (locally archived) + (log
    directories). Each entry carries status flags so the renderer can
    render badges:

        - `on_account`  — present in the live account roster
        - `has_archive` — has a Live snapshot on disk
        - `has_logs`    — has F-Chat log directories under FCHAT_DATA_DIR

    `id` is the F-list character_id when we know it (account or archive
    lookup); `null` for log-only characters whose F-list id is unknown.
    """
    # Identity for rows whose F-list id we know comes from the id, not the
    # name — F-list permits two characters whose names differ only in case
    # ("Foo" and "foo"), and case-collapsing them would silently fuse two
    # real characters into one row with the wrong id auto-pulled. Rows
    # with no known id (log-only directories, defensive cases) still fall
    # back to lowercased name so on-disk casing drift still collapses.
    by_id: dict[Any, dict[str, Any]] = {}
    by_name: dict[str, dict[str, Any]] = {}

    def _new(name: str) -> dict[str, Any]:
        return {
            "name": name,
            "id": None,
            "on_account": False,
            "has_archive": False,
            "has_logs": False,
            "last_pulled_at": None,
            "backup_count": 0,
        }

    def _upsert_by_id(name: str, cid: Any) -> dict[str, Any]:
        row = by_id.get(cid)
        if row is None:
            row = _new(name)
            row["id"] = cid
            by_id[cid] = row
        return row

    def _upsert_by_name(name: str) -> dict[str, Any]:
        key = name.strip().lower()
        row = by_name.get(key)
        if row is None:
            row = _new(name)
            by_name[key] = row
        return row

    if account_characters:
        for ch in account_characters:
            name = ch.get("name")
            if not isinstance(name, str) or not name:
                continue
            cid = ch.get("id")
            row = _upsert_by_id(name, cid) if cid is not None else _upsert_by_name(name)
            row["on_account"] = True

    archived = list_archived_characters()
    for a in archived:
        name = a["name"]
        if not isinstance(name, str) or not name:
            continue
        cid = a.get("id")
        row = _upsert_by_id(name, cid) if cid is not None else _upsert_by_name(name)
        row["has_archive"] = True
        row["last_pulled_at"] = a["last_pulled_at"]
        row["backup_count"] = a["backup_count"]

    if log_characters:
        # Log directories have no id — fall back to name match. Prefer
        # an existing id-keyed row with the same lowercased name so we
        # don't create a phantom log-only row alongside the canonical
        # one. With case-collision ids this is ambiguous; pick the
        # first id-keyed row deterministically.
        id_name_index: dict[str, dict[str, Any]] = {}
        for row in by_id.values():
            key = (row["name"] or "").strip().lower()
            id_name_index.setdefault(key, row)
        for name in log_characters:
            if not isinstance(name, str) or not name:
                continue
            key = name.strip().lower()
            row = id_name_index.get(key) or by_name.get(key)
            if row is None:
                row = _new(name)
                by_name[key] = row
            row["has_logs"] = True

    rows = list(by_id.values()) + list(by_name.values())
    rows.sort(key=lambda r: (r["name"] or "").lower())
    return rows
