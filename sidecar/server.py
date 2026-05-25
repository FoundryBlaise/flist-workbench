import json
import os
from dataclasses import asdict
from typing import Any

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import aliases as aliases_store
import documents
import labels as labels_store
import labels_jobs
import rag as rag_settings
import rag_chat
import rag_embed
import rag_jobs
import rag_query
import rag_store
import settings as settings_store
from flist import ProfileNotFound, fetch_profile
from logs import (
    LogDirError,
    find_contacts,
    list_characters,
    list_partners,
    read_messages,
    search_all_partners,
    search_messages,
)

app = FastAPI(title="F-list Workbench sidecar", version="0.0.0")

# The renderer runs in Electron at file:// or http://localhost:<vite>.
# Allow any local origin in dev; tighten in Phase 8 packaging.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": app.version}


@app.get("/profile/{name}")
async def profile(name: str) -> dict:
    try:
        result = await fetch_profile(name)
    except ProfileNotFound as exc:
        raise HTTPException(status_code=404, detail=f"character not found: {exc}") from exc
    return result.to_dict()


@app.get("/logs/characters")
def logs_characters() -> dict:
    try:
        return {"characters": [asdict(c) for c in list_characters()]}
    except LogDirError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/logs/partners")
def logs_partners(char: str) -> dict:
    try:
        entries = list_partners(char)
    except LogDirError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"character": char, "partners": [asdict(e) for e in entries]}


@app.get("/logs/messages")
def logs_messages(char: str, partner: str, offset: int = 0, limit: int | None = None) -> dict:
    try:
        messages = list(read_messages(char, partner, offset=offset, limit=limit))
    except LogDirError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    # Resolve each message's IC/OOC/Unlabeled label live — labels are
    # rule-on-read, so settings changes (e.g. threshold) take effect
    # immediately without rebuilding the DB.
    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    try:
        lab_settings = labels_store.load_settings(settings_conn)
        # Folding label rows from any linked alternate names — labels
        # written under "Daemon Enariel" pre-rename still apply when
        # the user opens the merged "Ashvalia" conversation.
        alias_group = aliases_store.all_names_for(labels_conn, char, partner)
        by_hash = labels_store.labels_for_partner(
            labels_conn, char, partner, partner_aliases=alias_group
        )
        for m in messages:
            h = labels_store.msg_hash(m)
            # Send the hash so the renderer can call /labels/override
            # without re-implementing sha1(ts|speaker|raw) client-side.
            m["hash"] = h
            row = by_hash.get(h)
            m["label"] = labels_store.resolve(m, row, lab_settings)
            if row is not None:
                m["label_source"] = row["source"]
                # Surface the model's own reason string in the badge
                # tooltip so the user can audit why a label was chosen.
                if row["reason"]:
                    m["label_reason"] = row["reason"]
                # Carry the prior snapshot so the UI can show "LLM had
                # said IC; you changed it to OOC" on manual overrides.
                if row["prior_label"] is not None:
                    m["prior_label"] = row["prior_label"]
                    m["prior_source"] = row["prior_source"]
            # Otherwise no source is attached — the UI infers "rule
            # or unlabeled" from absence of label_source.
    finally:
        settings_conn.close()
        labels_conn.close()

    return {"character": char, "partner": partner, "offset": offset, "messages": messages}


@app.get("/logs/search")
def logs_search(char: str, partner: str, q: str) -> dict:
    try:
        hits = search_messages(char, partner, q)
    except LogDirError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"character": char, "partner": partner, "query": q, "hits": hits}


@app.get("/logs/search_all")
def logs_search_all(char: str, q: str, limit_per_partner: int = 50) -> dict:
    try:
        return search_all_partners(char, q, limit_per_partner=limit_per_partner)
    except LogDirError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/logs/contacts")
def logs_contacts(name: str) -> dict:
    return find_contacts(name)


# ---- labels -------------------------------------------------------------


@app.get("/labels/stats")
def labels_stats(char: str, partner: str) -> dict:
    try:
        messages = list(read_messages(char, partner))
    except LogDirError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    settings_conn = settings_store.connect()
    labels_conn = labels_store.connect()
    try:
        lab_settings = labels_store.load_settings(settings_conn)
        alias_group = aliases_store.all_names_for(labels_conn, char, partner)
        counts = labels_store.stats(
            labels_conn,
            char,
            partner,
            messages,
            lab_settings,
            partner_aliases=alias_group,
        )
    finally:
        settings_conn.close()
        labels_conn.close()
    return {
        "character": char,
        "partner": partner,
        "ic": counts[labels_store.LABEL_IC],
        "ooc": counts[labels_store.LABEL_OOC],
        "unlabeled": counts[labels_store.LABEL_UNLABELED],
        "total": sum(counts.values()),
    }


