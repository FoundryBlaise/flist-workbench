"""Settings: the F-Chat folder, Label and Index tunables, import folders."""

import os

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import labels as labels_store
import rag as rag_settings
import settings as settings_store
from services import image_import as image_import_service

router = APIRouter()


def _settings_db():
    conn = settings_store.connect()
    try:
        yield conn
    finally:
        conn.close()


class LabelsSettingsUpdate(BaseModel):
    # Only the rule threshold is left — the classifier's endpoint,
    # model, prompt and context window went away with the in-app LLM.
    # None means "leave untouched"; below 1 is clamped silently.
    threshold_chars: int | None = None


class RagSettingsUpdate(BaseModel):
    # Same convention as LabelsSettingsUpdate: empty string clears
    # (falls back to default on read), None leaves untouched. Prefixes
    # are special — an empty string for them is a real value (not a
    # default), but we still accept it as "clear" since the default
    # also happens to be empty.
    # "local" (in-process ONNX) or "endpoint" (OpenAI-compatible server).
    embed_model: str | None = None
    # Retrieval fields. None = untouched; "" = reset to default.
    # Numeric fields are int|None — empty string isn't meaningful for an
    # int. The renderer just sends None when the user wants the default.
    rerank_model: str | None = None
    rerank_candidates: int | None = None
    top_k: int | None = None
    neighbors: int | None = None
    # Quality / fusion tunables. bool fields use None = untouched
    # (omitted from request); float for the rerank threshold ratio.
    rerank_min_ratio: float | None = None
    hybrid_enabled: bool | None = None
    hybrid_bm25_candidates: int | None = None
    chunk_max_chars: int | None = None
    chunk_soft_split_chars: int | None = None
    chunk_overlap_msgs: int | None = None


class SettingsUpdate(BaseModel):
    # Allow null to clear the override; absent fields are left
    # untouched. Empty string is treated as "unset" for symmetry with
    # the directory picker's "no folder selected" state.
    fchat_data_dir: str | None = None
    labels: LabelsSettingsUpdate | None = None
    rag: RagSettingsUpdate | None = None
    # Folders MCP's import_image may read from. Only this endpoint — the
    # window — sets them; the MCP settings tool can read but not change.
    image_import_roots: list[str] | None = None


def _settings_dict(conn) -> dict:
    import logs

    env_pinned = bool(os.environ.get("FCHAT_DATA_DIR"))
    stored = settings_store.get(conn, settings_store.KEY_FCHAT_DATA_DIR)
    # `effective` is what the sidecar will actually read from on the
    # next /logs request — useful for the UI to display the live path
    # regardless of where the override came from.
    lab = labels_store.load_settings(conn)
    rag = rag_settings.load_settings(conn)
    return {
        "fchat_data_dir": stored,
        "fchat_data_dir_effective": str(logs.data_dir()),
        # Surface whether the env var is forcing the value — the UI
        # should disable the picker in that case so the user isn't
        # surprised by their setting being ignored.
        "fchat_data_dir_env_locked": env_pinned,
        "labels": {
            "threshold_chars": lab.threshold_chars,
            # Defaults exposed so the UI can show "(default)" hints and
            # offer a one-click reset without hardcoding them.
            "defaults": {
                "threshold_chars": labels_store.DEFAULT_THRESHOLD_CHARS,
            },
        },
        "rag": {
            "embed_model": rag.embed_model,
            "rerank_model": rag.rerank_model,
            "rerank_candidates": rag.rerank_candidates,
            "top_k": rag.top_k,
            "neighbors": rag.neighbors,
            "rerank_min_ratio": rag.rerank_min_ratio,
            "hybrid_enabled": rag.hybrid_enabled,
            "hybrid_bm25_candidates": rag.hybrid_bm25_candidates,
            "chunk_max_chars": rag.chunk_max_chars,
            "chunk_soft_split_chars": rag.chunk_soft_split_chars,
            "chunk_overlap_msgs": rag.chunk_overlap_msgs,
            "defaults": {
                "embed_model": rag_settings.DEFAULT_EMBED_MODEL,
                "rerank_model": rag_settings.DEFAULT_RERANK_MODEL,
                "rerank_candidates": rag_settings.DEFAULT_RERANK_CANDIDATES,
                "top_k": rag_settings.DEFAULT_TOP_K,
                "neighbors": rag_settings.DEFAULT_NEIGHBORS,
                "rerank_min_ratio": rag_settings.DEFAULT_RERANK_MIN_RATIO,
                "hybrid_enabled": rag_settings.DEFAULT_HYBRID_ENABLED,
                "hybrid_bm25_candidates": rag_settings.DEFAULT_HYBRID_BM25_CANDIDATES,
                "chunk_max_chars": rag_settings.DEFAULT_CHUNK_MAX_CHARS,
                "chunk_soft_split_chars": rag_settings.DEFAULT_CHUNK_SOFT_SPLIT_CHARS,
                "chunk_overlap_msgs": rag_settings.DEFAULT_CHUNK_OVERLAP_MSGS,
            },
        },
        "image_import_roots": [
            str(p) for p in image_import_service.import_roots(conn)
        ],
    }


class DiscoverModelsRequest(BaseModel):
    """No fields — kept so the route keeps its POST shape."""


