"""Pairing + snapshot service for the F-list Workbench browser extension.

State:
  - Accepted pairing token: persisted to `restore-state.json` in the
    Workbench user-data dir. Loaded on first call, then held in RAM.
  - Pending handshakes: RAM only, lost on sidecar restart (a stale
    handshake just times out client-side).
  - Pre-restore form-state snapshots ("back up first" option): written
    into the character's existing `backups/` directory with a
    distinguishing filename prefix so they show up alongside regular
    ZIP backups but are clearly attributed.

The pairing model is OBS-style: extension posts /restore/handshake,
sidecar generates a fresh token + handshake_id, returns both, marks
the handshake `pending`. Workbench renderer polls
/restore/handshake/pending, surfaces an Accept-this-extension modal,
calls /restore/handshake/accept|reject. Extension polls
/restore/handshake-status to learn the outcome.
"""

from __future__ import annotations

import io
import json
import secrets
import tempfile
import threading
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import character_archive
import paths
import zip_serialise
from refusals import BackupNotUploadable

#: `backup-meta.json` kind of the Backup taken before an Upload.
PRE_UPLOAD_BACKUP_KIND = "pre_upload"

#: How the note of a Backup taken without its images begins. Backups an
#: earlier version took that way carry only this note, no mark.
IMAGES_NOT_PACKED_NOTE = "Full backup failed"


def upload_refusal(character_id: str, filename: str) -> str | None:
    """Why a Backup must not be an Upload source, or None when it can
    be. One taken without its image files lists no image in
    character.json, which an Upload reads as "remove every image"."""
    meta = character_archive.zip_backup_meta(character_id, filename)
    note = meta.get("note")
    if meta.get("images_missing") or (
        meta.get("kind") == PRE_UPLOAD_BACKUP_KIND
        and isinstance(note, str)
        and note.startswith(IMAGES_NOT_PACKED_NOTE)
    ):
        return (
            "This Backup was taken without its image files, so uploading it "
            "would remove every image from the profile. Load it into the "
            "Workbench instead, and upload the Workbench."
        )
    return None


_STATE_FILENAME = "restore-state.json"
_HANDSHAKE_TTL_SEC = 300  # five minutes; client polls every 1.5s


@dataclass
class _PendingHandshake:
    handshake_id: str
    token: str
    fingerprint: str
    created_at: float
    status: str = "pending"  # pending | accepted | rejected


@dataclass
class _State:
    accepted_token: str | None = None
    pending: dict[str, _PendingHandshake] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)


_STATE = _State()
_LOADED = False


def _state_path() -> Path:
    return paths.user_data_dir() / _STATE_FILENAME


def _load_if_needed() -> None:
    global _LOADED
    if _LOADED:
        return
    path = _state_path()
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            tok = data.get("accepted_token")
            if isinstance(tok, str) and tok:
                _STATE.accepted_token = tok
        except (OSError, ValueError):
            pass
    _LOADED = True


def _persist() -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps({"accepted_token": _STATE.accepted_token}, indent=2),
        encoding="utf-8",
    )
    tmp.replace(path)


def _prune_expired_handshakes() -> None:
    now = time.time()
    expired = [
        hid for hid, h in _STATE.pending.items()
        if now - h.created_at > _HANDSHAKE_TTL_SEC
    ]
    for hid in expired:
        del _STATE.pending[hid]


def _fingerprint(token: str) -> str:
    return f"WB-{token[:8]}...{token[-4:]}"


# ---- handshake API ----------------------------------------------------


def begin_handshake() -> dict[str, str]:
    """Mint a fresh token + handshake_id. Token is NOT yet authoritative;
    the renderer must call accept_handshake() first. Extension stores
    the token locally and polls handshake_status() until accepted."""
    _load_if_needed()
    with _STATE.lock:
        _prune_expired_handshakes()
        token = secrets.token_urlsafe(32)
        handshake_id = secrets.token_urlsafe(16)
        _STATE.pending[handshake_id] = _PendingHandshake(
            handshake_id=handshake_id,
            token=token,
            fingerprint=_fingerprint(token),
            created_at=time.time(),
        )
    return {"handshake_id": handshake_id, "token": token}


