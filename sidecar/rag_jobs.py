"""The Index's ingest: parse → resolve labels → chunk → embed → upsert.

`run(job)` is the work of one ingest job; `services.index.start_ingest`
starts it as a job holding the Index (`services.jobs`), so status and
cancel go through the one job model and only one ingest runs at a time.

One job processes one scope (one partner, one character, or all
characters). The worker iterates partner-by-partner; each partner is
independent so cancel always takes effect within ~one embedding batch.

The embedding model + dimension are detected on the first probe call
and persisted in the rag_meta manifest. If the user changes embedding
models between ingests, the next job detects the dim mismatch and
either:
  - fails with `embedding_model_changed` so the UI can offer "wipe +
    re-ingest" with explicit confirmation
  - or, when the job was created with `force_rewipe=True`, drops the
    collection and starts fresh.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import aliases as aliases_store
import chunker
import labels as labels_store
import logs as logs_store
import rag as rag_settings
import rag_embed
import rag_lexical
import rag_store
from services.jobs import Job

#: The job kind, as `services.jobs` lists it.
KIND = "ingest"

#: The error code of an ingest stopped because the Index was built with
#: another embedding model; the UI offers wipe + re-ingest on it.
MODEL_CHANGED = "embedding_model_changed"

EMBED_BATCH = 16


@dataclass(slots=True)
class IngestProgress:
    chunked: int = 0
    embedded: int = 0
    upserted: int = 0
    # Chunks the Index already held with the same text: not embedded again.
    skipped_existing: int = 0
    # Chunks the Logs and their Labels no longer produce, deleted from
    # the Index.
    removed: int = 0
    # Messages dropped because nothing has judged them IC or OOC yet.
    # A high count means the user should run the classification flow
    # (MCP: get_unlabeled_messages / set_message_labels) first.
    skipped_unlabeled: int = 0
    failed: int = 0
    total_chunks: int = 0
    current_partner: str | None = None
    last_error: str | None = None
    embed_model: str | None = None
    embed_dimension: int | None = None


def params(scope: dict, *, include_ooc: bool, force_rewipe: bool) -> dict[str, Any]:
    """An ingest job's parameters, as the job reports them."""
    return {"scope": scope, "include_ooc": include_ooc, "force_rewipe": force_rewipe}


def summary(progress: IngestProgress) -> dict[str, Any]:
    """What an ingest did, as its job's result."""
    return {
        "chunks_indexed": progress.upserted,
        "chunks_already_present": progress.skipped_existing,
        "chunks_removed": progress.removed,
        "skipped_unlabeled": progress.skipped_unlabeled,
        "failed": progress.failed,
    }


def _resolve_targets(scope: dict) -> list[tuple[str, str]]:
    """Same shape as labels_jobs._resolve_targets — kept in lockstep so
    the renderer can think about RAG ingest scopes the same way it
    thinks about classify scopes.

    Note on aliases: list_partners already folds alias groups so we
    naturally return one (char, primary_name) per group. For an
    explicit single-conversation scope we normalize the supplied
    partner to its primary so the chunker keys chunks canonically;
    read_messages on the primary will pick up every member's log file.

    Channel logs (`#name`) are left out unless asked for. They are group
    chat, not this character's roleplay, and they dwarf everything else:
    on one real archive they carried two thirds of all unjudged messages
    and millions of rule-OOC lines. Indexing them buries the private
    conversations the user is actually asking about. `list_partners`
    already hides them by default; the ingest used to be the one place
    that did not.
    """
    character = scope.get("character")
    partner = scope.get("partner")
    include_channels = bool(scope.get("include_channels"))

    def wanted(name: str) -> bool:
        return include_channels or not name.startswith("#")

    if character and partner:
        conn = aliases_store.connect()
        try:
            primary = aliases_store.primary_for(conn, character, partner)
        finally:
            conn.close()
        return [(character, primary)]
    if character:
        partners = logs_store.list_partners(character)
        return [(character, p.name) for p in partners if wanted(p.name)]
    targets: list[tuple[str, str]] = []
    chars = logs_store.list_characters()
    for c in chars:
        try:
            partners = logs_store.list_partners(c.name)
        except logs_store.LogDirError:
            continue
        for p in partners:
            if wanted(p.name):
                targets.append((c.name, p.name))
    return targets


