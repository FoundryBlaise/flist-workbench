"""Settings: the F-Chat folder, Label and Index tunables, import folders,
whether MCP clients may read Log text, and the Foreign profile cache's cap."""

import os
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

import foreign_cache
import labels as labels_store
import rag as rag_settings
import settings as settings_store
from services import image_import as image_import_service
from services import settings as settings_service
from wire import WireModel

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
    # None means "leave untouched"; services.settings clamps the value.
    threshold_chars: int | None = None


class RagSettingsUpdate(BaseModel):
    # Same convention as LabelsSettingsUpdate: empty string clears
    # (falls back to default on read), None leaves untouched.
    # A fastembed model id, "org/name".
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


class McpSettingsUpdate(BaseModel):
    # Whether MCP clients get the tools that return Log text. Only this
    # endpoint, the window, sets it: the MCP settings tool has no
    # parameter for it, so a model cannot grant itself the user's Logs.
    log_text: bool | None = None


class ForeignSettingsUpdate(BaseModel):
    # The Foreign profile cache's cap in whole megabytes. None leaves it
    # untouched; services.settings clamps it to at least 1.
    cache_cap_mb: int | None = None


class SettingsUpdate(BaseModel):
    # Allow null to clear the override; absent fields are left
    # untouched. Empty string is treated as "unset" for symmetry with
    # the directory picker's "no folder selected" state.
    fchat_data_dir: str | None = None
    labels: LabelsSettingsUpdate | None = None
    rag: RagSettingsUpdate | None = None
    # Folders MCP's import_images may read from. Only this endpoint — the
    # window — sets them; the MCP settings tool can read but not change.
    image_import_roots: list[str] | None = None
    mcp: McpSettingsUpdate | None = None
    foreign: ForeignSettingsUpdate | None = None


class LabelsDefaults(WireModel):
    threshold_chars: int


class LabelsSettings(WireModel):
    """Messages shorter than `threshold_chars` are OOC without asking
    anyone. The defaults let the window show "(default)" hints and offer
    a reset without hardcoding them."""

    threshold_chars: int
    defaults: LabelsDefaults


class RagValues(WireModel):
    """The Index and retrieval tunables, as set or as their defaults."""

    embed_model: str
    rerank_model: str
    rerank_candidates: int
    top_k: int
    neighbors: int
    rerank_min_ratio: float
    hybrid_enabled: bool
    hybrid_bm25_candidates: int
    chunk_max_chars: int
    chunk_soft_split_chars: int
    chunk_overlap_msgs: int


class RagSettings(RagValues):
    defaults: RagValues


class McpSettings(WireModel):
    """MCP settings only the window may change. `log_text`: whether MCP
    clients get the tools that return Log text; off by default."""

    log_text: bool


class ForeignDefaults(WireModel):
    cache_cap_mb: int


class ForeignSettings(WireModel):
    """The Foreign profile cache's cap, in whole megabytes (at least 1)."""

    cache_cap_mb: int
    defaults: ForeignDefaults


class Settings(WireModel):
    """The settings the sidecar keeps, as Settings shows them."""

    #: The stored F-Chat folder; null when none is set.
    fchat_data_dir: str | None
    #: What the sidecar reads Logs from now, wherever that came from.
    fchat_data_dir_effective: str
    #: FCHAT_DATA_DIR forces the folder; the picker is disabled.
    fchat_data_dir_env_locked: bool
    labels: LabelsSettings
    rag: RagSettings
    image_import_roots: list[str]
    mcp: McpSettings
    foreign: ForeignSettings


def _rag_values(source) -> dict:
    return {name: getattr(source, name) for name in RagValues.model_fields}


