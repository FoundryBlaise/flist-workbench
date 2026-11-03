"""Changing settings: the one place that validates, clamps, stores and
announces them.

The window changes settings with `PUT /settings`, a model with the MCP
`update_settings` tool. Both used to check the values themselves, and
drifted: the tool stored an empty model name the route would have
cleared, and knew only half the fields. Now both parse their request
into field names (`FIELDS`), call `update`, and shape what it returns.
A value is refused or clamped the same way whoever sends it, and every
change is published as `settings-changed`, so the window shows what a
model changed without a reload.

Which fields a caller may change is the caller's decision, not this
module's: the MCP tool has no parameter for the F-Chat folder or the
import folders, so a model cannot widen what it may read.
"""

from __future__ import annotations

import json
import math
import sqlite3
from pathlib import Path
from typing import Any, Callable, Mapping

import model_weights
import rag as rag_settings
import settings as settings_store
from refusals import ValidationFailed
from services import events
from services import image_import

#: Text fields where an empty value clears the setting back to its default.
_TEXT = {
    "fchat_data_dir": settings_store.KEY_FCHAT_DATA_DIR,
    "rag.embed_model": settings_store.KEY_RAG_EMBED_MODEL,
    "rag.rerank_model": settings_store.KEY_RAG_RERANK_MODEL,
}

#: Whole-number fields and the range a value is clamped into. A typo
#: out of range resolves to the nearest sensible value instead of an
#: error; the ranges match what `rag.load_settings` accepts on read.
_INT_RANGES: dict[str, tuple[str, int, int | None]] = {
    # Zero or below would make every message OOC: almost surely a typo.
    "labels.threshold_chars": (settings_store.KEY_LABELS_THRESHOLD_CHARS, 1, None),
    "rag.rerank_candidates": (settings_store.KEY_RAG_RERANK_CANDIDATES, 1, 200),
    "rag.top_k": (settings_store.KEY_RAG_TOP_K, 1, 50),
    "rag.neighbors": (settings_store.KEY_RAG_NEIGHBORS, 0, 5),
    "rag.hybrid_bm25_candidates": (settings_store.KEY_RAG_HYBRID_BM25_CANDIDATES, 1, 200),
    "rag.chunk_max_chars": (settings_store.KEY_RAG_CHUNK_MAX_CHARS, 500, 20000),
    "rag.chunk_overlap_msgs": (settings_store.KEY_RAG_CHUNK_OVERLAP_MSGS, 0, 5),
}

#: The fields naming a model, whose old weights go when they change.
_MODEL_KINDS = {
    "rag.embed_model": model_weights.Kind.EMBEDDING,
    "rag.rerank_model": model_weights.Kind.RERANKER,
}

#: Every field `update` takes.
FIELDS = (
    *_TEXT,
    *_INT_RANGES,
    "rag.chunk_soft_split_chars",
    "rag.rerank_min_ratio",
    "rag.hybrid_enabled",
    "image_import_roots",
    "mcp.log_text",
)