def _delete_rebuild_scope(
    scope: dict, *, store: rag_store.RagStore, lex: rag_lexical.LexicalStore
) -> None:
    """Delete what a scoped rebuild is about to fill again, and nothing
    else. The delete mirrors the ingest's own filter: one conversation as
    asked, or every conversation of the character except its channels
    (`#name`) unless the ingest includes channels too. Otherwise a
    rebuild would delete channel chunks it never puts back."""
    character = scope["character"]
    if scope.get("partner") or scope.get("include_channels"):
        store.delete_scope(scope)
        lex.delete_scope(scope)
        return
    owner = {"character": character}
    partners = sorted(
        p for p in store.partners(owner) | lex.partners(owner) if not p.startswith("#")
    )
    if not partners:
        return
    store.delete_scope({"character": character, "partners": partners})
    lex.delete_scope({"character": character, "partners": partners})


def run(job: Job) -> dict[str, Any] | None:
    """The work of one ingest job (`services.jobs`): `job.params` as
    `params` builds them, `job.progress` an `IngestProgress`. Returns
    the `summary` unless it failed."""
    scope: dict = job.params["scope"]
    force_rewipe = bool(job.params.get("force_rewipe"))
    progress: IngestProgress = job.progress
    try:
        targets = _resolve_targets(scope)
    except logs_store.LogDirError as exc:
        job.fail("log_dir_unavailable", str(exc))
        return None

    if not targets:
        # Nothing matched the scope — finish with state=done so the UI
        # closes cleanly. Not an error: an empty character folder is a
        # valid state on first launch.
        return summary(progress)

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
            job.fail(
                "embedding_failed",
                f"The embedding model could not be used: {exc}",
                model=rag_set.embed_model,
            )
            return None
        progress.embed_model = rag_set.embed_model
        progress.embed_dimension = dimension

        manifest = rag_store.read_manifest()
        with rag_store.RagStore() as store, rag_lexical.LexicalStore() as lex:
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
            # ensure_collection raises DimensionMismatchError. Trap it
            # here as the same model change so the UI can surface the
            # Wipe + re-ingest button.
            try:
                if mismatch and force_rewipe:
                    # Dim/model change confirmed → nuke the world. Per-
                    # conversation wipe wouldn't help because every old
                    # chunk's vector is the wrong dim.
                    store.recreate_collection(vector_size=dimension)
                    rag_store.clear_manifest()
                    lex.wipe()
                elif mismatch:
                    job.fail(
                        MODEL_CHANGED,
                        f"embedding model changed from "
                        f"{manifest.embed_model} (dim "
                        f"{manifest.embed_dimension}) to "
                        f"{rag_set.embed_model} (dim {dimension}). "
                        "Existing vectors are incompatible — confirm "
                        "wipe to re-ingest.",
                        indexed_model=manifest.embed_model,
                        indexed_dimension=manifest.embed_dimension,
                        model=rag_set.embed_model,
                        dimension=dimension,
                    )
                    return None
                elif force_rewipe:
                    # No dim mismatch, user explicitly asked for a
                    # rebuild. It deletes only the scope it was asked
                    # for (one conversation, or every conversation of
                    # one character), in both indexes, so rebuilding
                    # one character never costs another character's
                    # Index. Safe because chunks only reference others
                    # within the same (character, partner) via
                    # prev/next pointers.
                    if scope.get("character"):
                        _delete_rebuild_scope(scope, store=store, lex=lex)
                        store.ensure_collection(vector_size=dimension)
                    else:
                        # Unscoped: empty the whole Index first,
                        # matching "Re-ingest all".
                        store.recreate_collection(vector_size=dimension)
                        rag_store.clear_manifest()
                        lex.wipe()
                else:
                    store.ensure_collection(vector_size=dimension)
            except rag_store.DimensionMismatchError as exc:
                # Fresh install with an orphaned 768-dim Qdrant
                # collection while the manifest is empty — the
                # mismatch check above didn't fire because both
                # manifest fields were None. Surface as a model change
                # so the dialog offers the same Wipe + re-ingest button.
                job.fail(
                    MODEL_CHANGED,
                    f"existing vector index has dimension {exc.actual} "
                    f"but the embedding model now returns {exc.expected}. "
                    "The index needs to be wiped and rebuilt — confirm "
                    "wipe below or use Settings → RAG → Re-ingest all.",
                    indexed_model=None,
                    indexed_dimension=exc.actual,
                    model=rag_set.embed_model,
                    dimension=exc.expected,
                )
                return None

            # Persist manifest now so a crash mid-ingest still records
            # the model/dim — partial collections aren't useful but at
            # least the metadata won't lie about what they were embedded
            # with.
            rag_store.write_manifest(
                embed_model=rag_set.embed_model, embed_dimension=dimension
            )

            for char, partner in targets:
                if job.cancel_requested:
                    job.state = "cancelled"
                    break
                progress.current_partner = f"{char} / {partner}"
                _ingest_one_partner(
                    char,
                    partner,
                    job=job,
                    store=store,
                    lex=lex,
                    labels_conn=labels_conn,
                    label_settings=label_settings,
                    rag_set=rag_set,
                )
                if job.state == "cancelled":
                    break
    finally:
        labels_conn.close()
    return summary(progress)


