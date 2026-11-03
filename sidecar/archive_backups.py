"""Backups: `backups/<YYYY-MM-DDTHHMMSSZ>.zip` and their user-set names.

Also the whole-Workbench replacements (reset to Live, load a Backup),
which keep the Workbench as a `before-restore` Backup first (ADR 0003).
"""
from __future__ import annotations

import json
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

import archive_images
import archive_live
import archive_registry
import archive_workbench
import atomic_write
import backup_origin
from archive_errors import NoLive, WorkbenchConflict, WorkbenchNotKept
from refusals import (
    BackupHoldsNoProfile,
    BackupNotFound,
    BackupTooOld,
    BackupUnreadable,
    InvalidFileName,
    Refusal,
)
from services import events


def backups_dir(character_id: int | str) -> Path:
    """Per-character `backups/` dir — full ZIP backups, restorable via
    the userscript. Created lazily by `save_zip_backup`."""
    p = archive_registry.character_dir(character_id) / archive_registry.BACKUPS_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


_BACKUP_NAMES_FILENAME = "_names.json"


def _names_file(character_id: int | str) -> Path:
    return backups_dir(character_id) / _BACKUP_NAMES_FILENAME


def _read_backup_names(character_id: int | str) -> dict[str, str]:
    """Map of backup-filename → user-set name, persisted alongside
    the ZIPs. Keeping names in a sidecar JSON file (instead of inside
    each ZIP's `backup-meta.json`) means renames don't have to
    re-pack the ZIP. Missing file or corrupt JSON returns an empty
    dict — the UI just shows the timestamp-derived default name."""
    p = _names_file(character_id)
    if not p.exists():
        return {}
    try:
        raw = p.read_text(encoding="utf-8")
        parsed = json.loads(raw)
    except (OSError, ValueError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in parsed.items():
        if isinstance(k, str) and isinstance(v, str):
            out[k] = v
    return out


def _write_backup_names(
    character_id: int | str, names: dict[str, str]
) -> None:
    atomic_write.write_json(
        _names_file(character_id), names, indent=2, ensure_ascii=False, sort_keys=True
    )


@archive_registry.under_character_lock
def rename_zip_backup(
    character_id: int | str, filename: str, name: str
) -> None:
    """Persist a user-set name for one backup. The ZIP file itself is
    untouched (renames don't need to rewrite the archive bytes); the
    name only lives in the sidecar `_names.json` map. Empty string
    clears the entry so the UI falls back to the timestamp default."""
    require_backup_filename(filename)
    target = backups_dir(character_id) / filename
    if not target.exists():
        raise BackupNotFound(f"no such Backup: {filename}")
    names = _read_backup_names(character_id)
    if name.strip():
        names[filename] = name.strip()
    else:
        names.pop(filename, None)
    _write_backup_names(character_id, names)
    archive_registry.publish(events.BACKUPS_CHANGED, character_id)


def backup_name(character_id: int | str, filename: str) -> str | None:
    """The user-set name of one Backup, or None when it has none."""
    return _read_backup_names(character_id).get(filename) or None


@archive_registry.under_character_lock
def forget_backup_name(character_id: int | str, filename: str) -> None:
    """Drop the user-set name for a backup that's about to be deleted.
    Called by the DELETE endpoint so `_names.json` doesn't carry
    references to bytes that no longer exist."""
    names = _read_backup_names(character_id)
    if filename in names:
        names.pop(filename, None)
        _write_backup_names(character_id, names)


_ZIP_BACKUP_FILE_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-(\d+))?\.zip$"
)


def require_backup_filename(filename: str) -> None:
    """Refuse a name that is not a Backup file name, before any path is
    built from it, so a crafted `../` name reads or deletes nothing.
    A caller hears 400 `invalid_file_name`."""
    if not isinstance(filename, str) or not _ZIP_BACKUP_FILE_RE.fullmatch(filename):
        raise InvalidFileName("invalid backup filename")


