# MCP server — replacing the in-app AI

Status: **v3, 2026-09-11 — owner-approved.** Decisions D1–D4, D7–D10
settled (see §8); D5, D6 deferred.
**No code has landed. Do not start implementation until the owner
says so.**

Goal: every action the Workbench UI can perform becomes reachable for
an LLM client (LM Studio primarily, Claude Code for debugging, Claude
Desktop, Ollama-backed front-ends) through one local **Model Context
Protocol** server. **Workbench itself stops calling any LLM.** The
connected model does the talking *and* the IC/OOC classification. What
stays in-app is data plumbing only:

- log **ingest** into the vector index — needs an **embedding
  endpoint** (LM Studio / Ollama / OpenAI-compatible), the one external
  model dependency that remains;
- the **reranker** — a local ONNX cross-encoder, no endpoint,
  switchable off;
- the **label store** (IC/OOC verdicts, rules, manual overrides) —
  written by the connected model through MCP instead of by an in-app
  classifier.

## Ground rules (owner-confirmed)

1. **No write-back to f-list.net from Workbench, ever.** The F-list API
   rules are not worth implementing. Everything happens inside the
   client; the user reviews the result and pushes it themselves in the
   browser (extension or userscript). The last step is always human
   interaction. MCP tools must say so in their descriptions so models
   never claim to have "published" anything.
2. **No LLM calls inside Workbench.** Classification, summarising,
   rewriting — all done by the connected model via MCP tools. Only the
   embedding endpoint (for ingest + query vectors) remains.
3. The reranker stays, switchable off (D2).
4. `/mcp` runs without a token by default; a bearer token is an
   opt-in feature in Settings (D3).
5. Fine-grained tools, one per action (D4).
6. The old in-app AI is removed *before* the write tools land (D7).
7. File-path tools read/write anywhere the sidecar's user may (D9).
8. Primary client is **LM Studio**; **Claude Code** is the debugging
   client and gets verified first in phase 0 (D10).

---

## 1. Where we are

### 1.1 Process topology today

```
Electron main (electron/main.ts)
  ├─ spawns sidecar (python/uvicorn, or sidecar.exe when packaged)
  ├─ keytar: F-list account + password (OS credential store)
  └─ BrowserWindow → renderer (React, renderer/src)
                        └─ HTTP → sidecar  http://127.0.0.1:27384
                                              ├─ 95 FastAPI routes (sidecar/server.py, 4 066 lines)
                                              ├─ character_archive.py (2 532 lines) — on-disk archive
                                              ├─ flist_api.py — ticket store (RAM), pull, mapping list
                                              ├─ restore.py — browser-extension pairing + restore feed
                                              ├─ rag_* / chunker — Qdrant (embedded) + SQLite FTS5
                                              └─ labels* — IC/OOC store + LLM classifier
Browser extension (FlistCharExporter, upstream repo)
  └─ HTTP → sidecar /restore/* with X-Workbench-Auth token  → pushes to f-list.net
```

Facts that shape the design:

- The sidecar is **the single owner of all state** (JSON files, three
  SQLite DBs, embedded Qdrant). It also holds the **F-list ticket +
  password in RAM** — nothing else can pull from F-list.
- The sidecar has **no auth** on `/` routes (CORS `*`, loopback only).
  Only `/restore/*` data routes require a paired token.
- **There is no write-back to f-list.net from the sidecar** (ground
  rule 1). Only three outbound F-list URLs exist: `getApiTicket.php`,
  `character-data.php`, `mapping-list.php`, plus static image GETs.
- Fat route handlers: `pull` (326 lines), `backup-all` (259), `PUT
  /settings` (174) contain orchestration that lives *only* in the
  handler. An MCP tool that needs "pull" must call the same code —
  which argues for the MCP server living **inside** the sidecar.
- Startup hooks use the deprecated `@app.on_event("startup")` (four of
  them, `server.py:124, 1952, 1965, 2029`). Mounting an MCP endpoint
  requires a FastAPI **lifespan**, and FastAPI silently ignores
  `on_event` handlers once a lifespan is set.

### 1.2 AI feature inventory (what goes, what stays)

