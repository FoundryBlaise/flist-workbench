"""Tier 6 ZIP serialisation — translate a working.json payload into the
`character.json` shape the `flistcharexporter` userscript reads, and
package it with the referenced pool images into a userscript-compatible
ZIP.

Two entry points:

    to_zip_character_json(working_payload, *, pool_manifest=None) -> dict
        Pure shape transform. Tested by `test_zip_serialise.py`.

    build_zip(character_id, working_payload, *, pool_dir, avatar_path) -> bytes
        Bundles the JSON + each referenced pool image at
        `images/<image_id>.<ext>` + `avatar.png` at the root.

Shape contract: see the Vanessa sample at
`/sideprojects/flistcharexporter/flist_Vanessa_Arlington_*.json` and
the userscript's `importCharacterData` reader.
"""
from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# Working.json settings -> userscript-export settings rename map.
# Workbench stores the F-list profile-form field names (snake_case);
# the export shape collapses to the URL-friendly lowercase keys the
# userscript posts back at restore time.
_SETTINGS_RENAME = {
    "customs_first": "customsfirst",
    "show_friends": "showfriends",
    "prevent_bookmarks": "unbookmarkable",
}

# Working.json keys that don't survive into the ZIP. `guestbook` is a
# per-viewer preference on F-list, not a profile field — the userscript
# never sets it on restore.
_SETTINGS_DROP = {"guestbook"}

# Owner-only settings (visible to the account, not the public profile)
# default to these when missing from the working copy. Pinned by
# `test_owner_only_settings_filled_from_defaults` — change with caution.
_SETTINGS_OWNER_DEFAULTS: dict[str, bool] = {
    "showtimezone": True,
    "showbadges": False,
    "showcharlist": True,
}

_VALID_CHOICES = {"fave", "yes", "maybe", "no", "undecided"}

_EXPORT_FORMAT_VERSION = "0.0.0"