def _settings(conn) -> Settings:
    import logs

    lab = labels_store.load_settings(conn)
    rag = rag_settings.load_settings(conn)
    rag_defaults = RagValues(
        embed_model=rag_settings.DEFAULT_EMBED_MODEL,
        rerank_model=rag_settings.DEFAULT_RERANK_MODEL,
        rerank_candidates=rag_settings.DEFAULT_RERANK_CANDIDATES,
        top_k=rag_settings.DEFAULT_TOP_K,
        neighbors=rag_settings.DEFAULT_NEIGHBORS,
        rerank_min_ratio=rag_settings.DEFAULT_RERANK_MIN_RATIO,
        hybrid_enabled=rag_settings.DEFAULT_HYBRID_ENABLED,
        hybrid_bm25_candidates=rag_settings.DEFAULT_HYBRID_BM25_CANDIDATES,
        chunk_max_chars=rag_settings.DEFAULT_CHUNK_MAX_CHARS,
        chunk_soft_split_chars=rag_settings.DEFAULT_CHUNK_SOFT_SPLIT_CHARS,
        chunk_overlap_msgs=rag_settings.DEFAULT_CHUNK_OVERLAP_MSGS,
    )
    return Settings(
        fchat_data_dir=settings_store.get(conn, settings_store.KEY_FCHAT_DATA_DIR),
        fchat_data_dir_effective=str(logs.data_dir()),
        fchat_data_dir_env_locked=bool(os.environ.get("FCHAT_DATA_DIR")),
        labels=LabelsSettings(
            threshold_chars=lab.threshold_chars,
            defaults=LabelsDefaults(threshold_chars=labels_store.DEFAULT_THRESHOLD_CHARS),
        ),
        rag=RagSettings(**_rag_values(rag), defaults=rag_defaults),
        image_import_roots=[str(p) for p in image_import_service.import_roots(conn)],
        mcp=McpSettings(log_text=settings_service.log_text_over_mcp(conn)),
        foreign=ForeignSettings(
            cache_cap_mb=settings_service.foreign_cache_cap_mb(conn),
            defaults=ForeignDefaults(cache_cap_mb=foreign_cache.DEFAULT_CAP_MB),
        ),
    )


class DiscoverModelsRequest(BaseModel):
    """No fields — kept so the route keeps its POST shape."""


class EmbeddingModel(WireModel):
    model: str
    dimension: int
    size_gb: float | None
    license: str | None
    max_chars: int


class EmbeddingModels(WireModel):
    models: list[EmbeddingModel]
    source: Literal["local"]
    #: Why the catalogue could not be read; `models` is empty then.
    error: str | None


@router.post("/settings/discover-models")
def settings_discover_models(body: DiscoverModelsRequest) -> EmbeddingModels:
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
        return EmbeddingModels(models=[], source="local", error=str(exc))
    return EmbeddingModels.model_validate(
        {"models": sorted(models, key=lambda m: m["model"]), "source": "local", "error": None}
    )


@router.get("/settings")
def settings_get(conn=Depends(_settings_db)) -> Settings:
    return _settings(conn)


@router.put("/settings")
def settings_update(body: SettingsUpdate, conn=Depends(_settings_db)) -> Settings:
    settings_service.update(_changes(body), conn)
    return _settings(conn)


def _changes(body: SettingsUpdate) -> dict:
    """The request as the settings service's field names. A field the
    window left out (or sent as null, for the numbers) stays out, so it
    is left as it is; the service validates and clamps the rest."""
    changes: dict = {}
    # null clears the F-Chat folder, like an empty string; only a
    # missing key leaves it alone.
    if "fchat_data_dir" in body.model_fields_set:
        changes["fchat_data_dir"] = body.fchat_data_dir
    parts = (
        ("labels", body.labels),
        ("rag", body.rag),
        ("mcp", body.mcp),
        ("foreign", body.foreign),
    )
    for prefix, part in parts:
        if part is not None:
            for name, value in part.model_dump(exclude_none=True).items():
                changes[f"{prefix}.{name}"] = value
    if body.image_import_roots is not None:
        changes["image_import_roots"] = body.image_import_roots
    return changes