| # | Feature | Needs | Sidecar | Renderer | Verdict |
|---|---|---|---|---|---|
| 1 | IC/OOC classifier (in-app LLM) | LLM | `labels_llm.py`, `labels_jobs.py`, `/labels/classify`, `/labels/jobs*`, `/labels/test-connection`, `/labels/failure-log`, `/labels/job-history`, `classify-failures.log` | `ClassifyDialog.tsx`, Logs-menu classify items, Settings `LabelsPane` inference section + `PromptPresetPicker` | **Remove** — replaced by client-driven classification through MCP (§3.9, D1) |
| 1b | Label store, rule resolver, manual override, stats | — | `labels.py` (rules: empty / `< threshold_chars` / `((` ⇒ OOC), `/labels/stats*`, `/labels/override`, `/labels/clear*`, `/labels/rollup` | Label chips + right-click override in `LogViewer.tsx`, `PartnerList.tsx` pips, Settings coverage rollup + "Reset all labels" | **Keep**, expose via MCP |
| 2 | RAG ingest (chunk → embed → Qdrant + FTS5) | Embeddings | `rag_jobs.py`, `chunker.py`, `rag_embed.py`, `rag_store.py`, `rag_lexical.py`, `/rag/ingest`, `/rag/jobs*`, `/rag/status`, `/rag/wipe`, `/rag/lexical/rebuild`, `/rag/test-embedding` | `IngestDialog.tsx`, Logs-menu ingest items, Settings `EmbeddingPane` | **Keep**, expose via MCP |
| 3 | "Ask the logs" grounded chat (`/rag/query`) | Embeddings + LLM + reranker | `rag_query.py` (retrieval, LLM-free), `rag_chat.py` (streaming), route 2813-2977 | `ChatPanel.tsx` (802 lines), slash commands, citation → log jump | **Remove chat**; keep `rag_query.run_query` and wrap it as a *retrieval-only* MCP tool (new surface — none exists today) |
| 4 | "Talk" free-form chat (`/rag/talk`) | LLM | route 2979-3032 | `ChatPanel.tsx` talk mode | **Remove** |
| 5 | Multi-query expansion | LLM | `rag_expand.py` | Settings Quality toggle | **Remove** |
| 6 | Cross-encoder rerank | local ONNX (~1.1 GB cache) | `rag_rerank.py`, `fastembed` dep | Settings | **Keep, switchable off** (D2) |
| 7 | BM25 hybrid, neighbour expansion | — | `rag_lexical.py`, `rag_query.expand_with_neighbors` | Settings | **Keep** |
| 8 | Connection tests / model discovery | — | `/labels/test-connection`, `/rag/test-chat`, `/rag/test-embedding`, `/settings/discover-models` | Settings `ModelField`, `TestStatusPill` | Keep `/rag/test-embedding`; keep `discover-models` for the embedding picker; remove the two LLM tests |
| 8b | Ollama probe + model pull | — | `/system/ollama-*`, `system.py` | only `AISetupWizard.tsx` (verified: no other caller) | **Remove with the wizard** (D8) |
| 9 | AI Setup wizard | — | — | `AISetupWizard.tsx` (1 419 lines), first-run toast, `spawnPowerShell`/`openExternal` IPC, Help menu | **Remove** (D8) — the only thing left to provision is the embedding model, which the `EmbeddingPane` already handles with a test button |
| 10 | 30 AI settings keys | — | `settings.py`, `rag.py`, `labels.py`, `PUT /settings` | `SettingsModal.tsx` panes | Keep 16 (see §5); drop 14 |

Hidden couplings (must be handled during removal, in this order):

- `rag_embed.py:190` imports `_ollama_base` / `detect_endpoint_kind`
  from `rag_chat.py`. **Move those two helpers into `rag_embed.py`
  first**, then delete `rag_chat`.
- `rag_expand.py` and `labels_jobs.py` import `labels_llm`;
  `server.py` imports it at lines 28, 2348, 2559. All callers go, then
  `labels_llm` goes.
- `chunker.py:166-170` **drops every message whose label resolves to
  `Unlabeled`.** The gate stays; classification now happens through
  MCP before ingest. `ingest_logs` must report `skipped_unlabeled` and
  point at the classification tools.
- `labels.db` holds `labels`, `label_failures`, `label_jobs`,
  `partner_aliases`, `rag_meta`, `rag_fts`. Drop only the
  `label_failures` and `label_jobs` tables; never the file.
- `rag_query.citation_payload` strips chunk text; the MCP retrieval
  tool needs the text, so it must serialise `run_query` hits itself.
- `logs.find_contacts(name)` already searches **every own character**
  for a 1:1 DM log with that partner (`logs.py:296`). It is exact,
  case-insensitive, channels ignored.

### 1.3 Character data model essentials