def handshake_status(handshake_id: str) -> dict[str, str]:
    _load_if_needed()
    with _STATE.lock:
        _prune_expired_handshakes()
        h = _STATE.pending.get(handshake_id)
        if h is None:
            return {"status": "expired"}
        return {"status": h.status}


def list_pending_handshakes() -> list[dict[str, Any]]:
    """For the Workbench renderer to surface the accept modal."""
    _load_if_needed()
    with _STATE.lock:
        _prune_expired_handshakes()
        return [
            {
                "handshake_id": h.handshake_id,
                "fingerprint": h.fingerprint,
                "created_at": h.created_at,
            }
            for h in _STATE.pending.values()
            if h.status == "pending"
        ]


def accept_handshake(handshake_id: str) -> dict[str, str]:
    _load_if_needed()
    with _STATE.lock:
        _prune_expired_handshakes()
        h = _STATE.pending.get(handshake_id)
        if h is None:
            return {"ok": False, "error": "expired_or_unknown"}
        h.status = "accepted"
        _STATE.accepted_token = h.token
        _persist()
        return {"ok": True}


def reject_handshake(handshake_id: str) -> dict[str, str]:
    _load_if_needed()
    with _STATE.lock:
        h = _STATE.pending.get(handshake_id)
        if h is None:
            return {"ok": False, "error": "expired_or_unknown"}
        h.status = "rejected"
        return {"ok": True}


def revoke_token() -> None:
    """Settings → Security → Rotate pairing token."""
    _load_if_needed()
    with _STATE.lock:
        _STATE.accepted_token = None
        _STATE.pending.clear()
        _persist()


def is_paired() -> bool:
    """Whether an accepted pairing token is stored. Settings → Security
    shows this; the token itself never leaves this module."""
    _load_if_needed()
    with _STATE.lock:
        return _STATE.accepted_token is not None


def auth_token_valid(token: str | None) -> bool:
    _load_if_needed()
    if not token:
        return False
    with _STATE.lock:
        return _STATE.accepted_token is not None and secrets.compare_digest(
            _STATE.accepted_token, token
        )


# ---- extension version ------------------------------------------------

# The version the paired extension last reported, RAM only. Workbench
# ships the extension as an unpacked folder that Chrome reads once per
# browser start, so after an app update the files on disk can be newer
# than what the browser is running. Comparing the two is the only way
# to tell the user to reload it.
_EXTENSION_SEEN: dict[str, Any] | None = None


def note_extension_version(version: str | None) -> None:
    """Record the version an authenticated request carried. Called only
    after the token checked out, so an arbitrary local page cannot
    plant a version."""
    global _EXTENSION_SEEN
    if not version:
        return
    _EXTENSION_SEEN = {"version": version[:32], "seen_at": time.time()}


def extension_seen() -> dict[str, Any]:
    return _EXTENSION_SEEN or {"version": None, "seen_at": None}


# ---- snapshot listing + serving ---------------------------------------


