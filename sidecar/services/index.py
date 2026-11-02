"""The Index: its ingest job, its status, wiping it and rebuilding its
lexical half. The REST routes (`routers/index.py`) and the MCP tools
call these, so the window and a model see the same behaviour.

The Index is one resource in the job model (`services.jobs`): an
ingest holds it for as long as it runs, and a second ingest, a wipe or
a lexical rebuild meanwhile is refused with `index_busy`. The vector
store cannot be opened twice at once, so a status read or a search
during an ingest is answered from the job instead of from the store.

Ingest and wipe publish `index-changed`, so the window re-reads the
Index status whoever changed it.
"""

from __future__ import annotations

from typing import Any

import rag_jobs
import rag_lexical
import rag_store
from refusals import IndexBusy, IndexUnreadable, NoIndex
from services import events, jobs

#: The Index as a resource of `services.jobs`.
INDEX = "index"


def _changed(**data: Any) -> None:
    events.publish(events.INDEX_CHANGED, **data)


def start_ingest(
    scope: dict, *, include_ooc: bool = False, force_rewipe: bool = False
) -> jobs.Job:
    """Start an ingest of `scope` (as `resolve_ingest_scope` builds it)
    as a job. Raises `IndexBusy` while another job holds the Index."""
    job = jobs.registry().start(
        rag_jobs.KIND,
        INDEX,
        rag_jobs.run,
        busy=IndexBusy,
        params=rag_jobs.params(scope, include_ooc=include_ooc, force_rewipe=force_rewipe),
        progress=rag_jobs.IngestProgress(),
        on_finish=lambda done: _changed(job_id=done.id, state=done.state),
    )
    _changed(job_id=job.id, state="running")
    return job


def busy_with() -> jobs.Job | None:
    """The job holding the Index, if one does."""
    return jobs.registry().active(INDEX)


def ensure_idle() -> None:
    """Raise `IndexBusy` while a job holds the Index."""
    holder = busy_with()
    if holder is not None:
        raise IndexBusy(holder.id, holder.kind, holder.resource)


def status() -> dict[str, Any]:
    """What the Index holds: model, dimension, last ingest and chunk
    count; or, while a job holds it, `busy` and that job instead of a
    count. Raises `IndexUnreadable` when the store is there but cannot
    be read, rather than calling that zero chunks."""
    manifest = rag_store.read_manifest()
    out: dict[str, Any] = {
        "embed_model": manifest.embed_model,
        "embed_dimension": manifest.embed_dimension,
        "last_ingest_at": manifest.last_ingest_at,
        "busy": False,
        "job": None,
        "chunk_count": 0,
    }
    holder = busy_with()
    if holder is None and manifest.embed_dimension is not None:
        # Only open the store when a manifest exists — otherwise a
        # status read on a fresh install would create an empty
        # collection on disk for no reason.
        try:
            with rag_store.RagStore() as store:
                out["chunk_count"] = store.count() if store.collection_exists() else 0
        except Exception as exc:
            # An ingest that started meanwhile holds the store.
            holder = busy_with()
            if holder is None:
                raise IndexUnreadable(
                    f"The Index could not be read: {exc}", details={"reason": str(exc)}
                ) from exc
    if holder is not None:
        out.update(busy=True, job=holder.to_dict(), chunk_count=None)
    return out


def wipe() -> None:
    """Delete every chunk, both halves, and forget the model it was
    built with. Refused with `IndexBusy` while an ingest runs."""
    with jobs.registry().hold("wipe", INDEX, busy=IndexBusy) as job:
        with rag_store.RagStore() as store:
            store.wipe()
        rag_store.clear_manifest()
        with rag_lexical.LexicalStore() as lex:
            lex.wipe()
    _changed(job_id=job.id, state=job.state)


def rebuild_lexical() -> int:
    """Rebuild the lexical (BM25) half from the vector half; returns the
    chunks indexed. Refused with `IndexBusy` while an ingest runs and
    with `NoIndex` when nothing was ingested."""
    with jobs.registry().hold("lexical-rebuild", INDEX, busy=IndexBusy):
        with rag_store.RagStore() as store:
            if not store.collection_exists():
                raise NoIndex(
                    "No chunks indexed yet — run Ingest first. The lexical "
                    "index mirrors the dense store and has nothing to copy."
                )
            with rag_lexical.LexicalStore() as lex:
                # Wipe first so the rebuild is authoritative — otherwise a
                # chunk_id that was removed from Qdrant since the last build
                # would stay in FTS.
                lex.wipe()
                return rag_lexical.backfill_from_qdrant(store, lex)
