"""Workbench-native working-set bundle: build + import.

A bundle is a self-contained ZIP with everything needed to recreate a
working set on another Workbench install. Format is distinct from the
userscript restore ZIP (`zip_serialise.py`) — that one targets the
F-list edit form via the companion userscript; this one round-trips
between Workbench instances and carries the full v6 payload as-is so
no information is lost on the trip.

Layout inside the ZIP:

    manifest.json    { format, format_version, exported_at, source: {...},
                       payload_schema_version, image_count }
    working.json     The full set payload (the same shape write_set_payload
                     persists to disk).
    images/<image_id>.<ext>
                     Bytes for every image_id referenced by the payload's
                     gallery that exists on disk in the source archive.

On import, the bundle's images are added to the target character's
`images/` store *only* when an image with the same id doesn't already
exist there — pulled-image ids are content-addressed by F-list and
`local-<sha8>` ids are sha-derived, so a same-id collision means the
bytes match and overwriting would just thrash the disk.

Cross-character import is permitted but requires explicit confirmation
from the caller (the renderer puts up a modal). When confirmed, the
payload's `character.id`/`character.name` are rewritten to match the
target so the working set's identity matches its enclosing directory.
"""
from __future__ import annotations

import io
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import character_archive


BUNDLE_FORMAT = "flist-workbench-set"
BUNDLE_FORMAT_VERSION = 1

_MANIFEST_NAME = "manifest.json"
_PAYLOAD_NAME = "working.json"
_IMAGES_PREFIX = "images/"

_IMAGE_FILE_RE = re.compile(r"^([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)$")
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")

# Generous upper bound; protects the sidecar from absurd uploads but
# still leaves headroom for a profile with ~100 large images.
_MAX_BUNDLE_BYTES = 200 * 1024 * 1024


class BundleError(ValueError):
    """Raised for malformed or unsupported bundles. The endpoint maps
    these onto HTTP 422 with the message intact."""


class CrossCharacterConfirmationRequired(Exception):
    """Raised by `import_set_bundle` when the manifest's source character
    differs from the import target and the caller hasn't confirmed. The
    endpoint surfaces this as a structured 422 the renderer uses to
    drive the warning modal."""

    def __init__(self, source: dict[str, Any]) -> None:
        super().__init__("cross_character_confirmation_required")
        self.source = source


# ---- build -----------------------------------------------------------


def build_set_bundle(
    character_id: int | str,
    set_id: str,
) -> tuple[bytes, dict[str, Any]]:
    """Pack a set into a Workbench-native bundle. Returns
    `(zip_bytes, manifest_dict)` so the endpoint can use the manifest to
    derive a Content-Disposition filename without re-parsing the ZIP.

    Missing image bytes are skipped silently — the same behaviour as
    `zip_serialise.build_zip` so a partially-pulled set still exports
    something useful. The payload itself always lands in the ZIP intact;
    image references that didn't resolve stay in `working.json` and the
    receiving Workbench will simply display gaps in the gallery (the
    pool view already tolerates missing bytes).
    """
    meta = character_archive.read_set_meta(character_id, set_id)
    if meta is None:
        raise FileNotFoundError(f"set {set_id} not found")
    payload = character_archive.read_set_payload(character_id, set_id)
    if payload is None:
        raise FileNotFoundError(f"set {set_id} payload missing")

    char = payload.get("character") if isinstance(payload.get("character"), dict) else {}
    source_name = ""
    if isinstance(char, dict):
        nm = char.get("name")
        if isinstance(nm, str):
            source_name = nm

    images_dir = character_archive.images_dir(character_id)
    referenced = _referenced_image_ids(payload)

    # Map referenced id → on-disk filename (id.ext). Walk the directory
    # once rather than os.exists() per id so a profile with 50 images
    # stays a single stat-loop instead of 50 path checks.
    on_disk: dict[str, str] = {}
    if images_dir.exists():
        for entry in images_dir.iterdir():
            if not entry.is_file():
                continue
            m = _IMAGE_FILE_RE.match(entry.name)
            if not m:
                continue
            iid = m.group(1)
            if iid in referenced:
                on_disk[iid] = entry.name

    manifest = {
        "format": BUNDLE_FORMAT,
        "format_version": BUNDLE_FORMAT_VERSION,
        "exported_at": _iso_now(),
        "source": {
            "character_id": str(character_id),
            "character_name": source_name,
            "set_id": meta.id,
            "set_name": meta.name,
        },
        "payload_schema_version": payload.get(
            "_schema_version", character_archive.WORKING_SCHEMA_VERSION
        ),
        "image_count": len(on_disk),
    }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            _MANIFEST_NAME,
            json.dumps(manifest, indent=2, ensure_ascii=False),
        )
        zf.writestr(
            _PAYLOAD_NAME,
            json.dumps(payload, indent=2, ensure_ascii=False),
        )
        for iid, filename in sorted(on_disk.items()):
            src = images_dir / filename
            zf.write(src, f"{_IMAGES_PREFIX}{filename}")

    return buf.getvalue(), manifest


