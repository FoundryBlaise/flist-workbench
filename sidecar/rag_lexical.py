"""BM25 lexical store — SQLite FTS5 mirror of the chunk corpus.

Why FTS5:
  Dense embeddings smear exact strings (proper nouns, rare words, item
  names, numbers). The BGE-M3 vector for "Cocktail" lands near "drink",
  "Aperitif" — useful for semantic recall, harmful when the question is
  *literally* about "Cocktail" appearing in a chunk. BM25 is a long-
  established keyword ranker that handles this case exactly.

Why labels.db:
  The rag_meta manifest already lives in labels.db (see rag_store.py
  header). One file = one backup story, one migration story. FTS5 is
  bundled with the SQLite build Python ships with — no extension to
  load, no extra dependency.

Why unicode61 + diacritic folding:
  RP logs are German-heavy. "Café" should match "Cafe"; "Ophélia"
  should match "Ophelia". `unicode61` is FTS5's default Unicode
  tokeniser; `remove_diacritics 2` folds combining marks via the modern
  Unicode normalisation rules.

Caveat — typo robustness:
  BM25 is exact-token. A query for "Orphelia" returns nothing when the
  corpus only contains "Ophelia". Multi-query expansion (rag_expand)
  picks up that slack by asking the chat LLM to autocorrect proper
  nouns into variant queries before retrieval.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path

import labels as labels_store
import rag_store


_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(
    chunk_id    UNINDEXED,
    char_owner  UNINDEXED,
    partner     UNINDEXED,
    text,
    tokenize='unicode61 remove_diacritics 2'
);
"""


@dataclass(slots=True, frozen=True)
class LexicalHit:
    chunk_id: str
    bm25_score: float


def _connect(root: Path | None = None) -> sqlite3.Connection:
    """Open labels.db and ensure the FTS5 virtual table exists.

    Reuses labels.connect so this module shares the same database file
    as labels and rag_meta — same WAL, same backup story.
    """
    conn = labels_store.connect(root)
    conn.executescript(_SCHEMA)
    return conn


class LexicalStore:
    """SQLite FTS5 wrapper. Mirrors chunk text + scope columns and
    answers BM25-ranked keyword searches.

    Pair this with a RagStore: ingest writes to both; query reads from
    both and fuses results via reciprocal rank fusion (see rag_query).
    """

    def __init__(self, *, root: Path | None = None) -> None:
        self._conn = _connect(root)

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:  # noqa: BLE001 — close must never block teardown
            pass

    def __enter__(self) -> "LexicalStore":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- write ----------------------------------------------------------

    def upsert_chunks(self, chunks: list[dict]) -> None:
        """Replace any existing rows with the same chunk_id and insert
        the rest. FTS5 doesn't honour UNIQUE on UNINDEXED columns, so
        we DELETE-then-INSERT for matching chunk_ids — atomically inside
        a single transaction.
        """
        if not chunks:
            return
        ids = [c["chunk_id"] for c in chunks]
        with self._conn:
            # DELETE for the ids we're about to insert keeps the table
            # idempotent without relying on a UNIQUE constraint FTS5
            # can't provide on UNINDEXED columns.
            placeholders = ",".join("?" * len(ids))
            self._conn.execute(
                f"DELETE FROM rag_fts WHERE chunk_id IN ({placeholders})", ids
            )
            self._conn.executemany(
                "INSERT INTO rag_fts (chunk_id, char_owner, partner, text) "
                "VALUES (?, ?, ?, ?)",
                [
                    (
                        c["chunk_id"],
                        c.get("char_owner", ""),
                        c.get("partner", ""),
                        c.get("text", ""),
                    )
                    for c in chunks
                ],
            )

    def delete_scope(self, scope: dict | None) -> int:
        """Delete rows matching the same scope shape rag_store uses.

        None scope = delete everything; otherwise filter by char_owner
        and (single or any-of) partner.
        """
        sql, args = _scope_clause(scope)
        with self._conn:
            cur = self._conn.execute(f"DELETE FROM rag_fts{sql}", args)
            return cur.rowcount or 0

    def wipe(self) -> None:
        """Drop and recreate the virtual table. Mirrors RagStore.wipe so
        the chat path can't see lexical hits referencing dense-store
        chunks that no longer exist.
        """
        with self._conn:
            self._conn.execute("DROP TABLE IF EXISTS rag_fts")
            self._conn.executescript(_SCHEMA)

    # -- read -----------------------------------------------------------

    def count(self, scope: dict | None = None) -> int:
        sql, args = _scope_clause(scope)
        cur = self._conn.execute(f"SELECT COUNT(*) FROM rag_fts{sql}", args)
        return int(cur.fetchone()[0])

    def search(
        self,
        query: str,
        *,
        scope: dict | None = None,
        limit: int = 30,
    ) -> list[LexicalHit]:
        """BM25-ranked keyword search.

        Tokens are OR-fused for recall (the default AND-mode is too
        strict for natural-language questions). Each token is wrapped in
        double quotes so FTS5 operators a user might type accidentally
        ("AND", "OR", "NOT", "+", "-") are treated as literal words.

        Returns [] when the query has no usable tokens after sanitising
        (e.g. punctuation-only input).
        """
        match_expr = _build_match_expr(query)
        if not match_expr:
            return []
        scope_sql, scope_args = _scope_clause(scope, prefix=" AND")
        # FTS5 bm25() returns more-negative for better matches. Flip the
        # sign so callers can sort high-to-low like vector scores.
        sql = (
            "SELECT chunk_id, bm25(rag_fts) AS raw_score "
            "FROM rag_fts "
            f"WHERE rag_fts MATCH ?{scope_sql} "
            "ORDER BY raw_score "
            "LIMIT ?"
        )
        args: list = [match_expr, *scope_args, int(limit)]
        try:
            rows = self._conn.execute(sql, args).fetchall()
        except sqlite3.OperationalError:
            # Malformed MATCH expression slipped past the sanitiser.
            # Returning [] is the right fallback — the dense retriever
            # already covered this query, lexical just contributes
            # nothing.
            return []
        return [
            LexicalHit(chunk_id=str(r["chunk_id"]), bm25_score=-float(r["raw_score"]))
            for r in rows
        ]