def _zip_backup_filename(now: float | None = None) -> str:
    """`YYYY-MM-DDTHHMMSSZ.zip` — filesystem-safe ISO basic form. The
    explicit `Z` makes it clear the timestamp is UTC so a user copying
    the file off-machine isn't confused by their local-time mtime."""
    import datetime as _dt

    ts = _dt.datetime.fromtimestamp(
        time.time() if now is None else now, tz=_dt.timezone.utc
    )
    return ts.strftime("%Y-%m-%dT%H%M%SZ") + ".zip"


def _backup_paths(folder: Path, stem: str) -> Iterator[Path]:
    """`<folder>/<stem>.zip`, then `<stem>-1.zip`, `<stem>-2.zip`, ...:
    the names a Backup of one second may take, in order."""
    yield folder / f"{stem}.zip"
    i = 1
    while True:
        yield folder / f"{stem}-{i}.zip"
        i += 1


def _free_backup_path(folder: Path, stem: str) -> Path:
    """`<folder>/<stem>.zip`, or `<stem>-N.zip` with the first N not on
    disk yet, so a same-second second Backup never overwrites the first."""
    return next(p for p in _backup_paths(folder, stem) if not p.exists())


def free_backup_filename(character_id: int | str, filename: str) -> str:
    """A Backup file name like `filename` that nothing in the Backup list
    holds yet: `filename` itself, or the next free `-N` one beside it."""
    require_backup_filename(filename)
    stem = re.sub(r"-\d+$", "", filename[: -len(".zip")])
    target = backups_dir(character_id) / filename
    if not target.exists():
        return filename
    return _free_backup_path(backups_dir(character_id), stem).name


def write_new_backup(folder: Path, data: bytes) -> Path:
    """Store `data` as a new Backup in `folder`, named for this second
    with the first free `-N` suffix, and return where it went. Atomic,
    and two Backups made in the same second each keep their own name."""
    stem = _zip_backup_filename().removesuffix(".zip")
    return atomic_write.write_new(_backup_paths(folder, stem), data)


@archive_registry.under_character_lock
def write_backup_zip(character_id: int | str, data: bytes) -> Path:
    """Store `data` as a new Backup of the character, under the Backup
    file name the list recognises, and return where it went."""
    target = write_new_backup(backups_dir(character_id), data)
    archive_registry.publish(events.BACKUPS_CHANGED, character_id)
    return target


#: The name earlier versions gave the Backup before an Upload, which the
#: Backup list never recognised: `pre-restore-YYYY-MM-DDTHH-MM-SS.zip`, UTC.
_OLD_PRE_UPLOAD_FILE_RE = re.compile(
    r"^pre-restore-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.zip$"
)


def adopt_old_pre_upload_backups() -> int:
    """Give every Backup an earlier version took before an Upload the
    Backup file name, so the list shows it. Run at startup.

    A rename and nothing else: the file keeps every byte, and a name
    already taken gets the same-second suffix rather than overwriting.
    Returns how many were adopted.
    """
    adopted = 0
    for folder in archive_registry.root().iterdir():
        backups = folder / archive_registry.BACKUPS_DIRNAME
        if not backups.is_dir():
            continue
        for entry in list(backups.iterdir()):
            m = _OLD_PRE_UPLOAD_FILE_RE.fullmatch(entry.name)
            if not m or not entry.is_file():
                continue
            day, hh, mm, ss = m.groups()
            target = _free_backup_path(backups, f"{day}T{hh}{mm}{ss}Z")
            try:
                entry.rename(target)
            except OSError as exc:
                print(f"could not adopt {entry}: {exc}", file=sys.stderr)
                continue
            adopted += 1
    return adopted


def _live_to_zip_payload(live: dict[str, Any]) -> dict[str, Any]:
    """Reshape Live JSON into the working-copy payload `zip_serialise.
    build_zip` expects. Mirrors the renderer's `seedWorkingFromLive` —
    we keep the helper here (instead of pulling from server.py) so the
    character-archive module can build a ZIP without an HTTP round-trip
    from `/backup-all`."""
    out: dict[str, Any] = {
        "_schema_version": archive_workbench.WORKING_SCHEMA_VERSION,
        "_overlay": [],
    }
    if isinstance(live.get("character"), dict):
        out["character"] = dict(live["character"])
    else:
        out["character"] = {
            "id": live.get("id"),
            "name": live.get("name"),
            "description": live.get("description", ""),
            "custom_title": live.get("custom_title"),
        }
    for key in ("settings", "infotags", "custom_kinks", "inlines"):
        if key in live:
            out[key] = live[key]
    kinks = live.get("kinks")
    out["kinks"] = {} if isinstance(kinks, list) else (kinks or {})
    gallery: list[dict[str, Any]] = []
    raw_images = live.get("images")
    if isinstance(raw_images, list):
        for index, entry in enumerate(raw_images):
            if not isinstance(entry, dict):
                continue
            iid = entry.get("image_id") or entry.get("id")
            if iid is None:
                continue
            row = dict(entry)
            row.setdefault("image_id", str(iid))
            row.setdefault("position", index)
            gallery.append(row)
    out["images"] = gallery
    return out