def list_archived_characters() -> list[dict[str, Any]]:
    """Names of every character with an archive on disk. Lets the
    extension show a cross-character source picker — "edit Spielwiesending
    but load MainChar's working set."""
    root = character_archive.root()
    if not root.exists():
        return []
    out: list[dict[str, Any]] = []
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        live_path = entry / "live.json"
        if not live_path.exists():
            continue
        try:
            live = json.loads(live_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        name = live.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        out.append({
            "name": name,
            "character_id": entry.name,
        })
    out.sort(key=lambda r: r["name"].lower())
    return out


def _character_id_for_name(name: str) -> str | None:
    """Resolve F-list character name → local archive character_id by
    scanning live.json files. Returns None if no archive matches.

    live.json is the raw F-list API payload — name lives at the top
    level, not nested under "character". (zip_serialise wraps it under
    "character" for the userscript export shape; in-archive storage
    keeps the flat F-list shape.)
    """
    root = character_archive.root()
    if not root.exists():
        return None
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        live_path = entry / "live.json"
        if not live_path.exists():
            continue
        try:
            payload = json.loads(live_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        char_name = payload.get("name")
        if isinstance(char_name, str) and character_archive.same_character_name(
            char_name, name
        ):
            return entry.name
    return None


def list_snapshots(character_name: str) -> list[dict[str, Any]]:
    """Everything the extension can push into the F-list form:

    1. **Live on F-List** — `live.json`, what the website currently has.
       Pushing this reverts the profile to the last pull.
    2. **The Workbench** — the character's one editable copy. This is
       what a user means when they say "put my changes up".
    3. **Backups** — full ZIP archives under `backups/`, including the
       ones taken before an Upload by `/restore/snapshot/fresh`.

    Drafts the user never sees are not offered. A character used to be
    able to hold several named working sets, and the extension listed
    them all — which meant choosing between things the window did not
    show and the user could not name. Extra drafts left behind by an
    older version stay on disk and stay out of this list.

    Order: Live first (it reverts), then the bench, then backups
    newest-first.
    """
    character_id = _character_id_for_name(character_name)
    if character_id is None:
        return []

    out: list[dict[str, Any]] = []

    live = character_archive.read_live(character_id)
    if live is not None:
        live_images = live.get("images") if isinstance(live.get("images"), list) else []
        out.append({
            "id": "live",
            "kind": "live",
            "label": "Live on F-List (what the website has now)",
            "created_at": _iso_from_path(
                character_archive.character_dir(character_id) / "live.json"
            ),
            "image_count": len(live_images),
            "upload_refused": None,
        })

    # `create=False`: listing what can be pushed must not bring a
    # workbench into existence as a side effect.
    bench = character_archive.resolve_workbench(character_id, create=False)
    if bench is not None:
        payload = character_archive.read_set_payload(character_id, bench.id)
        image_count = 0
        if isinstance(payload, dict):
            images = payload.get("images")
            if isinstance(images, list):
                image_count = len(images)
        out.append({
            "id": f"set:{bench.id}",
            "kind": "set",
            "label": "Workbench (your edits)",
            "created_at": _iso_from_unix(bench.updated_at),
            "image_count": image_count,
            "upload_refused": None,
        })

    for entry in character_archive.list_zip_backups(character_id):
        filename = entry.get("filename") if isinstance(entry, dict) else None
        if not filename:
            continue
        # Surface the user-set name (from _names.json) and the backup
        # provenance sub-kind (manual_single / manual_bulk / scheduled /
        # import / pre_upload / unknown) so the extension's tab UI can
        # bucket backups the same way the in-app sidebar does. The
        # extension keeps the Backups taken before an Upload under their
        # own heading, which it calls "pre-restore".
        backup_kind = entry.get("kind") if isinstance(entry, dict) else None
        kind = "pre-restore" if backup_kind == PRE_UPLOAD_BACKUP_KIND else "backup"
        backup_name = entry.get("name") if isinstance(entry, dict) else None
        label = (
            entry.get("label")
            or backup_name
            or filename
        )
        created_at_raw = entry.get("created_at") or entry.get("mtime")
        created_at_iso = (
            _iso_from_unix(created_at_raw)
            if isinstance(created_at_raw, (int, float))
            else created_at_raw
        )
        out.append({
            "id": filename,
            "kind": kind,
            "label": label,
            "created_at": created_at_iso,
            "image_count": entry.get("image_count", 0),
            "backup_kind": backup_kind,
            "name": backup_name,
            # Listed, so the extension can say why it cannot be picked;
            # fetching it for an Upload is refused with the same reason.
            "upload_refused": upload_refusal(character_id, filename),
        })

    return out


def _iso_from_path(p: Path) -> str | None:
    try:
        mtime = p.stat().st_mtime
    except OSError:
        return None
    import datetime as _dt
    return _dt.datetime.fromtimestamp(mtime, tz=_dt.timezone.utc).isoformat()


def _iso_from_unix(ts: float | int | None) -> str | None:
    if ts is None:
        return None
    import datetime as _dt
    return _dt.datetime.fromtimestamp(float(ts), tz=_dt.timezone.utc).isoformat()


def fetch_snapshot_zip(character_name: str, snapshot_id: str) -> bytes | None:
    character_id = _character_id_for_name(character_name)
    if character_id is None:
        return None

    images_dir = character_archive.images_dir(character_id)
    avatar = _avatar_path_for_name(character_name)

    if snapshot_id == "live":
        live = character_archive.read_live(character_id)
        if live is None:
            return None
        working_shape = character_archive._seed_payload_from_live(live)
        return zip_serialise.build_zip(
            character_id,
            working_shape,
            images_dir=images_dir,
            avatar_path=avatar,
        )

    if snapshot_id.startswith("set:"):
        set_id = snapshot_id[len("set:"):]
        payload = character_archive.read_set_payload(character_id, set_id)
        if payload is None:
            return None
        return zip_serialise.build_zip(
            character_id,
            payload,
            images_dir=images_dir,
            avatar_path=avatar,
        )

    # Backup ZIP — already on disk; just return bytes. Only a name the
    # listing above offered: the id comes from a request, and joined
    # onto backups/ as given it could name any zip on the disk.
    listed = {
        entry.get("filename")
        for entry in character_archive.list_zip_backups(character_id)
    }
    if snapshot_id not in listed:
        return None
    candidate = character_archive.backups_dir(character_id) / snapshot_id
    if not candidate.is_file():
        return None
    refused = upload_refusal(character_id, snapshot_id)
    if refused:
        raise BackupNotUploadable(refused)
    return _with_form_state_translated(candidate.read_bytes())


def _with_form_state_translated(data: bytes) -> bytes:
    """A Backup an earlier version took before an Upload holds the edit
    form with the form's own field names (`fetish_<id>`, `info_<id>`) in
    character.json. The extension looks kinks and infotags up by bare id,
    so it would read every kink as unset and clear them on the page.
    Such a Backup is served translated; the file on disk stays as it is.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            working = json.loads(zf.read("working.json").decode("utf-8"))
    except (KeyError, ValueError, zipfile.BadZipFile):
        return data
    if not isinstance(working, dict) or not character_archive.is_form_state(working):
        return data
    return zip_serialise.repack_with_payload(
        data, character_archive.payload_from_form_state(working)
    )


def _avatar_path_for_name(character_name: str) -> Path | None:
    """Workbench stores avatars at `<userdata>/avatars/<lowercase_name>.png`
    (keyed by character name, not character id). Earlier this function
    looked under `avatars/<id>.<ext>` which always missed, so the
    extension's apply path never received an avatar and was a no-op."""
    p = character_archive.avatar_path_for(character_name)
    if p.exists():
        return p
    return None


# ---- the Backup before an Upload --------------------------------------


def write_pre_restore_snapshot(
    character_name: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Keep the F-list edit form, as the extension read it just before
    an Upload, as a Backup: the way back if the Upload goes wrong.

    It is a Backup like any other — same file name, listed by the window,
    MCP and the extension, restorable into the Workbench — so the form
    is translated into a Workbench payload first (`payload_from_form_state`).
    The gallery and the avatar come from the archive: gallery edits can
    only reach F-list through a save, so Live's images are what the
    profile has. The form fields are the page's, unsaved edits included.
    """
    character_id = _character_id_for_name(character_name)
    if character_id is None:
        return {"ok": False, "error": "unknown_character"}

    working = character_archive.payload_from_form_state(
        payload, character_archive.read_live(character_id)
    )
    try:
        zip_bytes = zip_serialise.build_zip(
            character_id,
            working,
            images_dir=character_archive.images_dir(character_id),
            avatar_path=_avatar_path_for_name(character_name),
            backup_kind=PRE_UPLOAD_BACKUP_KIND,
        )
    except Exception as exc:  # pylint: disable=broad-except
        # Without the image files if packing them fails: a partial
        # Backup beats none when the user is about to overwrite the
        # profile. working.json still lists the gallery, so it restores
        # into the Workbench; character.json lists no image, so it is
        # marked and refused as an Upload source, where it would read as
        # "remove every image".
        with tempfile.TemporaryDirectory() as no_images:
            zip_bytes = zip_serialise.build_zip(
                character_id,
                working,
                images_dir=Path(no_images),
                backup_kind=PRE_UPLOAD_BACKUP_KIND,
                backup_note=f"{IMAGES_NOT_PACKED_NOTE} ({exc}); form fields only.",
                images_missing=True,
            )

    target = character_archive.write_backup_zip(character_id, zip_bytes)

    return {
        "ok": True,
        "snapshot_id": target.name,
        "path": str(target),
        "bytes": len(zip_bytes),
    }
