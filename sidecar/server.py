import os
from dataclasses import asdict
from typing import Any

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import documents
import labels as labels_store
import labels_jobs
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
        by_hash = labels_store.labels_for_partner(labels_conn, char, partner)
        for m in messages:
            h = labels_store.msg_hash(m)
            # Send the hash so the renderer can call /labels/override
            # without re-implementing sha1(ts|speaker|raw) client-side.
            m["hash"] = h
            row = by_hash.get(h)
            m["label"] = labels_store.resolve(m, row, lab_settings)
            if row is not None:
                m["label_source"] = row["source"]
                m["label_confidence"] = row["confidence"]
                # Surface the model's own reason string in the badge
                # tooltip so the user can audit why a label was chosen
                # — useful when confidence saturates at 0.99+ and the
                # number alone isn't informative.
                if row["reason"]:
                    m["label_reason"] = row["reason"]
                # Carry the prior snapshot so the UI can show "LLM had
                # said IC; you changed it to OOC" on manual overrides.
                if row["prior_label"] is not None:
                    m["prior_label"] = row["prior_label"]
                    m["prior_source"] = row["prior_source"]
            # Otherwise no source/confidence is attached — the UI can
            # infer "rule or unlabeled" from absence of label_source.
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
        counts = labels_store.stats(labels_conn, char, partner, messages, lab_settings)
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
    canned_user = (
        ">>> ZIELNACHRICHT <<<\n"
        "[01-15 22:13 | 312 chars] Lyra: She turned slowly, her gaze settling on him with a "
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
        "error": None if parsed is not None else "model output did not contain a valid {label, confidence} JSON object",
    }


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
        labels_store.upsert_label(
            conn,
            hash=body.hash,
            character=body.character,
            partner=body.partner,
            ts=body.ts,
            speaker=body.speaker,
            label=body.label,
            source="manual",
            confidence=1.0,
            reason="manual override",
        )
        row = conn.execute(
            "SELECT label, source, confidence, prior_label, prior_source FROM labels WHERE hash = ?",
            (body.hash,),
        ).fetchone()
        return {
            "hash": body.hash,
            "label": row["label"],
            "source": row["source"],
            "confidence": row["confidence"],
            "prior_label": row["prior_label"],
            "prior_source": row["prior_source"],
        }
    finally:
        conn.close()


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


class SettingsUpdate(BaseModel):
    # Allow null to clear the override; absent fields are left
    # untouched. Empty string is treated as "unset" for symmetry with
    # the directory picker's "no folder selected" state.
    fchat_data_dir: str | None = None
    labels: LabelsSettingsUpdate | None = None


def _settings_dict(conn) -> dict:
    import logs

    env_pinned = bool(os.environ.get("FCHAT_DATA_DIR"))
    stored = settings_store.get(conn, settings_store.KEY_FCHAT_DATA_DIR)
    # `effective` is what the sidecar will actually read from on the
    # next /logs request — useful for the UI to display the live path
    # regardless of where the override came from.
    lab = labels_store.load_settings(conn)
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
            # Defaults exposed so the UI can show "(default)" hints and
            # offer a one-click reset without hardcoding them.
            "defaults": {
                "threshold_chars": labels_store.DEFAULT_THRESHOLD_CHARS,
                "llm_endpoint": labels_store.DEFAULT_LLM_ENDPOINT,
                "llm_model": labels_store.DEFAULT_LLM_MODEL,
                "llm_api_key": labels_store.DEFAULT_LLM_API_KEY,
                "system_prompt": labels_store.DEFAULT_SYSTEM_PROMPT,
            },
        },
    }


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