class ClassifyJobRequest(BaseModel):
    # All optional. {} = classify every character × every partner.
    # {character: X} = all partners for character X. {character: X,
    # partner: Y} = a single conversation.
    character: str | None = None
    partner: str | None = None


class TestConnectionRequest(BaseModel):
    # All optional — when omitted we pull from saved settings. The
    # renderer typically posts the current edit-state so the user can
    # test before saving.
    llm_endpoint: str | None = None
    llm_model: str | None = None
    llm_api_key: str | None = None
    system_prompt: str | None = None


@app.post("/labels/test-connection")
def labels_test_connection(body: TestConnectionRequest) -> dict:
    """One canned classification roundtrip so the user can validate
    endpoint / model / prompt without launching a real job.

    Returns latency + raw model output + parsed JSON (if any). All
    failure modes return 200 with `ok=false` and a structured `error`
    so the UI can show actionable feedback without HTTP-error parsing.
    """
    import time as _time
    from urllib.error import HTTPError, URLError

    import labels_llm

    settings_conn = settings_store.connect()
    try:
        saved = labels_store.load_settings(settings_conn)
    finally:
        settings_conn.close()

    endpoint = body.llm_endpoint or saved.llm_endpoint
    model = body.llm_model or saved.llm_model
    api_key = body.llm_api_key if body.llm_api_key is not None else saved.llm_api_key
    prompt = body.system_prompt or saved.system_prompt

    # Realistic test message: an IC-shaped paragraph long enough that
    # the resolver wouldn't have rule-skipped it, so the model has
    # something coherent to classify. Older two-word probes ("hello
    # there") confused the classifier into returning empty content.
    # IC-shaped paragraph long enough that the resolver wouldn't have
    # rule-skipped it, so the model has something coherent to classify.
    # Speaker uses a canonical fantasy name (Witcher) to avoid any
    # overlap with real F-list characters in the user's corpus.
    canned_user = (
        ">>> ZIELNACHRICHT <<<\n"
        "[01-15 22:13 | 312 chars] Triss: She turned slowly, her gaze settling on him with a "
        "measured calm that belied the storm of thoughts behind her eyes. The candlelight caught "
        "the silver threads woven through her cloak as she spoke, voice low and deliberate. \"You "
        "knew this moment would come, didn't you? You've been waiting for it.\"\n"
        ">>> ENDE ZIELNACHRICHT <<<"
    )
    # Cold-start inference on a 20B+ model can take 30–60 s on first
    # call. 90 s gives the model room without making "endpoint is
    # actually unreachable" feel like an eternity. Trade-off chosen
    # deliberately — faster models will return in 1–3 s.
    test_timeout = 90.0
    started = _time.monotonic()
    try:
        content = labels_llm.call_llm(
            endpoint, model, api_key, prompt, canned_user, timeout=test_timeout
        )
    except HTTPError as exc:
        return {
            "ok": False,
            "error": f"HTTP {exc.code}: {exc.reason}",
            "elapsed_ms": int((_time.monotonic() - started) * 1000),
        }
    except URLError as exc:
        return {
            "ok": False,
            "error": f"connection failed: {exc.reason}",
            "elapsed_ms": int((_time.monotonic() - started) * 1000),
        }
    except TimeoutError as exc:
        return {
            "ok": False,
            "error": (
                f"timed out after {int(test_timeout)} s — the model may be cold-loading. "
                f"Try again, or pick a smaller model. ({exc})"
            ),
            "elapsed_ms": int((_time.monotonic() - started) * 1000),
        }
    except Exception as exc:  # noqa: BLE001 — surface to UI
        return {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "elapsed_ms": int((_time.monotonic() - started) * 1000),
        }
    elapsed_ms = int((_time.monotonic() - started) * 1000)
    if not content.strip():
        return {
            "ok": False,
            "elapsed_ms": elapsed_ms,
            "raw": "",
            "parsed": None,
            "error": (
                "model returned empty content. The system prompt may be incompatible "
                "with this model, or the model needs more time to warm up — retry once."
            ),
        }
    parsed = labels_llm.parse_label(content)
    return {
        "ok": parsed is not None,
        "elapsed_ms": elapsed_ms,
        "raw": content[:400],
        "parsed": parsed,
        "error": None if parsed is not None else "model output did not contain a valid {label, reason} JSON object",
    }


# ---- rag (settings-side; ingest endpoints land in 4.6) ----------------


