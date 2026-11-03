# Cleanup plan (October 2026 review)

The outcome of an architecture review against the current product: one
Workbench per character, Backups as the only saved copies, the app never
writing to F-list or to F-Chat's Logs. Terms follow `GLOSSARY.md`;
decisions with lasting weight are in `docs/adr/`. Steps are ordered: each
one makes the next smaller or safer.

Tracking: #9 (test foundation) blocks everything. Step 1 shipped in
0.2.16 (advisory GHSA-874j-wj3f-f47j, published); steps
2–7 are issues #2 (data loss), #3 (one Workbench), #4 (write safety and
layering), #5 (Labels, Index, Foreign profiles), #6 (MCP and docs),
#7 (undo and merge), #8 (renderer store). The privacy items listed under
step 1 below moved to #5 (Foreign purge, import exclusion) and #6 (Log
tools opt-in); the advisory covers only access control.

Invariants every step must keep:

- A Log is never written, moved or deleted. (Verified: the sidecar only
  reads the F-Chat directory.)
- Every deleted file stays recoverable from the Trash or a Backup; only a
  human empties the Trash, and never over MCP.
- Nothing is uploaded to F-list without a human pressing Save there.

## 1. Lock down local access (ADR 0002)

The access-control items below are done in 0.2.16, with one change: the
secret reaches the window's requests through Electron's `webRequest`,
not the preload. ADR 0002 describes what shipped.

- Per-launch secret from Electron to sidecar (env) and renderer
  (preload); required on every REST route.
- `/restore/*` accepts only the pairing token; handshake accept moves
  behind the app secret.
- Host check on every route, not only `/mcp`.
- Replace `allow_origins=["*"]` (`sidecar/server.py:109-116`) with the
  renderer origin plus `https://www.f-list.net` for `/restore/*`.
- Validate `character_id` everywhere; `character_dir` must not fall back
  to `root()/cid` with an unchecked id (`character_archive.py:344-356`);
  backup payload route skips the filename regex (`server.py:807`).
- `read-file` / `write-file` IPC accept any absolute path
  (`electron/main.ts:156-190`); `select-directory` lacks a sender check.
- MCP tools that return Log text (partner lines included) are off by
  default; Settings → MCP turns them on with a plain note that a cloud
  model's provider receives that text. Fix the "nothing is sent
  anywhere" claim (`tools_logs.py:3-4`).
- A Foreign profile that F-list reports deleted, private or blocked is
  dropped from the cache at once; a stale copy is served only on network
  or server errors (`services/foreign.py:264-277`).
- Image import never reads from the app's own data folder, whatever
  parent folder is allowed (`services/image_import.py:130`).

## 2. Data-loss bugs

- Close-time flush PUTs to legacy `/working` (`AppLayout.tsx:116-154`),
  whose file the next migration deletes (`character_archive.py:1338-1345`);
  and `before-quit` stops the sidecar first (`main.ts:748-765`). Flush the
  Workbench through the normal save path, and stop the sidecar only after
  the window has flushed.
- `GET /export.zip` reads legacy `working.json` and falls back to Live
  (`server.py:1565`) while the modal shows Workbench counts.
- `flistOpenWorking` does not re-check the active character after its
  awaits (`state.ts:2188-2318`); A's description can land in B's
  Workbench. The unsaved-edits check also runs before the read.
- Pre-upload Backups are named `pre-restore-…` (`restore.py:464-465`),
  which `_ZIP_BACKUP_FILE_RE` (`character_archive.py:751`) rejects: they
  exist but are invisible everywhere.
- Hard deletes to route through the Trash: Backup delete
  (`server.py:705-729`), same-id image with a stale extension on Pull and
  Backup-all (`pull.py:213`, `backup_all.py:116`), stale-image removal in
  repair (`character_archive.py:2472`). MCP export refuses to overwrite
  (`tools_ops.py:547-563`).
- `clear_labels` requires `confirm` and moves the cleared Labels to the
  Trash first.
- `flistUndoResetWorking` writes against the current etag and can revert
  a model's edit made in the meantime (`state.ts:4232`).
- The portable build runs the updater (`main.ts:509-605`), downloads the
  setup, installs it silently elsewhere and stays old (ADR 0005). Gate
  the updater on `PORTABLE_EXECUTABLE_DIR`; portable only links to the
  release. Drop `autoInstallOnAppQuit` for portable.
