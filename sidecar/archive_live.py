"""Live: the character as F-list showed it at the last Pull (`live.json`).

Writing Live is what brings a character into the archive: it registers
the character and creates its folder (`archive_registry`).
"""
from __future__ import annotations

import json
from typing import Any

import archive_registry
from services import events


@archive_registry.under_character_lock
def write_live(character_id: int | str, payload: dict[str, Any]) -> None:
    """Overwrite the Live snapshot. Caller is responsible for stamping
    `fetched_at` into the payload before calling.

    Also registers the character_id ↔ name in the folder registry and
    renames the on-disk folder if the name changed since the last
    write (e.g. F-list renames are detected the next time we pull
    that character). The registry write happens BEFORE the live.json
    write so the live.json lands in the new folder, not the stale one.
    """
    name = payload.get("name")
    if isinstance(name, str) and name.strip():
        archive_registry.register_character(character_id, name)
    folder = archive_registry.create_character_dir(character_id)
    archive_registry.write_json(folder / archive_registry.LIVE_FILENAME, payload)
    archive_registry.publish(events.LIVE_CHANGED, character_id)


@archive_registry.under_character_lock
def read_live(character_id: int | str) -> dict[str, Any] | None:
    p = archive_registry.character_dir(character_id) / archive_registry.LIVE_FILENAME
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


# Fields that are not F-list-side state: the Pull stamps `fetched_at`
# every time, so a hash that counted it would never match.
_LIVE_HASH_EXCLUDE = {"fetched_at"}


def live_content_hash(live: dict[str, Any]) -> str:
    """Canonical-JSON sha256 of `live`, ignoring fields that aren't
    really part of the F-list profile state (currently just
    `fetched_at`). A Pull compares it to tell whether F-list changed,
    and the ZIP backup dedup uses the same shape."""
    import hashlib

    filtered = {k: v for k, v in live.items() if k not in _LIVE_HASH_EXCLUDE}
    canonical = json.dumps(filtered, sort_keys=True, ensure_ascii=False).encode(
        "utf-8"
    )
    return hashlib.sha256(canonical).hexdigest()