class RagTestEmbeddingRequest(BaseModel):
    # All optional — when omitted we pull from saved settings. The
    # renderer typically posts the current edit-state so the user can
    # test before saving, mirroring /labels/test-connection.
    embed_endpoint: str | None = None
    embed_model: str | None = None
    embed_api_key: str | None = None
    embed_query_prefix: str | None = None
    embed_document_prefix: str | None = None


@app.post("/rag/test-embedding")
def rag_test_embedding(body: RagTestEmbeddingRequest) -> dict:
    """One canned embedding roundtrip — validates endpoint + model +
    that the model is actually loaded in LM Studio / equivalent.

    Returns latency + dimension on success; ok=false + structured
    error string on failure. Same 200-always shape as
    /labels/test-connection so the UI can render either with one path.
    """
    import time as _time

    saved = rag_settings.load_settings()
    # Only the embedding-side fields are overridable from this endpoint
    # — chat / rerank / retrieval tunables ride on saved settings to
    # keep the test surface tight.
    merged = rag_settings.RagSettings(
        embed_endpoint=body.embed_endpoint or saved.embed_endpoint,
        embed_model=body.embed_model or saved.embed_model,
        embed_api_key=(
            body.embed_api_key if body.embed_api_key is not None else saved.embed_api_key
        ),
        embed_query_prefix=(
            body.embed_query_prefix
            if body.embed_query_prefix is not None
            else saved.embed_query_prefix
        ),
        embed_document_prefix=(
            body.embed_document_prefix
            if body.embed_document_prefix is not None
            else saved.embed_document_prefix
        ),
        chat_endpoint=saved.chat_endpoint,
        chat_model=saved.chat_model,
        chat_api_key=saved.chat_api_key,
        chat_system_prompt=saved.chat_system_prompt,
        rerank_model=saved.rerank_model,
        rerank_candidates=saved.rerank_candidates,
        top_k=saved.top_k,
        neighbors=saved.neighbors,
        chunk_max_chars=saved.chunk_max_chars,
        chunk_soft_split_chars=saved.chunk_soft_split_chars,
        chunk_overlap_msgs=saved.chunk_overlap_msgs,
    )

    # 60 s probe budget: cold-loading a 768-dim model in LM Studio
    # takes 15–30 s; loaded-already returns in <1 s. 60 s leaves a
    # cushion without making "endpoint unreachable" feel forever.
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


@app.post("/rag/ingest", status_code=202)
def rag_ingest_start(body: RagIngestRequest) -> dict:
    if body.partner and not body.character:
        raise HTTPException(status_code=400, detail="partner requires character")
    scope: dict = {}
    if body.character:
        scope["character"] = body.character
    if body.partner:
        scope["partner"] = body.partner
    job = rag_jobs.start(
        scope, include_ooc=body.include_ooc, force_rewipe=body.force_rewipe
    )
    return job.to_dict()


@app.get("/rag/jobs")
def rag_jobs_list() -> dict:
    return {"jobs": [j.to_dict() for j in rag_jobs.registry().list()]}


@app.get("/rag/jobs/{job_id}")
def rag_job_get(job_id: str) -> dict:
    job = rag_jobs.registry().get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job: {job_id}")
    return job.to_dict()


@app.delete("/rag/jobs/{job_id}")
def rag_job_cancel(job_id: str) -> dict:
    ok = rag_jobs.registry().cancel(job_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"unknown job: {job_id}")
    return {"id": job_id, "cancel_requested": True}


@app.post("/rag/wipe")
def rag_wipe() -> dict:
    """Drop the local Qdrant collection and clear the manifest.

    Pure delete — no re-ingest, no probe. Use this when you want to
    forget everything and rebuild on your own schedule (e.g. after
    changing chunking settings without immediately re-embedding 80k
    messages). The next /rag/ingest starts cold.
    """
    with rag_store.RagStore() as store:
        store.wipe()
    rag_store.clear_manifest()
    return {"wiped": True}


@app.get("/rag/status")
def rag_status() -> dict:
    """Snapshot of the local vector store + manifest.

    Used by the renderer's Settings → RAG panel to show "indexed: N
    chunks for model X (dim 768)" and by the Ingest dialog as a sanity
    check before a re-ingest. Cheap — one Qdrant count + one SQLite
    read.
    """
    manifest = rag_store.read_manifest()
    chunk_count = 0
    if manifest.embed_dimension is not None:
        # Only open the store when a manifest exists — otherwise the
        # bare /rag/status from a fresh install would create an empty
        # collection on disk for no reason.
        try:
            with rag_store.RagStore() as store:
                chunk_count = store.count() if store.collection_exists() else 0
        except Exception:  # noqa: BLE001 — status must always answer
            chunk_count = 0
    return {
        "embed_model": manifest.embed_model,
        "embed_dimension": manifest.embed_dimension,
        "last_ingest_at": manifest.last_ingest_at,
        "chunk_count": chunk_count,
    }