# ---- import ----------------------------------------------------------


def import_set_bundle(
    target_character_id: int | str,
    zip_bytes: bytes,
    *,
    name: str,
    confirm_cross_character: bool = False,
) -> dict[str, Any]:
    """Materialise a bundle into a new working set under
    `target_character_id`. `name` is the set name to create with — the
    renderer chooses it (auto-`Imported set N` or user-supplied).

    Returns `{set: SetMeta, source: {...}, image_stats: {added, skipped}}`.

    Raises:
      BundleError — malformed ZIP, missing/invalid manifest or payload,
        unsupported format/version.
      CrossCharacterConfirmationRequired — source character differs from
        target and `confirm_cross_character` is False. The endpoint
        translates this into a 422 the renderer's import modal handles.
      ValueError — `name` fails `validate_set_name`.
    """
    if len(zip_bytes) > _MAX_BUNDLE_BYTES:
        raise BundleError(
            f"bundle is larger than the {_MAX_BUNDLE_BYTES // (1024 * 1024)} MB import limit"
        )

    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes), mode="r")
    except zipfile.BadZipFile as exc:
        raise BundleError(f"not a valid ZIP file: {exc}") from exc

    with zf:
        manifest = _read_manifest(zf)
        _validate_manifest(manifest)
        payload = _read_payload(zf)

        source = manifest.get("source") or {}
        source_character_id = str(source.get("character_id") or "")
        target_str = str(target_character_id)
        cross_character = (
            source_character_id != "" and source_character_id != target_str
        )
        if cross_character and not confirm_cross_character:
            raise CrossCharacterConfirmationRequired(
                {
                    "character_id": source_character_id,
                    "character_name": str(source.get("character_name") or ""),
                    "set_name": str(source.get("set_name") or ""),
                }
            )

        clean_name = character_archive.validate_set_name(name)

        if cross_character:
            payload = _rewrite_character_identity(payload, target_character_id)

        added, skipped = _copy_images(zf, target_character_id)

    new_meta = character_archive._materialise_set(
        target_character_id, clean_name, payload
    )
    return {
        "set": new_meta.to_dict(),
        "source": {
            "character_id": source_character_id,
            "character_name": str(source.get("character_name") or ""),
            "set_id": str(source.get("set_id") or ""),
            "set_name": str(source.get("set_name") or ""),
        },
        "image_stats": {"added": added, "skipped": skipped},
        "cross_character": cross_character,
    }


# ---- internals -------------------------------------------------------


def _iso_now() -> str:
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    if now.endswith("+00:00"):
        now = now[:-6] + "Z"
    return now


def _referenced_image_ids(payload: dict[str, Any]) -> set[str]:
    """Collect every image_id that the payload's gallery names. Inline
    images live in a separate `inlines/` store keyed by sha1 basename
    and are intentionally excluded from the v1 bundle — they round-trip
    as metadata inside working.json but no inline bytes are carried."""
    out: set[str] = set()
    images = payload.get("images")
    if isinstance(images, list):
        for entry in images:
            if not isinstance(entry, dict):
                continue
            iid = entry.get("image_id") or entry.get("id")
            if isinstance(iid, (str, int)) and str(iid):
                out.add(str(iid))
    return out