def list_zip_backups(character_id: int | str) -> list[dict[str, Any]]:
    """List ZIP backups newest first. Each entry:
    `{filename, created_at, size, kind, source, occasion, holds_profile,
    name}`. `source`, `occasion` and `holds_profile` come from
    `backup-meta.json` too; a Backup that does not record them is listed
    with source "unknown" and occasion null (see `backup_origin.read`). Filenames are the
    ISO-basic form written by `save_zip_backup`. `kind` comes from
    the embedded `backup-meta.json` (added 2026-06-17); older backups
    without that file get `"unknown"` so the UI can still bucket
    them. `name` is the user-set rename from `_names.json` or `null`
    when the user hasn't renamed it yet (UI then falls back to a
    timestamp-derived label).

    Tiebreaker: same-second writes are disambiguated by the `-N`
    suffix counter on the filename; higher N = more recent. The sort
    key must reflect that so the dedup check always compares against
    the *truly* latest ZIP — relying on lex order alone would put the
    no-suffix (oldest) file at the top because `.` > `-` in ASCII.
    """
    import datetime as _dt
    import zipfile

    names = _read_backup_names(character_id)
    out: list[dict[str, Any]] = []
    p = archive_registry.character_dir(character_id) / archive_registry.BACKUPS_DIRNAME
    if not p.exists():
        return out
    for entry in p.iterdir():
        if not entry.is_file():
            continue
        # Skip the names sidecar file — it lives in this dir but
        # isn't a backup of its own.
        if entry.name == _BACKUP_NAMES_FILENAME:
            continue
        m = _ZIP_BACKUP_FILE_RE.fullmatch(entry.name)
        if not m:
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        ts = _dt.datetime(
            int(m.group(1)),
            int(m.group(2)),
            int(m.group(3)),
            int(m.group(4)),
            int(m.group(5)),
            int(m.group(6)),
            tzinfo=_dt.timezone.utc,
        )
        suffix = int(m.group(7)) if m.group(7) else 0
        # Cheap peek: open the ZIP just to read backup-meta.json.
        # Falls through to "unknown" on legacy files, corrupt ZIPs, or
        # missing meta — listing every backup must be fast even when
        # there are hundreds, so we don't load other ZIP entries here.
        kind = "unknown"
        meta: Any = None
        try:
            with zipfile.ZipFile(entry, "r") as zf:
                raw = zf.read("backup-meta.json").decode("utf-8")
            meta = json.loads(raw)
            if isinstance(meta, dict) and isinstance(meta.get("kind"), str):
                kind = meta["kind"]
        except (KeyError, OSError, ValueError, zipfile.BadZipFile):
            pass
        out.append(
            {
                "filename": entry.name,
                "created_at": int(ts.timestamp()),
                "_suffix": suffix,
                "size": stat.st_size,
                "kind": kind,
                **backup_origin.read(meta),
                "name": names.get(entry.name),
            }
        )
    out.sort(key=lambda r: (r["created_at"], r["_suffix"]), reverse=True)
    for row in out:
        row.pop("_suffix", None)
    return out


def zip_backup_meta(character_id: int | str, filename: str) -> dict[str, Any]:
    """A Backup's `backup-meta.json`; empty for one without it (older
    Backups), and for a file that is not a readable Backup."""
    import zipfile

    require_backup_filename(filename)
    try:
        with zipfile.ZipFile(backups_dir(character_id) / filename, "r") as zf:
            meta = json.loads(zf.read("backup-meta.json").decode("utf-8"))
    except (KeyError, OSError, ValueError, zipfile.BadZipFile):
        return {}
    return meta if isinstance(meta, dict) else {}