def to_zip_character_json(
    working_payload: dict[str, Any],
    *,
    pool_manifest: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Translate `working_payload` into the userscript's character.json.

    `pool_manifest` is the per-character `pool/manifest.json` mapping
    `sha256 -> {extension, image_id, …}`. Optional so the pinned
    contract tests can drive the serialiser without a real archive —
    they pass `image_id`+`extension` directly on image entries.
    """
    return {
        "meta": _build_meta(),
        "character": _reshape_character(working_payload.get("character")),
        "settings": _reshape_settings(working_payload.get("settings")),
        "infotags": _reshape_infotags(working_payload.get("infotags")),
        "kinks": _reshape_kinks(working_payload.get("kinks")),
        "customKinks": _reshape_custom_kinks(working_payload),
        "images": _reshape_images(
            working_payload.get("images"), pool_manifest=pool_manifest
        ),
        "inlines": _reshape_inlines(working_payload.get("inlines")),
    }


def build_zip(
    character_id: str | int,
    working_payload: dict[str, Any],
    *,
    pool_manifest: dict[str, dict[str, Any]],
    pool_dir: Path,
    avatar_path: Path | None = None,
) -> bytes:
    """Pack `character.json` + referenced pool images + the avatar into
    a ZIP, returning the bytes. Skips image entries whose pool file is
    missing rather than failing the whole export — the userscript will
    still upload the JSON + any images that resolved.

    `character_id` is currently ignored; reserved for future per-set
    routing (Tier 7) so the signature doesn't churn then.
    """
    del character_id  # not yet used; signature reserved for Tier 7

    character_json = to_zip_character_json(
        working_payload, pool_manifest=pool_manifest
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "character.json",
            json.dumps(character_json, indent=2, ensure_ascii=False),
        )
        # Each ZIP entry name must be unique. Two images in the gallery
        # could resolve to the same `images/<image_id>.<ext>` path if
        # the working payload duplicates a sha — skip the dup.
        written: set[str] = set()
        for entry in character_json["images"]["list"]:
            filename = entry.get("filename")
            if not isinstance(filename, str) or filename in written:
                continue
            sha = _sha_for_image_filename(
                filename, working_payload.get("images"), pool_manifest
            )
            if sha is None:
                continue
            meta = pool_manifest.get(sha)
            if not isinstance(meta, dict):
                continue
            ext = meta.get("extension")
            if not isinstance(ext, str):
                continue
            src = pool_dir / f"{sha}.{ext}"
            if not src.exists():
                continue
            zf.write(src, filename)
            written.add(filename)
        if avatar_path is not None and avatar_path.exists():
            zf.write(avatar_path, "avatar.png")
    return buf.getvalue()


# ---- internals --------------------------------------------------------


def _build_meta() -> dict[str, str]:
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    if now.endswith("+00:00"):
        now = now[:-6] + "Z"
    return {"exportedAt": now, "version": _EXPORT_FORMAT_VERSION}


def _reshape_character(character: Any) -> dict[str, str]:
    """Lowercase-+-camelCase mapping for the four export fields. F-list's
    public character payload uses `custom_title`; the userscript export
    renames it to `customTitle`."""
    if not isinstance(character, dict):
        character = {}
    cid = character.get("id")
    return {
        "id": "" if cid is None else str(cid),
        "name": _as_str(character.get("name")),
        "description": _as_str(character.get("description")),
        "customTitle": _as_str(
            character.get("custom_title") or character.get("customTitle")
        ),
    }


def _reshape_settings(settings: Any) -> dict[str, Any]:
    if not isinstance(settings, dict):
        settings = {}
    out: dict[str, Any] = {}
    for key, value in settings.items():
        if key in _SETTINGS_DROP:
            continue
        out[_SETTINGS_RENAME.get(key, key)] = value
    for key, default in _SETTINGS_OWNER_DEFAULTS.items():
        out.setdefault(key, default)
    return out


def _reshape_infotags(infotags: Any) -> dict[str, Any]:
    if not isinstance(infotags, dict):
        return {}
    # Tier 2 convention: cleared infotags are absent (not ""); pass
    # through whatever the working payload carries.
    return {str(k): v for k, v in infotags.items()}


def _reshape_kinks(kinks: Any) -> dict[str, str]:
    if not isinstance(kinks, dict):
        return {}
    return {str(k): str(v) for k, v in kinks.items()}


def _reshape_custom_kinks(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Custom kinks come out of working.json as a dict keyed by id (or
    `local:<uuid>` for not-yet-uploaded entries), plus a sibling
    `_custom_kinks_order` array that fixes display order. The ZIP
    flattens to an ordered array, drops tombstones, normalises invalid
    choices to "undecided", and clears the local: prefix to a null id
    so F-list knows to mint a real one at restore."""
    custom_kinks = payload.get("custom_kinks")
    if not isinstance(custom_kinks, dict):
        return []
    order = payload.get("_custom_kinks_order")
    if not isinstance(order, list):
        order = list(custom_kinks.keys())
    out: list[dict[str, Any]] = []
    for key in order:
        if not isinstance(key, str):
            continue
        entry = custom_kinks.get(key)
        if not isinstance(entry, dict):
            continue
        if entry.get("_deleted"):
            continue
        choice = entry.get("choice")
        if not isinstance(choice, str) or choice not in _VALID_CHOICES:
            choice = "undecided"
        out.append(
            {
                "id": None if key.startswith("local:") else key,
                "name": _as_str(entry.get("name")),
                "description": _as_str(entry.get("description")),
                "choice": choice,
            }
        )
    return out


def _reshape_images(
    images: Any,
    *,
    pool_manifest: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Two input shapes are accepted:

    1. Tier 6+: `[{sha256, description}]` — needs `pool_manifest` to
       resolve sha → (image_id, extension). When the manifest entry has
       no F-list image_id (user-uploaded, never restored), a local
       filename is synthesised so the ZIP entry has a stable name.

    2. Pinned-test legacy: `[{image_id, extension, description?}]` —
       used directly without manifest lookup.
    """
    out_list: list[dict[str, Any]] = []
    if isinstance(images, list):
        for index, entry in enumerate(images):
            if not isinstance(entry, dict):
                continue
            sha = entry.get("sha256")
            image_id = entry.get("image_id") or entry.get("id")
            ext = entry.get("extension")
            if isinstance(sha, str) and pool_manifest is not None:
                meta = pool_manifest.get(sha, {})
                if not image_id:
                    image_id = meta.get("image_id")
                if not ext:
                    ext = meta.get("extension")
            if not image_id:
                # User-uploaded image with no F-list id yet. Use a short
                # sha-derived stem so the ZIP entry name stays stable
                # across exports.
                stem = sha[:16] if isinstance(sha, str) and sha else f"unknown_{index}"
                image_id = f"local_{stem}"
            if not ext:
                ext = "png"
            out_list.append(
                {
                    "position": index,
                    "filename": f"images/{image_id}.{ext}",
                    "description": _as_str(entry.get("description")),
                }
            )
    return {
        "list": out_list,
        "avatar": {"filename": "avatar.png"},
    }


def _reshape_inlines(inlines: Any) -> list[str]:
    """The userscript's restore path doesn't yet upload inlines, but the
    export still carries the id list so a future round-trip can be
    verified against existing exports. dict-form working.json (`{id:
    {hash, extension, nsfw}}`) collapses to the id array."""
    if isinstance(inlines, dict):
        return [str(k) for k in inlines.keys()]
    if isinstance(inlines, list):
        return [str(x) for x in inlines if x is not None]
    return []


def _sha_for_image_filename(
    filename: str,
    images: Any,
    pool_manifest: dict[str, dict[str, Any]],
) -> str | None:
    """Reverse-lookup: given an `images/<image_id>.<ext>` entry, return
    the pool sha so `build_zip` knows which file to embed. Handles both
    F-list image_id stems and the `local_<sha-prefix>` synthetic stems
    from `_reshape_images`."""
    stem = Path(filename).stem
    if stem.startswith("local_"):
        prefix = stem[len("local_") :]
        # Match a manifest entry whose sha starts with the prefix.
        for sha in pool_manifest.keys():
            if sha.startswith(prefix):
                return sha
        # Fall through to image-array sha lookup.
    # Try matching the stem against pool manifest's image_id field.
    for sha, meta in pool_manifest.items():
        if meta.get("image_id") == stem:
            return sha
    # Last resort: scan the images array for an entry whose sha would
    # serialise to this filename. Useful when a Tier 6 working payload
    # carries the sha but no F-list image_id resolves via manifest.
    if isinstance(images, list):
        for entry in images:
            if not isinstance(entry, dict):
                continue
            sha = entry.get("sha256")
            if not isinstance(sha, str):
                continue
            if stem == f"local_{sha[:16]}":
                return sha
    return None


def _as_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value)
