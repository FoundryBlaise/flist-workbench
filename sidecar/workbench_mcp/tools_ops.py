"""Long-running and file-touching operations (design §3.8, §3.10, §3.11).

Pulling from F-list, backing up, ingesting logs, writing the file the
user uploads, and the settings the rest of it reads.

Three things run long enough to need progress: a pull walks a
character's whole image set, the backup sweep pulls every character on
the account, and an ingest embeds Logs. All three run as jobs
(`services.jobs`): waiting, they report through
`Context.report_progress` so a client can show something moving; with
`wait=false` they answer a job id, the same answer for each, for
`get_job` and `cancel_job`, which every endpoint carrying one of them
carries too. A pull and the sweep are bounded by F-list's rate limit
rather than by anything here.

On file paths: the export tool writes wherever the user running the app
can. That is the same reach the app already has through its own file
dialogs, and narrowing it would mean a model couldn't put the file
where the user asked for it.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

import archive_backups
import archive_images
import archive_registry
import archive_workbench
import atomic_write
import backup_origin
from mcp.server.fastmcp import Context
from refusals import INTERNAL_ERROR

from services import jobs

from ._context import (
    WORKBENCH,
    ToolError,
    audit,
    resolve_character,
    resolve_ingest_scope,
    resolve_workbench_or_live,
)
from ._registry import TAG_CHARACTER, TAG_CLASSIFY, TAG_CORE, TAG_LOGS, tool

#: How long a tool will sit waiting on a job before handing the caller
#: a job id to poll instead. Ten minutes covers any realistic single
#: pull; a full-corpus ingest can run far longer.
WAIT_BUDGET_SEC = 600


# --------------------------------------------------------------------
# F-list
# --------------------------------------------------------------------


def _job_failure(job: jobs.Job, fallback: str) -> ToolError:
    """A failed job's error as the tool's error: the job's code and
    details (`services.sse.error`), a Pull's `stage` among them."""
    error = job.error or {}
    code = str(error.get("code") or INTERNAL_ERROR)
    message = str(error.get("message") or fallback)
    if code == "not_signed_in":
        message += " The user signs in inside the app window (F-list → Sign in)."
    elif code == "embedding_failed":
        message += (
            " get_rag_status with check_embedding=true shows whether the "
            "model loads on its own."
        )
    return ToolError(code, message, **(error.get("details") or {}))


def _job_answer(job: jobs.Job, note: str) -> dict[str, Any]:
    return {"job_id": job.id, "kind": job.kind, "state": job.state, "note": note}


def _started(job: jobs.Job) -> dict[str, Any]:
    """The answer of a tool asked not to wait (or done waiting)."""
    return _job_answer(
        job,
        "Running in the background. Poll get_job for progress and the "
        "result; cancel_job stops it.",
    )


async def _follow(job: jobs.Job, on_event: Any) -> bool:
    """Follow a job's events into `on_event(event, data)` until it ends.
    False when it still runs after WAIT_BUDGET_SEC: the caller answers
    with the job id then. Leaving early never stops the job."""
    try:
        async with asyncio.timeout(WAIT_BUDGET_SEC):
            async for event, data in jobs.follow(job):
                await on_event(event, data)
    except TimeoutError:
        return False
    return True


def _cancelled(job: jobs.Job) -> dict[str, Any]:
    return _job_answer(job, "Cancelled. What it wrote before the cancel stays.")


