"""Vector store wrapper around an embedded Qdrant + a tiny SQLite manifest.

Why embedded Qdrant:
  - qdrant-client supports `path=<dir>` mode — same Python API as a
    hosted instance, no docker, no port 6333, persists to a folder
    inside the user's documents dir. Right shape for a desktop app.
  - Point IDs are uuid5(NAMESPACE, chunk_id), matching the original
    Chat_RAG/embed.py wire format so the on-disk corpus is portable
    to a hosted instance if the user ever wants to scale up.

Why the manifest table:
  - Qdrant collections lock in their vector dimension at create time.
    If the user swaps from a 768-dim model to a 1024-dim model and we
    silently upsert, retrieval breaks. The `rag_meta` row records the
    embedding model + dimension; the ingest job detects a swap and
    forces a wipe-then-reingest path with explicit user confirmation
    (UI in 4.7).

Stored payload mirrors the original embed.py:
  chunk_id, char_owner, partner, date, label, subchunk,
  ts_start, ts_end, speakers, msg_count, char_count, text,
  prev_chunk_id, next_chunk_id
"""

from __future__ import annotations

import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchAny,
    MatchValue,
    PointStruct,
    VectorParams,
)

import documents
import labels as labels_store

# Must match Chat_RAG/embed.py so a future re-host preserves point IDs.
_NAMESPACE = uuid.UUID("a3f9b1c2-1111-4444-8888-c0ffee000000")
COLLECTION = "rp_chunks"

_PAYLOAD_FIELDS = (
    "chunk_id",
    "char_owner",
    "partner",
    "date",
    "label",
    "subchunk",
    "ts_start",
    "ts_end",
    "speakers",
    "msg_count",
    "char_count",
    "prev_chunk_id",
    "next_chunk_id",
    "text",
)


_MANIFEST_SCHEMA = """
CREATE TABLE IF NOT EXISTS rag_meta (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  REAL NOT NULL
);
"""

_KEY_EMBED_MODEL = "embed_model"
_KEY_EMBED_DIMENSION = "embed_dimension"
_KEY_LAST_INGEST_AT = "last_ingest_at"


@dataclass(slots=True, frozen=True)
class Manifest:
    embed_model: str | None
    embed_dimension: int | None
    last_ingest_at: float | None


def cid_to_uuid(chunk_id: str) -> str:
    return str(uuid.uuid5(_NAMESPACE, chunk_id))


def qdrant_dir(root: Path | None = None) -> Path:
    base = root or documents.user_data_dir()
    base.mkdir(parents=True, exist_ok=True)
    target = base / "qdrant"
    target.mkdir(parents=True, exist_ok=True)
    return target


# -- manifest (lives in labels.db; one file, one backup story) -----------


def _manifest_conn(root: Path | None = None) -> sqlite3.Connection:
    """Open the same labels.db connection and ensure rag_meta exists.

    Stashing manifest rows next to labels keeps the user's app data in
    one SQLite file — easier to back up, no second migration story.
    """
    conn = labels_store.connect(root)
    conn.executescript(_MANIFEST_SCHEMA)
    return conn


def read_manifest(conn: sqlite3.Connection | None = None, root: Path | None = None) -> Manifest:
    own = False
    if conn is None:
        conn = _manifest_conn(root)
        own = True
    try:
        rows = {
            r["key"]: r["value"]
            for r in conn.execute("SELECT key, value FROM rag_meta").fetchall()
        }
        dim_raw = rows.get(_KEY_EMBED_DIMENSION)
        at_raw = rows.get(_KEY_LAST_INGEST_AT)
        return Manifest(
            embed_model=rows.get(_KEY_EMBED_MODEL),
            embed_dimension=int(dim_raw) if dim_raw else None,
            last_ingest_at=float(at_raw) if at_raw else None,
        )
    finally:
        if own:
            conn.close()


