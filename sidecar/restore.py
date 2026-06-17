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
import threading
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import character_archive
import paths
import zip_serialise


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


def auth_token_valid(token: str | None) -> bool:
    _load_if_needed()
    if not token:
        return False
    with _STATE.lock:
        return _STATE.accepted_token is not None and secrets.compare_digest(
            _STATE.accepted_token, token
        )


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
    target = name.strip().lower()
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
        if isinstance(char_name, str) and char_name.strip().lower() == target:
            return entry.name
    return None


def list_snapshots(character_name: str) -> list[dict[str, Any]]:
    """Expose every importable source for `character_name`:

    1. **Live** — `live.json`, the canonical "From F-list" state.
    2. **Working sets** — each named set under `sets/`. Working sets are
       the user's saved drafts; the active one is reflected in
       `working.json` but the persisted entity is the set itself.
    3. **Backups** — full ZIP archives under `backups/`. Includes the
       auto pre-restore snapshots written by `/restore/snapshot/fresh`.

    Order: Live first (highest semantic priority — reverts edits),
    then sets newest-first, then backups newest-first.
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
            "label": "From F-list (current live state)",
            "created_at": _iso_from_path(
                character_archive.character_dir(character_id) / "live.json"
            ),
            "image_count": len(live_images),
        })

    for meta in character_archive.list_sets(character_id):
        payload = character_archive.read_set_payload(character_id, meta.id)
        image_count = 0
        if isinstance(payload, dict):
            images = payload.get("images")
            if isinstance(images, list):
                image_count = len(images)
        out.append({
            "id": f"set:{meta.id}",
            "kind": "set",
            "label": meta.name,
            "created_at": _iso_from_unix(meta.updated_at),
            "image_count": image_count,
        })

    for entry in character_archive.list_zip_backups(character_id):
        filename = entry.get("filename") if isinstance(entry, dict) else None
        if not filename:
            continue
        kind = "pre-restore" if filename.startswith("pre-restore-") else "backup"
        label = entry.get("label") or filename
        out.append({
            "id": filename,
            "kind": kind,
            "label": label,
            "created_at": entry.get("created_at") or entry.get("mtime"),
            "image_count": entry.get("image_count", 0),
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

    # Backup ZIP — already on disk; just return bytes.
    backups = character_archive.backups_dir(character_id)
    candidate = backups / snapshot_id
    if not candidate.exists() or not candidate.is_file():
        return None
    if candidate.suffix.lower() != ".zip":
        return None
    return candidate.read_bytes()


def _avatar_path_for_name(character_name: str) -> Path | None:
    """Workbench stores avatars at `<userdata>/avatars/<lowercase_name>.png`
    (keyed by character name, not character id). Earlier this function
    looked under `avatars/<id>.<ext>` which always missed, so the
    extension's apply path never received an avatar and was a no-op."""
    p = character_archive.avatar_path_for(character_name)
    if p.exists():
        return p
    return None


# ---- pre-restore "back up first" -------------------------------------


def write_pre_restore_snapshot(
    character_name: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Store the form-state payload sent by the extension as a labelled
    full ZIP backup. Bundles the form fields the extension extracted
    PLUS the character's local image gallery + avatar (last-pulled
    state from live.json), so the backup is a complete rollback
    point. Storage is cheap; the user's stated preference is "if
    we're going to take a snapshot we may as well make it full."

    The image list comes from live.json (last pulled state) — that's
    what's actually on F-list right now since gallery edits can't
    happen without saving the form. The form fields come from the
    extension (current page state, possibly unsaved edits).
    """
    character_id = _character_id_for_name(character_name)
    if character_id is None:
        return {"ok": False, "error": "unknown_character"}

    ts = time.strftime("%Y-%m-%dT%H-%M-%S", time.gmtime())
    filename = f"pre-restore-{ts}.zip"
    target = character_archive.backups_dir(character_id) / filename

    # Merge the form-state payload with the last-pulled image gallery so
    # zip_serialise.build_zip emits a complete character.json + images.
    working_shape = {
        "character": payload.get("character") or {},
        "settings": payload.get("settings") or {},
        "infotags": payload.get("infotags") or {},
        "kinks": payload.get("kinks") or {},
        "custom_kinks": payload.get("customKinks") or payload.get("custom_kinks") or [],
        "images": [],
        "inlines": [],
    }
    live = character_archive.read_live(character_id)
    if isinstance(live, dict):
        live_images = live.get("images")
        if isinstance(live_images, list):
            working_shape["images"] = live_images
        live_inlines = live.get("inlines")
        if live_inlines is not None:
            working_shape["inlines"] = live_inlines

    try:
        zip_bytes = zip_serialise.build_zip(
            character_id,
            working_shape,
            images_dir=character_archive.images_dir(character_id),
            avatar_path=_avatar_path_for_name(character_name),
        )
    except Exception as exc:  # pylint: disable=broad-except
        # Fall back to form-only if the merged build fails — better to
        # have a partial backup than none at all when the user is about
        # to apply a destructive restore.
        character_json = zip_serialise.to_zip_character_json(payload)
        character_json["meta"]["source"] = "pre-restore-extension"
        character_json["meta"]["note"] = (
            f"Full backup failed ({exc}); form fields only."
        )
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(
                "character.json",
                json.dumps(character_json, indent=2, ensure_ascii=False),
            )
        zip_bytes = buf.getvalue()

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(zip_bytes)

    return {
        "ok": True,
        "snapshot_id": filename,
        "path": str(target),
        "bytes": len(zip_bytes),
    }
