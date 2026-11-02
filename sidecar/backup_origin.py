"""What a Backup holds and why it was made.

Every Backup records its `source` (the Live or the Workbench of its
moment) and its `occasion` (why it was taken) in its `backup-meta.json`.
Backups written before these fields existed are listed with source
"unknown" and no occasion.

The older `kind` field stays next to them: extension 0.1.1 sorts its
Backup list by it and leaves out a Backup whose kind it does not know,
so every Backup still writes one of the kinds that extension knows, or
none at all.
"""

from __future__ import annotations

from typing import Any

LIVE = "live"
WORKBENCH = "workbench"
SOURCES = (LIVE, WORKBENCH)
UNKNOWN_SOURCE = "unknown"

MANUAL = "manual"
BEFORE_UPLOAD = "before-upload"
BEFORE_RESTORE = "before-restore"
MIGRATION = "migration"
BACKUP_ALL = "backup-all"
OCCASIONS = (MANUAL, BEFORE_UPLOAD, BEFORE_RESTORE, MIGRATION, BACKUP_ALL)

#: The `kind` each occasion writes for extension 0.1.1. None writes no
#: kind; the Backup is then listed under kind "unknown", which that
#: extension still shows.
_EXTENSION_KIND: dict[str, str | None] = {
    MANUAL: "manual_single",
    BACKUP_ALL: "manual_bulk",
    BEFORE_UPLOAD: "pre_upload",
    BEFORE_RESTORE: "manual_single",
    MIGRATION: None,
}


def require(source: str, occasion: str) -> None:
    """Refuse a source or occasion outside the vocabulary."""
    if source not in SOURCES:
        raise ValueError(f"unknown Backup source: {source!r}")
    if occasion not in OCCASIONS:
        raise ValueError(f"unknown Backup occasion: {occasion!r}")


def extension_kind(occasion: str) -> str | None:
    """The older `kind` a Backup of this occasion writes."""
    return _EXTENSION_KIND[occasion]


def meta(source: str, occasion: str, *, kind: str | None = None) -> dict[str, Any]:
    """The origin fields of a new Backup's `backup-meta.json`: source,
    occasion and the extension's kind (the occasion's own unless given).
    The caller adds `created_at` and anything else it records."""
    require(source, occasion)
    out: dict[str, Any] = {}
    kind = kind if kind is not None else extension_kind(occasion)
    if kind is not None:
        out["kind"] = kind
    out["source"] = source
    out["occasion"] = occasion
    return out


def read(backup_meta: dict[str, Any] | None) -> dict[str, Any]:
    """`{source, occasion}` as a Backup list reports them: source
    "unknown" and occasion None for a Backup that does not record them."""
    backup_meta = backup_meta if isinstance(backup_meta, dict) else {}
    source = backup_meta.get("source")
    occasion = backup_meta.get("occasion")
    return {
        "source": source if source in SOURCES else UNKNOWN_SOURCE,
        "occasion": occasion if occasion in OCCASIONS else None,
    }