# -- scope translation ---------------------------------------------------


def _scope_clause(scope: dict | None, *, prefix: str = " WHERE") -> tuple[str, list]:
    """Same scope shape as rag_store._scope_to_filter, translated to SQL."""
    if not scope:
        return "", []
    clauses: list[str] = []
    args: list = []
    char = scope.get("character") or scope.get("char_owner")
    if char:
        clauses.append("char_owner = ?")
        args.append(char)
    partners = scope.get("partners")
    if partners is None and scope.get("partner"):
        partners = [scope["partner"]]
    if partners:
        partners = [p for p in partners if p]
        if len(partners) == 1:
            clauses.append("partner = ?")
            args.append(partners[0])
        elif partners:
            placeholders = ",".join("?" * len(partners))
            clauses.append(f"partner IN ({placeholders})")
            args.extend(partners)
    if not clauses:
        return "", []
    return f"{prefix} " + " AND ".join(clauses), args


# -- query sanitisation --------------------------------------------------


def _build_match_expr(query: str) -> str:
    """Turn a natural-language question into an FTS5 MATCH expression.

    Strategy:
      1. Extract word-like tokens (letters + digits, allowing Unicode).
      2. Drop very short tokens (<2 chars) — too noisy.
      3. Wrap each in double quotes (escapes FTS5 operators inside).
      4. OR-join the result for recall.

    Empty / punctuation-only queries return "".
    """
    tokens: list[str] = []
    current: list[str] = []
    for ch in query:
        if ch.isalnum() or ch in "_":
            current.append(ch)
        else:
            if current:
                tokens.append("".join(current))
                current = []
    if current:
        tokens.append("".join(current))
    keep = [t for t in tokens if len(t) >= 2]
    if not keep:
        return ""
    # Escape any embedded double-quote (FTS5 quoting rule: "" inside "").
    quoted = [f'"{t.replace(chr(34), chr(34) * 2)}"' for t in keep]
    return " OR ".join(quoted)


# -- backfill helper -----------------------------------------------------


def backfill_from_qdrant(store: rag_store.RagStore, lex: LexicalStore) -> int:
    """Rebuild the FTS5 mirror from chunk payloads already in Qdrant.

    Cheap on the desktop scale we target (tens of thousands of rows in
    seconds) because the text + scope fields are already in each point's
    payload. Used by:
      - The Settings → "Rebuild lexical index" button for users who
        added FTS5 after their initial ingest.
      - An auto-rebuild safety net on first hybrid query when the table
        is empty but Qdrant isn't (avoids "I enabled hybrid and got no
        results" surprise after upgrading).
    """
    if not store.collection_exists():
        return 0
    written = 0
    offset: str | int | None = None
    BATCH = 512
    # qdrant-client's scroll is page-by-page; we re-use the same idiom
    # as RagStore.existing_chunk_ids but pull the full payload this time.
    while True:
        points, offset = store._client.scroll(  # noqa: SLF001 — intentional cross-module
            collection_name=rag_store.COLLECTION,
            with_payload=True,
            with_vectors=False,
            limit=BATCH,
            offset=offset,
        )
        batch_chunks: list[dict] = []
        for p in points:
            payload = p.payload or {}
            cid = payload.get("chunk_id")
            if not cid:
                continue
            batch_chunks.append(
                {
                    "chunk_id": cid,
                    "char_owner": payload.get("char_owner", ""),
                    "partner": payload.get("partner", ""),
                    "text": payload.get("text", ""),
                }
            )
        if batch_chunks:
            lex.upsert_chunks(batch_chunks)
            written += len(batch_chunks)
        if offset is None:
            break
    return written
