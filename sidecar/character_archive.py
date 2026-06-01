"""On-disk archive store for F-list character backups.

Layout under `<userdata>/characters/<character_id>/`:

    live.json                        last fetched character-data + fetch ts
    backups/<unix>.json              snapshot of a previous Live
    images/<image_id>.<ext>          gallery images, deduped by F-list id
    inlines/<sha1>.<ext>             inline images referenced in BBCode

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
# v3 → v4 (Tier 6 attempt 2): gallery refs back to image_id (string), with
#   a `local-<sha8>` synthetic id for pool images not yet uploaded to
#   F-list. Pool stays sha-keyed for its own dedup but is no longer the
#   primary key for what a character displays.
# Writers stamp the current version; readers refuse files older than v4
# (v3 carried sha-only refs and can't be auto-migrated without re-pulling)
# AND files newer than v4.
WORKING_SCHEMA_VERSION = 4


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
    without re-querying F-list. The caller is responsible for re-seeding
    the gallery from live.json after a v3-or-older file lands here.
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
    # external tooling inspecting working.json) sees the canonical v4
    # layout — otherwise a renderer that never edits would carry the
    # in-memory migration forever and the on-disk file would stay v3.
    if (
        isinstance(version, int)
        and version < WORKING_SCHEMA_VERSION
    ):
        try:
            _atomic_write_json(p, migrated)
        except OSError:
            pass
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


# ---- image pool (Tier 6) ----------------------------------------------

POOL_DIRNAME = "pool"
POOL_MANIFEST_FILENAME = "manifest.json"

# F-list only accepts these on upload; rejecting other extensions in the
# pool keeps the manifest honest as the source of truth for what's
# restorable.
_POOL_EXTS = frozenset({"png", "jpg", "jpeg", "gif"})


def pool_dir(character_id: int | str) -> Path:
    p = character_dir(character_id) / POOL_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def pool_manifest_path(character_id: int | str) -> Path:
    return pool_dir(character_id) / POOL_MANIFEST_FILENAME


def _normalise_pool_ext(ext: str) -> str:
    e = ext.lower().lstrip(".")
    if e == "jpeg":
        e = "jpg"
    if e not in _POOL_EXTS:
        raise ValueError(f"unsupported pool extension: {ext!r}")
    return e


def normalise_image_ext(ext: str) -> str:
    """Public wrapper around `_normalise_pool_ext` so callers outside
    this module (server.py's pull loop) don't have to import a private."""
    return _normalise_pool_ext(ext)


def _hash_bytes(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


def read_pool_manifest(character_id: int | str) -> dict[str, dict[str, Any]]:
    p = pool_manifest_path(character_id)
    if not p.exists():
        return {}
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {
        k: v
        for k, v in raw.items()
        if isinstance(k, str) and isinstance(v, dict)
    }


def write_pool_manifest(
    character_id: int | str,
    manifest: dict[str, dict[str, Any]],
) -> None:
    _atomic_write_json(pool_manifest_path(character_id), manifest)


def pool_path(character_id: int | str, sha: str, ext: str) -> Path:
    """`pool/<sha>.<ext>`. Sha validated as a safe filename segment
    (sha256 hex satisfies `_SAFE_NAME_RE`); ext normalised to the
    pool's accepted set."""
    if not _SAFE_NAME_RE.match(sha):
        raise ValueError(f"unsafe pool sha: {sha!r}")
    e = _normalise_pool_ext(ext)
    return pool_dir(character_id) / f"{sha}.{e}"


def add_to_pool(
    character_id: int | str,
    data: bytes,
    ext: str,
    *,
    source: str = "user_upload",
) -> str:
    """Hash + store image bytes; return sha256 hex. Idempotent — re-
    adding identical bytes does not duplicate on disk. The pool is a
    sha-keyed forever archive; F-list image_ids live next to the bytes
    in `images/<image_id>.<ext>` and are NOT tracked in the pool
    manifest (the pool doesn't care which F-list character or image_id
    a byte sequence came from)."""
    ext_n = _normalise_pool_ext(ext)
    sha = _hash_bytes(data)
    dest = pool_dir(character_id) / f"{sha}.{ext_n}"
    if not dest.exists():
        dest.write_bytes(data)
    manifest = read_pool_manifest(character_id)
    existing = manifest.get(sha, {})
    merged: dict[str, Any] = {
        "extension": ext_n,
        "source": existing.get("source") or source,
        "added_at": existing.get("added_at") or int(time.time()),
        "size": len(data),
    }
    manifest[sha] = merged
    write_pool_manifest(character_id, manifest)
    return sha


def add_path_to_pool(
    character_id: int | str,
    path: Path,
    *,
    source: str = "flist_pull",
) -> str | None:
    """Copy a file from `path` into the pool. Returns sha or None if
    the file is unreadable or carries an unrecognised extension.
    Caller is responsible for unlinking the source if it's a move."""
    if not path.exists():
        return None
    ext = path.suffix.lstrip(".").lower()
    try:
        _normalise_pool_ext(ext)
    except ValueError:
        return None
    try:
        data = path.read_bytes()
    except OSError:
        return None
    return add_to_pool(character_id, data, ext, source=source)


def list_pool_entries(character_id: int | str) -> list[dict[str, Any]]:
    """Pool entries sorted newest first. Each row:
    `{sha256, extension, source, added_at, size}`. Entries whose
    backing file is missing are skipped so the renderer never sees a
    phantom thumbnail."""
    manifest = read_pool_manifest(character_id)
    out: list[dict[str, Any]] = []
    for sha, meta in manifest.items():
        ext = meta.get("extension")
        if not isinstance(ext, str):
            continue
        path = pool_dir(character_id) / f"{sha}.{ext}"
        if not path.exists():
            continue
        out.append(
            {
                "sha256": sha,
                "extension": ext,
                "source": meta.get("source") or "unknown",
                "added_at": meta.get("added_at") or 0,
                "size": meta.get("size") or 0,
            }
        )
    out.sort(key=lambda r: r["added_at"], reverse=True)
    return out


def remove_from_pool(character_id: int | str, sha: str) -> bool:
    """Delete a pool entry. Manual affordance only — no auto-GC. Returns
    True when the file was removed (or was already gone but tracked)."""
    if not _SAFE_NAME_RE.match(sha):
        return False
    manifest = read_pool_manifest(character_id)
    meta = manifest.get(sha)
    if not meta:
        return False
    ext = meta.get("extension")
    if not isinstance(ext, str):
        return False
    path = pool_dir(character_id) / f"{sha}.{ext}"
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        return False
    manifest.pop(sha, None)
    write_pool_manifest(character_id, manifest)
    return True


# ---- per-character images/ (F-list image_id-keyed) -------------------


def list_character_images(character_id: int | str) -> list[dict[str, Any]]:
    """Walk `images/` and return one row per file: `{image_id, extension,
    size}`. The renderer pairs these with `description`/`sort_order`
    from working.json. Order is by image_id (string-sorted) — the user-
    facing order comes from the working copy."""
    out: list[dict[str, Any]] = []
    d = images_dir(character_id)
    for entry in d.iterdir():
        if not entry.is_file():
            continue
        m = _IMAGE_FILE_RE.match(entry.name)
        if not m:
            continue
        try:
            size = entry.stat().st_size
        except OSError:
            continue
        out.append(
            {
                "image_id": m.group(1),
                "extension": m.group(2).lower(),
                "size": size,
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
    """Write `data` to `images/<image_id>.<ext>` AND copy into the pool
    (sha-keyed) so the bytes are doubly-stored: once for restore, once
    for the forever archive. Both writes are idempotent."""
    if not _SAFE_NAME_RE.match(image_id):
        raise ValueError(f"unsafe image_id: {image_id!r}")
    ext_n = _normalise_pool_ext(ext)
    target = images_dir(character_id) / f"{image_id}.{ext_n}"
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(target)
    add_to_pool(character_id, data, ext_n, source="flist_pull")


def materialise_pool_to_character(
    character_id: int | str,
    sha: str,
) -> str | None:
    """Copy a pool image into `images/local-<sha8>.<ext>` so it can be
    bundled in the restore ZIP and reordered alongside F-list images.
    Returns the synthetic local image_id (e.g. `local-248fffe4`) or None
    when the pool entry is missing. Idempotent — re-calling for the same
    sha returns the existing local id without re-writing bytes."""
    manifest = read_pool_manifest(character_id)
    meta = manifest.get(sha)
    if not meta:
        return None
    ext = meta.get("extension")
    if not isinstance(ext, str):
        return None
    src = pool_dir(character_id) / f"{sha}.{ext}"
    if not src.exists():
        return None
    local_id = f"local-{sha[:8]}"
    target = images_dir(character_id) / f"{local_id}.{ext}"
    if not target.exists():
        target.write_bytes(src.read_bytes())
    return local_id


def remove_character_image(character_id: int | str, image_id: str) -> bool:
    """Delete `images/<image_id>.<ext>`. Pool entry stays intact — the
    user can re-add the same image later without re-downloading.
    Returns True iff a file was removed."""
    if not _SAFE_NAME_RE.match(image_id):
        return False
    d = images_dir(character_id)
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


def sync_character_images_to_flist(
    character_id: int | str,
    expected_ids: Iterable[str],
) -> list[str]:
    """Delete from `images/` any F-list-shaped id (digits only) not in
    `expected_ids`. Local synthetic ids (`local-*`) are preserved —
    they're user uploads the userscript hasn't restored to F-list yet.
    Returns the list of image_ids that were removed.
    """
    keep = {str(i) for i in expected_ids}
    removed: list[str] = []
    d = images_dir(character_id)
    for entry in list(d.iterdir()):
        if not entry.is_file():
            continue
        m = _IMAGE_FILE_RE.match(entry.name)
        if not m:
            continue
        iid = m.group(1)
        if iid.startswith("local-"):
            # User uploads not yet on F-list — left alone by the mirror
            # sync. Only the user removes these explicitly.
            continue
        if iid in keep:
            continue
        try:
            entry.unlink()
            removed.append(iid)
        except OSError:
            pass
    return removed


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