def update(changes: Mapping[str, Any], conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    """Validate and store `changes` (field name -> value); fields left
    out stay as they are. Returns the fields as stored, after clamping;
    None for one that went back to its default.

    Every value is checked before anything is written, and the writes
    land in one transaction, so a refused field leaves every other one
    as it was. Raises `ValidationFailed` naming the field.

    None, or an empty text, clears a field back to its default.
    """
    unknown = sorted(set(changes) - set(FIELDS))
    if unknown:
        raise ValidationFailed(unknown[0], "not a setting", allowed=list(FIELDS))
    if not changes:
        return {}

    own = conn is None
    conn = conn or settings_store.connect()
    try:
        writes: dict[str, str | None] = {}
        changed: dict[str, Any] = {}
        for field in FIELDS:
            if field not in changes:
                continue
            key, stored, reported = _VALIDATORS[field](conn, changes, changes[field])
            writes[key] = stored
            changed[field] = reported
        settings_store.write_many(conn, writes)
        switched = [kind for field, kind in _MODEL_KINDS.items() if field in changes]
        if switched:
            model_weights.remove_stale(switched)
    finally:
        if own:
            conn.close()

    events.publish(events.SETTINGS_CHANGED, changed=changed)
    return changed


# --------------------------------------------------------------------
# One validator per field: (conn, all changes, value) ->
# (settings key, text to store or None to clear, value to report)
# --------------------------------------------------------------------

_Result = tuple[str, "str | None", Any]


def _fchat_data_dir(conn: sqlite3.Connection, changes: Mapping[str, Any], value: Any) -> _Result:
    key = _TEXT["fchat_data_dir"]
    text = _text("fchat_data_dir", value)
    if not text:
        return key, None, None
    # Refused up front, so the window gets a clear reason rather than an
    # empty character list later.
    path = Path(text).expanduser()
    if not path.is_dir():
        raise ValidationFailed("fchat_data_dir", f"directory does not exist: {text}")
    return key, str(path), str(path)


def _embed_model(conn: sqlite3.Connection, changes: Mapping[str, Any], value: Any) -> _Result:
    key = _TEXT["rag.embed_model"]
    text = _text("rag.embed_model", value)
    if not text:
        return key, None, None
    # Every fastembed id is "org/name"; `rag.load_settings` ignores
    # anything else, so storing it would report a change that never
    # takes effect.
    if "/" not in text:
        raise ValidationFailed(
            "rag.embed_model", f"not a fastembed model id (org/name): {text}"
        )
    return key, text, text


def _rerank_model(conn: sqlite3.Connection, changes: Mapping[str, Any], value: Any) -> _Result:
    key = _TEXT["rag.rerank_model"]
    text = _text("rag.rerank_model", value)
    return key, text or None, text or None


def _clamped_int(field: str) -> Callable[..., _Result]:
    key, lo, hi = _INT_RANGES[field]

    def validate(conn: sqlite3.Connection, changes: Mapping[str, Any], value: Any) -> _Result:
        if value is None:
            return key, None, None
        n = _clamp(_int(field, value), lo, hi)
        return key, str(n), n

    return validate


def _chunk_soft_split_chars(
    conn: sqlite3.Connection, changes: Mapping[str, Any], value: Any
) -> _Result:
    key = settings_store.KEY_RAG_CHUNK_SOFT_SPLIT_CHARS
    if value is None:
        return key, None, None
    # A soft split at or past the hard maximum never fires, so it stays
    # at least 100 under it: the maximum sent alongside, or the stored one.
    if changes.get("rag.chunk_max_chars") is not None:
        _, _, cur_max = _VALIDATORS["rag.chunk_max_chars"](
            conn, changes, changes["rag.chunk_max_chars"]
        )
    else:
        cur_max = _stored_int(
            conn, settings_store.KEY_RAG_CHUNK_MAX_CHARS, rag_settings.DEFAULT_CHUNK_MAX_CHARS
        )
    n = _clamp(_int("rag.chunk_soft_split_chars", value), 400, max(500, cur_max - 100))
    return key, str(n), n


def _rerank_min_ratio(conn: sqlite3.Connection, changes: Mapping[str, Any], value: Any) -> _Result:
    key = settings_store.KEY_RAG_RERANK_MIN_RATIO
    if value is None:
        return key, None, None
    if isinstance(value, bool):
        raise ValidationFailed("rag.rerank_min_ratio", "not a number")
    try:
        ratio = float(value)
    except (TypeError, ValueError):
        raise ValidationFailed("rag.rerank_min_ratio", "not a number") from None
    if not math.isfinite(ratio):
        raise ValidationFailed("rag.rerank_min_ratio", "not a finite number")
    ratio = max(0.0, min(1.0, ratio))
    return key, str(ratio), ratio


def _bool(field: str, key: str, cleared: bool | None) -> Callable[..., _Result]:
    """A true-or-false field; None clears it, reported as `cleared`."""

    def validate(conn: sqlite3.Connection, changes: Mapping[str, Any], value: Any) -> _Result:
        if value is None:
            return key, None, cleared
        if not isinstance(value, bool):
            raise ValidationFailed(field, "not true or false", allowed=[True, False])
        # Stored as "1" / "0" so the table stays TEXT.
        return key, "1" if value else "0", value

    return validate


def log_text_over_mcp(conn: sqlite3.Connection | None = None) -> bool:
    """Whether the user has let MCP clients have the tools that return
    Log text. Off until they turn it on in Settings → MCP.

    Asked on every MCP tool listing, so asking creates nothing: without
    a settings.db nothing was ever turned on.
    """
    if conn is None and not settings_store.db_exists():
        return False
    own = conn is None
    conn = conn or settings_store.connect()
    try:
        return settings_store.get(conn, settings_store.KEY_MCP_LOG_TEXT) == "1"
    finally:
        if own:
            conn.close()


def _image_import_roots(
    conn: sqlite3.Connection, changes: Mapping[str, Any], value: Any
) -> _Result:
    key = settings_store.KEY_IMAGE_IMPORT_ROOTS
    if value is None:
        return key, None, []
    if not isinstance(value, (list, tuple)):
        raise ValidationFailed("image_import_roots", "not a list of folders")
    try:
        cleaned = image_import.clean_import_roots(list(value))
    except ValueError as exc:
        raise ValidationFailed("image_import_roots", str(exc)) from exc
    return key, json.dumps(cleaned) if cleaned else None, cleaned


_VALIDATORS: dict[str, Callable[..., _Result]] = {
    "fchat_data_dir": _fchat_data_dir,
    "rag.embed_model": _embed_model,
    "rag.rerank_model": _rerank_model,
    **{field: _clamped_int(field) for field in _INT_RANGES},
    "rag.chunk_soft_split_chars": _chunk_soft_split_chars,
    "rag.rerank_min_ratio": _rerank_min_ratio,
    "rag.hybrid_enabled": _bool("rag.hybrid_enabled", settings_store.KEY_RAG_HYBRID_ENABLED, None),
    "image_import_roots": _image_import_roots,
    # Off unless the user turned it on: cleared reads as off.
    "mcp.log_text": _bool("mcp.log_text", settings_store.KEY_MCP_LOG_TEXT, False),
}


def _text(field: str, value: Any) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValidationFailed(field, "not text")
    return value.strip()


def _int(field: str, value: Any) -> int:
    if isinstance(value, bool):
        raise ValidationFailed(field, "not a whole number")
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        raise ValidationFailed(field, "not a whole number") from None


def _clamp(n: int, lo: int, hi: int | None) -> int:
    n = max(lo, n)
    return n if hi is None else min(hi, n)


def _stored_int(conn: sqlite3.Connection, key: str, default: int) -> int:
    raw = settings_store.get(conn, key)
    try:
        return int(raw) if raw else default
    except (TypeError, ValueError):
        return default