def write_manifest(
    *,
    embed_model: str,
    embed_dimension: int,
    conn: sqlite3.Connection | None = None,
    root: Path | None = None,
) -> None:
    own = False
    if conn is None:
        conn = _manifest_conn(root)
        own = True
    try:
        now = time.time()
        for key, value in (
            (_KEY_EMBED_MODEL, embed_model),
            (_KEY_EMBED_DIMENSION, str(embed_dimension)),
            (_KEY_LAST_INGEST_AT, str(now)),
        ):
            conn.execute(
                """
                INSERT INTO rag_meta (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                """,
                (key, value, now),
            )
        conn.commit()
    finally:
        if own:
            conn.close()


def clear_manifest(conn: sqlite3.Connection | None = None, root: Path | None = None) -> None:
    """Used after a destructive wipe; the next ingest re-establishes it."""
    own = False
    if conn is None:
        conn = _manifest_conn(root)
        own = True
    try:
        conn.execute("DELETE FROM rag_meta")
        conn.commit()
    finally:
        if own:
            conn.close()


# -- vector store --------------------------------------------------------


class RagStore:
    """Thin wrapper around an embedded QdrantClient.

    All Qdrant access goes through this class so the ingest job and
    (later) the query path don't have to know about embedded-vs-hosted
    semantics. Open one instance per worker thread — qdrant-client's
    embedded backend uses file locks, so a single process can only hold
    the directory open from one client at a time.
    """

    def __init__(self, *, path: Path | None = None, root: Path | None = None) -> None:
        self._path = path or qdrant_dir(root)
        self._client = QdrantClient(path=str(self._path))

    @property
    def path(self) -> Path:
        return self._path

    def close(self) -> None:
        # qdrant-client embedded mode locks the directory; tests need an
        # explicit close to swap instances without "Storage folder is
        # already accessed by another instance" errors.
        try:
            self._client.close()
        except Exception:  # noqa: BLE001 — close should never block teardown
            pass

    def __enter__(self) -> RagStore:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- collection lifecycle -------------------------------------------

    def ensure_collection(self, vector_size: int) -> None:
        """Create the collection if missing. No-op if it exists with the
        same vector size; raises if size mismatches (caller decides
        whether to wipe + recreate)."""
        existing = self._client.collection_exists(COLLECTION)
        if not existing:
            self._client.create_collection(
                collection_name=COLLECTION,
                vectors_config=VectorParams(size=vector_size, distance=Distance.COSINE),
            )
            return
        info = self._client.get_collection(COLLECTION)
        current_size = info.config.params.vectors.size
        if current_size != vector_size:
            raise DimensionMismatchError(
                expected=vector_size, actual=current_size
            )

    def recreate_collection(self, vector_size: int) -> None:
        """Drop + recreate the collection (destroys all stored vectors).

        Used by the ingest job when a model swap is detected and the
        user confirmed the wipe.
        """
        if self._client.collection_exists(COLLECTION):
            self._client.delete_collection(COLLECTION)
        self._client.create_collection(
            collection_name=COLLECTION,
            vectors_config=VectorParams(size=vector_size, distance=Distance.COSINE),
        )

    def collection_exists(self) -> bool:
        return self._client.collection_exists(COLLECTION)

    def count(self, scope: dict | None = None) -> int:
        flt = _scope_to_filter(scope)
        return self._client.count(
            collection_name=COLLECTION, count_filter=flt, exact=True
        ).count

    # -- read / write ---------------------------------------------------

    def upsert_chunks(self, chunks: list[dict], vectors: list[list[float]]) -> None:
        """Upsert N chunks + their vectors in a single Qdrant request.

        chunks and vectors must line up by index (same order embed_texts
        returned them in). Idempotent: re-running upserts in place via
        the deterministic uuid5(chunk_id) point ID.
        """
        if not chunks:
            return
        if len(chunks) != len(vectors):
            raise ValueError(
                f"chunks ({len(chunks)}) / vectors ({len(vectors)}) length mismatch"
            )
        points = [
            PointStruct(
                id=cid_to_uuid(c["chunk_id"]),
                vector=v,
                payload={k: c.get(k) for k in _PAYLOAD_FIELDS},
            )
            for c, v in zip(chunks, vectors)
        ]
        self._client.upsert(collection_name=COLLECTION, points=points, wait=True)

    def existing_chunk_ids(self, scope: dict | None = None) -> set[str]:
        """Return the set of chunk_ids already in the collection, optionally
        filtered to a scope. Used by the ingest job to skip re-embedding.
        """
        if not self._client.collection_exists(COLLECTION):
            return set()
        flt = _scope_to_filter(scope)
        seen: set[str] = set()
        offset: str | int | None = None
        while True:
            points, offset = self._client.scroll(
                collection_name=COLLECTION,
                scroll_filter=flt,
                with_payload=["chunk_id"],
                with_vectors=False,
                limit=512,
                offset=offset,
            )
            for p in points:
                cid = (p.payload or {}).get("chunk_id")
                if cid:
                    seen.add(cid)
            if offset is None:
                break
        return seen

    def search(
        self,
        vector: list[float],
        *,
        scope: dict | None = None,
        limit: int = 30,
    ) -> list[dict]:
        """Vector search, optionally filtered to scope. Returns hits as
        plain dicts {id, score, payload} so the query path doesn't import
        qdrant-client types.
        """
        flt = _scope_to_filter(scope)
        # query_points is the modern replacement for search() in
        # qdrant-client 1.10+; gives the same vector-similarity output.
        result = self._client.query_points(
            collection_name=COLLECTION,
            query=vector,
            query_filter=flt,
            limit=limit,
            with_payload=True,
            with_vectors=False,
        )
        return [
            {"id": str(p.id), "score": float(p.score or 0.0), "payload": p.payload or {}}
            for p in result.points
        ]

    def fetch_by_chunk_ids(self, chunk_ids: set[str]) -> dict[str, dict]:
        """Retrieve specific chunks by their chunk_id (not point UUID).

        Used by the neighbor-expansion step at query time so the prev/
        next chain can pull adjacent context for each hit. Returns
        {chunk_id: {id, payload}}.
        """
        if not chunk_ids:
            return {}
        point_ids = [cid_to_uuid(cid) for cid in chunk_ids]
        points = self._client.retrieve(
            collection_name=COLLECTION,
            ids=point_ids,
            with_payload=True,
            with_vectors=False,
        )
        out: dict[str, dict] = {}
        for p in points:
            payload = p.payload or {}
            cid = payload.get("chunk_id")
            if cid:
                out[cid] = {"id": str(p.id), "payload": payload}
        return out

    def delete_scope(self, scope: dict | None = None) -> int:
        """Delete every point matching scope. Returns the count that was
        present before deletion (Qdrant doesn't report exact count on
        delete). No-op + 0 if no collection exists yet.
        """
        if not self._client.collection_exists(COLLECTION):
            return 0
        before = self.count(scope)
        flt = _scope_to_filter(scope) or Filter()
        self._client.delete(
            collection_name=COLLECTION,
            points_selector=flt,
            wait=True,
        )
        return before


