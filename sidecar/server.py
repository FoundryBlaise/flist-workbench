from dataclasses import asdict
from typing import Any

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import documents
from flist import ProfileNotFound, fetch_profile
from logs import (
    LogDirError,
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