- The Index goes stale: re-ingest skips by chunk id
  (`rag_jobs.py:417-418`), so appended messages and later Labels never
  arrive and flipped or cleared Labels stay searchable. Reconcile per
  day: recompute a day's chunks, delete stale ids, upsert new; a Label
  change marks its day dirty. Fix the tool hints that say "run
  ingest_logs" (`tools_classify.py:378-380, 502`).
- `rebuild=true` scoped to one character wipes every character's Index
  (`rag_jobs.py:297-303`); `ingest_logs` skips `resolve_conversation`.

## 3. One Workbench on disk; remove the legacy (ADR 0001)

- One-time migration: chosen set → `workbench/`; every other set and all
  snapshots → one migration Backup. Then delete `active_set.json` handling
  and `resolve_workbench()`'s heuristic.
- Remove (~2,150 production lines, ~1,700 test lines): `/working` and
  `/sets*` routes, snapshot routes, `set_bundle.py`, multi-set ops,
  snapshot writes on Pull, scheduled backups and their pruning
  (`maybe_run_scheduled_backup`), `documents.db` migration, set
  addressing in MCP.
- Renderer: `flistCreateSet/Rename/Duplicate/Delete/Activate`,
  `flistCreateSetFromBackup`, the dead second save pipeline
  (`state.ts:806-850, 3594-3730`), `flistSetWorking*`/`flistSets*`,
  bundle import/export and `CrossCharacterImportModal`,
  `working-sets/NameDialog.tsx`, orphaned `flistSaveSnapshot`,
  `flistOpenBackup`, `flistOpenExportRestore`, unused api.ts calls.
- Diff compares Workbench ↔ Live, optionally ↔ a Backup; `BackupPicker`
  lists real Backups instead of snapshots.
- Backups record their source (Live or Workbench) and occasion (manual,
  before upload, before restore, migration). Backup-all and pre-upload
  back up Live; a manual Backup holds the Workbench.
- Restore, reset to Live and `load_backup_into_workbench` back up the
  Workbench first (ADR 0003).
- Pull's dedup and `image_import.references` read snapshots; rewire.
- Delete tests that assert `working.json` deletion
  (`test_working_sets_v2_api.py:468`, `test_working_sets_v2_storage.py:109`).

## 4. Write safety and backend layering

- Per-character lock around every read-modify-write; etag required for
  every writer, internal ones included; unique temp name + fsync +
  `os.replace` for JSON and zips (`character_archive.py:573-602, 1050`).
- Move blocking work off the event loop: `search_logs_semantic`, zip
  builds, gallery hashing (`tools_rag.py:20`, `server.py:629, 1460, 1553`).
- One job per resource (Qdrant folder lock, `rag_jobs.py:454`); Pull and
  Backup-all become jobs instead of running inside the SSE generator
  (`server.py:604, 859`).
- Routes and tools become adapters; logic in `services/`. New
  `services/labels` (SQL now in `server.py` ~2006-2560 and
  `tools_classify.py`), `services/settings` (validation in `server.py`
  2855-2980 and `tools_ops.py` 637-715); Backup-all reuses Pull's image
  loop.
- Split `server.py` into routers; split `character_archive.py` into
  Workbench / Live / Backups / images after step 3.
- One error shape `{code, message, details}`; fix the nested detail
  (`server.py:922`) and 410-vs-409 for the same case (`696` vs `1051`).
- Emit `SETTINGS_CHANGED` and `INDEX_CHANGED`; the renderer handles them.
- Electron: check the sidecar version on `/health` (`sidecar.ts:225`),
  handle a taken port, restart the sidecar after a crash.
- Sidecar built `--onedir` (ADR 0005); stop it with `/shutdown` and the
  launch secret, `taskkill /F` only after a timeout (`sidecar.ts:172`);
  clean orphaned `_MEI*` folders once.
- SQLite: `user_version` migrations, WAL and `busy_timeout` for
  `labels.db` and `settings.db` (`labels.py:437-439`).

## 4b. Labels, Index, Foreign profiles

- Labels keyed by message hash only, no stored owner (ADR 0004);
  conversation membership from the Log; fixes the cross-character
  overwrite (`labels.py:686-693`), hash-only deletes (`773, 917`) and
  alias detach (`aliases.py:192-224`).