def _ingest_one_partner(
    character: str,
    partner: str,
    *,
    job: Job,
    store: rag_store.RagStore,
    lex: rag_lexical.LexicalStore,
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
    unlabeled_counter = [0]
    chunks = chunker.chunk_messages(
        messages,
        character=character,
        partner=partner,
        labels_by_hash=by_hash,
        label_settings=label_settings,
        include_ooc=bool(job.params.get("include_ooc")),
        speaker_aliases=alias_group,
        max_chars=rag_set.chunk_max_chars,
        soft_split=rag_set.chunk_soft_split_chars,
        overlap=rag_set.chunk_overlap_msgs,
        skipped_unlabeled=unlabeled_counter,
    )
    job.progress.skipped_unlabeled += unlabeled_counter[0]
    job.progress.chunked += len(chunks)
    job.progress.total_chunks += len(chunks)

    # Reconcile the conversation's Index with what the Logs and their
    # current Labels make of it now. A chunk id names one (day, Label,
    # sub-chunk), so it stays the same when F-Chat appends to a day or a
    # Label changes; comparing the text is what tells a changed day from
    # an unchanged one. Only changed chunks are embedded again.
    scope = {"character": character, "partner": partner}
    indexed = store.chunk_payloads(scope)
    lexical = lex.chunk_texts(scope)
    fresh_ids = {c["chunk_id"] for c in chunks}

    # Chunk ids no longer produced: the message drops out of search
    # (its Label flipped or was cleared, or a day lost its last IC line).
    gone = (set(indexed) | set(lexical)) - fresh_ids
    if gone:
        store.delete_chunk_ids(gone)
        lex.delete_chunk_ids(gone)
        job.progress.removed += len(gone)

    pending: list[dict] = []
    repointed: list[dict] = []
    for c in chunks:
        stored = indexed.get(c["chunk_id"])
        if stored is None or stored.get("text") != c["text"]:
            pending.append(c)
        elif stored != rag_store.chunk_payload(c):
            repointed.append(c)
    job.progress.skipped_existing += len(chunks) - len(pending)
    # Same text, so the same vector; only a neighbour pointer moved.
    store.replace_payloads(repointed)
    # The vector Index is current for these but the lexical one is not
    # (a lexical mirror that failed on an earlier ingest).
    pending_ids = {c["chunk_id"] for c in pending}
    _mirror_lexical(
        [
            c
            for c in chunks
            if c["chunk_id"] not in pending_ids and lexical.get(c["chunk_id"]) != c["text"]
        ],
        lex=lex,
        job=job,
        where=f"{character} / {partner}",
    )

    for i in range(0, len(pending), EMBED_BATCH):
        if job.cancel_requested:
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
        # Mirror into the FTS5 lexical index inline so dense + lexical
        # stay equivalent in chunk_id coverage.
        _mirror_lexical(batch, lex=lex, job=job, where=f"{character} / {partner}")
        job.progress.upserted += len(batch)


def _mirror_lexical(
    chunks: list[dict], *, lex: rag_lexical.LexicalStore, job: Job, where: str
) -> None:
    """Write chunks to the lexical Index. Cheap (no network). A failure
    here should not abort the dense upsert the user already paid for, so
    it is swallowed into last_error; the next ingest sees the lexical
    text differ and writes it again."""
    if not chunks:
        return
    try:
        lex.upsert_chunks(chunks)
    except Exception as exc:  # noqa: BLE001 — lexical mirror is best-effort
        job.progress.last_error = f"{where}: lexical mirror failed: {exc}"