def require_backup_holds_profile(character_id: int | str, filename: str) -> None:
    """Refuse a Backup that holds no profile (`backup_origin.holds_profile`)
    before anything reads one out of it: raises `BackupHoldsNoProfile`."""
    if not backup_origin.holds_profile(zip_backup_meta(character_id, filename)):
        raise BackupHoldsNoProfile(filename)


def read_backup_profile(character_id: int | str, filename: str) -> dict[str, Any]:
    """The profile a Backup stores (its `working.json`), as Browse and
    Restore read it. Refuses, the same way for both: `BackupNotFound`,
    `BackupHoldsNoProfile` for the migration Backup, `BackupTooOld` for
    one from before the profile was stored in it, `BackupUnreadable`
    for a zip or profile that cannot be read."""
    import zipfile

    require_backup_filename(filename)
    target = backups_dir(character_id) / filename
    if not target.is_file():
        raise BackupNotFound(f"no such Backup: {filename}")
    require_backup_holds_profile(character_id, filename)
    try:
        with zipfile.ZipFile(target, "r") as zf:
            raw = zf.read("working.json").decode("utf-8")
    except KeyError as exc:
        raise BackupTooOld(filename) from exc
    except (zipfile.BadZipFile, UnicodeDecodeError) as exc:
        raise BackupUnreadable(f"corrupt backup file: {exc}") from exc
    try:
        payload = json.loads(raw)
    except ValueError as exc:
        raise BackupUnreadable("backup working.json is not valid JSON") from exc
    if not isinstance(payload, dict):
        raise BackupUnreadable("backup working.json is not an object")
    return payload


def latest_zip_backup_content_hash(
    character_id: int | str, source: str | None = None
) -> str | None:
    """Hash of the most recent ZIP backup's `character.json`, in the same
    canonical-JSON shape used by `live_content_hash`. Used by
    `save_zip_backup` to dedup against an unchanged Live so two
    Back-up-all clicks in a row don't write two identical ZIPs.

    With `source`, only Backups holding that source count: a Backup of
    Live is compared with the newest Backup of Live, not with a manual
    Backup of the Workbench taken in between."""
    import hashlib
    import zipfile

    rows = list_zip_backups(character_id)
    if source is not None:
        rows = [r for r in rows if r.get("source") == source]
    if not rows:
        return None
    target = backups_dir(character_id) / rows[0]["filename"]
    try:
        with zipfile.ZipFile(target, "r") as zf:
            raw = zf.read("character.json").decode("utf-8")
        manifest = json.loads(raw)
    except (OSError, KeyError, ValueError, zipfile.BadZipFile):
        return None
    # `meta.exportedAt` is the only field that changes when nothing
    # else did — strip it before hashing so dedup works the way the
    # snapshot path does.
    if isinstance(manifest, dict):
        meta = manifest.get("meta")
        if isinstance(meta, dict):
            meta = dict(meta)
            meta.pop("exportedAt", None)
            manifest = {**manifest, "meta": meta}
    canonical = json.dumps(manifest, sort_keys=True, ensure_ascii=False).encode(
        "utf-8"
    )
    return hashlib.sha256(canonical).hexdigest()


def _zip_payload_content_hash(payload: dict[str, Any]) -> str:
    """Hash of the post-`to_zip_character_json` shape with `meta.
    exportedAt` zeroed — so a fresh Live that round-trips to the same
    ZIP shape hashes to the same value as the latest existing ZIP."""
    import hashlib

    meta = payload.get("meta")
    if isinstance(meta, dict):
        meta = dict(meta)
        meta.pop("exportedAt", None)
        payload = {**payload, "meta": meta}
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode(
        "utf-8"
    )
    return hashlib.sha256(canonical).hexdigest()