class DimensionMismatchError(RuntimeError):
    def __init__(self, *, expected: int, actual: int) -> None:
        super().__init__(
            f"collection vector size {actual} != requested {expected} — "
            "user must confirm wipe + re-ingest"
        )
        self.expected = expected
        self.actual = actual


def _scope_to_filter(scope: dict | None) -> Filter | None:
    """Translate {character, partner, partners} into a Qdrant Filter.

    Same shape the original query.py used so the eventual chat panel
    can pass the same scope dict it'd use against a hosted Qdrant.

    Accepts:
      {character: X}                              — every chunk for char X
      {character: X, partner: Y}                  — one conversation
      {character: X, partners: [Y, Z]}            — multiple partners merged
      None                                        — no filter (all chunks)
    """
    if not scope:
        return None
    must: list = []
    char = scope.get("character") or scope.get("char_owner")
    if char:
        must.append(FieldCondition(key="char_owner", match=MatchValue(value=char)))
    partners = scope.get("partners")
    if partners is None and scope.get("partner"):
        partners = [scope["partner"]]
    if partners:
        partners = [p for p in partners if p]
        if len(partners) == 1:
            must.append(FieldCondition(key="partner", match=MatchValue(value=partners[0])))
        elif partners:
            must.append(FieldCondition(key="partner", match=MatchAny(any=list(partners))))
    if not must:
        return None
    return Filter(must=must)
