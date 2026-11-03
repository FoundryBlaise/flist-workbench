"""The Index: ingest, status, wipe and the embedding check. The ingest
is a job: poll and cancel it through `routers/jobs.py`."""

import dataclasses

from fastapi import APIRouter
from pydantic import BaseModel

import rag as rag_settings
import rag_embed
from refusals import LogNameRefused
from services import index as index_service

router = APIRouter()


class RagTestEmbeddingRequest(BaseModel):
    # Optional — omitted means "the saved model". Kept so a model can be
    # tried before it is saved.
    embed_model: str | None = None


@router.post("/rag/test-embedding")
def rag_test_embedding(body: RagTestEmbeddingRequest) -> dict:
    """One canned embedding — validates that the model loads and says
    what dimension it produces.

    Returns latency + dimension on success; ok=false + structured
    error string on failure. Same 200-always shape as
    /labels/test-connection so the UI can render either with one path.
    """
    import time as _time

    saved = rag_settings.load_settings()
    merged = (
        dataclasses.replace(saved, embed_model=body.embed_model)
        if body.embed_model
        else saved
    )

    # First call downloads the model and deserialises the ONNX graph;
    # after that it is milliseconds.
    test_timeout = 60.0
    started = _time.monotonic()
    try:
        dimension, _vec = rag_embed.probe(merged, timeout=test_timeout)
    except rag_embed.EmbedError as exc:
        return {
            "ok": False,
            "error": str(exc),
            "dimension": None,
            "model": merged.embed_model,
            "elapsed_ms": int((_time.monotonic() - started) * 1000),
        }
    except Exception as exc:  # noqa: BLE001 — surface to UI
        return {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "dimension": None,
            "model": merged.embed_model,
            "elapsed_ms": int((_time.monotonic() - started) * 1000),
        }
    return {
        "ok": True,
        "error": None,
        "dimension": dimension,
        "model": merged.embed_model,
        "elapsed_ms": int((_time.monotonic() - started) * 1000),
    }


class RagIngestRequest(BaseModel):
    # Same scope shape as ClassifyJobRequest. {} = every char × every
    # partner; {character: X} = all partners for X; {character: X,
    # partner: Y} = one conversation.
    character: str | None = None
    partner: str | None = None
    # Default off — OOC chunks pollute retrieval for "what happened in
    # this RP" questions. Power users can flip this in a future
    # Settings → RAG advanced toggle.
    include_ooc: bool = False
    # The renderer sends true after the user confirms wiping the
    # collection because the embedding model changed. Without
    # confirmation we refuse to silently corrupt the index.
    force_rewipe: bool = False


@router.post("/rag/ingest", status_code=202)
def rag_ingest_start(body: RagIngestRequest) -> dict:
    # The same resolver MCP ingest_logs uses: any case, and a partner's
    # alias reaches its conversation. An unknown name is refused instead
    # of indexing nothing.
    from workbench_mcp._context import ToolError, resolve_ingest_scope

    try:
        scope = resolve_ingest_scope(body.character, body.partner)
    except ToolError as exc:
        raise LogNameRefused(exc.message, code=exc.code, details=exc.details) from exc
    job = index_service.start_ingest(
        scope, include_ooc=body.include_ooc, force_rewipe=body.force_rewipe
    )
    return job.to_dict()


@router.post("/rag/wipe")
def rag_wipe() -> dict:
    """Drop the local Qdrant collection and clear the manifest.

    Pure delete — no re-ingest, no probe. Use this when you want to
    forget everything and rebuild on your own schedule (e.g. after
    changing chunking settings without immediately re-embedding 80k
    messages). The next /rag/ingest starts cold. Refused with
    `index_busy` while an ingest runs.
    """
    index_service.wipe()
    return {"wiped": True}


@router.post("/rag/lexical/rebuild")
def rag_lexical_rebuild() -> dict:
    """Rebuild the BM25 lexical index from the existing Qdrant chunks.

    Avoids a full re-ingest when the dense store is up-to-date but the
    lexical mirror is stale (e.g. after a chunking-config change that
    only required re-embedding once, or after upgrading from a pre-
    hybrid install). Returns the number of chunks indexed.
    """
    return {"indexed": index_service.rebuild_lexical()}


@router.get("/rag/status")
def rag_status() -> dict:
    """Snapshot of the local vector store + manifest.

    Used by the renderer's Settings → RAG panel to show "indexed: N
    chunks for model X (dim 768)". Cheap — one Qdrant count + one SQLite
    read. While an ingest runs it says `busy` and names the job instead
    of counting.
    """
    return index_service.status()