@archive_registry.under_character_lock
def save_zip_backup(
    character_id: int | str,
    *,
    source: str,
    occasion: str,
    force: bool = False,
    kind: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """Pack the character's Live or Workbench into
    `<character>/backups/<ISO>.zip` — userscript-restoreable, includes
    every gallery image still on disk plus the avatar.

    `source` is what the Backup holds: `live` (what F-list showed at the
    last Pull) or `workbench` (the user's edits; a Workbench not created
    yet holds what Live seeds it with). `occasion` is why it was made:
    `manual`, `before-upload`, `before-restore`, `migration` or
    `backup-all` (see `backup_origin`). Both go into the ZIP's
    `backup-meta.json`, together with the older `kind` the extension
    sorts by — the occasion's own unless `kind` is given.

    Dedup: unless `force`, nothing is written when the newest Backup of
    the same source already holds this content; that returns
    `{saved: False, reason: 'unchanged'}`. `note` is reserved for a
    future free-text annotation surface.

    Returns one of:
      `{saved: True, path, filename, created_at, size, kind, source, occasion}`
      `{saved: False, reason: 'unchanged'}`
      `{saved: False, reason: 'no_live'}`
    """
    import zip_serialise

    origin = backup_origin.meta(source, occasion, kind=kind)

    # Heal before packing. `build_zip` drops gallery rows whose file is
    # missing, so a backup taken over a broken gallery silently lacks
    # the images — and the extension then deletes them from the profile
    # for not being in the backup. That chain cost a user their gallery
    # once; a backup must never be the weak link in it.
    live = archive_live.read_live(character_id)
    if live is not None:
        try:
            archive_images.repair_gallery(character_id)
        except Exception as exc:  # noqa: BLE001 - never block a backup
            print(f"gallery repair before backup failed: {exc}", file=sys.stderr)

    working = None
    if source == backup_origin.WORKBENCH:
        bench = archive_workbench.read_workbench(character_id)
        if bench is not None:
            working = bench.payload
    if working is None:
        if live is None:
            return {"saved": False, "reason": "no_live"}
        working = _live_to_zip_payload(live)
    image_extensions: dict[str, str] = {}
    img_dir = archive_images.images_dir(character_id)
    if img_dir.exists():
        for entry in img_dir.iterdir():
            m = archive_images._IMAGE_FILE_RE.fullmatch(entry.name)
            if m and entry.is_file():
                image_extensions[m.group(1)] = m.group(2).lower()
    candidate_payload = zip_serialise.to_zip_character_json(
        working, image_extensions=image_extensions
    )

    if not force:
        candidate_hash = _zip_payload_content_hash(candidate_payload)
        prior_hash = latest_zip_backup_content_hash(character_id, source)
        if prior_hash == candidate_hash:
            return {"saved": False, "reason": "unchanged"}

    # Resolve avatar path from the character name carried in the Live
    # payload. F-list allows Unicode names; `avatar_path_for` already
    # handles that.
    avatar_path: Path | None = None
    char = working.get("character")
    if isinstance(char, dict):
        nm = char.get("name")
        if isinstance(nm, str) and nm:
            candidate_avatar = archive_images.avatar_path_for(nm)
            if candidate_avatar.exists():
                avatar_path = candidate_avatar

    data = zip_serialise.build_zip(
        character_id,
        working,
        images_dir=img_dir,
        avatar_path=avatar_path,
        backup_kind=origin.get("kind"),
        backup_note=note,
        backup_source=source,
        backup_occasion=occasion,
    )

    target = write_backup_zip(character_id, data)
    return {
        "saved": True,
        "path": str(target),
        "filename": target.name,
        "created_at": int(time.time()),
        "size": len(data),
        "kind": origin.get("kind", "unknown"),
        "source": source,
        "occasion": occasion,
    }


# ---- replacing the whole Workbench ----------------------------------
#
# Reset to Live, loading a Backup and MCP's raw payload replacement
# overwrite all of the Workbench, so they keep it as a Backup first
# (ADR 0003). They live here rather than
# in `archive_workbench` because taking that Backup is this module's
# job, and `archive_workbench` must not import this one.


@dataclass(frozen=True)
class WorkbenchReplaced:
    """What a whole-Workbench replacement did: the new payload and its
    etag, and `kept`, the `before-restore` Backup holding the Workbench
    that was replaced, as `{filename, created_at}`. `kept` is None when
    the character had no Workbench yet, so there was nothing to keep.
    """

    payload: dict[str, Any]
    etag: str
    kept: dict[str, Any] | None


def _keep_workbench_before_replacing(character_id: int | str) -> dict[str, Any]:
    """Save the Workbench as a Backup (source `workbench`, occasion
    `before-restore`) before something replaces all of it (ADR 0003).

    Always taken, never deduplicated: the Backup is the undo of the
    replacement. Raises `WorkbenchNotKept` when the Backup cannot be
    written; the caller must then leave the Workbench alone.
    """
    try:
        result = save_zip_backup(
            character_id,
            source=backup_origin.WORKBENCH,
            occasion=backup_origin.BEFORE_RESTORE,
            force=True,
        )
    except Exception as exc:  # noqa: BLE001 - any failure means "not kept"
        raise WorkbenchNotKept(
            "The Workbench could not be saved as a Backup first, so it"
            f" was not replaced: {exc}"
        ) from exc
    if not result.get("saved"):
        raise WorkbenchNotKept(
            "The Workbench could not be saved as a Backup first, so it"
            f" was not replaced: {result.get('reason')}"
        )
    return {"filename": result["filename"], "created_at": result["created_at"]}


@archive_registry.under_character_lock
def replace_workbench(
    character_id: int | str,
    payload: dict[str, Any],
    *,
    expected_etag: str | None = None,
) -> WorkbenchReplaced:
    """Keep the Workbench as a Backup, then overwrite it with `payload`.

    `payload` is checked first (ValueError) and so is `expected_etag`,
    when given (`WorkbenchConflict`), so a replacement that would be
    refused keeps no Backup. A Workbench this call had to make from Live
    holds no edits, so it is not kept. The write goes against the etag
    read before the Backup: a save that lands in between is refused as
    `WorkbenchConflict` rather than lost, since the Backup would not
    hold it.
    """
    payload = archive_workbench.checked_payload(payload)
    current = archive_workbench.read_workbench(character_id, create=True)
    if current is None:
        raise NoLive("no Live to make a Workbench from")
    if expected_etag is not None and expected_etag != current.etag:
        raise WorkbenchConflict(
            "etag_mismatch",
            "The Workbench changed since it was read, so it was not"
            " replaced. Read it again and redo the change.",
            current.etag,
        )
    kept = None if current.created else _keep_workbench_before_replacing(character_id)
    try:
        etag = archive_workbench.write_workbench(character_id, payload, expected_etag=current.etag)
    except archive_workbench.EtagMismatch as exc:
        raise WorkbenchConflict(
            "etag_mismatch",
            "The Workbench changed while it was being replaced, so it was"
            " not replaced. Try again.",
            exc.current_etag,
        ) from exc
    return WorkbenchReplaced(payload=payload, etag=etag, kept=kept)


@archive_registry.under_character_lock
def reset_workbench_to_live(character_id: int | str) -> WorkbenchReplaced:
    """Throw away every edit: the Workbench becomes a fresh copy of Live.

    The Workbench it replaces is kept as a `before-restore` Backup
    first; see `_keep_workbench_before_replacing`. Raises `NoLive` when
    the character has no Live to reset to.
    """
    live = archive_live.read_live(character_id)
    if live is None:
        raise NoLive("no Live to reset the Workbench to")
    return replace_workbench(character_id, archive_workbench._seed_payload_from_live(live))


def load_zip_backup_into_workbench(
    character_id: int | str, backup_filename: str
) -> WorkbenchReplaced:
    """Restore: replace the Workbench's payload with a Backup's contents.

    The Backup is read and checked first; only then is the Workbench it
    replaces kept as a `before-restore` Backup, and only once that is
    written is the Workbench overwritten. Raises `BackupHoldsNoProfile`
    for the migration Backup, and `BackupTooOld` for a Backup from
    before the profile payload was stored in it (`read_backup_profile`).
    """
    payload = archive_workbench.backup_payload(
        read_backup_profile(character_id, backup_filename)
    )
    try:
        return replace_workbench(character_id, payload)
    except Refusal:
        raise
    except ValueError as exc:
        # Not a payload the Workbench takes (`write_workbench` checks).
        raise BackupUnreadable(f"the profile in this Backup cannot be loaded: {exc}") from exc
