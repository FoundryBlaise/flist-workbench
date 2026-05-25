"""Background ingest jobs — parse → resolve labels → chunk → embed → upsert.

Mirrors the shape of labels_jobs.JobRegistry so the renderer can poll
both kinds with the same code shape (state machine, progress event,
cancel between batches).

One job processes one scope (one partner, one character, or all
characters). The worker iterates partner-by-partner; each partner is
independent so cancel always takes effect within ~one embedding batch.

The embedding model + dimension are detected on the first probe call
and persisted in the rag_meta manifest. If the user changes embedding
models between ingests, the next job detects the dim mismatch and
either:
  - returns to the renderer with `state='failed'` + `model_swap=True`
    so the UI can offer "wipe + re-ingest" with explicit confirmation
  - or, when the job was created with `force_rewipe=True`, drops the
    collection and starts fresh.
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Literal

import aliases as aliases_store
import chunker
import labels as labels_store
import logs as logs_store
import rag as rag_settings
import rag_embed
import rag_store

JobState = Literal["pending", "running", "done", "cancelled", "failed"]

EMBED_BATCH = 16


@dataclass(slots=True)
class IngestProgress:
    chunked: int = 0
    embedded: int = 0
    upserted: int = 0
    skipped_existing: int = 0
    failed: int = 0
    total_chunks: int = 0
    current_partner: str | None = None
    last_error: str | None = None


@dataclass(slots=True)
class IngestJob:
    id: str
    scope: dict
    include_ooc: bool = False
    force_rewipe: bool = False
    state: JobState = "pending"
    progress: IngestProgress = field(default_factory=IngestProgress)
    error: str | None = None
    # When a dim mismatch is detected and force_rewipe is False, the
    # job stops in `failed` state with this flag set so the UI can
    # surface "your model changed; confirm wipe?" without parsing
    # error strings.
    model_swap: bool = False
    embed_model: str | None = None
    embed_dimension: int | None = None
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    _cancel: threading.Event = field(default_factory=threading.Event)
    _thread: threading.Thread | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "scope": self.scope,
            "include_ooc": self.include_ooc,
            "force_rewipe": self.force_rewipe,
            "state": self.state,
            "chunked": self.progress.chunked,
            "embedded": self.progress.embedded,
            "upserted": self.progress.upserted,
            "skipped_existing": self.progress.skipped_existing,
            "failed": self.progress.failed,
            "total_chunks": self.progress.total_chunks,
            "current_partner": self.progress.current_partner,
            "last_error": self.progress.last_error,
            "error": self.error,
            "model_swap": self.model_swap,
            "embed_model": self.embed_model,
            "embed_dimension": self.embed_dimension,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
        }


class JobRegistry:
    def __init__(self, retention_seconds: float = 300.0) -> None:
        self._jobs: dict[str, IngestJob] = {}
        self._lock = threading.Lock()
        self.retention_seconds = retention_seconds

    def create(
        self, scope: dict, *, include_ooc: bool = False, force_rewipe: bool = False
    ) -> IngestJob:
        job_id = uuid.uuid4().hex[:12]
        job = IngestJob(
            id=job_id, scope=scope, include_ooc=include_ooc, force_rewipe=force_rewipe
        )
        with self._lock:
            self._sweep_locked()
            self._jobs[job_id] = job
        return job

    def get(self, job_id: str) -> IngestJob | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[IngestJob]:
        with self._lock:
            return list(self._jobs.values())

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            return False
        job._cancel.set()
        return True

    def _sweep_locked(self) -> None:
        now = time.time()
        stale = [
            jid
            for jid, j in self._jobs.items()
            if j.finished_at is not None and (now - j.finished_at) > self.retention_seconds
        ]
        for jid in stale:
            del self._jobs[jid]


_registry = JobRegistry()


def registry() -> JobRegistry:
    return _registry


def _resolve_targets(scope: dict) -> list[tuple[str, str]]:
    """Same shape as labels_jobs._resolve_targets — kept in lockstep so
    the renderer can think about RAG ingest scopes the same way it
    thinks about classify scopes.

    Note on aliases: list_partners already folds alias groups so we
    naturally return one (char, primary_name) per group. For an
    explicit single-conversation scope we normalize the supplied
    partner to its primary so the chunker keys chunks canonically;
    read_messages on the primary will pick up every member's log file.
    """
    character = scope.get("character")
    partner = scope.get("partner")
    if character and partner:
        conn = aliases_store.connect()
        try:
            primary = aliases_store.primary_for(conn, character, partner)
        finally:
            conn.close()
        return [(character, primary)]
    if character:
        partners = logs_store.list_partners(character)
        return [(character, p.name) for p in partners]
    targets: list[tuple[str, str]] = []
    chars = logs_store.list_characters()
    for c in chars:
        try:
            partners = logs_store.list_partners(c.name)
        except logs_store.LogDirError:
            continue
        for p in partners:
            targets.append((c.name, p.name))
    return targets


def _run_job(job: IngestJob) -> None:
    job.state = "running"
    try:
        targets = _resolve_targets(job.scope)
    except logs_store.LogDirError as exc:
        job.error = str(exc)
        job.state = "failed"
        job.finished_at = time.time()
        return

    if not targets:
        # Nothing matched the scope — finish with state=done so the UI
        # closes cleanly. Not an error: an empty character folder is a
        # valid state on first launch.
        job.state = "done"
        job.finished_at = time.time()
        return

    labels_conn = labels_store.connect()
    try:
        label_settings = labels_store.load_settings()
        rag_set = rag_settings.load_settings()

        # First, probe the embedding endpoint so we know the dimension
        # before opening the Qdrant collection. Failure here aborts the
        # whole job — no partner-by-partner retry, the endpoint is
        # global.
        try:
            dimension, _vec = rag_embed.probe(rag_set, timeout=60.0)
        except rag_embed.EmbedError as exc:
            job.error = f"embedding probe failed: {exc}"
            job.state = "failed"
            job.finished_at = time.time()
            return
        job.embed_model = rag_set.embed_model
        job.embed_dimension = dimension

        manifest = rag_store.read_manifest()
        with rag_store.RagStore() as store:
            # Detect a model swap — manifest disagrees with the probe's
            # dimension or the previously-recorded model name. The UI
            # asks the user; if they say yes the renderer retries with
            # force_rewipe=True.
            mismatch = (
                manifest.embed_dimension is not None
                and manifest.embed_dimension != dimension
            ) or (
                manifest.embed_model is not None
                and manifest.embed_model != rag_set.embed_model
            )

            # Also catch the manifest-empty-but-collection-exists case:
            # ensure_collection raises DimensionMismatchError, but the
            # bare `Exception` handler used to swallow it as a generic
            # failure (no model_swap flag, no actionable UI path). Trap
            # it here as the same model_swap signal so the UI can
            # surface the Wipe + re-ingest button.
            try:
                if mismatch and job.force_rewipe:
                    # Dim/model change confirmed → nuke the world. Per-
                    # conversation wipe wouldn't help because every old
                    # chunk's vector is the wrong dim.
                    store.recreate_collection(vector_size=dimension)
                    rag_store.clear_manifest()
                elif mismatch:
                    job.model_swap = True
                    job.error = (
                        f"embedding model changed from "
                        f"{manifest.embed_model} (dim "
                        f"{manifest.embed_dimension}) to "
                        f"{rag_set.embed_model} (dim {dimension}). "
                        "Existing vectors are incompatible — confirm "
                        "wipe to re-ingest."
                    )
                    job.state = "failed"
                    job.finished_at = time.time()
                    return
                elif job.force_rewipe:
                    # No dim mismatch, user explicitly asked for a
                    # rewipe — scope-aware so re-ingesting one
                    # conversation doesn't nuke the whole index. Safe
                    # because chunks only reference others within the
                    # same (character, partner) via prev/next pointers.
                    if job.scope.get("character") and job.scope.get("partner"):
                        store.delete_scope(job.scope)
                        store.ensure_collection(vector_size=dimension)
                    else:
                        # Broad scope (character-only or all): nuke +
                        # rebuild, matching the user's mental model of
                        # "Re-ingest all".
                        store.recreate_collection(vector_size=dimension)
                        rag_store.clear_manifest()
                else:
                    store.ensure_collection(vector_size=dimension)
            except rag_store.DimensionMismatchError as exc:
                # Fresh install with an orphaned 768-dim Qdrant
                # collection while the manifest is empty — the
                # mismatch check above didn't fire because both
                # manifest fields were None. Surface as model_swap so
                # the dialog offers the same Wipe + re-ingest button.
                job.model_swap = True
                job.error = (
                    f"existing vector index has dimension {exc.actual} "
                    f"but the embedding model now returns {exc.expected}. "
                    "The index needs to be wiped and rebuilt — confirm "
                    "wipe below or use Settings → RAG → Re-ingest all."
                )
                job.state = "failed"
                job.finished_at = time.time()
                return

            # Persist manifest now so a crash mid-ingest still records
            # the model/dim — partial collections aren't useful but at
            # least the metadata won't lie about what they were embedded
            # with.
            rag_store.write_manifest(
                embed_model=rag_set.embed_model, embed_dimension=dimension
            )

            for char, partner in targets:
                if job._cancel.is_set():
                    job.state = "cancelled"
                    break
                job.progress.current_partner = f"{char} / {partner}"
                _ingest_one_partner(
                    char,
                    partner,
                    job=job,
                    store=store,
                    labels_conn=labels_conn,
                    label_settings=label_settings,
                    rag_set=rag_set,
                )
                if job.state == "cancelled":
                    break

            if job.state == "running":
                job.state = "done"
    except Exception as exc:  # noqa: BLE001 — worker top-level guard
        job.error = repr(exc)
        job.state = "failed"
    finally:
        labels_conn.close()
        job.finished_at = time.time()


def _ingest_one_partner(
    character: str,
    partner: str,
    *,
    job: IngestJob,
    store: rag_store.RagStore,
    labels_conn,
    label_settings: labels_store.LabelsSettings,
    rag_set: rag_settings.RagSettings,
) -> None:
    """Parse → chunk → embed → upsert for one conversation.

    Records partial progress so the dialog can show "chunked: N of M"
    while embedding is still running. Cancels are honoured between
    embedding batches; the batch in flight finishes so the upsert it'd
    produce isn't lost.
    """
    try:
        messages = list(logs_store.read_messages(character, partner))
    except logs_store.LogDirError as exc:
        job.progress.last_error = f"{character} / {partner}: {exc}"
        return

    # Look up the full alias group so labels written under any of the
    # member names apply to this conversation. (_resolve_targets has
    # already normalised `partner` to the primary name for single-
    # conversation scopes, but for character / all-characters scopes
    # we still get the primary names from list_partners.) Also passed
    # to the chunker as speaker_aliases so messages from the pre-
    # rename name read as the canonical name in the LLM context.
    alias_group = aliases_store.all_names_for(labels_conn, character, partner)
    by_hash = labels_store.labels_for_partner(
        labels_conn, character, partner, partner_aliases=alias_group
    )
    chunks = chunker.chunk_messages(
        messages,
        character=character,
        partner=partner,
        labels_by_hash=by_hash,
        label_settings=label_settings,
        include_ooc=job.include_ooc,
        speaker_aliases=alias_group,
        max_chars=rag_set.chunk_max_chars,
        soft_split=rag_set.chunk_soft_split_chars,
        overlap=rag_set.chunk_overlap_msgs,
    )
    job.progress.chunked += len(chunks)
    job.progress.total_chunks += len(chunks)
    if not chunks:
        return

    # Skip chunks already in Qdrant — re-runs after a "new messages
    # arrived" event are mostly no-ops because chunk_ids are
    # deterministic in (char, partner, date, label, subchunk).
    existing = store.existing_chunk_ids({"character": character, "partner": partner})
    pending = [c for c in chunks if c["chunk_id"] not in existing]
    job.progress.skipped_existing += len(chunks) - len(pending)
    if not pending:
        return

    for i in range(0, len(pending), EMBED_BATCH):
        if job._cancel.is_set():
            job.state = "cancelled"
            return
        batch = pending[i : i + EMBED_BATCH]
        texts = [c["text"] for c in batch]
        try:
            vectors = rag_embed.embed_texts(texts, "document", rag_set)
        except rag_embed.EmbedError as exc:
            # A transient embedding failure should fail this batch
            # only — keep going so a flaky network doesn't waste an
            # hour of progress. The user can re-run; deterministic
            # IDs make it idempotent.
            job.progress.failed += len(batch)
            job.progress.last_error = f"{character} / {partner}: {exc}"
            continue
        job.progress.embedded += len(vectors)
        store.upsert_chunks(batch, vectors)
        job.progress.upserted += len(batch)


def start(
    scope: dict, *, include_ooc: bool = False, force_rewipe: bool = False
) -> IngestJob:
    job = registry().create(scope, include_ooc=include_ooc, force_rewipe=force_rewipe)
    thread = threading.Thread(target=_run_job, args=(job,), daemon=True)
    job._thread = thread
    thread.start()
    return job