@tool(tags=TAG_CHARACTER, title="Pull from F-list", open_world=True)
async def pull_character(character: str, ctx: Context, wait: bool = True) -> dict[str, Any]:
    """Fetch a character's current profile and images from F-list into
    the local archive.

    This is a *download*. It refreshes `live` — the record of what is
    published — and leaves the Workbench alone. `changed` says whether
    the profile on F-list differed from the stored Live. Needs the user to be
    signed in, which happens in the app window; there is no
    sign-in tool, because credentials never travel through MCP.

    Takes a while: F-list is rate-limited to one request a second and
    every gallery image is a request. `wait=false` returns a job id at
    once, to poll with get_job (or stop with cancel_job). One Pull per
    character at a time: another is refused `character_busy`.
    """
    from services import pull as pull_service

    name = str(character).strip()
    if not name:
        raise ToolError("validation_failed", "character is empty")

    job = pull_service.start(name)
    audit("pull_character", character=name, job=job.id)
    if not wait:
        return _started(job)

    images_total = 0

    async def report(event: str, data: dict[str, Any]) -> None:
        nonlocal images_total
        if event == pull_service.IMAGES:
            images_total = int(data.get("total") or 0)
            await ctx.report_progress(0, images_total or None, "downloading images")
        elif event == pull_service.IMAGE:
            await ctx.report_progress(
                int(data.get("index") or 0),
                images_total or None,
                f"image {data.get('index')}/{images_total}",
            )
        elif event == pull_service.FETCHING:
            await ctx.info(f"fetching {name} from F-list")

    if not await _follow(job, report):
        return _started(job)
    if job.state == "cancelled":
        return _cancelled(job)
    if job.state == "failed":
        raise _job_failure(job, "pull failed")
    summary = job.result
    if summary is None:
        raise ToolError("pull_failed", "the pull ended without a result")

    return {
        "character": name,
        "character_id": summary.get("character_id"),
        "images": summary.get("image_count"),
        "changed": summary.get("changed"),
        "job_id": job.id,
        "note": (
            "This updated the local copy of what is published. Edits "
            "live in the Workbench and were not touched."
        ),
    }


