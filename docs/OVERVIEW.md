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
| `sidecar/foreign_cache.py` | read-only cache of *other people's* profiles, under its own root |
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

## Other people's profiles

The character picker carries a stand-in row, **Foreign profile**, next
to the real characters; Tools → Search Foreign Character selects the
same one. Picking it puts the editor panel into a read-only state:
find somebody in your bookmarks, your friends list or your chat logs,
or type a name, and their profile fills the panel — Description,
Profile fields, Kinks, Images, no Diff. It answers one question: how
is this profile written.

It is the editor's own panel rather than a dialog on purpose, and it
borrows the editor's markup rather than imitating it. Description
splits code left / rendered right and carries the same
`.pane.preview[data-flist-theme]` shell, so the Dark / Default / Light
switch and the F-list theme mimics work here unchanged; the source
side is the editor's own CodeMirror with the BBCode language, both
read-only locks on, because the highlighting is most of what makes
nested tags legible. Profile fields
use the editor's `infotag-field` rows down the left and the editor's
own `ProfileFieldsPreview` on the right — that component takes an
optional payload now, so both sides render the Info preview from one
implementation. Kinks use the editor's four-column layout
(`kinks-pane`, `kink-column`, `kink-row`); an earlier version listed
them in one flowing grid with descriptions inline, which on a profile
with a long favourites list was unreadable. Images take the full width
as a thumbnail grid.

A profile needs the window's height for a long description and its
width for a gallery; a modal sized for a form gave it neither.

Two things are paced differently from the rest of the app. The
candidate list for a source is fetched once and filtered in the
window — a round trip per keystroke put the eight-second log sweep on
the critical path of typing. And that sweep now reads names with
`os.scandir` instead of `logs.list_partners()`, whose `stat()` per log
file was the eight seconds; it is cached for two minutes on top.
Gallery images load all at once, down a pooled connection and
capped on concurrency rather than paced per second. That follows
the prior art: F-Chat 3.0 renders a gallery as plain `<img>` tags
with no pacing at all, and Horizon throttles only the JSON API —
`throat(2)`, a concurrency cap on `character-data.php` — while
leaving `static.f-list.net` untouched. Workbench needs a cap only
because its images go through the sidecar to be cached on disk,
which funnels what a browser would run as parallel connections
into one queue.

The pooling matters more than the cap. `download_to` builds a
throwaway client when handed none, so every image was paying for
its own TLS handshake; measured cold on a real eight-image gallery
that was 1.9 s, against 0.07-0.14 s through one
`foreign_cdn_client()`. The 2/s lane stays on the sweep paths (a
pull, the backup-all run), where nothing waits on any single image.

The slot is not a character. It has no id, no archive entry, no
working set and never sets `flistActiveCharacterId` — which is what
leaves every edit, pull, backup and export path with nothing to act
on. The sidebar hides the per-character zones while it is selected,
and a `read-only` badge sits in the panel's header, because the panel
otherwise looks exactly like the editor.

Nothing is remembered about who you looked at. The slot holds one
profile in memory, picking a real character leaves it without clearing
it, and closing the app forgets it. There is no list of viewed
profiles anywhere in the window.

The payloads cache under `%APPDATA%\flist-workbench\foreign\<name>\`
in the same shape `live.json` uses, with a 24-hour TTL and a manual ↻.
That root is deliberately not `characters/`: every path that can copy,
back up, export or edit a character resolves through
`character_archive.character_dir()`, and nothing under `foreign/` is
reachable that way. Copying a profile by hand in a file manager is of
course still possible — what the app must not offer is a button that
does it, and it offers none, in the window or over MCP.

The three MCP tools (`search_foreign_characters`, `get_foreign_profile`,
`get_foreign_kinks`) spend a quarter of the hourly F-list budget at
most. The user's own pulls and a model's browsing share one
200-requests-per-hour ceiling, and a model walking a friend list would
otherwise empty it in three minutes.

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