- Manual Labels are never overwritten over MCP; the tool reports the
  skipped hashes (`tools_classify.py:313-328`, `upsert_label`).
- System lines (ads, rolls, events) get no Label, are not counted as
  Unlabeled and are not sent to a model (`classification.py:152-160`).
  The short-message rule stays as it is, `/me` included.
- Retrieval: return the fused rank and rerank score instead of the dense
  cosine (`rag_query.py:173`, `retrieval.py:206`); keep relevance order
  after neighbour expansion (`rag_query.py:92-100`); a failed FTS write
  is an error, not swallowed (`rag_jobs.py:446-450`).
- Foreign cache: size-capped, 1 GB by default and configurable in
  Settings; when a new profile or a refresh no longer fits, the least
  recently viewed entry goes, images included. No time-based deletion.
  Refresh drops images that left the gallery; avatar refetched with
  the profile.
- Foreign errors: a spent MCP budget returns `rate_limited`
  (`foreign.py:253`); offline or timeout serves the cached copy instead
  of a 500 (`flist_api.py:455-457`); a 5xx is not "no such character"
  (`state.ts:4855`). `foreignLoad` gets a request token (`state.ts:4833`).
- Share the editor's kink and field components instead of the copied
  JSX in `foreignPanes.tsx`; drop the unused `foreignLeaveSlot`.
- The log-name sweep runs off the event loop (`foreign.py:210`).

## 5. MCP surface and docs

- Drop set tools, bundles, `explain_set_addressing`, `list_snapshots`;
  `get_working_set` → `get_workbench` (Live by parameter); drop `set_kink`,
  `append_description`, `import_image`, `search_all_partners`; fold
  `test_embedding_connection` into `get_rag_status`. No aliases.
- Rename internal "restore" code to "upload" (`restore.py` → `upload.py`,
  `export_restore_zip` → `export_upload_zip`); HTTP `/restore/*` stays
  until the next extension release adds `/upload/*`.
- One job model for every long tool (`wait=false`, `get_job`,
  `cancel_job`), including `pull_character` and `backup_all_characters`.
- Make `destructive` and `confirm` agree (`_registry.py:11-12`): every
  destructive tool takes `confirm`, and the flag is checked.
- Rewrite server instructions (`workbench_mcp/__init__.py:70-72`) and
  every hint that says "create a working set".
- Docs: `OVERVIEW.md` (Stack table still lists an embeddings endpoint;
  working-set and snapshot sections), `MCP.md` (tool counts, working
  sets, embedding key), `MCP_DESIGN.md` (tools that never existed).
  Extension UI: drop the Live source; label "Import from Workbench" as
  Upload.
- `OVERVIEW.md` on Foreign profiles: cached until the size cap evicts
  them, not "nothing is remembered"; the activity log records which
  profiles a model fetched. `INSTALL_WINDOWS.md`: installer is primary,
  portable unpacks ~350 MB per start and does not auto-update, releases
  are unsigned. `rag_rerank.py:18` names the wrong model folder.
- Delete the local build script (wrong branch and artifact name); CI is the
  build path. Move react/codemirror to devDependencies; exclude pytest
  from the sidecar bundle. Remove old model weights when the model
  changes.

## 6. Undo and merge (ADR 0003)

- One Workbench-level undo stack per character in the window; every
  change is an entry, a model's tagged `MCP: <tool>`; Ctrl+Z works on
  every tab; replaces the three 5-second toasts.
- Reloads from external changes enter the stack instead of CodeMirror's
  own history (`addToHistory.of(false)`).
- Field-level merge on conflict via `_overlay`; ask only when both sides
  changed the same field. Description is one field.

## 7. Frontend structure

- Split `state.ts` into Workbench, Logs, Settings and UI slices plus an
  undo module; the description lives only in the payload; one slot
  cache.
- Generate API types from FastAPI's OpenAPI schema; route every call
  through `request()` (12 raw `fetch` calls today); match conflicts by
  error code, not message text.
- Pull api calls out of `SettingsModal` panes; one `BUCKET_ORDER`.
- Tests for close-time flush, event subscription, undo, the
  open-character race, concurrent REST + MCP writes, the migration.