def _read_manifest(zf: zipfile.ZipFile) -> dict[str, Any]:
    try:
        raw = zf.read(_MANIFEST_NAME)
    except KeyError as exc:
        raise BundleError("bundle is missing manifest.json") from exc
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BundleError(f"manifest.json is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise BundleError("manifest.json must be a JSON object")
    return data


def _validate_manifest(manifest: dict[str, Any]) -> None:
    fmt = manifest.get("format")
    if fmt != BUNDLE_FORMAT:
        raise BundleError(
            f"unsupported bundle format: {fmt!r} "
            f"(expected {BUNDLE_FORMAT!r})"
        )
    version = manifest.get("format_version")
    if not isinstance(version, int) or version < 1 or version > BUNDLE_FORMAT_VERSION:
        raise BundleError(
            f"unsupported bundle format_version: {version!r} "
            f"(this build understands up to {BUNDLE_FORMAT_VERSION})"
        )


def _read_payload(zf: zipfile.ZipFile) -> dict[str, Any]:
    try:
        raw = zf.read(_PAYLOAD_NAME)
    except KeyError as exc:
        raise BundleError("bundle is missing working.json") from exc
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BundleError(f"working.json is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise BundleError("working.json must be a JSON object")
    # Validation mirrors write_set_payload's checks so a malformed bundle
    # fails fast instead of after we've already copied image bytes.
    overlay = data.get("_overlay")
    if overlay is None:
        data["_overlay"] = []
    elif not isinstance(overlay, list) or not all(isinstance(s, str) for s in overlay):
        raise BundleError("working.json _overlay must be a list of strings")
    if not any(k in data for k in character_archive._WORKING_TOP_LEVEL_KEYS):
        raise BundleError(
            "working.json must carry at least one of "
            f"{sorted(character_archive._WORKING_TOP_LEVEL_KEYS)}"
        )
    schema_version = data.get("_schema_version")
    if isinstance(schema_version, int) and schema_version > character_archive.WORKING_SCHEMA_VERSION:
        raise BundleError(
            f"bundle payload schema v{schema_version} is newer than this "
            f"build supports (v{character_archive.WORKING_SCHEMA_VERSION}); "
            f"upgrade the app to import this bundle"
        )
    return data


def _rewrite_character_identity(
    payload: dict[str, Any],
    target_character_id: int | str,
) -> dict[str, Any]:
    """Cross-character import: replace the source character's id (and
    name, when known) so the imported working set's identity matches the
    target character. Everything else — description, infotags, kinks,
    custom_kinks, images — is preserved verbatim, which is the whole
    point of allowing cross-character import."""
    char = payload.get("character")
    if not isinstance(char, dict):
        char = {}
    char = dict(char)
    char["id"] = str(target_character_id)
    # Look up the target name from its live.json. If unavailable
    # (character archived but never pulled, edge case) fall back to
    # whatever the source carried so the field isn't empty.
    live = character_archive.read_live(target_character_id)
    if isinstance(live, dict):
        live_char = live.get("character")
        if isinstance(live_char, dict):
            nm = live_char.get("name")
            if isinstance(nm, str) and nm:
                char["name"] = nm
        elif isinstance(live.get("name"), str) and live["name"]:
            char["name"] = live["name"]
    out = dict(payload)
    out["character"] = char
    return out


def _copy_images(
    zf: zipfile.ZipFile,
    target_character_id: int | str,
) -> tuple[int, int]:
    """Walk every `images/*` entry in the ZIP and copy bytes into the
    target's `images/` store, skipping any id that's already on disk.
    Returns `(added, skipped)`. Path-traversal and weird filenames are
    silently dropped — a malicious bundle can't escape the archive."""
    images_dir = character_archive.images_dir(target_character_id)
    existing_ids: set[str] = set()
    if images_dir.exists():
        for entry in images_dir.iterdir():
            if not entry.is_file():
                continue
            m = _IMAGE_FILE_RE.match(entry.name)
            if m:
                existing_ids.add(m.group(1))

    added = 0
    skipped = 0
    for info in zf.infolist():
        if info.is_dir():
            continue
        if not info.filename.startswith(_IMAGES_PREFIX):
            continue
        rest = info.filename[len(_IMAGES_PREFIX):]
        if "/" in rest or "\\" in rest or ".." in rest:
            continue
        m = _IMAGE_FILE_RE.match(rest)
        if not m:
            continue
        image_id = m.group(1)
        ext = m.group(2).lower()
        if not _SAFE_ID_RE.match(image_id):
            continue
        if image_id in existing_ids:
            skipped += 1
            continue
        try:
            ext_n = character_archive.normalise_image_ext(ext)
        except ValueError:
            # Unsupported extension — ignore; the userscript would also
            # reject it on the eventual restore round.
            continue
        try:
            data = zf.read(info)
        except (KeyError, zipfile.BadZipFile):
            continue
        # write_character_image is atomic + idempotent + validates the id.
        try:
            character_archive.write_character_image(
                target_character_id, image_id, ext_n, data
            )
        except ValueError:
            continue
        existing_ids.add(image_id)
        added += 1
    return added, skipped
