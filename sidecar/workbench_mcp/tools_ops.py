"""Long-running and file-touching operations (design §3.8, §3.10, §3.11).

Pulling from F-list, backing up, ingesting logs, moving bundles on and
off disk, and the settings the rest of it reads.

Two things run long enough to need progress: a pull walks a
character's whole image set, and the backup sweep pulls every
character on the account. Both report through `Context.report_progress`
so a client can show something moving, and both are bounded by
F-list's rate limit rather than by anything here.

On file paths: the export and import tools read and write wherever the
user running Workbench can. That is the same reach the app already has
through its own file dialogs, and narrowing it would mean a model
couldn't put a bundle where the user asked for it.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

import character_archive
import rag_jobs
from mcp.server.fastmcp import Context

from ._context import ToolError, audit, resolve_character, resolve_set
from ._registry import TAG_CHARACTER, TAG_CORE, TAG_LOGS, tool
from .tools_session import NO_PUSH_NOTE

#: How long a tool will sit waiting on a job before handing the caller
#: a job id to poll instead. Ten minutes covers any realistic single
#: pull; a full-corpus ingest can run far longer.
WAIT_BUDGET_SEC = 600


# --------------------------------------------------------------------
# F-list
# --------------------------------------------------------------------


@tool(tags=TAG_CHARACTER, title="Pull from F-list", open_world=True)
async def pull_character(character: str, ctx: Context) -> dict[str, Any]:
    """Fetch a character's current profile and images from F-list into
    the local archive.

    This is a *download*. It refreshes `live` — the record of what is
    published — and leaves working sets alone. Needs the user to be
    signed in, which happens in the Workbench window; there is no
    sign-in tool, because credentials never travel through MCP.

    Takes a while: F-list is rate-limited to one request a second and
    every gallery image is a request.
    """
    from services import pull as pull_service

    name = str(character).strip()
    if not name:
        raise ToolError("validation_failed", "character is empty")

    summary: dict[str, Any] | None = None
    failure: dict[str, Any] | None = None
    images_total = 0

    async for event, data in pull_service.run(name):
        if event == "error":
            failure = data
            break
        if event == "images":
            images_total = int(data.get("total") or 0)
            await ctx.report_progress(0, images_total or None, "downloading images")
        elif event == "image":
            await ctx.report_progress(
                int(data.get("index") or 0),
                images_total or None,
                f"image {data.get('index')}/{images_total}",
            )
        elif event == "fetching":
            await ctx.info(f"fetching {name} from F-list")
        elif event == "done":
            summary = data

    if failure is not None:
        stage = failure.get("stage")
        message = str(failure.get("message") or "pull failed")
        if stage == "ticket":
            raise ToolError(
                "not_signed_in",
                f"{message} The user signs in inside the Workbench "
                "window (F-list → Sign in).",
            )
        raise ToolError("pull_failed", message, stage=stage)

    if summary is None:
        raise ToolError("pull_failed", "the pull ended without a result")

    audit("pull_character", character=name)
    return {
        "character": name,
        "character_id": summary.get("character_id"),
        "images": summary.get("image_count"),
        "backup": summary.get("backup_path"),
        "note": (
            "This updated the local copy of what is published. Edits "
            "live in working sets and were not touched. " + NO_PUSH_NOTE
        ),
    }


@tool(tags=TAG_CHARACTER, title="Back up a character")
def create_backup(
    character: str, note: str | None = None, force: bool = True
) -> dict[str, Any]:
    """Write a ZIP backup of a character's current published profile,
    including its images and avatar.

    Backups are what `create_working_set(source="backup:...")` restores
    from, and what the user can hand to the browser extension.
    `force=false` skips the write when nothing changed since the last
    backup.
    """
    target = resolve_character(character)
    result = character_archive.save_zip_backup(
        target.id, force=force, kind="manual_single"
    )
    # A skip comes back as `{saved: False, reason: ...}` rather than an
    # exception. "no_live" is a real failure — there is nothing to pack
    # — while "unchanged" is the deduplication doing its job.
    if not result.get("saved"):
        if result.get("reason") == "no_live":
            raise ToolError(
                "live_not_found",
                f"No profile stored for {target.name}, so there is "
                "nothing to back up. Pull the character first — a "
                "backup packs what was last fetched from F-list.",
            )
        return {
            "character": target.name,
            "saved": False,
            "reason": result.get("reason"),
            "note": (
                "Nothing changed since the last backup, so no new file "
                "was written. Pass force=true to make one anyway."
            ),
        }

    if note:
        filename = result.get("filename")
        if filename:
            character_archive.rename_zip_backup(target.id, filename, str(note))
    audit("create_backup", character=target.name, filename=result.get("filename"))
    return {"character": target.name, **result}


@tool(tags=TAG_CHARACTER, title="Back up every character", open_world=True)
async def backup_all_characters(ctx: Context) -> dict[str, Any]:
    """Pull and back up every character on the signed-in account.

    Long: each character is a full pull, one at a time, at F-list's
    rate limit. Characters whose content hasn't changed since their
    last backup are skipped rather than re-zipped. Tell the user this
    will take a few minutes on a large account before starting it.
    """
    from services import backup_all as backup_all_service

    summary: dict[str, Any] | None = None
    failure: dict[str, Any] | None = None
    total = 0
    seen = 0
    rows: list[dict[str, Any]] = []

    async for event, data in backup_all_service.run("manual_bulk", "manual"):
        if event == "error":
            failure = data
            break
        if event == "start":
            total = int(data.get("total") or 0)
            await ctx.report_progress(0, total or None, "starting")
        elif event == "character":
            if data.get("status") in ("saved", "unchanged", "error"):
                seen += 1
                rows.append(
                    {
                        "character": data.get("name"),
                        "status": data.get("status"),
                        "filename": data.get("filename"),
                        "message": data.get("message"),
                    }
                )
                await ctx.report_progress(
                    seen, total or None, str(data.get("name") or "")
                )
        elif event == "done":
            summary = data

    if failure is not None:
        message = str(failure.get("message") or "the sweep failed")
        raise ToolError("backup_failed", message, stage=failure.get("stage"))

    audit("backup_all_characters", **(summary or {}))
    return {"summary": summary or {}, "characters": rows}


# --------------------------------------------------------------------
# Ingest
# --------------------------------------------------------------------


@tool(tags=TAG_LOGS, title="Index logs for search")
async def ingest_logs(
    ctx: Context,
    character: str | None = None,
    partner: str | None = None,
    include_ooc: bool = False,
    include_channels: bool = False,
    rebuild: bool = False,
    wait: bool = True,
) -> dict[str, Any]:
    """Chunk and embed logs so search_logs_semantic can find them.

    Only messages with an IC/OOC verdict are indexed — the count of
    those skipped comes back as `skipped_unlabeled`, and a high number
    means the classification flow should run first. OOC is excluded
    unless `include_ooc=true`; it is usually noise in a search over
    roleplay.

    Channel logs are excluded unless `include_channels=true`, matching
    list_partners. They are group chat rather than this character's
    roleplay, and they are large enough to bury everything else.

    Embedding runs in-process by default, so nothing needs to be
    installed. `wait=false` returns a job id to poll with get_job
    instead of blocking.
    """
    if partner and not character:
        raise ToolError(
            "validation_failed",
            "partner needs a character too — logs are scoped per (your "
            "character, their character) pair",
        )
    scope: dict[str, Any] = {}
    if character:
        scope["character"] = character
    if partner:
        scope["partner"] = partner
    if include_channels:
        scope["include_channels"] = True

    job = rag_jobs.start(scope, include_ooc=include_ooc, force_rewipe=rebuild)
    audit("ingest_logs", character=character, partner=partner, job=job.id)
    if not wait:
        return {
            "job_id": job.id,
            "state": job.state,
            "note": "Running in the background — poll get_job for progress.",
        }

    started = time.monotonic()
    last_reported = -1
    while True:
        current = rag_jobs.registry().get(job.id)
        if current is None:
            raise ToolError("job_lost", f"job {job.id} disappeared")
        snapshot = current.to_dict()
        if snapshot.get("state") in ("done", "cancelled", "failed"):
            return _ingest_summary(snapshot)
        done = int(snapshot.get("embedded") or 0)
        if done != last_reported:
            await ctx.report_progress(
                done,
                int(snapshot.get("total_chunks") or 0) or None,
                str(snapshot.get("current_partner") or "indexing"),
            )
            last_reported = done
        if time.monotonic() - started > WAIT_BUDGET_SEC:
            return {
                "job_id": job.id,
                "state": snapshot.get("state"),
                "note": (
                    "Still running after 10 minutes — left in the "
                    "background. Poll get_job for progress."
                ),
            }
        await asyncio.sleep(0.5)


def _ingest_summary(snapshot: dict[str, Any]) -> dict[str, Any]:
    out = {
        "job_id": snapshot.get("id"),
        "state": snapshot.get("state"),
        "chunks_indexed": snapshot.get("upserted"),
        "chunks_already_present": snapshot.get("skipped_existing"),
        "skipped_unlabeled": snapshot.get("skipped_unlabeled"),
        "failed": snapshot.get("failed"),
        "error": snapshot.get("error") or snapshot.get("last_error"),
    }
    if out["skipped_unlabeled"]:
        out["note"] = (
            f"{out['skipped_unlabeled']} message(s) were skipped for "
            "having no IC/OOC verdict — they aren't searchable. Run the "
            "classification flow (get_messages_to_classify) and ingest "
            "again to include them."
        )
    elif out["state"] == "failed":
        out["note"] = (
            "The embedding model failed to load — see `last_error`. "
            "test_embedding_connection reports the same failure on its "
            "own, which is the quicker way to see what went wrong."
        )
    return out


@tool(tags=(TAG_CORE, TAG_LOGS), title="Job status", read_only=True)
def get_job(job_id: str) -> dict[str, Any]:
    """Progress of a background ingest started with wait=false."""
    job = rag_jobs.registry().get(job_id)
    if job is None:
        raise ToolError(
            "job_not_found",
            f"No job {job_id!r}. Finished jobs are forgotten after a "
            "few minutes.",
        )
    return job.to_dict()


@tool(tags=(TAG_CORE, TAG_LOGS), title="Cancel a job")
def cancel_job(job_id: str) -> dict[str, Any]:
    """Ask a running ingest to stop. Chunks already written stay
    indexed; the job stops at the next partner boundary."""
    ok = rag_jobs.registry().cancel(job_id)
    if not ok:
        raise ToolError("job_not_found", f"No job {job_id!r}.")
    audit("cancel_job", job=job_id)
    return {"job_id": job_id, "cancel_requested": True}


@tool(tags=TAG_LOGS, title="Wipe the search index", destructive=True)
def wipe_search_index(confirm: bool = False) -> dict[str, Any]:
    """Delete every indexed chunk. The logs and their labels are
    untouched; only the search index goes.

    Needed when switching embedding models — an index built with one
    model can't be searched with another.
    """
    if not confirm:
        raise ToolError(
            "confirm_required",
            "This deletes the whole search index. Re-indexing means "
            "re-embedding every message, which takes a while. Ask the "
            "user, then call again with confirm=true.",
        )
    import rag_lexical
    import rag_store

    with rag_store.RagStore() as store:
        store.wipe()
    rag_store.clear_manifest()
    with rag_lexical.LexicalStore() as lex:
        lex.wipe()
    audit("wipe_search_index")
    return {"wiped": True, "note": "Run ingest_logs to rebuild."}


@tool(
    tags=(TAG_CORE, TAG_LOGS),
    title="Test the embedding model",
    read_only=True,
)
def test_embedding_connection() -> dict[str, Any]:
    """Check that the embedding model loads, and report its dimension.

    Embedding runs inside Workbench — there is no server to start and
    nothing to configure. The first call downloads the model, so it can
    take a moment; after that it is milliseconds.
    """
    import rag as rag_settings
    import rag_embed

    settings = rag_settings.load_settings()
    started = time.monotonic()
    try:
        dimension, _vec = rag_embed.probe(settings, timeout=60.0)
    except rag_embed.EmbedError as exc:
        return {
            "ok": False,
            "model": settings.embed_model,
            "error": str(exc),
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        }
    return {
        "ok": True,
        "model": settings.embed_model,
        "dimension": dimension,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }


# --------------------------------------------------------------------
# Bundles and exports
# --------------------------------------------------------------------


@tool(tags=TAG_CHARACTER, title="Export a working set")
def export_working_set_bundle(
    character: str, path: str, working_set: str | None = None
) -> dict[str, Any]:
    """Save a working set as a Workbench bundle at `path`.

    A bundle round-trips between Workbench installs: it carries the
    payload verbatim plus every image it references. This is *not* the
    file to upload to F-list — that is export_restore_zip.
    """
    import set_bundle

    target = resolve_character(character)
    resolved = resolve_set(target, working_set, allow_live=False)
    try:
        data, manifest = set_bundle.build_set_bundle(
            target.id, resolved.id or ""
        )
    except FileNotFoundError as exc:
        raise ToolError("set_not_found", str(exc)) from exc

    written = _write_file(path, data, suffix=".zip")
    audit("export_working_set_bundle", character=target.name, path=str(written))
    return {
        "character": target.name,
        "set": resolved.name,
        "path": str(written),
        "bytes": len(data),
        "manifest": manifest.get("source"),
    }


@tool(tags=TAG_CHARACTER, title="Import a working set")
def import_working_set_bundle(
    character: str,
    path: str,
    name: str | None = None,
    confirm_cross_character: bool = False,
) -> dict[str, Any]:
    """Load a Workbench bundle from `path` as a new working set.

    Importing a bundle exported from a *different* character needs
    `confirm_cross_character=true` — the payload carries that
    character's identity, and copying it over is occasionally what
    someone wants and usually a mistake.
    """
    import set_bundle

    target = resolve_character(character)
    source = Path(path).expanduser()
    if not source.is_file():
        raise ToolError("file_not_found", f"No file at {source}")

    try:
        result = set_bundle.import_set_bundle(
            target.id,
            source.read_bytes(),
            name=(name or "").strip() or f"Imported {source.stem}"[:80],
            confirm_cross_character=confirm_cross_character,
        )
    except set_bundle.CrossCharacterConfirmationRequired as exc:
        origin = (exc.source or {}).get("character_name") or "another character"
        raise ToolError(
            "cross_character_import",
            f"This bundle was exported from {origin!r}, not "
            f"{target.name!r}. Importing it copies that character's "
            "profile over. Ask the user, then call again with "
            "confirm_cross_character=true.",
            source=exc.source,
        ) from exc
    except set_bundle.BundleError as exc:
        raise ToolError("bad_bundle", str(exc)) from exc
    except ValueError as exc:
        raise ToolError("validation_failed", str(exc)) from exc

    meta = result.get("set")
    audit("import_working_set_bundle", character=target.name, path=str(source))
    return {
        "character": target.name,
        "set": getattr(meta, "name", None) or (meta or {}).get("name"),
        "source": result.get("source"),
        "images": result.get("image_stats"),
    }


@tool(tags=TAG_CHARACTER, title="Export for upload to F-list")
def export_restore_zip(
    character: str, path: str, working_set: str | None = None
) -> dict[str, Any]:
    """Save the ZIP the user uploads to F-list themselves.

    This is the hand-off point. Workbench does not publish anything:
    the user opens f-list.net in their browser and restores this file
    with the FlistCharExporter userscript or the paired extension.
    Never tell them a profile is live because this file was written.
    """
    import zip_serialise

    target = resolve_character(character)
    resolved = resolve_set(target, working_set)
    payload = (
        character_archive.read_set_payload(target.id, resolved.id or "")
        if not resolved.is_live
        else None
    )
    if payload is None:
        live = character_archive.read_live(target.id)
        if live is None:
            raise ToolError(
                "live_not_found",
                f"Nothing to export for {target.name} — pull the "
                "character or create a working set first.",
            )
        from services import payload_ops

        payload = payload_ops.seed_from_live(live)

    data = zip_serialise.build_zip(
        target.id,
        payload,
        images_dir=character_archive.images_dir(target.id),
        avatar_path=character_archive.avatar_path_for(target.name),
    )
    written = _write_file(path, data, suffix=".zip")
    audit("export_restore_zip", character=target.name, path=str(written))
    return {
        "character": target.name,
        "set": resolved.name,
        "path": str(written),
        "bytes": len(data),
        "next_step": (
            "The user uploads this in their browser — f-list.net with "
            "the FlistCharExporter userscript, or the paired Workbench "
            "extension. Workbench cannot do it for them."
        ),
    }


def _write_file(path: str, data: bytes, *, suffix: str) -> Path:
    """Write bytes to a user-chosen path, creating parent directories.

    A directory path gets a generated filename rather than an error —
    "put it in Downloads" is a reasonable thing for a user to say.
    """
    target = Path(str(path)).expanduser()
    if target.is_dir():
        target = target / f"workbench-{int(time.time())}{suffix}"
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    except OSError as exc:
        raise ToolError(
            "write_failed", f"Couldn't write {target}: {exc}"
        ) from exc
    return target


@tool(tags=TAG_CORE, title="Extension pairing status", read_only=True)
def get_extension_pairing_status() -> dict[str, Any]:
    """Whether the browser extension is paired with this Workbench.

    The extension is one of the two ways the user uploads a profile to
    F-list. Pairing is accepted by the user in the Workbench window and
    cannot be done from here.
    """
    import restore as restore_svc

    # `auth_token_valid` is the only public read of the pairing state;
    # an obviously-wrong token answers the question "is anything
    # paired at all" without exposing the real one.
    paired = restore_svc._STATE.accepted_token is not None
    return {
        "paired": paired,
        "note": (
            "The extension can fetch backups from this Workbench and "
            "restore them to F-list."
            if paired
            else "Not paired. The user pairs it from the extension; "
            "Workbench then shows an accept prompt. That has to be a "
            "human action."
        ),
    }


# --------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------


@tool(tags=TAG_CORE, title="Settings", read_only=True)
def get_settings() -> dict[str, Any]:
    """Workbench's settings: the F-Chat log directory, the IC/OOC rule
    threshold, the embedding model and the retrieval tuning.
    """
    import logs as log_store
    import rag as rag_settings
    import labels as labels_store

    rag = rag_settings.load_settings()
    labels = labels_store.load_settings()
    return {
        "log_directory": str(log_store.data_dir()),
        "labels": {"ooc_threshold_chars": labels.threshold_chars},
        "embedding": {
            "model": rag.embed_model,
            "runs": "in-process (no server to configure)",
        },
        "retrieval": {
            "top_k": rag.top_k,
            "neighbors": rag.neighbors,
            "rerank_model": rag.rerank_model,
            "rerank_candidates": rag.rerank_candidates,
            "rerank_min_ratio": rag.rerank_min_ratio,
            "hybrid_enabled": rag.hybrid_enabled,
        },
        "chunking": {
            "max_chars": rag.chunk_max_chars,
            "soft_split_chars": rag.chunk_soft_split_chars,
            "overlap_messages": rag.chunk_overlap_msgs,
        },
    }


@tool(tags=TAG_CORE, title="Change settings")
def update_settings(
    ooc_threshold_chars: int | None = None,
    embed_model: str | None = None,
    top_k: int | None = None,
    neighbors: int | None = None,
    rerank_model: str | None = None,
    hybrid_enabled: bool | None = None,
) -> dict[str, Any]:
    """Change Workbench settings. Omitted values are left alone.

    The embedding API key is deliberately not settable here — a secret
    should be typed into Settings, not passed through a tool call that
    ends up in a transcript. Changing `embed_model` invalidates the
    search index: it was built with the old model's vectors.
    """
    import rag as rag_settings
    import settings as settings_store

    conn = settings_store.connect()
    changed: dict[str, Any] = {}
    try:
        if ooc_threshold_chars is not None:
            value = max(1, int(ooc_threshold_chars))
            settings_store.set_value(
                conn, settings_store.KEY_LABELS_THRESHOLD_CHARS, str(value)
            )
            changed["ooc_threshold_chars"] = value
        if embed_model is not None:
            settings_store.set_value(
                conn, settings_store.KEY_RAG_EMBED_MODEL, str(embed_model)
            )
            changed["embed_model"] = embed_model
        if top_k is not None:
            value = max(1, min(50, int(top_k)))
            settings_store.set_value(conn, settings_store.KEY_RAG_TOP_K, str(value))
            changed["top_k"] = value
        if neighbors is not None:
            value = max(0, min(5, int(neighbors)))
            settings_store.set_value(
                conn, settings_store.KEY_RAG_NEIGHBORS, str(value)
            )
            changed["neighbors"] = value
        if rerank_model is not None:
            settings_store.set_value(
                conn, settings_store.KEY_RAG_RERANK_MODEL, str(rerank_model)
            )
            changed["rerank_model"] = rerank_model
        if hybrid_enabled is not None:
            settings_store.set_value(
                conn,
                settings_store.KEY_RAG_HYBRID_ENABLED,
                "1" if hybrid_enabled else "0",
            )
            changed["hybrid_enabled"] = bool(hybrid_enabled)
    finally:
        conn.close()

    if not changed:
        raise ToolError("validation_failed", "nothing to change")

    audit("update_settings", **changed)
    out: dict[str, Any] = {"changed": changed}
    if "embed_model" in changed:
        out["warning"] = (
            "The search index was built with the previous model's "
            "vectors and can't be searched with this one. Run "
            "wipe_search_index then ingest_logs."
        )
    del rag_settings  # imported for the settings-key names only
    return out


# --------------------------------------------------------------------
# Aliases
# --------------------------------------------------------------------


@tool(tags=TAG_LOGS, title="Link a renamed partner")
def add_alias(character: str, name: str, primary_name: str) -> dict[str, Any]:
    """Record that two partner names are the same person.

    F-Chat starts a new log file when someone renames mid-roleplay.
    Linking merges the conversations everywhere: the log viewer, label
    lookups, and the scope of a semantic search.
    """
    import aliases as aliases_store
    import labels as labels_store

    conn = labels_store.connect()
    try:
        aliases_store.add_alias(conn, character, name, primary_name)
        group = aliases_store.all_names_for(conn, character, primary_name)
    except ValueError as exc:
        raise ToolError("validation_failed", str(exc)) from exc
    finally:
        conn.close()
    audit("add_alias", character=character, name=name, primary=primary_name)
    return {"character": character, "primary": primary_name, "group": group}


@tool(tags=TAG_LOGS, title="Unlink a partner name", destructive=True)
def remove_alias(character: str, name: str) -> dict[str, Any]:
    """Undo add_alias for one name, so it shows as its own conversation
    again."""
    import aliases as aliases_store
    import labels as labels_store

    conn = labels_store.connect()
    try:
        removed = aliases_store.remove_alias(conn, character, name)
    finally:
        conn.close()
    audit("remove_alias", character=character, name=name)
    return {"character": character, "name": name, "removed": bool(removed)}