class RagQueryScope(BaseModel):
    character: str | None = None
    partner: str | None = None
    partners: list[str] | None = None


class RagQueryRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    scope: RagQueryScope | None = None
    # Per-request overrides — the chat panel exposes these via slash
    # commands (/top, /neighbors). Server clamps the same way the
    # settings loader does so a runaway /top 9999 doesn't try to
    # retrieve thousands of chunks.
    top_k: int | None = None
    neighbors: int | None = None


def _sse_event(event: str, data: dict | str) -> bytes:
    """Format one SSE message. Reuses the OpenAI streaming convention:
    each event has an `event:` name + a JSON `data:` payload, separated
    by a blank line.
    """
    if isinstance(data, str):
        payload = data
    else:
        payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n".encode("utf-8")


@app.post("/rag/query")
def rag_query_stream(body: RagQueryRequest) -> StreamingResponse:
    """SSE stream: 'token' events with per-delta content, then a 'done'
    event carrying the citation list. Errors emit an 'error' event and
    close the stream so the renderer can render a single failure pill
    rather than parsing HTTP non-2xx.

    Pipeline runs synchronously up to the LLM call (cheap), then yields
    deltas as the LLM streams. Citations are computed up-front from the
    retrieval hits — they don't depend on the LLM's response, so the
    final `done` event has them ready the instant the stream completes.
    """
    rag_set = rag_settings.load_settings()
    scope = body.scope.model_dump(exclude_none=True) if body.scope else None
    # Expand a single-partner scope into the full alias group so
    # queries scoped to "Ashvalia" also pull chunks indexed under the
    # pre-rename name "Daemon Enariel". Skips the expansion when scope
    # is character-only / cross-RP — those don't filter by partner.
    if scope and scope.get("character") and scope.get("partner") and not scope.get("partners"):
        alias_conn = aliases_store.connect()
        try:
            group = aliases_store.all_names_for(
                alias_conn, scope["character"], scope["partner"]
            )
        finally:
            alias_conn.close()
        if len(group) > 1:
            # Move from single-partner filter to multi-partner filter;
            # rag_store._scope_to_filter handles both shapes.
            scope = {
                "character": scope["character"],
                "partners": group,
            }
    top_k = body.top_k if body.top_k is not None else rag_set.top_k
    neighbors = body.neighbors if body.neighbors is not None else rag_set.neighbors
    # Clamp the same way the settings loader does — overrides shouldn't
    # be able to do what saved settings can't.
    top_k = max(1, min(50, int(top_k)))
    neighbors = max(0, min(5, int(neighbors)))

    def producer():
        # Phase 1: retrieval. Failures here are visible to the user
        # immediately as an `error` SSE event — no partial LLM stream.
        try:
            with rag_store.RagStore() as store:
                if not store.collection_exists():
                    yield _sse_event(
                        "error",
                        {
                            "stage": "retrieval",
                            "message": (
                                "no RAG index yet — run Logs → Ingest before asking."
                            ),
                        },
                    )
                    return
                try:
                    result = rag_query.run_query(
                        body.question,
                        scope=scope,
                        store=store,
                        rag_set=rag_set,
                        rerank_model=rag_set.rerank_model,
                        rerank_candidates=rag_set.rerank_candidates,
                        top_k=top_k,
                        neighbors=neighbors,
                        system_prompt=rag_set.chat_system_prompt,
                    )
                except rag_embed.EmbedError as exc:
                    yield _sse_event(
                        "error", {"stage": "embed", "message": str(exc)}
                    )
                    return
                citations = rag_query.citation_payload(result.hits)

            # Phase 1.5: tell the renderer what we retrieved before any
            # LLM tokens arrive — useful so the citation chip strip can
            # render while the answer streams.
            yield _sse_event(
                "retrieved",
                {
                    "hit_count": len(citations),
                    "rerank_applied": result.rerank_applied,
                    "rerank_model": result.rerank_model,
                    "embed_model": result.embed_model,
                },
            )

            # Phase 2: stream the LLM answer.
            try:
                for delta in rag_chat.stream_chat(
                    rag_set.chat_endpoint,
                    rag_set.chat_model,
                    rag_set.chat_api_key,
                    result.messages,
                ):
                    yield _sse_event("token", {"content": delta})
            except rag_chat.ChatError as exc:
                yield _sse_event(
                    "error", {"stage": "chat", "message": str(exc)}
                )
                return

            yield _sse_event("done", {"citations": citations})
        except Exception as exc:  # noqa: BLE001 — last-resort: don't bring down the stream silently
            yield _sse_event(
                "error", {"stage": "unknown", "message": repr(exc)}
            )

    return StreamingResponse(
        producer(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


# ---- labels jobs (continued) ------------------------------------------


@app.post("/labels/classify", status_code=202)
def labels_classify_start(body: ClassifyJobRequest) -> dict:
    if body.partner and not body.character:
        raise HTTPException(status_code=400, detail="partner requires character")
    scope: dict = {}
    if body.character:
        scope["character"] = body.character
    if body.partner:
        scope["partner"] = body.partner
    job = labels_jobs.start(scope)
    return job.to_dict()


@app.get("/labels/jobs")
def labels_jobs_list() -> dict:
    return {"jobs": [j.to_dict() for j in labels_jobs.registry().list()]}


@app.get("/labels/jobs/{job_id}")
def labels_job_get(job_id: str) -> dict:
    job = labels_jobs.registry().get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job: {job_id}")
    return job.to_dict()


@app.delete("/labels/jobs/{job_id}")
def labels_job_cancel(job_id: str) -> dict:
    ok = labels_jobs.registry().cancel(job_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"unknown job: {job_id}")
    return {"id": job_id, "cancel_requested": True}


class LabelOverride(BaseModel):
    character: str
    partner: str
    hash: str
    ts: int
    speaker: str
    # label=None / missing deletes the row (revert to rule / Unlabeled).
    label: str | None = None


class LabelsClearRequest(BaseModel):
    character: str
    partner: str


@app.post("/labels/clear")
def labels_clear(body: LabelsClearRequest) -> dict:
    """Delete every label (LLM + manual) for one conversation.

    Used by the renderer's "Reset all labels" context-menu action.
    After this returns, the resolver falls back to rule-on-read for
    every message in that conversation.
    """
    conn = labels_store.connect()
    try:
        alias_group = aliases_store.all_names_for(
            conn, body.character, body.partner
        )
        deleted = labels_store.delete_labels_for_partner(
            conn,
            body.character,
            body.partner,
            partner_aliases=alias_group,
        )
    finally:
        conn.close()
    return {
        "character": body.character,
        "partner": body.partner,
        "deleted": deleted,
    }


@app.post("/labels/override")
def labels_override(body: LabelOverride) -> dict:
    conn = labels_store.connect()
    try:
        if body.label is None:
            removed = labels_store.delete_label(conn, body.hash)
            return {"hash": body.hash, "deleted": removed, "label": None}
        if body.label not in (labels_store.LABEL_IC, labels_store.LABEL_OOC):
            raise HTTPException(
                status_code=400,
                detail=f"label must be IC or OOC, got {body.label!r}",
            )
        # Write labels under the alias group's canonical primary so
        # the partner column stays consistent post-rename. Lookup is
        # alias-aware (labels_for_partner expands the group) so old
        # rows under the alias name still resolve.
        primary = aliases_store.primary_for(conn, body.character, body.partner)
        labels_store.upsert_label(
            conn,
            hash=body.hash,
            character=body.character,
            partner=primary,
            ts=body.ts,
            speaker=body.speaker,
            label=body.label,
            source="manual",
            reason="manual override",
        )
        row = conn.execute(
            "SELECT label, source, prior_label, prior_source FROM labels WHERE hash = ?",
            (body.hash,),
        ).fetchone()
        return {
            "hash": body.hash,
            "label": row["label"],
            "source": row["source"],
            "prior_label": row["prior_label"],
            "prior_source": row["prior_source"],
        }
    finally:
        conn.close()


# ---- aliases ------------------------------------------------------------


class AliasAdd(BaseModel):
    character: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=200)
    primary_name: str = Field(min_length=1, max_length=200)


@app.get("/aliases")
def aliases_list(char: str) -> dict:
    """Return {primary_name: [member names…]} for one character.

    Empty dict when the character has no linked partners. Renderer
    uses this to decide whether to render alias hints on each partner
    row.
    """
    conn = aliases_store.connect()
    try:
        groups = aliases_store.list_groups(conn, char)
    finally:
        conn.close()
    return {"character": char, "groups": groups}


@app.post("/aliases", status_code=201)
def aliases_add(body: AliasAdd) -> dict:
    """Link `name` to `primary_name` for `character`. Idempotent;
    handles chain consolidation (linking A→B then A→C ends with both
    A and B pointing at C, never building a multi-hop chain)."""
    conn = aliases_store.connect()
    try:
        aliases_store.add_alias(conn, body.character, body.name, body.primary_name)
        group = aliases_store.all_names_for(conn, body.character, body.primary_name)
    finally:
        conn.close()
    return {
        "character": body.character,
        "primary_name": body.primary_name,
        "group": group,
    }


@app.delete("/aliases")
def aliases_remove(char: str, name: str) -> dict:
    """Drop one name from its alias group."""
    conn = aliases_store.connect()
    try:
        removed = aliases_store.remove_alias(conn, char, name)
    finally:
        conn.close()
    return {"character": char, "name": name, "removed": removed}


@app.delete("/aliases/group")
def aliases_unlink_group(char: str, primary: str) -> dict:
    """Drop every member of an alias group at once."""
    conn = aliases_store.connect()
    try:
        deleted = aliases_store.unlink_group(conn, char, primary)
    finally:
        conn.close()
    return {"character": char, "primary": primary, "deleted": deleted}


# ---- settings -----------------------------------------------------------


def _settings_db():
    conn = settings_store.connect()
    try:
        yield conn
    finally:
        conn.close()


class LabelsSettingsUpdate(BaseModel):
    # Empty strings restore the default for any of these — see
    # labels.load_settings() for the fallback policy. None means "leave
    # untouched". threshold_chars below 1 is clamped silently.
    threshold_chars: int | None = None
    llm_endpoint: str | None = None
    llm_model: str | None = None
    llm_api_key: str | None = None
    system_prompt: str | None = None
    context_before: int | None = None
    context_after: int | None = None


class RagSettingsUpdate(BaseModel):
    # Same convention as LabelsSettingsUpdate: empty string clears
    # (falls back to default on read), None leaves untouched. Prefixes
    # are special — an empty string for them is a real value (not a
    # default), but we still accept it as "clear" since the default
    # also happens to be empty.
    embed_endpoint: str | None = None
    embed_model: str | None = None
    embed_api_key: str | None = None
    embed_query_prefix: str | None = None
    embed_document_prefix: str | None = None
    # Chat / query-time fields. None = untouched; "" = reset to default.
    # Numeric fields are int|None — empty string isn't meaningful for an
    # int. The renderer just sends None when the user wants the default.
    chat_endpoint: str | None = None
    chat_model: str | None = None
    chat_api_key: str | None = None
    chat_system_prompt: str | None = None
    rerank_model: str | None = None
    rerank_candidates: int | None = None
    top_k: int | None = None
    neighbors: int | None = None
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
            "llm_endpoint": lab.llm_endpoint,
            "llm_model": lab.llm_model,
            "llm_api_key": lab.llm_api_key,
            "system_prompt": lab.system_prompt,
            "context_before": lab.context_before,
            "context_after": lab.context_after,
            # Defaults exposed so the UI can show "(default)" hints and
            # offer a one-click reset without hardcoding them.
            "defaults": {
                "threshold_chars": labels_store.DEFAULT_THRESHOLD_CHARS,
                "llm_endpoint": labels_store.DEFAULT_LLM_ENDPOINT,
                "llm_model": labels_store.DEFAULT_LLM_MODEL,
                "llm_api_key": labels_store.DEFAULT_LLM_API_KEY,
                "system_prompt": labels_store.DEFAULT_SYSTEM_PROMPT,
                "context_before": labels_store.DEFAULT_CONTEXT_BEFORE,
                "context_after": labels_store.DEFAULT_CONTEXT_AFTER,
            },
        },
        "rag": {
            "embed_endpoint": rag.embed_endpoint,
            "embed_model": rag.embed_model,
            "embed_api_key": rag.embed_api_key,
            "embed_query_prefix": rag.embed_query_prefix,
            "embed_document_prefix": rag.embed_document_prefix,
            "chat_endpoint": rag.chat_endpoint,
            "chat_model": rag.chat_model,
            "chat_api_key": rag.chat_api_key,
            "chat_system_prompt": rag.chat_system_prompt,
            "rerank_model": rag.rerank_model,
            "rerank_candidates": rag.rerank_candidates,
            "top_k": rag.top_k,
            "neighbors": rag.neighbors,
            "chunk_max_chars": rag.chunk_max_chars,
            "chunk_soft_split_chars": rag.chunk_soft_split_chars,
            "chunk_overlap_msgs": rag.chunk_overlap_msgs,
            "defaults": {
                "embed_endpoint": rag_settings.DEFAULT_EMBED_ENDPOINT,
                "embed_model": rag_settings.DEFAULT_EMBED_MODEL,
                "embed_api_key": rag_settings.DEFAULT_EMBED_API_KEY,
                "embed_query_prefix": rag_settings.DEFAULT_EMBED_QUERY_PREFIX,
                "embed_document_prefix": rag_settings.DEFAULT_EMBED_DOCUMENT_PREFIX,
                "chat_endpoint": rag_settings.DEFAULT_CHAT_ENDPOINT,
                "chat_model": rag_settings.DEFAULT_CHAT_MODEL,
                "chat_api_key": rag_settings.DEFAULT_CHAT_API_KEY,
                # Expose the resolved English default so the UI can
                # show "Reset to default" without hardcoding it.
                "chat_system_prompt": _resolve_default_chat_prompt(),
                "rerank_model": rag_settings.DEFAULT_RERANK_MODEL,
                "rerank_candidates": rag_settings.DEFAULT_RERANK_CANDIDATES,
                "top_k": rag_settings.DEFAULT_TOP_K,
                "neighbors": rag_settings.DEFAULT_NEIGHBORS,
                "chunk_max_chars": rag_settings.DEFAULT_CHUNK_MAX_CHARS,
                "chunk_soft_split_chars": rag_settings.DEFAULT_CHUNK_SOFT_SPLIT_CHARS,
                "chunk_overlap_msgs": rag_settings.DEFAULT_CHUNK_OVERLAP_MSGS,
            },
        },
    }