@router.post("/settings/discover-models")
def settings_discover_models(body: DiscoverModelsRequest) -> dict:
    """The embedding models that can be selected.

    This used to enumerate whatever an inference server had loaded.
    Embedding runs in-process now, so the honest answer is fastembed's
    own catalogue — with the dimension, download size and licence, since
    those are what the choice actually turns on. Licence matters:
    the catalogue mixes apache-2.0 and MIT with cc-by-nc-4.0.
    """
    import rag_embed_local

    try:
        models = rag_embed_local.available_models()
    except Exception as exc:  # noqa: BLE001 — surfaces in the UI
        return {"models": [], "source": "local", "error": str(exc)}
    return {
        "models": sorted(models, key=lambda m: m["model"]),
        "source": "local",
        "error": None,
    }


@router.get("/settings")
def settings_get(conn=Depends(_settings_db)) -> dict:
    return _settings_dict(conn)


@router.put("/settings")
def settings_update(body: SettingsUpdate, conn=Depends(_settings_db)) -> dict:
    if body.fchat_data_dir is not None:
        value = body.fchat_data_dir.strip()
        if value:
            # Reject obviously bogus paths up front so the UI gets a
            # clean 400 rather than a "characters: []" reply later.
            from pathlib import Path

            p = Path(value).expanduser()
            if not p.exists() or not p.is_dir():
                raise HTTPException(
                    status_code=400,
                    detail=f"directory does not exist: {value}",
                )
            settings_store.set_value(conn, settings_store.KEY_FCHAT_DATA_DIR, str(p))
        else:
            settings_store.clear(conn, settings_store.KEY_FCHAT_DATA_DIR)

    if body.labels is not None:
        _apply_labels_update(conn, body.labels)

    if body.rag is not None:
        _apply_rag_update(conn, body.rag)

    if body.image_import_roots is not None:
        try:
            image_import_service.save_import_roots(conn, body.image_import_roots)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return _settings_dict(conn)


def _apply_labels_update(conn, update: LabelsSettingsUpdate) -> None:
    """Persist each labels field that was supplied.

    None means "leave untouched". threshold_chars below 1 is clamped to
    1 — zero or negative would make every message OOC and is almost
    certainly a typo.
    """
    if update.threshold_chars is not None:
        n = max(1, int(update.threshold_chars))
        settings_store.set_value(conn, settings_store.KEY_LABELS_THRESHOLD_CHARS, str(n))


def _apply_rag_update(conn, update: RagSettingsUpdate) -> None:
    """Persist each RAG field that was supplied.

    Same convention as _apply_labels_update: None leaves the field
    untouched, empty string clears (falls back to default on read).
    """
    for field, key in (
        ("embed_model", settings_store.KEY_RAG_EMBED_MODEL),
        ("rerank_model", settings_store.KEY_RAG_RERANK_MODEL),
    ):
        value = getattr(update, field)
        if value is None:
            continue
        if value == "":
            settings_store.clear(conn, key)
        else:
            settings_store.set_value(conn, key, value)

    # Numeric fields: int|None. Clamp + store as string.
    if update.rerank_candidates is not None:
        n = max(1, min(200, int(update.rerank_candidates)))
        settings_store.set_value(conn, settings_store.KEY_RAG_RERANK_CANDIDATES, str(n))
    if update.top_k is not None:
        n = max(1, min(50, int(update.top_k)))
        settings_store.set_value(conn, settings_store.KEY_RAG_TOP_K, str(n))
    if update.neighbors is not None:
        n = max(0, min(5, int(update.neighbors)))
        settings_store.set_value(conn, settings_store.KEY_RAG_NEIGHBORS, str(n))
    if update.rerank_min_ratio is not None:
        # Stored as the literal float string ("0.5"); _coerce_float on
        # read handles the parse + clamp.
        ratio = max(0.0, min(1.0, float(update.rerank_min_ratio)))
        settings_store.set_value(conn, settings_store.KEY_RAG_RERANK_MIN_RATIO, str(ratio))
    if update.hybrid_enabled is not None:
        # Bools stored as "1" / "0" so the settings table stays TEXT.
        settings_store.set_value(
            conn,
            settings_store.KEY_RAG_HYBRID_ENABLED,
            "1" if update.hybrid_enabled else "0",
        )
    if update.hybrid_bm25_candidates is not None:
        n = max(1, min(200, int(update.hybrid_bm25_candidates)))
        settings_store.set_value(
            conn, settings_store.KEY_RAG_HYBRID_BM25_CANDIDATES, str(n)
        )
    if update.chunk_max_chars is not None:
        n = max(500, min(20000, int(update.chunk_max_chars)))
        settings_store.set_value(conn, settings_store.KEY_RAG_CHUNK_MAX_CHARS, str(n))
    if update.chunk_soft_split_chars is not None:
        # Clamp against the saved (or just-saved) max to keep
        # soft_split < max — same invariant the loader enforces.
        # Re-read so an in-same-request max change is honoured.
        max_raw = settings_store.get(conn, settings_store.KEY_RAG_CHUNK_MAX_CHARS)
        try:
            cur_max = int(max_raw) if max_raw else rag_settings.DEFAULT_CHUNK_MAX_CHARS
        except (TypeError, ValueError):
            cur_max = rag_settings.DEFAULT_CHUNK_MAX_CHARS
        n = max(400, min(max(500, cur_max - 100), int(update.chunk_soft_split_chars)))
        settings_store.set_value(conn, settings_store.KEY_RAG_CHUNK_SOFT_SPLIT_CHARS, str(n))
    if update.chunk_overlap_msgs is not None:
        n = max(0, min(5, int(update.chunk_overlap_msgs)))
        settings_store.set_value(conn, settings_store.KEY_RAG_CHUNK_OVERLAP_MSGS, str(n))
