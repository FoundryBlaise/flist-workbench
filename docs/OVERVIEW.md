# F-list Workbench — what it is

A Windows desktop tool for F-list.net roleplayers: edit your character
profiles offline, keep several drafts of each, and browse your own
F-Chat logs. It is **not** an F-list client — Frolic and F-Chat 3.0
fill that role. Workbench complements them with a better editor, better
log search, and a way to let a language model work on your profiles.

Replaces `PLAN.md`, which described the May 2026 shape of the project
(RAG chat, an in-app classifier, an AI setup wizard) and had drifted
out of date.

## The two rules that shape everything

1. **Workbench never writes to f-list.net.** Every edit stays in local
   files. When a profile is ready the user reviews it and uploads it
   themselves in the browser, via the `flistcharexporter` userscript or
   the paired browser extension. The last step is always a human one.
   The extension does report that step back: when the user presses
   Save on f-list.net it calls `/restore/saved`, and the app re-pulls
   so its read-only Live copy matches the site again. That pull writes
   Live, images and a snapshot — never a working set. The Workbench
   may well have moved on while the upload happened, and overwriting
   the user's draft with what they just published is not something
   "the upload finished" should ever mean.
2. **Workbench runs no language model.** It has no chat, no classifier,
   no model to configure. A model the user connects over MCP does that
   work; the app provides the data and the tools. It talks to no
   inference server at all: embedding runs in-process on the CPU
   (fastembed / onnxruntime), and the only other model it loads is a
   small ONNX reranker.

## Shape

```
Electron main ──spawns──> sidecar.exe (Python, FastAPI, 127.0.0.1:27384)
     │                        │
     │                        ├─ REST  ← the Workbench window
     │                        ├─ /restore/*  ← the paired browser extension
     │                        └─ /mcp  ← LM Studio, Claude, any MCP client
     └─ BrowserWindow ──> React renderer
```

The sidecar owns all state: the character archive, three SQLite
databases, an embedded Qdrant index, and the F-list ticket (held in RAM
only, never written to disk). That is why the MCP server lives inside
it rather than beside it.

## What lives where

| Path | What |
|---|---|
| `electron/` | main process, preload bridge, native menu, sidecar spawn |
| `renderer/src/features/` | editor, logs, flist (profile tabs), sidebar, settings |
| `renderer/src/state.ts` | one Zustand store; `state/flist.ts` holds the payload helpers |
| `sidecar/server.py` | the REST surface the renderer and extension call |
| `sidecar/services/` | orchestration shared by REST routes and MCP tools |
| `sidecar/workbench_mcp/` | the MCP server: tool registry + tool modules |
| `sidecar/services/render.py` | parks a render request until the app draws it |
| `electron/renderProfile.ts` | offscreen capture of a profile, for `render_profile_image` |
| `sidecar/character_archive.py` | on-disk character archive (working sets, snapshots, backups) |
| `sidecar/labels.py` | IC/OOC verdicts + the read-time rule resolver |
| `sidecar/rag_*.py`, `chunker.py` | chunking, embedding, Qdrant, BM25, reranking |
| `docs/MCP_DESIGN.md` | the design this architecture came from |

## Character data model

Per character under `%APPDATA%\flist-workbench\characters\<Folder>\`:

- `live.json` — the last profile pulled from F-list. Read-only. The
  window calls it **Live on F-List**.
- `sets/<12hex>/{payload,meta}.json` — the editable copy. On disk this
  is still the working-set format, and a character can technically hold
  several; the window shows exactly one and calls it the **Workbench**.
  `active_set.json` says which one that is.
- `snapshots/`, `backups/*.zip`, `images/`, `inlines/`

Working sets were once a user-facing concept — create, name, keep
several, pick an active one. Testers could not say what one was or how
it differed from the read-only row above it, so the concept stayed on
disk and left the vocabulary. `character_archive.resolve_workbench()`
picks the bench: the active set, else the most recently changed, else a
new one seeded from Live. Extra sets an older version left behind stay
on disk, out of the window, and are logged once when chosen — there is
no migration step to remove later.

The working payload (schema v6) carries `_overlay` — the dotted paths
the user has touched — so a later pull can refresh untouched fields
without clobbering edits.

## Logs and search

Workbench reads F-Chat 3.0's binary log format in place; it never
writes to the F-Chat data directory.

Every message resolves to IC, OOC or Unlabeled at read time. Three
rules decide the easy cases (empty, shorter than the threshold,
starting with `((` ⇒ OOC); everything else waits for a verdict from a
connected model or from the user. **Only labelled messages are
indexed** — an unjudged message could be roleplay or player chatter,
and indexing the latter poisons search.

## Stack

| Concern | Choice |
|---|---|
| Desktop shell | Electron + electron-vite |
| Renderer | React 18 + TypeScript, Zustand, CodeMirror 6 (custom BBCode language) |
| Sidecar | Python 3.12 + FastAPI, frozen with PyInstaller |
| MCP | the reference SDK's FastMCP, Streamable HTTP at `/mcp` |
| Vector store | Qdrant, embedded file-backed mode |
| Embeddings | any OpenAI-compatible `/embeddings` endpoint (LM Studio, Ollama) |
| Reranker | fastembed ONNX cross-encoder, local, optional |
| Packaging | electron-builder → portable .exe on GitHub Releases |
| Tests | vitest (renderer), pytest (sidecar), Playwright-for-Electron (e2e) |

No bundled model weights, no code signing (see
`docs/INSTALL_WINDOWS.md` for the SmartScreen click-through).