@tool(tags=TAG_CHARACTER, title="Back up a character")
def create_backup(
    character: str, note: str | None = None, force: bool = True
) -> dict[str, Any]:
    """Write a Backup of a character's Workbench, the user's edits, as
    a ZIP including its images and avatar.

    It is recorded as `source: workbench, occasion: manual`.
    Backups are what `load_backup_into_workbench` restores from, and
    what the user can upload through the browser extension.
    `force=false` skips the write when the newest Backup of the
    Workbench already holds the same content.
    """
    target = resolve_character(character)
    result = archive_backups.save_zip_backup(
        target.id,
        source=backup_origin.WORKBENCH,
        occasion=backup_origin.MANUAL,
        force=force,
    )
    # A skip comes back as `{saved: False, reason: ...}` rather than an
    # exception. "no_live" is a real failure — there is nothing to pack
    # — while "unchanged" is the deduplication doing its job.
    if not result.get("saved"):
        if result.get("reason") == "no_live":
            raise ToolError(
                "no_live",
                f"No profile stored for {target.name}, so there is "
                "nothing to back up. Pull the character first — its "
                "Workbench starts from what was last fetched from F-list.",
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
            archive_backups.rename_zip_backup(target.id, filename, str(note))
    audit("create_backup", character=target.name, filename=result.get("filename"))
    return {"character": target.name, **result}


@tool(tags=TAG_CHARACTER, title="Back up every character", open_world=True)
async def backup_all_characters(ctx: Context, wait: bool = True) -> dict[str, Any]:
    """Pull every character on the signed-in account and keep each one's
    Live, what F-list shows, as a Backup (`source: live, occasion:
    backup-all`). Workbenches are neither read nor changed.

    Long: each character is a full pull, one at a time, at F-list's
    rate limit. Characters whose Live hasn't changed since their last
    Backup of Live are skipped rather than re-zipped. Tell the user this
    will take a few minutes on a large account before starting it, or
    pass `wait=false` for a job id to poll with get_job (cancel_job
    stops it). Refused `character_busy` while a Pull runs.
    """
    from services import backup_all as backup_all_service

    job = backup_all_service.start()
    audit("backup_all_characters", job=job.id)
    if not wait:
        return _started(job)

    total = 0
    rows: list[dict[str, Any]] = []

    async def report(event: str, data: dict[str, Any]) -> None:
        nonlocal total
        if event == backup_all_service.START:
            total = int(data.get("total") or 0)
            await ctx.report_progress(0, total or None, "starting")
        elif event == backup_all_service.CHARACTER and data.get("status") in ("saved", "unchanged", "error"):
            rows.append(
                {
                    "character": data.get("name"),
                    "status": data.get("status"),
                    "filename": data.get("filename"),
                    "message": data.get("message"),
                }
            )
            await ctx.report_progress(len(rows), total or None, str(data.get("name") or ""))

    if not await _follow(job, report):
        return _started(job)
    if job.state == "cancelled":
        return {**_cancelled(job), "characters": rows}
    if job.state == "failed":
        raise _job_failure(job, "the sweep failed")
    summary = {k: v for k, v in (job.result or {}).items() if k != "characters"}
    return {"summary": summary, "characters": rows, "job_id": job.id}


# --------------------------------------------------------------------
# Ingest
# --------------------------------------------------------------------


@tool(tags=(TAG_LOGS, TAG_CLASSIFY), title="Index logs for search")
async def ingest_logs(
    ctx: Context,
    character: str | None = None,
    partner: str | None = None,
    include_ooc: bool = False,
    include_channels: bool = False,
    rebuild: bool = False,
    wait: bool = True,
) -> dict[str, Any]:
    """Chunk and embed Logs so search_logs_semantic can find them.

    Only messages with an IC or OOC Label are indexed;
    `skipped_unlabeled` counts the rest, and a high number means
    get_messages_to_classify should run first. OOC is left out: pass
    include_ooc=true on every ingest to keep OOC chunks.
    Channel Logs are left out unless `include_channels=true`, as in
    list_partners: group chat buries a character's roleplay.

    Re-running it brings new messages and Label changes to search: only
    conversation days whose messages or Labels changed are embedded
    again (`chunks_already_present` counts the rest), and chunks no
    longer labelled for the Index are deleted (`chunks_removed`).
    `rebuild=true` first deletes the scope's chunks (all of them when
    unscoped; a character's channel chunks only with include_channels).

    Embedding runs in-process. `wait=false` returns a job id at once,
    for get_job and cancel_job. One ingest at a time: another is
    refused `index_busy`.
    """
    # Resolve to the on-disk spelling like every other conversation
    # tool: the Labels and alias links are keyed on it, so a different
    # case or an alias would otherwise index nothing and report done.
    scope: dict[str, Any] = resolve_ingest_scope(character, partner)
    if include_channels:
        scope["include_channels"] = True

    from services import index as index_service

    job = index_service.start_ingest(scope, include_ooc=include_ooc, force_rewipe=rebuild)
    audit(
        "ingest_logs",
        character=scope.get("character"),
        partner=scope.get("partner"),
        job=job.id,
    )
    if not wait:
        return _started(job)

    started = time.monotonic()
    last_reported = -1
    while not job.finished:
        progress = job.progress
        if progress.embedded != last_reported:
            await ctx.report_progress(
                progress.embedded,
                progress.total_chunks or None,
                progress.current_partner or "indexing",
            )
            last_reported = progress.embedded
        if time.monotonic() - started > WAIT_BUDGET_SEC:
            return _started(job)
        await asyncio.sleep(0.5)
    if job.state == "failed":
        raise _job_failure(job, "the ingest failed")
    return _ingest_summary(job.to_dict())


def _ingest_summary(job: dict[str, Any]) -> dict[str, Any]:
    out = {
        "job_id": job["id"],
        "state": job["state"],
        **(job["result"] or {}),
        "last_error": job["progress"].get("last_error"),
    }
    if out.get("skipped_unlabeled"):
        out["note"] = (
            f"{out['skipped_unlabeled']} message(s) were skipped for "
            "having no IC/OOC verdict — they aren't searchable. Run the "
            "classification flow (get_messages_to_classify) and ingest "
            "again to include them."
        )
    return out


@tool(
    tags=(TAG_CORE, TAG_LOGS, TAG_CLASSIFY),
    title="Job status",
    read_only=True,
)
def get_job(job_id: str) -> dict[str, Any]:
    """Progress of a job started with wait=false, of any kind: `state`,
    `progress`, `result` once done, `error` ({code, message, details})
    if it failed. Jobs are kept in memory, so an id from before a
    restart is `job_not_found`."""
    from services import jobs

    return jobs.registry().get(job_id).to_dict()


@tool(tags=(TAG_CORE, TAG_LOGS, TAG_CLASSIFY), title="Cancel a job")
def cancel_job(job_id: str) -> dict[str, Any]:
    """Stop a running job of any kind at its next safe point; what it
    already wrote stays. get_job shows it end."""
    from services import jobs

    job = jobs.registry().cancel(job_id)
    audit("cancel_job", job=job_id)
    return job.to_dict()


@tool(
    tags=TAG_LOGS,
    title="Wipe the search index",
    destructive=True,
    warning=(
        "This deletes the whole search index. Re-indexing means "
        "re-embedding every message, which takes a while."
    ),
)
def wipe_search_index(confirm: bool = False) -> dict[str, Any]:
    """Delete every indexed chunk. The logs and their labels are
    untouched; only the search index goes.

    Needed when switching embedding models — an index built with one
    model can't be searched with another. Refused with `index_busy`
    while an ingest runs.
    """
    from services import index as index_service

    index_service.wipe()
    audit("wipe_search_index")
    return {"wiped": True, "note": "Run ingest_logs to rebuild."}


# --------------------------------------------------------------------
# Exports
# --------------------------------------------------------------------


@tool(tags=TAG_CHARACTER, title="Export for upload to F-list")
def export_restore_zip(
    character: str, path: str, source: str = WORKBENCH
) -> dict[str, Any]:
    """Save the ZIP the user uploads to F-list themselves.

    This is the hand-off point. The app does not publish anything:
    the user opens f-list.net in their browser and uploads this file
    with the FlistCharExporter userscript or the paired extension.
    Never tell them a profile is live because this file was written.
    """
    import zip_serialise

    target = resolve_character(character)
    resolved = resolve_workbench_or_live(target, source)
    # Payload and images in one step under the character's lock, as the
    # window's export does.
    with archive_registry.character_lock(target.id):
        payload = archive_workbench.export_payload(
            target.id, from_live=resolved.is_live
        )
        if payload is None:
            raise ToolError(
                "no_live",
                f"Nothing to export for {target.name} — pull the character first.",
            )

        data = zip_serialise.build_zip(
            target.id,
            payload,
            images_dir=archive_images.images_dir(target.id),
            avatar_path=archive_images.avatar_path_for(target.name),
        )
    written = _write_file(path, data, suffix=".zip")
    audit("export_restore_zip", character=target.name, path=str(written))
    return {
        "character": target.name,
        "path": str(written),
        "bytes": len(data),
        "next_step": (
            "The user uploads this in their browser — f-list.net with "
            "the FlistCharExporter userscript, or the paired Workbench "
            "extension. The app cannot do it for them."
        ),
    }


def _write_file(path: str, data: bytes, *, suffix: str) -> Path:
    """Write bytes to a user-chosen path, creating parent directories.

    A directory path gets a generated filename rather than an error —
    "put it in Downloads" is a reasonable thing for a user to say. If
    that name is taken, a numbered one beside it is used instead.

    An existing file is never overwritten: the name is claimed in the
    same step that places the bytes, so a model can't clobber something
    the user keeps there, even if it appears between a check and the
    write. A file path that is taken gets an `exists` refusal.
    """
    target = Path(str(path)).expanduser()
    if target.is_dir():
        stem = f"workbench-{int(time.time())}"
        candidates = [target / f"{stem}{suffix}"] + [
            target / f"{stem}-{n}{suffix}" for n in range(2, _MAX_NAME_TRIES + 1)
        ]
    else:
        candidates = [target]

    try:
        return atomic_write.write_new(candidates, data)
    except FileExistsError:
        raise ToolError(
            "exists",
            f"{candidates[0]} already exists and an export never overwrites "
            "a file. Ask the user for another name, or give a folder to get "
            "a fresh file name.",
        ) from None
    except OSError as exc:
        raise ToolError(
            "write_failed", f"Couldn't write {candidates[0]}: {exc}"
        ) from exc


#: How many numbered names an export into a folder tries before giving
#: up with an `exists` refusal.
_MAX_NAME_TRIES = 100


@tool(tags=TAG_CORE, title="Extension pairing status", read_only=True)
def get_extension_pairing_status() -> dict[str, Any]:
    """Whether the browser extension is paired with this Workbench.

    The extension is one of the two ways the user uploads a profile to
    F-list. Pairing is accepted by the user in the app window and
    cannot be done from here.
    """
    import restore as restore_svc

    paired = restore_svc.is_paired()
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
    threshold, the embedding model and the retrieval tuning, and the
    folders `import_images` may read from (which only the user can
    change, in Settings → Security).
    """
    import logs as log_store
    import rag as rag_settings
    import labels as labels_store
    from services import image_import

    rag = rag_settings.load_settings()
    labels = labels_store.load_settings()
    return {
        "log_directory": str(log_store.data_dir()),
        "image_import_folders": [str(p) for p in image_import.import_roots()],
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

    Numbers out of range are clamped; `changed` reports what was
    stored. An empty model name resets it to the default. The window
    shows the change at once. Changing `embed_model` invalidates the
    search index: it was built with the old model's vectors.
    """
    from services import settings as settings_service

    given = {
        "ooc_threshold_chars": ooc_threshold_chars,
        "embed_model": embed_model,
        "top_k": top_k,
        "neighbors": neighbors,
        "rerank_model": rerank_model,
        "hybrid_enabled": hybrid_enabled,
    }
    given = {param: value for param, value in given.items() if value is not None}
    if not given:
        raise ToolError("validation_failed", "nothing to change")

    stored = settings_service.update(
        {_SETTINGS_FIELDS[param]: value for param, value in given.items()}
    )
    changed = {param: stored[_SETTINGS_FIELDS[param]] for param in given}
    audit("update_settings", **changed)
    out: dict[str, Any] = {"changed": changed}
    if "embed_model" in changed:
        out["warning"] = (
            "The search index was built with the previous model's "
            "vectors and can't be searched with this one. Run "
            "wipe_search_index then ingest_logs."
        )
    return out


#: `update_settings` parameters -> the settings service's field names.
_SETTINGS_FIELDS = {
    "ooc_threshold_chars": "labels.threshold_chars",
    "embed_model": "rag.embed_model",
    "top_k": "rag.top_k",
    "neighbors": "rag.neighbors",
    "rerank_model": "rag.rerank_model",
    "hybrid_enabled": "rag.hybrid_enabled",
}


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

    conn = aliases_store.connect()
    try:
        aliases_store.add_alias(conn, character, name, primary_name)
        group = aliases_store.all_names_for(conn, character, primary_name)
    except ValueError as exc:
        raise ToolError("validation_failed", str(exc)) from exc
    finally:
        conn.close()
    audit("add_alias", character=character, name=name, primary=primary_name)
    return {"character": character, "primary": primary_name, "group": group}


@tool(
    tags=TAG_LOGS,
    title="Unlink a partner name",
    destructive=True,
    warning=(
        "Unlinking splits the name's conversation off again; only "
        "add_alias brings it back."
    ),
)
def remove_alias(character: str, name: str, confirm: bool = False) -> dict[str, Any]:
    """Undo add_alias for one name, so it shows as its own conversation
    again. Needs `confirm=true`."""
    import aliases as aliases_store

    conn = aliases_store.connect()
    try:
        removed = aliases_store.remove_alias(conn, character, name)
    finally:
        conn.close()
    audit("remove_alias", character=character, name=name)
    return {"character": character, "name": name, "removed": bool(removed)}