Per character under `%APPDATA%\flist-workbench\characters\<Folder>\`:
`live.json` (last pull, read-only), `sets/<12hex>/{payload,meta}.json`
(working sets — the only editable thing), `active_set.json`,
`snapshots/*.json`, `backups/*.zip`, `images/<id>.<ext>`,
`inlines/`. Registry `characters/_registry.json` maps id → folder.

Working payload (schema v6) keys: `_schema_version`, `_overlay`
(dotted paths the user touched), `character{id,name,description,
custom_title}`, `settings{…}`, `infotags{id: value}`, `kinks{id:
fave|yes|maybe|no|undecided}`, `custom_kinks{id|local:<uuid>: {name,
description, choice, children, _deleted?}}`, `_custom_kinks_order`,
`images[{image_id, description, sort_order}]`, `inlines{}`.

Invariants the sidecar enforces on write: `_overlay` present and a
list of strings (else 422); at least one container key; set exists;
`If-Match` etag → 409 on mismatch; set id `^[0-9a-f]{12}$`; set name
≤ 80 chars. **Not** enforced anywhere: description length, infotag
ids/values against the mapping list, standard-kink choice values,
gallery renumbering, overlay bookkeeping — all of that lives in the
renderer (`state/flist.ts`, `state.ts`). An MCP server writing
payloads must replicate those rules server-side (§4.2).

Three near-identical "seed from live" copies exist
(`character_archive._seed_payload_from_live`,
`server._seed_working_from_live`, renderer `seedWorkingFromLive`) —
the MCP work is the moment to collapse them to one.

---

## 2. Target architecture

### 2.1 The MCP server lives inside the sidecar

```
sidecar process (uvicorn, :27384)
  ├─ FastAPI REST  (unchanged for the renderer + extension)
  └─ /mcp          Streamable HTTP  ← LM Studio, Claude Code (direct)
                                    ← Claude Desktop, stdio-only clients (via `npx mcp-remote`)
```

| Option | Verdict |
|---|---|
| **A. FastMCP mounted in the sidecar** (`app.mount("/mcp", mcp.http_app())`) | **Chosen.** One state owner, direct access to `character_archive`, the live F-list ticket, and the job registry. No second process to install or keep alive. |
| B. Standalone stdio server proxying the REST API | Duplicates orchestration and still needs the sidecar running. Covered for free by `mcp-remote` / FastMCP proxy mode. |
| C. Standalone server importing sidecar modules directly | Two processes writing the same JSON/SQLite files; no access to the in-RAM ticket. Rejected. |

Library: **`fastmcp` 2.x** (PyPI `fastmcp`; superset of the reference
`mcp` SDK's FastMCP). Reasons: clean `http_app()` + lifespan mount,
`Context.report_progress`, tag-filtered tool sets, built-in proxy for a
stdio bridge, image/blob return types, prompts. Fallback if it fights
PyInstaller: reference `mcp` SDK with manual session-manager lifespan.

Precondition: convert the four `@app.on_event("startup")` hooks to a
single lifespan and combine it with the MCP app's lifespan
(`fastmcp.utilities.lifespan.combine_lifespans`).

The endpoint is always on while the sidecar runs; a Settings toggle
(`mcp.enabled`) can disable it.

### 2.2 Client matrix

| Client | How it connects | Notes |
|---|---|---|
| **LM Studio ≥ 0.3.17** (primary) | `%USERPROFILE%\.lmstudio\mcp.json` → `{"url": "http://127.0.0.1:27384/mcp"}` | direct HTTP; `headers` supported for a token; tool-calling model ≥ 14B recommended; no prompt/resource support assumed → everything must be reachable as a tool |
| **Claude Code** (debugging) | `claude mcp add --transport http flist-workbench http://127.0.0.1:27384/mcp` | native Streamable HTTP; the implementing session can call the tools itself to debug |
| Claude Desktop | `claude_desktop_config.json` → `npx mcp-remote http://127.0.0.1:27384/mcp` | Desktop's "custom connectors" are for remote HTTPS+OAuth; local servers go through the stdio bridge (needs Node) |
| Ollama | **not an MCP client.** Use a front-end that is: LM Studio, Goose, `ollmcp`, Open WebUI (`mcpo`), Cherry Studio, Jan | |
| Anything stdio-only | `npx mcp-remote <url>` or a one-line `FastMCP.as_proxy(...)` script | |

Config snippets for all of these get a **Settings → MCP** pane with
copy buttons (replaces the wizard as the "getting started" surface).

### 2.3 Security model

- Loopback only, same as today. The MCP endpoint is exactly as powerful
  as the REST API any local process can already call — no regression.
- **Optional bearer token** (`mcp.auth_token` in `settings.db`,
  generated on demand, shown in Settings → MCP, revocable). **Off by
  default**; the user can switch it on (D3).
- **DNS-rebinding protection on `/mcp`**: allowed hosts
  `127.0.0.1:27384` / `localhost:27384`, no `Origin` other than none or
  localhost. The main app's CORS `*` must not leak onto the sub-app.
- **No credentials through MCP.** No sign-in tool; the user signs in
  via the Workbench UI (auto-login via keytar). Tools that need a
  ticket return a structured `not_signed_in` error. The embedding API
  key is write-only through MCP.
- **Extension pairing stays a human action.** MCP can *read* pairing
  status, never accept a handshake.
- **F-list push stays a human action** (ground rule 1).
- Destructive tools carry `destructiveHint` annotations and require an
  explicit `confirm: true` argument (delete set/backup/images, wipe
  index, clear labels). Claude Code additionally prompts per call.
- File-path tools (`add_image`, bundle export/import,
  `export_restore_zip`) read/write anywhere the sidecar's user can
  (D9) — same posture as Electron's `workbench:write-file` IPC.
- Every MCP write is recorded in the existing activity log
  (`flist_activity.py`) with `source: "mcp"` + tool name.

---

## 3. Tool surface

Design rules:

- **Task-level tools, not a 1:1 REST mirror.** Payloads are big
  (descriptions of 30 KB, 560-entry kink dict); a model should be able
  to change one profile field without round-tripping the whole
  payload. A raw payload get/put stays as escape hatch.
- **Addressing by name.** `character` accepts a character name or id;
  `set` accepts a set name, set id, or `"live"` (read-only). `set`
  omitted ⇒ the active set; if none is active, writes fail with a hint
  to `create_working_set`.
- **Server-side validation** of everything the renderer validates today
  (§4.2).
- **Small, paginated reads.** Descriptions support `offset/length`; log
  reads have `limit` + cursor; kink lists have filters.
- **Everything reachable as a tool.** Prompts and resources are extras
  for clients that support them; LM Studio may not.
- **Tag-filtered sub-servers** for small local models: `/mcp` (all),
  `/mcp/character` (profile editing only, ~30 tools), `/mcp/logs`
  (logs, labels, classification, retrieval, ~20 tools). Same code,
  different `include_tags`.

Names below are proposals; ~75 tools in total.

### 3.1 Session & overview

| Tool | Maps to | Notes |
|---|---|---|
| `get_workbench_status` | `/health`, `/rag/status`, `/flist/session`, `/labels/rollup` | version, data dir, signed-in account, ticket age, index size, label coverage |
| `list_characters` | `GET /flist/characters` | name, id, on_account, has_archive, has_logs, last_pulled_at, set count, active set |
| `get_activity_log(limit)` | `GET /flist/activity` | |
| `get_mapping_list(section)` | `GET /flist/mapping-list` | `infotags` \| `infotag_groups` \| `listitems` \| `kinks` \| `kink_groups` |
| `get_bbcode_reference` | static | F-list BBCode dialect cheat-sheet so models write valid markup |

### 3.2 Live profile & pull

| Tool | Maps to | Notes |
|---|---|---|
| `get_live_profile(character, include_description=false)` | `…/live` | condensed `live.json` |
| `pull_character(character)` | `POST /flist/character/{name}/pull` (SSE consumed in-process) | needs session; returns the `done` summary; progress via MCP notifications |
| `fetch_public_profile(name)` | `GET /profile/{name}` | any F-list character; needs ticket |

### 3.3 Working sets

| Tool | Maps to |
|---|---|
| `list_working_sets(character)` | `GET …/sets` + `active_set.json` |
| `create_working_set(character, name?, source)` — `source`: `live` \| `set:<id>` \| `backup:<file>` | `POST …/sets`, `…/duplicate`, `…/zip-backups/{f}/create-set` |
| `rename_working_set`, `duplicate_working_set`, `delete_working_set(confirm)` | `PATCH/POST/DELETE …/sets/{id}` |
| `activate_working_set(character, set \| "live")` | `…/activate`, `…/from-flist/activate` — visibly switches the UI |
| `get_working_set(character, set?, include=[summary, infotags, kinks, custom_kinks, images, settings])` | `GET …/payload` filtered |
| `get_working_set_payload` / `put_working_set_payload(payload, if_match?)` | raw escape hatch |
| `diff_working_set(character, set, against="live" \| set)` | new — Python structural diff (D6) |

### 3.4 Description (BBCode) & title

| Tool | Notes |
|---|---|
| `get_description(character, set?, offset?, length?)` | `set="live"` allowed |
| `set_description(character, set, text)` | whole text; normalises CR/CRLF → LF |
| `edit_description(character, set, old_string, new_string, replace_all=false)` | exact-match edit like a code editor; fails on 0 or >1 matches unless `replace_all` |
| `append_description(character, set, text)` | |
| `set_custom_title(character, set, title)` | |

### 3.5 Profile fields (infotags) & settings

| Tool | Notes |
|---|---|
| `list_profile_fields(character, set?, group?, only_set=false)` | resolved via the mapping list: id, label, group, type (`text`/`list`/`number`/`unknown`), current value + resolved option label, allowed options for lists |
| `set_profile_field(character, set, field, value)` | `field` = id or label (case-insensitive). `list` → option id **or** option label → stored as id; `number` → numeric string; `unknown`/not-in-mapping → rejected |
| `clear_profile_field(character, set, field)` | deletes the key (never writes `""`) |
| `set_profile_settings(character, set, {customs_first, show_friends, guestbook, prevent_bookmarks, public})` | |

### 3.6 Kinks

| Tool | Notes |
|---|---|
| `list_kinks(character, set?, choice?, group?, query?, include_undecided=false)` | standard kinks with names from the mapping list |
| `set_kink(character, set, kink, choice)` / `set_kinks(character, set, items[])` | `kink` = id or name; `choice` ∈ fave/yes/maybe/no/undecided |
| `list_custom_kinks`, `add_custom_kink(name, description, choice)`, `update_custom_kink(id, …)`, `delete_custom_kink(id)` (tombstone), `restore_custom_kink(id)`, `reorder_custom_kinks(ids)` | mirrors `flistCustomKinks*` actions incl. `local:<uuid>` ids and `_custom_kinks_order` |

### 3.7 Images

| Tool | Notes |
|---|---|
| `list_images(character, set?)` | gallery rows + on-disk pool, sizes, which are on profile |
| `get_image(character, image_id, max_px=512)` | returns MCP `ImageContent` (downscaled) — vision-capable models can *see* the gallery |
| `get_avatar(name)` | image |
| `add_image(character, set, path \| base64, description?)` | magic-byte sniffing as today; appends to gallery |
| `remove_image(character, set, image_id, delete_file=false)` | |
| `set_image_description`, `reorder_images(character, set, image_ids)` | renumbers `sort_order` 0..n-1 |

### 3.8 Snapshots, backups, export

| Tool | Maps to |
|---|---|
| `list_snapshots`, `get_snapshot(character, file, include_description=false)` | `…/snapshots*` |
| `list_backups`, `create_backup(character, note?, force=false)`, `rename_backup`, `delete_backup(confirm)`, `get_backup_payload` | `…/zip-backup*` |
| `backup_all_characters(kind="manual_bulk", wait=true)` | `POST /flist/backup-all` (SSE consumed) — long-running |
| `export_working_set_bundle(character, set, path)` / `import_working_set_bundle(character, path, name?, confirm_cross_character=false)` | `…/sets/{id}/export`, `…/sets/import` |
| `export_restore_zip(character, set, path)` | `…/export.zip`; result text says "upload this on F-list yourself with the userscript / extension" |
| `get_extension_pairing_status` | `/restore/*` read-only; cannot accept |

### 3.9 Logs, labels & client-driven classification

| Tool | Maps to |
|---|---|
| `list_log_characters`, `list_partners(character)` | `/logs/characters`, `/logs/partners` |
| `read_log_messages(character, partner, from?, to?, limit=200, cursor?, labels?=[IC,OOC,Unlabeled])` | `/logs/messages` — paginated; includes `hash` + resolved label + source |
| `search_logs(character, partner?, query, limit)` / `search_all_partners(character, query)` | `/logs/search`, `/logs/search_all` |
| `find_contacts(name, partial=false)` | `/logs/contacts` — **already cross-character**: "have I ever DM'd XY on any of my characters?" returns `[{character, partner, bytes, last_message_at}]`. `partial=true` adds substring matching on partner names (new, cheap: directory-name scan). Channels stay excluded. |
| `list_aliases`, `add_alias`, `remove_alias`, `unlink_alias_group` | `/aliases*` |
| `get_label_stats(character, partner?)` | `/labels/stats*`, `/labels/rollup` — IC / OOC / Unlabeled / manual counts per partner |
| `get_messages_to_classify(character, partner, limit=40, context_before=1, context_after=1, cursor?, include_failed=true)` | **new.** Returns only messages whose label resolves to `Unlabeled` (the rules already decided empty / short / `((` ones): `[{hash, ts, speaker, text, context_before:[{speaker,text}], context_after:[…]}]`, plus `next_cursor` and `remaining`. This is the same material `labels_llm.build_user_prompt` assembled for the in-app classifier. |
| `set_message_labels(character, partner, items[{hash, label, reason?}])` | `/labels/override` with `source: "mcp"`; `label` ∈ `IC`/`OOC` (validated); `reason` stored like the old LLM reason; returns per-hash ok/unknown-hash |
| `get_classification_guidelines(language="de"\|"en"\|"minimal")` | **new.** Returns the existing classifier system prompts (`labels.py` presets `de-default` / `en-default` / `minimal`) as text so the client model applies the same rulebook. Also exposed as MCP prompt `classify_ic_ooc` for clients that support prompts. |
| `clear_labels(character, partner?, confirm)` | `/labels/clear*` |

**Worked flow — "Klassifiziere von A alle Chats mit B":**

1. `get_label_stats("A", "B")` → e.g. 3 200 messages, 1 900 rule-OOC,
   1 250 unlabeled.
2. `get_classification_guidelines("de")` once.
3. Loop: `get_messages_to_classify("A", "B", limit=40, cursor)` →
   model decides → `set_message_labels("A", "B", [{hash, label,
   reason}, …])` → until `remaining == 0`.
4. `get_label_stats` again to confirm; optionally `ingest_logs("A",
   "B")` → `search_logs_semantic(...)`.

With LM Studio this is time, not money; with Claude it is tokens —
the tool description states the batch count up front (`remaining /
limit`) so the model can warn the user before a 100-round loop.
Optional later: a server-side `classify_logs` that drives the same
loop through **MCP sampling** (`ctx.sample`) when the client advertises
the `sampling` capability — not relied on, because LM Studio / Claude
Desktop support is uncertain.

### 3.10 Retrieval & ingest

| Tool | Notes |
|---|---|
| `search_logs_semantic(question, character?, partner?, top_k?, neighbors?, hybrid?)` | **new retrieval-only surface** over `rag_query.run_query`: chunks with full text, date, partner, speakers, score, `expanded` flag, plus `retrieval_info` (embed model, rerank applied). The connected model reads the chunks and answers. |
| `ingest_logs(character?, partner?, include_ooc=false, overwrite=false, wait=false)` | `POST /rag/ingest`; returns `job_id` immediately, or runs to completion with progress when `wait=true`. Result includes `skipped_unlabeled` with the hint "run the classification flow (§3.9) first". |
| `get_job(job_id)`, `cancel_job(job_id)` | over the ingest / backup-all job registry |
| `get_rag_status`, `wipe_rag_index(confirm)`, `rebuild_lexical_index`, `test_embedding_connection` | |

### 3.11 Settings

`get_settings`, `update_settings(patch)` — the surviving keys:
`fchat_data_dir`, `labels.threshold_chars`, `rag.embed_endpoint`,
`rag.embed_model`, `rag.embed_api_key` (write-only), `rag.embed_query_
prefix`, `rag.embed_document_prefix`, `rag.chat_embed_keep_alive`
(rename to `rag.embed_keep_alive`), `rag.chunk_max_chars`,
`rag.chunk_soft_split_chars`, `rag.chunk_overlap_msgs`,
`rag.rerank_model`, `rag.rerank_candidates`, `rag.rerank_min_ratio`,
`rag.top_k`, `rag.neighbors`, `rag.hybrid_enabled`,
`rag.hybrid_bm25_candidates`, `backups.*`, `mcp.enabled`,
`mcp.auth_token`.

### 3.12 Resources & prompts (secondary)

Resources: `workbench://characters`, `workbench://character/{name}/
live`, `workbench://character/{name}/set/{set}/description.bbcode`,
`workbench://mapping/{section}`, `workbench://bbcode-reference`.
Prompts: `classify_ic_ooc(language)`, `review_profile(character,
set)`, `polish_description(character, set, style)`,
`summarise_rp(character, partner)`. Every prompt/resource has a tool
twin, because LM Studio is the primary client.

---

## 4. Cross-cutting design

### 4.1 Code layout

```
sidecar/
  mcp/
    __init__.py        build_mcp_servers() → {all, character, logs}; mounted by server.py
    _context.py        character/set resolution, error types, audit hook
    tools_session.py   §3.1–3.2
    tools_sets.py      §3.3–3.4
    tools_profile.py   §3.5–3.6
    tools_images.py    §3.7
    tools_backup.py    §3.8
    tools_logs.py      §3.9 (incl. classification batch tools)
    tools_rag.py       §3.10–3.11
    resources.py       §3.12
  services/            orchestration lifted out of server.py so REST + MCP share it
    pull.py            (from the 326-line handler; yields events, REST wraps as SSE)
    backup_all.py
    jobs.py            one registry for ingest / backup-all jobs (labels jobs disappear)
    payload_ops.py     edit_field / clear_field / overlay bookkeeping / seed_from_live (one copy)
    profile_fields.py  mapping-list resolver + validation (Python port of infotagsResolver.ts)
    classification.py  unlabeled-batch builder (reuses context-window logic from labels_llm before it is deleted)
    diff.py            structural diff for diff_working_set
```

`server.py` keeps its routes but the fat handlers become thin wrappers
over `services/`.

### 4.2 Rules `payload_ops` must enforce (today renderer-only)

- Append the dotted path of every edit to `_overlay` (`infotags.<id>`,
  `kinks.<id>`, `custom_kinks.<id>.choice`, `custom_kinks._order`,
  `images` as one coarse path, `character.description`, …).
- Clearing an infotag deletes the key.
- `kinks: []` from live is reshaped to `{}` on seed.
- Gallery re-sorted by `sort_order` and renumbered 0..n-1 after any
  change; removing an image also drops its gallery row.
- Custom-kink delete = tombstone `_deleted: true`; new ids are
  `local:<uuid4>`; `_custom_kinks_order` kept consistent.
- Description normalised CR/CRLF → LF.
- Standard-kink choices validated against the five allowed values;
  kink ids validated against the mapping list; infotag values
  validated per type (§3.5).
- Writes only to an existing set; `live` is never writable.
- `If-Match` used on every write (read etag → mutate → put), retried
  once on 409 with a fresh read.

### 4.3 UI ↔ MCP concurrency (needs real work)

Today, when a PUT hits a 409 the renderer shows "Another window saved
a different version. Reload to merge." **and adopts the server etag**
(`state.ts:2415-2437`) — so the *next* keystroke overwrites whatever
the MCP wrote. With no pending edits the UI simply shows stale data
until a reload. Fix in phase 5:

1. Sidecar broadcast bus + `GET /events` (SSE): `set-payload-changed
   {character_id, set_id, etag, source}`, `sets-changed`,
   `active-set-changed`, `live-changed`, `labels-changed`,
   `job-progress`.
2. Renderer subscribes once (`AppLayout`). On an event for the open
   set: no local pending edits → reload silently and toast "Updated by
   <tool>"; pending edits → banner with *Reload* / *Keep mine*.
3. Same bus refreshes label chips after `set_message_labels`, the
   sidebar lists, and the Settings → MCP pane ("last tool call: …").

### 4.4 Long-running operations

`pull_character`, `backup_all_characters`, `ingest_logs(wait=true)`
stream progress via `Context.report_progress` and return a summary.
Hard cap per tool call (10 min); beyond that the tool returns a
`job_id` and the client polls `get_job`. Classification is *not* a
server-side job any more — it is a client loop (§3.9).

### 4.5 Errors

Structured tool errors with a stable `code`: `not_signed_in`,
`no_active_set`, `set_not_found`, `character_not_found`,
`partner_not_found`, `validation_failed {field, reason, allowed}`,
`etag_conflict`, `rate_limited {retry_after}`, `confirm_required`,
`embedding_unreachable`, `unknown_hash`.

---

## 5. Removal plan (everything that calls an LLM)

| Remove | Where |
|---|---|
| Sidecar modules | `rag_chat.py` (after moving `_ollama_base`/`detect_endpoint_kind` into `rag_embed.py`), `rag_expand.py`, `labels_llm.py` (after lifting the context-window builder into `services/classification.py`), `labels_jobs.py`, `system.py` |
| Routes | `/rag/query`, `/rag/talk`, `/rag/test-chat`, `/labels/classify`, `/labels/jobs`, `/labels/jobs/{id}` (GET+DELETE), `/labels/test-connection`, `/labels/failure-log`, `/labels/job-history`, `/system/ollama-status`, `/system/ollama-pull`; trim `/settings/discover-models` to the embedding case |
| Settings keys (14) | `labels.llm_endpoint`, `labels.llm_model`, `labels.llm_api_key`, `labels.system_prompt`, `labels.context_before`, `labels.context_after`, `rag.chat_endpoint`, `rag.chat_model`, `rag.chat_api_key`, `rag.chat_system_prompt`, `rag.chat_num_ctx`, `rag.multiquery_enabled`, `rag.multiquery_variants`; rename `rag.chat_embed_keep_alive` → `rag.embed_keep_alive`. One-shot cleanup deletes dropped keys from `settings.db` on first boot. |
| DB | drop tables `label_failures`, `label_jobs` from `labels.db`; delete `classify-failures.log` |
| Renderer | `features/rag/ChatPanel.tsx`; `features/labels/ClassifyDialog.tsx`; `features/setup/AISetupWizard.tsx` + first-run toast (`AppLayout.tsx:195-227`) — replace with a one-time toast pointing at Settings → MCP; Settings `ChatPane`, `LabelsPane` inference section + `PromptPresetPicker` + `LabelsHistorySection` (keep coverage rollup + "Reset all labels"), `GeneralPane` "Inference endpoints" mirror; move the Retrieval + Quality sections (top_k, neighbours, rerank, hybrid) into `EmbeddingPane` or a new "Retrieval" pane; state slices `chatPanelOpen`, `chatFocusNonce`, `logJump`, `classifyTarget`, `aiSetupOpen` and their actions; `api.ts` `ragQuery`, `ragTalk`, `ragTestChat`, `labelsClassifyStart`, `labelsTestConnection`, `labelsJobGet`, `labelsJobCancel`, `labelsJobHistory`, `systemOllamaStatus`, `systemOllamaPull`, and the SSE `dispatchSseBlock` plumbing if nothing else streams; "Classify…" / "Chat about…" entries in `LogViewer.tsx` and `PartnerList.tsx` context menus (keep "Ingest…") |
| Electron | menu items `classify-current`, `classify-character`, `classify-all`, `chat-toggle`, `ai-setup`, "Open Classify Failure Log…"; `MenuFlags.classifyCurrent/classifyCharacter` (ingest items get their own flags); IPC `workbench:spawn-powershell`, `workbench:open-external` (keep `open-settings` for the new toast) |
| Tests | `test_rag_chat.py`, `test_rag_expand.py`, `test_labels_llm.py`, `test_system.py`; LLM parts of `test_labels.py`, `test_rag_settings.py`, `test_rag_query_api.py` (keep retrieval tests), `test_settings.py`; e2e `classify-dialog.spec.ts`; renderer tests touching `ChatPanel` |
| Deps | none removed on the Python side (`httpx` still needed for embeddings/F-list) |
| Docs | `PLAN.md` is stale since May (still "no write-back, no MCP", lists RAG chat as the product) — fold what is still true into `docs/`, delete it; `package.json` description ("RAG chat over your own F-Chat logs") gets a new line; `docs/INSTALL_WINDOWS.md` §6 data-dir list |

Explicitly **kept**: `labels.py` (store + resolver + presets text),
`/labels/stats*`, `/labels/override`, `/labels/clear*`,
`/labels/rollup`, label chips + manual override UI, `IngestDialog.tsx`
and the ingest menu items, `EmbeddingPane`, `lib/endpoint.ts`
remote-endpoint consent (still guards the embedding endpoint),
`chunker` gate on `Unlabeled`.

---

## 6. Phases

Each phase ships a working build. Order: prove the risky part
(mounting MCP in the packaged sidecar) first, cut the in-app AI second
(D7), then build up tools.

| Phase | Deliverable | Acceptance | Size |
|---|---|---|---|
| **0 Groundwork** | lifespan migration; `fastmcp` dep; empty server mounted at `/mcp` with `get_workbench_status`; DNS-rebinding guard; Settings → MCP pane (URL, on/off, config snippets); `pack:sidecar` verified (PyInstaller hidden imports) | **Claude Code first**: `claude mcp add …` and call the status tool from the implementing session; then LM Studio via `mcp.json`; both against the **packaged** exe | S–M |
| **1 Cut the in-app AI** | §5 removal; settings-key cleanup + rename; Retrieval settings re-homed; new first-run toast; version 0.1.0 | `uv run pytest`, `npm test`, `npm run typecheck` green; no LLM endpoint anywhere in Settings; ingest, label chips, manual override unchanged | M |
| **2 Read-only tools** | §3.1–3.3 reads, `get_description`, `list_profile_fields` (needs `services/profile_fields.py`), `list_kinks`, `list_images`/`get_image`, backups/snapshots lists, logs read/search, `find_contacts`, `get_label_stats`, `search_logs_semantic`, tag-filtered sub-servers | "Summarise the differences between my live profile and set X", "what did partner Y say about Z", "have I ever talked to XY" work from Claude Code **and** from LM Studio with no UI interaction | M |
| **3 Classification via MCP + label writes** | `services/classification.py`, `get_messages_to_classify`, `set_message_labels`, `get_classification_guidelines` (+ prompt), `clear_labels`, `labels-changed` hook | The §3.9 worked flow labels a real partner log end-to-end from LM Studio; chips update after reload; ingest of that partner then produces chunks | S–M |
| **4 Write tools** | `services/payload_ops.py` (+ collapse the three seed copies), description/field/kink/custom-kink/settings/image/set-CRUD tools with full validation and audit | A model can create a set, rewrite the description, set height/species/kinks, reorder images; UI shows the result after reload; sidecar tests cover every validation rule | L |
| **5 Operations** | `pull_character`, `create_backup`, `backup_all_characters`, `ingest_logs`, `services/jobs.py`, bundle export/import, restore-zip export, aliases writes, `update_settings`; `services/pull.py` + `backup_all.py` extracted | Long-running tools report progress in Claude Code; REST behaviour unchanged (uxtest specs green); classify → ingest → search works end-to-end | M–L |
| **6 UI sync** | `/events` SSE bus, renderer reload-on-external-change + conflict banner, label chips refresh, MCP activity in Settings | Editing the same set from UI and MCP never silently loses either side | M |
| **7 Polish** | opt-in bearer token, `diff_working_set`, remaining prompts/resources, headless sidecar note, `docs/MCP.md` client guide, release | | S–M |

---

## 7. Execution notes for the implementing session

Written so a lower-effort session can work phase by phase without
re-deriving the analysis.

- The design is approved; **each phase still needs the owner's go
  before work starts.** One phase per branch/PR; never push (see repo
  `CLAUDE.md`).
- Commands: sidecar tests `cd sidecar && uv run pytest`; renderer
  `npm test`; types `npm run typecheck`; packaged sidecar `npm run
  pack:sidecar` (needs the `sidecar/.venv` from `uv sync`); full
  portable build `npm run pack:win`.
- Sidecar port is fixed at **27384**; the extension hardcodes it too.
- `FLIST_WORKBENCH_DATA_DIR` overrides the data root — use a temp dir
  for MCP experiments so real character data stays untouched.
- Phase 0 concrete steps: (1) add `fastmcp` to
  `sidecar/pyproject.toml`; (2) replace the four `@app.on_event`
  blocks with one `@asynccontextmanager` lifespan; (3) `mcp =
  FastMCP("flist-workbench")`, `mcp_app = mcp.http_app(path="/")`,
  `app = FastAPI(lifespan=combine_lifespans(sidecar_lifespan,
  mcp_app.lifespan))`, `app.mount("/mcp", mcp_app)`; (4) one tool
  `get_workbench_status`; (5) transport security settings restricting
  Host/Origin to localhost; (6) `claude mcp add --transport http
  flist-workbench http://127.0.0.1:27384/mcp` and call it; (7) build
  `sidecar.exe`, run it standalone with `SIDECAR_PORT=27384`, repeat
  (6); (8) LM Studio `mcp.json` entry, verify the tool appears.
- Phase 1 order of operations: move `_ollama_base` /
  `detect_endpoint_kind` into `rag_embed.py` → delete `rag_chat.py`,
  `rag_expand.py` + routes → lift the context-window builder out of
  `labels_llm.py` into `services/classification.py` → delete
  `labels_llm.py`, `labels_jobs.py`, `system.py` + routes → settings
  keys + migration → renderer/electron removals → tests → docs.
- Every MCP tool: short description (one sentence what, one sentence
  constraints), typed parameters with defaults, structured error
  codes (§4.5), `readOnlyHint` / `destructiveHint` annotations, and a
  pytest that calls it in-process through the FastMCP client.
- Keep tool descriptions honest about F-list: "Workbench never writes
  to f-list.net; the user uploads changes in the browser."

---

## 8. Decisions

| # | Question | Decision |
|---|---|---|
| D1 | IC/OOC classifier | **Move to the client model via MCP** (batch tools + guidelines prompt, §3.9). The in-app LLM classifier is removed; the label store stays. Result: Workbench needs **no LLM endpoint at all**, only an embedding endpoint. |
| D2 | ONNX reranker | **Stays, switchable off** (`rag.rerank_model = "disabled"`). Local model, no endpoint. |
| D3 | Bearer token on `/mcp` | **Off by default**, opt-in toggle in Settings → MCP. |
| D4 | Tool granularity | **Fine-grained tools**, ~75, plus tag-filtered sub-servers for small models. |
| D5 | Headless sidecar for MCP-only use | Deferred. Sign-in lives in the UI/keytar; a headless mode needs its own credential path. |
| D6 | `diff_working_set`: port the TS diff engine or simpler structural diff | Deferred — proposal: structural diff first (phase 7). |
| D7 | Remove the in-app AI before the write tools | **Before** — phase 1. |
| D8 | AI Setup wizard (+ `system.py`, `/system/ollama-*`) | **Remove.** With no LLM left in-app, the wizard's Ollama-install / GPU / env / chat-model pages are dead weight; the embedding model is configured and tested in `EmbeddingPane`. Settings → MCP becomes the getting-started surface. |
| D9 | File-path tools | **Anywhere the sidecar's user may read/write.** |
| D10 | Clients | **LM Studio primary, Claude Code for debugging** (verified first in phase 0). |
| — | F-list write-back | **Never.** Push is the user's manual step in the browser (ground rule 1). |
| — | "Have I ever talked to XY on any character?" | Covered by `find_contacts` (already cross-character); `partial=true` added for fuzzy names. |

---

## Appendix A — client config snippets (for the Settings → MCP pane)

LM Studio (`%USERPROFILE%\.lmstudio\mcp.json`):

```json
{
  "mcpServers": {
    "flist-workbench": {
      "url": "http://127.0.0.1:27384/mcp"
    }
  }
}
```

Claude Code:

```
claude mcp add --transport http flist-workbench http://127.0.0.1:27384/mcp
# with token:  --header "Authorization: Bearer <token>"
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "flist-workbench": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:27384/mcp"]
    }
  }
}
```

Small-model variant: point at `/mcp/character` or `/mcp/logs` instead
of `/mcp`.

## Appendix B — sources

- LM Studio MCP docs: https://lmstudio.ai/docs/app/mcp (0.3.17+, local + remote servers, `mcp.json`)
- Ollama has no built-in MCP client (issue #7865 still open): https://www.morphllm.com/ollama-mcp
- Claude Desktop local servers via stdio / `mcp-remote`: https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers
- FastMCP ⇄ FastAPI mounting + `from_fastapi`: https://gofastmcp.com/integrations/fastapi
- Reference SDK mounting pitfall (task group not initialised without lifespan): https://github.com/modelcontextprotocol/python-sdk/issues/1367