def _resolve_default_chat_prompt() -> str:
    # Lazy import — rag_query imports rag, rag imports rag_query in
    # its loader, so doing this at module top would cycle.
    from rag_query import DEFAULT_SYSTEM_PROMPT

    return DEFAULT_SYSTEM_PROMPT


@app.get("/settings")
def settings_get(conn=Depends(_settings_db)) -> dict:
    return _settings_dict(conn)


@app.put("/settings")
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

    return _settings_dict(conn)


def _apply_labels_update(conn, update: LabelsSettingsUpdate) -> None:
    """Persist each labels field that was supplied.

    Convention: empty string clears (falls back to default on read).
    None means "leave untouched". threshold_chars below 1 is clamped to
    1 — zero or negative would make every message OOC and is almost
    certainly a typo.
    """
    if update.threshold_chars is not None:
        n = max(1, int(update.threshold_chars))
        settings_store.set_value(conn, settings_store.KEY_LABELS_THRESHOLD_CHARS, str(n))
    if update.context_before is not None:
        # Clamp same as load_settings: 0..10. Higher is risky on small
        # context windows; lower than 0 is meaningless.
        n = max(0, min(10, int(update.context_before)))
        settings_store.set_value(conn, settings_store.KEY_LABELS_CONTEXT_BEFORE, str(n))
    if update.context_after is not None:
        n = max(0, min(10, int(update.context_after)))
        settings_store.set_value(conn, settings_store.KEY_LABELS_CONTEXT_AFTER, str(n))
    for field, key in (
        ("llm_endpoint", settings_store.KEY_LABELS_LLM_ENDPOINT),
        ("llm_model", settings_store.KEY_LABELS_LLM_MODEL),
        ("llm_api_key", settings_store.KEY_LABELS_LLM_API_KEY),
        ("system_prompt", settings_store.KEY_LABELS_SYSTEM_PROMPT),
    ):
        value = getattr(update, field)
        if value is None:
            continue
        if value == "":
            settings_store.clear(conn, key)
        else:
            settings_store.set_value(conn, key, value)


def _apply_rag_update(conn, update: RagSettingsUpdate) -> None:
    """Persist each RAG field that was supplied.

    Same convention as _apply_labels_update: None leaves the field
    untouched, empty string clears (falls back to default on read).
    """
    for field, key in (
        ("embed_endpoint", settings_store.KEY_RAG_EMBED_ENDPOINT),
        ("embed_model", settings_store.KEY_RAG_EMBED_MODEL),
        ("embed_api_key", settings_store.KEY_RAG_EMBED_API_KEY),
        ("embed_query_prefix", settings_store.KEY_RAG_EMBED_QUERY_PREFIX),
        ("embed_document_prefix", settings_store.KEY_RAG_EMBED_DOCUMENT_PREFIX),
        ("chat_endpoint", settings_store.KEY_RAG_CHAT_ENDPOINT),
        ("chat_model", settings_store.KEY_RAG_CHAT_MODEL),
        ("chat_api_key", settings_store.KEY_RAG_CHAT_API_KEY),
        ("chat_system_prompt", settings_store.KEY_RAG_CHAT_SYSTEM_PROMPT),
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


# ---- documents ----------------------------------------------------------


# Reopen a fresh connection per request so the dependency cleans up
# after itself. SQLite connections aren't safe to share across threads
# under FastAPI's default executor.
def _db():
    conn = documents.connect()
    try:
        yield conn
    finally:
        conn.close()


class DocCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    bbcode: str = ""
    inlines: dict[str, Any] = Field(default_factory=dict)


class DocRename(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class RevisionWrite(BaseModel):
    bbcode: str
    inlines: dict[str, Any] = Field(default_factory=dict)


def _doc_dict(doc: documents.Document) -> dict:
    return {
        "id": doc.id,
        "name": doc.name,
        "scratch": doc.scratch,
        "created_at": doc.created_at,
        "updated_at": doc.updated_at,
        "latest_revision_id": doc.latest_revision_id,
        "latest_char_count": doc.latest_char_count,
        "latest_created_at": doc.latest_created_at,
        "has_draft": doc.has_draft,
    }


def _rev_dict(rev: documents.Revision) -> dict:
    return {
        "id": rev.id,
        "doc_id": rev.doc_id,
        "bbcode": rev.bbcode,
        "inlines": rev.inlines,
        "char_count": rev.char_count,
        "created_at": rev.created_at,
    }


@app.get("/documents")
def documents_list(conn=Depends(_db)) -> dict:
    return {"documents": [_doc_dict(d) for d in documents.list_documents(conn)]}


@app.post("/documents", status_code=201)
def documents_create(body: DocCreate, conn=Depends(_db)) -> dict:
    try:
        doc = documents.create_document(conn, body.name, bbcode=body.bbcode, inlines=body.inlines)
    except documents.DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _doc_dict(doc)


@app.get("/documents/{doc_id}")
def documents_get(doc_id: int, conn=Depends(_db)) -> dict:
    try:
        doc = documents.get_document(conn, doc_id)
        current = documents.current_content(conn, doc_id)
    except documents.DocumentError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"document": _doc_dict(doc), "current": _rev_dict(current)}


@app.patch("/documents/{doc_id}")
def documents_rename(doc_id: int, body: DocRename, conn=Depends(_db)) -> dict:
    try:
        return _doc_dict(documents.rename_document(conn, doc_id, body.name))
    except documents.DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/documents/{doc_id}", status_code=204)
def documents_delete(doc_id: int, conn=Depends(_db)) -> None:
    try:
        documents.delete_document(conn, doc_id)
    except documents.DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/documents/{doc_id}/duplicate", status_code=201)
def documents_duplicate(doc_id: int, body: DocRename, conn=Depends(_db)) -> dict:
    try:
        return _doc_dict(documents.duplicate_document(conn, doc_id, body.name))
    except documents.DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/documents/{doc_id}/revisions")
def revisions_list(doc_id: int, conn=Depends(_db)) -> dict:
    try:
        revs = documents.list_revisions(conn, doc_id)
    except documents.DocumentError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    # The list view doesn't need the full BBCode body — drop it to keep
    # the payload tiny when there are hundreds of revisions.
    return {
        "doc_id": doc_id,
        "revisions": [
            {
                "id": r.id,
                "char_count": r.char_count,
                "created_at": r.created_at,
            }
            for r in revs
        ],
    }


@app.get("/documents/{doc_id}/revisions/{rev_id}")
def revisions_get(doc_id: int, rev_id: int, conn=Depends(_db)) -> dict:
    try:
        return _rev_dict(documents.get_revision(conn, doc_id, rev_id))
    except documents.DocumentError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/documents/{doc_id}/revisions", status_code=201)
def revisions_save(doc_id: int, body: RevisionWrite, conn=Depends(_db)) -> dict:
    try:
        return _rev_dict(documents.save_revision(conn, doc_id, body.bbcode, body.inlines))
    except documents.DocumentError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.put("/documents/{doc_id}/draft", status_code=204)
def drafts_save(doc_id: int, body: RevisionWrite, conn=Depends(_db)) -> None:
    try:
        documents.save_draft(conn, doc_id, body.bbcode, body.inlines)
    except documents.DocumentError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.delete("/documents/{doc_id}/draft", status_code=204)
def drafts_discard(doc_id: int, conn=Depends(_db)) -> None:
    documents.discard_draft(conn, doc_id)


# Entry point for the PyInstaller-frozen build. In dev we run via
# `uv run uvicorn server:app` which imports `app` directly, so this
# block is unreached. The packaged Electron app spawns sidecar.exe
# (this script frozen) and reads SIDECAR_PORT from the environment.
if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("SIDECAR_PORT", "8770"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
