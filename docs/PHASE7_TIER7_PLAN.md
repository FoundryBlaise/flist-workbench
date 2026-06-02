# Phase 7 Tier 7 — Implementation Plan

Grounded plan for Tier 7 of the character-archive feature: **working sets,
metadata-only snapshots, self-contained backup ZIPs, and per-set undo /
redo**, hosted in a stacked-accordion sidebar pane (Draft B of
`PHASE7_TIER7_UX_DRAFTS.md`). Drafted 2026-06-02 against the post-Tier-6
codebase (`state.ts` 2960 lines, `character_archive.py` 1010 lines,
`zip_serialise.py` shipping the Tier 6 builder, schema v5 on disk).

Tier 7 reshapes the lower-left sidebar — the region today hosting the
`SNIPPETS` heading + `[+ Snippet] [+ Folder] (?)` toolbar — into three
stacked accordion sections (Snippets / Working sets / Backups). It bumps
the working-copy schema to v6 (sets directory + active-set pointer + a
sibling snapshots store), introduces a metadata-only snapshot concept
(no image bytes), promotes the existing `backups/<unix>.json` directory
into a userscript-compatible self-contained ZIP store (auto-pull +
manual), and adds an in-memory undo / redo stack scoped per working set.

Snippets are global and unchanged. Working sets, snapshots, and backups
are per-character and visible only when an F-list character is active.
Character archive code (`sidecar/character_archive.py` + the renderer's
`flistArchive`, `flistWorking`, image actions) is the only surface that
changes shape. The pull pipeline keeps its existing SSE shape; only one
new side-effect lands inside `pull_character_async` (auto-backup ZIP
write at end-of-pull).

The plan supersedes the pre-Tier-6 sketch in BACKLOG.md → "Tier 7 —
Multi working-sets + drop snapshots." That sketch dropped backups in
favour of sets; this plan keeps both — sets carry editable state,
snapshots are cheap metadata checkpoints, and backups are forever-kept
self-contained ZIPs. Each plays a distinct role and the three together
match the user's mental model of how RP characters get archived.

## Companion docs

- `PHASE7_TIER1_PLAN.md` — pull pipeline, ticket / rate limit / SSE shape.
- `PHASE7_TIER2_PLAN.md` — working-copy persistence, `_overlay`, autosave
  / If-Match, reset-to-Live + 5s undo. Tier 7 inherits these wholesale.
- `PHASE7_TIER3_PLAN.md` — custom-kinks + standard-kinks dirty model.
  Tier 7's undo stack captures patches at this granularity.
- `PHASE7_TIER4_PLAN.md` — diff engine. Tier 7 extends the right-source
  picker to support `Snapshot of this set` and `Other set`.
- `PHASE7_TIER7_UX_DRAFTS.md` — Draft B (stacked accordion) is the basis.
  Draft A (tabs) and Draft C (mode-switch) deliberately rejected.
- `BACKUP_FEASIBILITY.md` — the userscript ZIP contract (root
  `character.json` + `images/<image_id>.<ext>` + optional `avatar.png`).
  Tier 7's auto + manual backups produce that exact bundle.
- `ZIP_SCHEMA.md` — pinned wire shape Tier 6 already produces.
- `BACKLOG.md` → "Tier 7 — Multi working-sets + drop snapshots" — the
  outdated sketch. **This plan overrides it.**

---

## Goal

One **stacked accordion** sidebar pane hosting (1) the existing global
Snippets list, (2) per-character **working sets** with inline
metadata-only **snapshots**, and (3) per-character **self-contained
backup ZIPs** (auto on pull + manual on demand). Every working set has
its own undo / redo stack (≥ 50 in-memory steps). All destructive
operations take a snapshot or 5-second undo first; the only path that
permanently loses data is the explicit Delete-backup confirm modal,
gated behind a non-backdrop-dismissable confirm.

## Non-goals

- **No drag-and-drop between sets.** Move/copy across sets stays out
  of Tier 7 — backlog.
- **No multi-character comparison view.** Diff stays per-character.
- **No snapshot-vs-snapshot diff picker in Tier 7.** Tier 4's right-
  source picker grows two new options (Snapshot / Other set) but
  snapshot-vs-snapshot is deferred; only Working ↔ {Live, Snapshot,
  Other set, Backup} ships.
- **No ZIP import as a new set.** Round-trip through `flistcharexporter`
  + a fresh F-list pull is the only ingress; userscript-driven ZIP
  → working-set import is a polish item.
- **No automatic snapshot pruning.** Snapshots are cheap (metadata
  only); manual delete is the only path.
- **No cloud sync.** Local-only forever.
- **No F-list write-back.** Restore stays via `flistcharexporter`.
- **No bundled LLM weights.** N/A for this tier — but reaffirmed.
- **No backup-ZIP auto-prune.** Owner explicitly chose keep-forever;
  per-row Delete is the only removal path.

---

## Storage layout (v6)

```
<userData>/characters/<id>/
  live.json                          ← unchanged (pull writes here)
  pull_state.json                    ← unchanged (integrity manifest)
  sets/                              ← NEW
    <set_id>/
      payload.json                   ← working payload (replaces working.json)
      meta.json                      ← {id, name, createdAt, updatedAt,
                                       snapshots: [SnapshotMeta…]}
      snapshots/
        <snapshot_id>.json           ← frozen payload, no bytes
  active_set.json                    ← NEW {active_set_id: "<uuid>"}
  backups/                           ← unchanged location; now ZIPs
    2026-06-02T18-44-00__auto-pull__d2f8.zip
    2026-06-02T14-12-00__manual-set__Main__a401.zip
    2026-05-30T09-11-00__manual-snapshot__Pre-rewrite__7c2d.zip
  images/<image_id>.<ext>            ← unchanged; character-wide
  inlines/<hash>.<ext>               ← unchanged
  avatars/<lowercase_name>.png       ← unchanged (one level up, account-wide)
```

`<set_id>` and `<snapshot_id>` are `uuid4().hex[:12]`. Set names are
user-controlled UTF-8 strings (validated by the rename endpoint — no
slashes, no nulls, 1-80 chars). Backup filenames embed an ISO-8601
timestamp (with `:` substituted to `-` for NTFS safety), the source
kind, an optional source name (sanitised), and a short payload hash —
the hash makes lexicographic sort stable even when two backups land in
the same second.

### Migration (v5 → v6)

Runs once on first read of the character directory in a v6 build:

1. If `sets/` exists → already migrated; no-op.
2. Otherwise: mint `<set_id> = uuid4().hex[:12]`, create
   `sets/<set_id>/`.
3. If `working.json` exists: read it, write to
   `sets/<set_id>/payload.json` (atomic temp+rename, schema bumped to v6
   on the way through).
4. If `working.json` is absent: skip — no working copy yet. The user's
   first edit on this character creates the default "Main" set lazily
   (matches today's materialise-on-first-edit behaviour).
5. Write `sets/<set_id>/meta.json` with
   `{id, name: "Main", createdAt: stat(working.json).st_mtime,
   updatedAt: stat(working.json).st_mtime, snapshots: []}`. When
   working.json was absent, use `int(time.time())` for both.
6. Write `active_set.json` with `{active_set_id: <set_id>}`.
7. Delete `working.json` only after `payload.json` reads back cleanly
   (sha256 of bytes matches the in-memory write). On mismatch, leave
   `working.json` in place and log a one-line warning; the v6 reader
   tolerates both.
8. Backups in `backups/` that are still `*.json` (Tier 1 shape, no
   image bytes) are left as-is and surfaced in the Backups list with a
   `legacy-json` badge. They round-trip as read-only artefacts. They
   are **not** auto-upgraded to ZIP — that would require re-reading
   bytes the user may have since deleted. Manual "Re-bundle as ZIP" is
   a backlog item.

Migration is idempotent — re-running on an already-v6 directory is a
no-op. `WORKING_SCHEMA_VERSION = 6` stamps the payload; v1–v5 readers
in `_migrate_working_payload` continue to migrate forward in memory.

---

## Data shapes

### Sidecar (Python dataclass-ish)

```python
# repo/sidecar/character_archive.py

@dataclass(frozen=True)
class SetMeta:
    id: str                    # uuid4().hex[:12]
    name: str
    created_at: int            # unix
    updated_at: int            # unix
    snapshot_count: int        # cached; mirrors len(snapshots) in meta.json

@dataclass(frozen=True)
class SnapshotMeta:
    id: str                    # uuid4().hex[:12]
    name: str
    created_at: int

@dataclass(frozen=True)
class BackupListing:
    filename: str              # 2026-06-02T18-44-00__auto-pull__d2f8.zip
    created_at: int
    size: int
    source: str                # "auto-pull" | "manual-set" | "manual-snapshot" | "legacy-json"
    source_name: str | None    # set name / snapshot name; None for auto-pull + legacy
    payload_hash: str          # first 8 hex of sha256 — UI sort tiebreaker
```

### Renderer (TypeScript)

```ts
// repo/renderer/src/state/flist.ts

export interface SetMeta {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  snapshotCount: number
}

export interface SnapshotMeta {
  id: string
  name: string
  createdAt: number
}

export interface BackupListing {
  filename: string
  createdAt: number
  size: number
  source:
    | 'auto-pull'
    | 'manual-set'
    | 'manual-snapshot'
    | 'legacy-json'
  sourceName: string | null
  payloadHash: string
}

/** A patch applied by a single user-meaningful action. Used by both
 *  undo (revert) and redo (re-apply). One of three discriminated shapes
 *  so the reducer can fast-path the common case (description text) and
 *  the bulk cases (kinks). */
export type UndoPatch =
  | {
      kind: 'set'                       // generic dotted-path replace
      path: string
      before: unknown
      after: unknown
    }
  | {
      kind: 'replace-overlay'           // multi-path edit (reset, bulk)
      beforePayload: WorkingPayload
      beforeOverlay: string[]
      afterPayload: WorkingPayload
      afterOverlay: string[]
    }
  | {
      kind: 'rename-set'
      setId: string
      before: string
      after: string
    }
```

`replace-overlay` is the catch-all for multi-field changes (custom-kinks
reorder, bulk-set-choice, reset-to-Live, etc.). It's expensive to store
(deep clones of the payload) but cheap to apply, and large bulk ops are
rare. The renderer caps the undo stack at **50 entries per set**; the
oldest entry drops off when the cap is hit.

---

## UX — the accordion pane

### Character-loaded, default state (~485 px budget; design for 400 px)

```
┌──────────────────────────────┐
│ ACTIVE CHARACTER             │  unchanged
│ ┌──────────────────────────┐ │
│ │ Lyra ▾   ●               │ │
│ └──────────────────────────┘ │
│ ┌──────┬───────────────────┐ │
│ │ Logs │ Editor            │ │  unchanged
│ └──────┴───────────────────┘ │
│ [↻ Refresh]  [⬇ Export ZIP] │  flist-zone titlebar (chip + actions)
│ ⌄ My edits · saved 2m ago   │  flist-zone "live/working" toggle
│ ─────────────────────────   │
│ ▸ SNIPPETS (global) · 14   │  ← 28 px header, collapsed
│ ─────────────────────────   │
│ ▾ WORKING SETS for Lyra (3)│  ← 28 px header, OPEN
│   [+ New set ▾]   (?)       │     28 px button row
│   ⤺ Undo · ⤻ Redo · 2 edits│     20 px undo strip
│   ▾ ✱ Main · 2m ago         │  ← active set, expanded
│       Snapshots (3)         │
│       · Pre-rewrite  2026-06│
│         ↺ Revert  ⋯         │
│       · After kinks  2026-05│
│       · Baseline     2026-05│
│       [+ Take snapshot]     │
│   ▸   Modern AU  · 3d ago  │  ← collapsed
│   ▸   Sub variant · 1w ago │
│ ─────────────────────────   │
│ ▾ BACKUPS for Lyra (12)    │  ← 28 px header, OPEN
│   [+ Make backup…]   (?)    │     28 px button row
│   06-02 18:44  4.2 MB       │
│   🟢 Auto pull              │
│   ───────────               │
│   06-02 14:12  4.1 MB       │
│   🔵 Set: Main              │
│   ───────────               │
│   05-30 09:11  4.1 MB       │
│   🔵 Snapshot: Pre-rewrite  │
│   …  (scroll inside section)│
└──────────────────────────────┘
```

Section bodies each have a `max-height` (40 % / 50 % / 30 % of the
accordion budget when all three open; renderer adjusts when fewer are
open). Each body overflows internally — Snippets scrolling can't push
Working sets off-screen.

### No-character state

```
┌──────────────────────────────┐
│ ACTIVE CHARACTER             │
│ ┌──────────────────────────┐ │
│ │ Sign in to F-list ▾      │ │
│ └──────────────────────────┘ │
│ ─────────────────────────   │
│ ▾ SNIPPETS (global) · 14   │
│   [+ Snippet] [+ Folder] (?)│
│   🔎 Filter snippets…       │
│   …  (full pane height —    │
│       Working sets +        │
│       Backups headers       │
│       collapse to their     │
│       28-px placeholder)    │
│ ─────────────────────────   │
│ ▸ WORKING SETS (sign in)   │  ← disabled, greyed, no count
│ ─────────────────────────   │
│ ▸ BACKUPS (sign in)        │  ← disabled, greyed, no count
└──────────────────────────────┘
```

Clicking either disabled header is a no-op (cursor stays default).
Tooltip on hover: "Sign in to F-list and pick a character to see this."

### Section-state table

| Section       | No character signed-in | Character loaded                                |
|---------------|------------------------|-------------------------------------------------|
| Snippets      | Open by default        | Collapsed by default (count visible)            |
| Working sets  | Header only, disabled  | Open by default, active set's row auto-expanded |
| Backups       | Header only, disabled  | Open by default                                 |

Once a character is loaded, the user's open/collapsed overrides per
section persist to
`localStorage['flist-workbench:accordion:<characterId>']`. Cross-
character switches preserve open state on Snippets (global) and reset
Working sets / Backups to defaults so each character lands cleanly. The
active set's expansion-of-snapshots is sticky per-set within a session;
flipping back and forth between sets remembers per-set expansion.

### Right-click menus

#### Snippet row (unchanged from today)

```
┌──────────────────────────┐
│ Rename…                  │
│ Move to folder…       ▸  │
│ Duplicate                │
│ Delete…                  │
└──────────────────────────┘
```

#### Working-set row

```
┌──────────────────────────┐
│ Activate                 │   greyed when already active
│ Rename…                  │
│ Duplicate…               │
│ Take snapshot            │   convenience — same action as the
│ Create backup from this  │   inline buttons
│ Delete…                  │
└──────────────────────────┘
```

#### Snapshot row

```
┌──────────────────────────────┐
│ Rename…                      │
│ Revert this set to snapshot… │   confirm modal; auto-takes a
│ Create backup from this      │   safety snapshot of current set
│ Delete… (5s undo)            │
└──────────────────────────────┘
```

#### Backup row

```
┌──────────────────────────┐
│ Reveal in folder         │
│ Copy path                │
│ Export ZIP to…           │
│ Restore as new set       │   (deferred — disabled with tooltip
│ Delete…                  │    "Import-as-set lands later")
└──────────────────────────┘
```

`Export ZIP to…` opens Electron's save-file dialog and copies the file;
the original stays in `backups/`. `Reveal in folder` uses
`shell.showItemInFolder` (already imported in `electron/menu.ts`).
`Delete…` requires an explicit confirm modal — owner said
"keep forever, but delete remains an escape hatch."

### Undo / Redo affordance

Two icon buttons in the Working-sets section header row, immediately
under the `[+ New set ▾]` button:

```
⤺ Undo · ⤻ Redo · 2 edits
```

- Disabled when stack empty (visual: muted opacity, no hover state).
- Tooltip on each: action description from the top of the stack
  ("Undo: edited description" / "Undo: bulk-set-choice 8 kinks").
- Keyboard: `Ctrl+Z` = undo, `Ctrl+Shift+Z` = redo (also `Ctrl+Y`
  on Windows). Bound at the document level; suppressed when focus is
  inside an `<input>`/`<textarea>` or CodeMirror (those keep their
  own undo). The renderer routes through the active-set's stack.
- Visible only when Working sets section is expanded; keyboard
  shortcuts still work when it's collapsed.

---

## Sidecar API

All routes are under `/flist/character/{character_id}/...`. JSON
responses; If-Match etag honoured per Tier 2's contract.

### Sets

| Method | Path                                    | Body / Query                          | Returns / Errors                                    |
|--------|-----------------------------------------|---------------------------------------|-----------------------------------------------------|
| GET    | `/sets`                                 | —                                     | `{sets: SetMeta[], active_set_id: str}` (200)       |
| POST   | `/sets`                                 | `{name, seed: "live"\|"empty"\|{"fork": "<set_id>"}}` | `{set: SetMeta}` (201); 422 on bad seed     |
| PATCH  | `/sets/{set_id}`                        | `{name}`                              | `{set: SetMeta}` (200); 404 missing; 422 bad name   |
| DELETE | `/sets/{set_id}`                        | —                                     | `{deleted: bool, new_active_set_id: str}` (200);     |
|        |                                         |                                       | 409 if the request would leave no sets; 404 missing |
| POST   | `/sets/{set_id}/activate`               | —                                     | `{active_set_id: str}` (200); 404 missing           |
| GET    | `/sets/{set_id}/payload`                | —                                     | `{payload, etag}` (200); 404 missing                |
| PUT    | `/sets/{set_id}/payload`                | full payload; `If-Match: <sha256>`    | `{etag}` (200); 409 mismatch; 422 bad payload       |

Naming rules: 1-80 unicode chars, no `\0`, no leading/trailing
whitespace. Server canonicalises by stripping surrounding whitespace.
Duplicate names across sets are allowed (UI disambiguates by `(2)`
suffix at render time, same convention as the custom-kink rail).

`POST /sets` seed cases:
- `seed = "live"` — payload from current `live.json` via the existing
  `_seed_working_from_live` helper. 409 when no live exists.
- `seed = "empty"` — empty payload (only `_schema_version` and
  `_overlay = []`). User then opens it and starts blank.
- `seed = {"fork": "<set_id>"}` — deep-copy the named set's payload.
  404 when that set doesn't exist.

`DELETE /sets/{set_id}` business rule: the renderer must include
`?next_active=<set_id>` when deleting the currently-active set. The
server refuses to delete the only set (409 with
`detail: "cannot delete only set"`).

### Snapshots

| Method | Path                                                   | Body                  | Returns / Errors                              |
|--------|--------------------------------------------------------|-----------------------|-----------------------------------------------|
| POST   | `/sets/{set_id}/snapshots`                             | `{name}`              | `{snapshot: SnapshotMeta}` (201)              |
| PATCH  | `/sets/{set_id}/snapshots/{snap_id}`                   | `{name}`              | `{snapshot: SnapshotMeta}` (200); 404         |
| DELETE | `/sets/{set_id}/snapshots/{snap_id}`                   | —                     | `{deleted: bool}` (200)                       |
| POST   | `/sets/{set_id}/snapshots/{snap_id}/revert`            | —                     | `{set: SetMeta, safety_snapshot_id: str}` (200); 404 |
| GET    | `/sets/{set_id}/snapshots/{snap_id}`                   | —                     | `{snapshot: SnapshotMeta, payload: WorkingPayload}` (200); 404 |

Revert always takes a safety snapshot of the current set state first,
named `Auto-safety @ <time>`. The renderer surfaces `safety_snapshot_id`
in a 5-second undo banner — Undo deletes the just-applied revert by
reverting AGAIN to that safety snapshot.

Snapshot creation reads the current payload from disk (not from any
in-flight renderer edit). Renderer is responsible for flushing any
pending autosave before triggering snapshot creation.

### Backups (auto + manual)

| Method | Path                                            | Body                                                | Returns / Errors                                |
|--------|-------------------------------------------------|-----------------------------------------------------|-------------------------------------------------|
| GET    | `/backups`                                      | —                                                   | `{backups: BackupListing[]}` (newest first)     |
| POST   | `/backups`                                      | `{source: "set"\|"snapshot", set_id, snapshot_id?}` | `{backup: BackupListing}` (201); 404 missing src; 422 bad source |
| DELETE | `/backups/{filename}`                           | —                                                   | `{deleted: bool}` (200)                         |
| GET    | `/backups/{filename}/path`                      | —                                                   | `{abs_path: str}` (200); 404                    |
| GET    | `/backups/{filename}/download`                  | —                                                   | `application/zip` stream (200); 404             |

Filename safety: `/backups/{filename}` paths regex-validate against
`r"^[0-9T\-_a-zA-Z\.]+\.zip$"` (timestamp + ASCII source-tag +
hash). Anything outside the regex 400s without touching disk —
prevents path-traversal via crafted filenames. Legacy `*.json` is
**served read-only** by `GET /backups/{filename}/download` (for Reveal
/ Copy path) but rejected by the regex on DELETE for safety. Owner can
remove via the filesystem; surfaced in BACKLOG.

### Back-compat redirects (during the migration window)

The existing routes used by Tier 2-6 renderers stay alive for one
release:

```
GET    /flist/character/{id}/working
PUT    /flist/character/{id}/working
DELETE /flist/character/{id}/working
```

These resolve via `active_set.json` and proxy to
`/sets/{active}/payload` (same If-Match semantics). The
`POST /flist/character/{id}/backup` route now writes a ZIP backup from
the active set (was: dump of live.json into `backups/<unix>.json`). The
old `<unix>.json` dump is removed in this release — the `legacy-json`
view in the Backups list is read-only.

When the v7 renderer ships, these shim routes are deleted in the same
PR — there's no third-party consumer to worry about.

---

## Renderer state

Existing slice grows. **`flistWorkingPayload` becomes a getter** rather
than stored state — there is no longer a top-level "current working
payload" because the source of truth is `sets[activeSetId].payload`.
Selectors derive the active payload on read.

```ts
// repo/renderer/src/state/flist.ts (additions)

export interface FlistState {
  // existing fields …

  /** Per-character set metadata, ordered newest-first by updatedAt. */
  flistSets: Record<string, SetMeta[]>
  flistSetsStatus: Record<string, 'idle' | 'loading' | 'ready' | 'error'>

  /** Active set id per character. Persisted to active_set.json server-
   *  side; renderer mirrors so chips don't flicker. */
  flistActiveSetId: Record<string, string>

  /** Snapshots per set. Keyed by setId across all characters since
   *  uuids don't collide. */
  flistSetSnapshots: Record<string, SnapshotMeta[]>

  /** Working-copy slot — was `flistWorking[characterId]`; now
   *  `flistSetWorking[setId]`. Tier 7 keeps the per-set granularity so
   *  switching sets keeps each set's autosave / dirty / etag state. */
  flistSetWorking: Record<string, FlistWorkingSlot>
  flistSetWorkingLoadStatus: Record<string, 'idle' | 'loading' | 'ready' | 'error'>

  /** In-memory undo / redo. NOT persisted to disk. Per-set so switching
   *  sets swaps stacks atomically. */
  flistSetUndoStack: Record<string, UndoPatch[]>
  flistSetRedoStack: Record<string, UndoPatch[]>

  /** Per-character backups list (ZIPs). Replaces the JSON-only Tier 1
   *  list shape. */
  flistBackupsList: Record<string, BackupListing[]>
  flistBackupsStatus: Record<string, 'idle' | 'loading' | 'ready' | 'error'>

  /** Open/closed pane state, mirrored from localStorage. */
  flistAccordion: Record<
    string,
    { snippets: boolean; sets: boolean; backups: boolean }
  >

  // ---- actions ----
  flistLoadSets: (characterId: string) => Promise<void>
  flistCreateSet: (
    characterId: string,
    args: { name: string; seed: 'live' | 'empty' | { fork: string } }
  ) => Promise<SetMeta>
  flistRenameSet: (characterId: string, setId: string, name: string) => Promise<void>
  flistDuplicateSet: (
    characterId: string,
    setId: string,
    name: string
  ) => Promise<SetMeta>
  flistDeleteSet: (
    characterId: string,
    setId: string,
    nextActiveSetId?: string
  ) => Promise<void>
  flistActivateSet: (characterId: string, setId: string) => Promise<void>

  flistLoadSnapshots: (characterId: string, setId: string) => Promise<void>
  flistTakeSnapshot: (
    characterId: string,
    setId: string,
    name: string
  ) => Promise<SnapshotMeta>
  flistRenameSnapshot: (
    characterId: string,
    setId: string,
    snapshotId: string,
    name: string
  ) => Promise<void>
  flistRevertToSnapshot: (
    characterId: string,
    setId: string,
    snapshotId: string
  ) => Promise<{ safetySnapshotId: string }>
  flistDeleteSnapshot: (
    characterId: string,
    setId: string,
    snapshotId: string
  ) => Promise<void>

  flistLoadBackups: (characterId: string) => Promise<void>
  flistCreateBackup: (
    characterId: string,
    args:
      | { from: 'set'; setId: string }
      | { from: 'snapshot'; setId: string; snapshotId: string }
  ) => Promise<BackupListing>
  flistDeleteBackup: (characterId: string, filename: string) => Promise<void>
  flistRevealBackup: (characterId: string, filename: string) => Promise<void>
  flistExportBackupAs: (characterId: string, filename: string) => Promise<void>

  flistUndo: (characterId: string) => void
  flistRedo: (characterId: string) => void
  flistRecordPatch: (setId: string, patch: UndoPatch) => void
}
```

### `flistWorkingPayload` getter

Today's `flistWorking[characterId].payload` reads are replaced with a
helper that resolves through the active set:

```ts
export function selectWorkingSlot(
  s: FlistState,
  characterId: string
): FlistWorkingSlot | undefined {
  const setId = s.flistActiveSetId[characterId]
  if (!setId) return undefined
  return s.flistSetWorking[setId]
}
```

Existing consumers (`EditorPane`, `ProfileFieldsTab`, `CustomKinksPane`,
`StandardKinksPane`, `ImagesTab`, `DiffPane`) migrate to this selector
in a mechanical sweep — the path goes from `flistWorking[id]` to
`selectWorkingSlot(s, id)`. The store stays the single source of truth;
no caller derives `activeSetId` independently.

### Action ↔ patch granularity

Every store action that mutates a working payload calls
`flistRecordPatch(activeSetId, …)` synchronously after the mutation.
Granularity rules:

| Surface                         | Debounce             | Patch kind            |
|---------------------------------|----------------------|-----------------------|
| Description CodeMirror edit     | 500 ms quiet         | `set` (path = `character.description`) |
| Infotag text/list change        | immediate            | `set`                 |
| Infotag clear                   | immediate            | `set` (after = `undefined`) |
| Kink choice flip                | immediate            | `set`                 |
| Custom-kink name/desc edit      | 500 / 1500 ms        | `set`                 |
| Custom-kink tombstone           | immediate            | `replace-overlay`     |
| Custom-kink add / reorder       | immediate            | `replace-overlay`     |
| Bulk-set-choice                 | immediate            | `replace-overlay`     |
| Reset-to-Live (whole char)      | immediate            | `replace-overlay`     |
| Reset row to source             | immediate            | `set`                 |
| Set rename                      | immediate            | `rename-set`          |
| Image gallery reorder / pool↔profile | immediate       | `replace-overlay`     |

The 500 ms quiet-time on description matches today's autosave debounce.
Per-keystroke undo would be miserable; one-edit-per-pause matches
common editor mental models (VS Code, Slack composer).

`flistRecordPatch` clears the redo stack and pushes the patch. The
undo stack is capped at 50 entries — when the push would exceed 50, the
oldest entry is dropped (shift). The renderer never persists these.

---

## Auto-backup on pull

Hook lands at the END of `pull_character_async` in `server.py`, after
the existing `compute_pull_status` call (line ~610) and before the
`done` SSE event is yielded:

```python
# server.py — inside pull_character_async, after pull_state seal +
# before the `yield _sse_event("done", …)` block.

if pull_status["status"] in ("complete", "partial"):
    try:
        backup_listing = character_archive.create_backup_from_live(
            cid,
            payload_for_export=live_payload,
            source="auto-pull",
            source_name=None,
        )
    except Exception as exc:  # noqa: BLE001 — non-fatal
        flist_activity.record(
            "pull-warning",
            stage="auto-backup",
            name=name,
            error=repr(exc),
        )
        backup_listing = None
else:
    # status == "interrupted" or "never_pulled"; skip auto-backup.
    backup_listing = None
```

The `done` event grows one optional field
`auto_backup_filename: str | None` so the renderer can refresh its
backups list inline without a separate round-trip.

**Failed/cancelled pulls don't write a backup.** Status `interrupted`
or any earlier `error` event bails before this hook. Networking failures
mid-image-loop still surface as `partial` → an auto-backup IS written
because the user has *something* worth keeping (live.json + the images
that did download). Owner agreed that capturing partial progress is
useful — the alternative loses every pull where one image hits a 5xx.

`create_backup_from_live(cid, ..., source="auto-pull")` builds the ZIP
using:
- `character.json` = the freshly-pulled live payload (no working copy
  involved). Avoids stamping over user edits.
- `images/<image_id>.<ext>` = exactly the files referenced by the live
  gallery, read from `images/` on disk. Missing files are skipped.
- `avatar.png` = current avatar file if present.

Implementation reuses `zip_serialise.build_zip(...)` with a small
`_seed_working_from_live(live)` adapter (identical to the existing one
in `server.py` for the export route).

---

## Manual backup creation

Endpoint: `POST /flist/character/{id}/backups` body
`{source: "set"|"snapshot", set_id, snapshot_id?}`.

Flow:

1. Resolve the source payload:
   - `source == "set"` → read `sets/<set_id>/payload.json`. 404 if
     missing.
   - `source == "snapshot"` → read
     `sets/<set_id>/snapshots/<snapshot_id>.json`. 404 if missing.
2. Compose the ZIP via `zip_serialise.build_zip(cid, payload,
   images_dir=…, avatar_path=…)`. The serialiser already filters
   missing-image rows + writes only one copy of each image file.
3. Compute `payload_hash = sha256(canonical_json(payload))[:8]`.
4. Compose the filename:
   ```
   <iso_ts>__<source>__<sanitised_name>__<hash>.zip
   e.g. 2026-06-02T18-44-00__manual-snapshot__Pre-rewrite__7c2d.zip
        2026-06-02T18-44-01__auto-pull__d2f8.zip
   ```
   The source-name segment is omitted for `auto-pull`. Source-name
   sanitisation: `re.sub(r"[^A-Za-z0-9._-]+", "_", name)[:32]`.
5. Atomic write (tmp + rename), then return the `BackupListing` row.

**Bytes-from-where contract.** Snapshots reference images by image_id
only — no embedded bytes. When a snapshot's referenced image isn't on
disk under `images/<image_id>.<ext>` (rare; only happens if the user
explicitly deleted the file from the pool view after taking the
snapshot), the backup is still produced — the image row is silently
dropped by `zip_serialise.build_zip` (same behaviour as the export-zip
route). Owner accepts the gap; the alternative is forcing snapshots to
carry bytes, which defeats their "metadata only" purpose.

`POST /backups` for `source == "set"` with the set's
`payload.json` returning bytes that hash to the same `payload_hash` as
a backup taken in the same calendar second is **non-idempotent** — the
ISO timestamp differs by at most one second, but the hash collides
intentionally to mean "same content." Practical effect: two clicks on
"Create backup" in <1 s produce two different filenames with the same
hash; UI dedupes by hash when rendering. Not a problem for users —
documented for the test.

---

## Undo / redo internals

### Patch shape choice

`UndoPatch` is **tagged-action**, not pure JSON-Pointer. The renderer
already has a working knowledge of dotted paths (`_overlay`), and a
JSON-Pointer-only design would lose semantic info (was this an
infotag clear, or an explicit `undefined` set?). Tagged action lets the
reducer round-trip cleanly while keeping the cheap-case (single field
edit) small.

### Stack operations

```ts
// Pseudocode for the apply layer:
function flistUndo(s: State, characterId: string): State {
  const setId = s.flistActiveSetId[characterId]
  if (!setId) return s
  const stack = s.flistSetUndoStack[setId] ?? []
  if (stack.length === 0) return s
  const patch = stack[stack.length - 1]
  const nextStack = stack.slice(0, -1)
  const nextRedo = [...(s.flistSetRedoStack[setId] ?? []), patch]
  const nextSlot = revertPatch(s.flistSetWorking[setId], patch)
  scheduleAutosaveFlush(characterId, setId)
  return {
    ...s,
    flistSetWorking: { ...s.flistSetWorking, [setId]: nextSlot },
    flistSetUndoStack: { ...s.flistSetUndoStack, [setId]: nextStack },
    flistSetRedoStack: { ...s.flistSetRedoStack, [setId]: nextRedo }
  }
}

function revertPatch(slot: FlistWorkingSlot, patch: UndoPatch): FlistWorkingSlot {
  switch (patch.kind) {
    case 'set':           return applyEdit(slot, patch.path, patch.before)
    case 'replace-overlay':
      return { ...slot, payload: structuredClone(patch.beforePayload),
               overlay: [...patch.beforeOverlay], unsavedDirty: true,
               saveStatus: 'idle' }
    case 'rename-set':    // no-op against the slot — handled at set-meta layer
      return slot
  }
}
```

Redo is the mirror image: pop redo, apply `after`, push back to undo.

### What clears the redo stack

- Any new user edit (the `flistRecordPatch` call).
- A set switch (`flistActivateSet`) — the redo stack for the previous
  set is preserved; the newly-active set's stack is independent.
- A character switch — same; per-set persistence in memory.

### What clears the undo stack

Nothing programmatically. The stack survives set switches and
character switches in memory. App reload (renderer process restart)
clears all stacks — owner accepted that the payload itself is what
matters; granular undo is a session affordance, not a permanent log.

### Memory footprint

The expensive case is `replace-overlay` — a full deep-clone of the
payload. Typical payload is 100-300 KB JSON. Worst case: 50 entries
× 300 KB = 15 MB per set. With three sets edited heavily in a
session, ~45 MB. Acceptable on a desktop machine; documented in
Risks below.

---

## Implementation step list

Numbered steps in approximate dependency order. Steps with no
dependency on each other can be parallelized (Steps 4-7 e.g.). Each
step is one reviewable PR-sized chunk.

### Step 1 — Sidecar: v6 storage layout + migration

- **Files:** `repo/sidecar/character_archive.py`,
  `repo/sidecar/tests/test_character_archive.py`,
  `repo/sidecar/tests/test_set_migration.py` (new).
- **Scope:** Add `sets_dir`, `set_dir`, `set_payload_path`,
  `set_meta_path`, `snapshots_dir`, `snapshot_path`,
  `active_set_path`, `read_set_meta`, `write_set_meta`,
  `read_set_payload`, `write_set_payload`, `read_active_set_id`,
  `set_active_set_id`. Bump `WORKING_SCHEMA_VERSION = 6`. Implement
  `migrate_v5_working_to_sets(character_id)` per the migration
  pseudo-code in "Storage layout v6." Make it idempotent and safe to
  re-run.
- **Test to write:** `test_migration_v5_to_v6_roundtrip` — seeds a
  tmpdir with v5 `working.json`, runs migration, asserts (a) sets/
  exists with one subdir, (b) `payload.json` content matches the
  original working.json (after schema bump), (c) `meta.json` has
  `name == "Main"`, (d) `active_set.json` points at the new set,
  (e) old `working.json` is gone, (f) re-running migration is a no-op.
  Add: `test_migration_v5_without_working_json` — directory with only
  `live.json` migrates without minting an empty set; first edit then
  creates "Main" lazily.

### Step 2 — Sidecar: sets CRUD endpoints

- **Files:** `repo/sidecar/server.py`,
  `repo/sidecar/tests/test_sets_api.py` (new).
- **Scope:** Add `GET/POST /sets`, `PATCH/DELETE /sets/{set_id}`,
  `POST /sets/{set_id}/activate`, `GET/PUT /sets/{set_id}/payload`.
  Reuse `EtagMismatch` from Tier 2. Validate `name` (1-80 chars, no
  `\0`). Refuse `DELETE` of the only set with 409. `POST` accepts
  `seed: "live"|"empty"|{fork}` and dispatches.
- **Test to write:** `test_sets_crud_roundtrip` — create 3 sets,
  rename one, duplicate, delete one (not active), activate another;
  verify `GET /sets` reflects all changes. `test_sets_cannot_delete_only_set`.
  `test_sets_payload_if_match_mismatch_409`.
  `test_sets_payload_seed_empty_vs_fork`.

### Step 3 — Sidecar: snapshots endpoints

- **Files:** `repo/sidecar/character_archive.py`,
  `repo/sidecar/server.py`,
  `repo/sidecar/tests/test_snapshots_api.py` (new).
- **Scope:** `read_snapshots`, `write_snapshot`, `read_snapshot_payload`
  in `character_archive.py`. Add `POST/PATCH/DELETE /sets/{set_id}/snapshots[…]`
  and `POST /sets/{set_id}/snapshots/{snap_id}/revert`. Revert
  automatically writes a safety snapshot first (named
  `Auto-safety @ <iso_time>`) and returns its id.
- **Test to write:** `test_snapshot_revert_creates_safety` — set has
  description "A", take snapshot "S1", edit description to "B",
  revert to S1, assert (a) current payload description == "A",
  (b) snapshots list now has S1 + an "Auto-safety @ …" snapshot,
  (c) the safety snapshot's payload description == "B".

### Step 4 — Sidecar: backup ZIP create + list + delete

- **Files:** `repo/sidecar/character_archive.py`,
  `repo/sidecar/zip_serialise.py` (small reuse),
  `repo/sidecar/server.py`,
  `repo/sidecar/tests/test_backups_zip_api.py` (new).
- **Scope:** Add `create_backup_from_payload(cid, payload, source,
  source_name)` in `character_archive.py` — composes the ZIP via
  `zip_serialise.build_zip`, writes to `backups/<filename>.zip`.
  Add `list_backups_v6(cid)` returning `BackupListing` rows parsed
  from the filename (with `legacy-json` fallback for `*.json`).
  Replace `POST /backups` to accept `{source, set_id, snapshot_id?}`
  and call `create_backup_from_payload`. Add `DELETE /backups/{filename}`
  and `GET /backups/{filename}/path` and `GET /backups/{filename}/download`.
  Validate filenames against the regex.
- **Test to write:** `test_create_backup_from_set_produces_valid_zip`
  — POST `/backups` body `{source: "set", set_id}` → assert response
  is a `BackupListing`, file exists at the returned path, ZIP contains
  `character.json` + at least one `images/<id>.<ext>` matching the
  set's gallery. `test_filename_regex_rejects_traversal` —
  DELETE `backups/../etc/passwd.zip` → 400. `test_legacy_json_listed_as_legacy`
  — seed `backups/1700000000.json`, GET `/backups` includes a row
  with `source == "legacy-json"`.

### Step 5 — Sidecar: auto-backup hook in pull pipeline

- **Files:** `repo/sidecar/server.py` (in `pull_character_async`),
  `repo/sidecar/tests/test_pull_auto_backup.py` (new).
- **Scope:** Add the auto-backup call after the manifest seal + before
  the `done` SSE. Extend the `done` event to include
  `auto_backup_filename`. Skip on `status in ("never_pulled",
  "interrupted")`. Wrap in try/except so a failed backup doesn't
  fail the whole pull (records to `flist_activity` instead).
- **Test to write:** `test_auto_backup_after_pull` — drive a mocked
  pull with httpx_mock for the JSON + image endpoints, assert
  `backups/<…>__auto-pull__<hash>.zip` exists after the pull,
  `done` event carries `auto_backup_filename`. Mock a backup-create
  exception → pull still completes, `flist_activity` has a
  `pull-warning` event.

### Step 6 — Sidecar: back-compat redirect routes

- **Files:** `repo/sidecar/server.py`,
  `repo/sidecar/tests/test_working_legacy_compat.py` (new).
- **Scope:** `GET/PUT/DELETE /flist/character/{id}/working` resolve
  via `active_set.json` and proxy to `/sets/{active}/payload`. Pass
  through `If-Match`. These ship for one release then are removed in
  the same PR that updates the renderer (Step 9). Document in code +
  add a release note.
- **Test to write:** `test_legacy_working_routes_proxy_active_set`
  — POST a set, activate it, PUT to `/working` → assert the bytes
  land in `sets/{active}/payload.json`.

### Step 7 — Renderer: state-slice surgery

- **Files:** `repo/renderer/src/state/flist.ts`,
  `repo/renderer/src/state.ts`,
  `repo/renderer/src/lib/api.ts`,
  `repo/renderer/src/__tests__/state-flist-sets.test.ts` (new).
- **Scope:** Add the `flistSets`, `flistActiveSetId`,
  `flistSetSnapshots`, `flistSetWorking`, `flistSetUndoStack`,
  `flistSetRedoStack`, `flistBackupsList`, `flistAccordion` fields.
  Implement the new actions per the spec above. Add the
  `selectWorkingSlot` selector. Add `api.flistSetsList`,
  `api.flistSetsCreate`, `…Rename`, `…Delete`, `…Activate`,
  `…PayloadGet`, `…PayloadPut`, `…SnapshotsList`, `…SnapshotCreate`,
  `…SnapshotRevert`, etc. **Do not yet migrate the consumers** —
  Steps 8 + 10 do the consumer sweep.
- **Test to write:** vitest snapshot of the slice's initial state +
  unit tests for `flistRecordPatch` (capacity capped at 50, redo
  cleared on new push), `flistUndo` / `flistRedo` round-trip on a
  `set` patch, `flistUndo` no-op when stack empty.

### Step 8 — Renderer: replace `flistWorkingPayload` references with selector

- **Files:** every TSX file currently reading `state.flistWorking[id]`
  — confirmed by grep:
  - `features/editor/EditorPane.tsx`
  - `features/editor/PreviewPane.tsx`
  - `features/flist/ProfileFieldsTab.tsx`
  - `features/flist/CustomKinksPane.tsx`, `KinkListRail.tsx`,
    `KinkDetailPane.tsx`
  - `features/flist/StandardKinksPane.tsx`,
    `StandardKinksBucketView.tsx`
  - `features/flist/ImagesTab.tsx`, `GallerySection.tsx`,
    `PoolSection.tsx`
  - `features/flist/DiffPane.tsx`
  - `features/flist/ExportRestoreModal.tsx`
  - `features/flist/FlistCharacterZone.tsx`
- **Scope:** Mechanical sweep. `useStore((s) => s.flistWorking[id])`
  becomes `useStore((s) => selectWorkingSlot(s, id))`. Likewise for
  `flistWorkingLoadStatus` (read from `flistSetWorkingLoadStatus`
  keyed by activeSetId). Mutators (`flistSetWorkingField`, etc.) now
  internally route through the active set.
- **Test to write:** existing vitest snapshots should keep passing
  unchanged; if any snapshot delta surfaces a path that was reaching
  for stored vs derived, fix the snapshot. New unit test:
  `test_active_set_switch_swaps_working_slot` — render hook with two
  sets, call `flistActivateSet`, assert `selectWorkingSlot` returns
  the new set's slot.

### Step 9 — Renderer: accordion shell + Snippets section move

- **Files:** `repo/renderer/src/features/sidebar/Sidebar.tsx`
  (extract the right region into an Accordion shell),
  `repo/renderer/src/features/sidebar/AccordionPane.tsx` (new),
  `repo/renderer/src/features/sidebar/SnippetList.tsx` (wrap in a
  section — internal content unchanged).
- **Scope:** Create the AccordionPane primitive: three named sections
  with controlled `expanded` state, `max-height` and internal scroll
  per section, headers with `▸/▾` chevron + label + count + actions
  slot. Hook to `localStorage['flist-workbench:accordion:<characterId>']`
  for character-loaded state; ephemeral state for no-character. Move
  `<SnippetList />` into the Snippets section. Render Working sets +
  Backups headers in their disabled state when no character is
  signed in.
- **Test to write:** vitest snapshot of AccordionPane with three
  sections (all collapsed / one open / all open). Snapshot of the
  no-character state shows two disabled headers.

### Step 10 — Renderer: Working sets section

- **Files:** `repo/renderer/src/features/sidebar/WorkingSetsSection.tsx`
  (new), `repo/renderer/src/features/sidebar/WorkingSetRow.tsx` (new),
  `repo/renderer/src/features/sidebar/UndoRedoStrip.tsx` (new),
  `repo/renderer/src/features/sidebar/NewSetMenu.tsx` (new — the
  `[+ New set ▾]` dropdown with seed picker).
- **Scope:** Render `flistSets[characterId]` as a vertical list with
  the active set marked `✱` + auto-expanded. Inline rename on header
  click. Right-click menu per requirements. `[+ Take snapshot]`
  button at the bottom of an expanded set's snapshot list. Snapshot
  rows with `↺ Revert` + `⋯` (right-click also). Inline-rename
  inputs follow the existing snippet-rename pattern (sandboxed
  Electron blocks `window.prompt`). Confirm modals reuse the existing
  modal infrastructure with the **no-backdrop-dismiss** rule.
- **Test to write:** vitest snapshot of the section in all-three-open
  state with seeded `flistSets` / `flistSetSnapshots`. Integration
  test: clicking `Activate` on a non-active row calls
  `flistActivateSet`. Clicking `Take snapshot` on an active row calls
  `flistTakeSnapshot` and re-renders with the new row.

### Step 11 — Renderer: Backups section

- **Files:** `repo/renderer/src/features/sidebar/BackupsSection.tsx`
  (new), `repo/renderer/src/features/sidebar/BackupRow.tsx` (new),
  `repo/renderer/src/features/flist/MakeBackupModal.tsx` (new —
  picker: from active set / from a snapshot).
- **Scope:** Render `flistBackupsList[characterId]` newest-first with
  source badge (🟢 auto / 🔵 manual) + size + relative timestamp +
  ZIP filename on hover. Right-click menu (Reveal in folder / Copy
  path / Export ZIP to… / Delete…). Internal scroll once > 20 rows.
  `[+ Make backup…]` opens MakeBackupModal — single dropdown
  (default = active set; other options are the active set's
  snapshots), then `[Cancel] [Create]`.
- **Test to write:** vitest snapshot for empty backups, 3 backups
  (one of each source kind). Playwright case in step 15 covers the
  right-click menu rendering.

### Step 12 — Renderer: Native menu integration

- **Files:** `repo/electron/menu.ts`,
  `repo/renderer/src/menuActions.ts`.
- **Scope:** Per CLAUDE.md "app chrome lives in the native menu":
  add menu items under `Tools` (or a new top-level `Character`
  submenu if Tools is already busy — TBD during review):
  - `Tools → Take snapshot of active set` (Ctrl+Shift+S; greyed when
    no character)
  - `Tools → Create backup from active set` (no shortcut)
  - `Tools → Working sets ▸ New set…` (Ctrl+Shift+N)
  - `Tools → Working sets ▸ Rename active set…`
  - `Edit → Undo` and `Edit → Redo` rebind so they invoke
    `flistUndo` / `flistRedo` when the active surface is the F-list
    editor (and not a CodeMirror / `<input>` that owns its undo).
- **Test to write:** unit test in `menuActions` that the channels are
  wired; manual smoke for the keybindings since Playwright + native
  menus is flaky.

### Step 13 — Renderer: Undo/redo wiring across surfaces

- **Files:** every store action that mutates a working payload.
  `repo/renderer/src/state/flist.ts` adds `withPatch(setId, prev, next,
  patch)` wrapper. Mutator actions call `flistRecordPatch` after
  applying.
- **Scope:** Audit list:
  - `flistSetWorkingField` → 'set' patch with `before = oldValue,
    after = newValue` (debounce-coalesced for description; see
    Granularity table).
  - `flistResetWorkingField` → 'set' patch with `after = liveValue`.
  - `flistCustomKinksEdit` → 'set' patch per field.
  - `flistCustomKinksTombstone` / `…BulkTombstone` →
    `replace-overlay` (already a multi-field op).
  - `flistCustomKinksReorder` → `replace-overlay`.
  - `flistStandardKinkSet` / `…BulkSetChoice` →
    `'set'` per id (bulk uses `replace-overlay` for atomicity).
  - `flistMoveImageToProfile` / `…ToPool` / `flistSetGalleryImages` →
    `replace-overlay` (galleries are arrays; per-row patching is too
    fiddly).
  - `flistResetWorkingToLive` / `…ToBackup` → `replace-overlay`.
- **Test to write:** new `state-undo.test.ts` —
  - Edit description, undo, payload reverts; redo, returns.
  - Bulk-set-choice 5 kinks → one undo entry, undo reverts all 5.
  - Stack capped at 50 (51st push drops oldest).
  - Set switch + undo on the new set doesn't affect prior set.

### Step 14 — Renderer: Diff tab right-source picker extension

- **Files:** `repo/renderer/src/features/flist/DiffPane.tsx`,
  `repo/renderer/src/features/flist/BackupPicker.tsx`.
- **Scope:** Extend `FlistDiffRightSource`:
  ```ts
  type FlistDiffRightSource =
    | { kind: 'live' }
    | { kind: 'backup'; filename: string }
    | { kind: 'snapshot'; setId: string; snapshotId: string }
    | { kind: 'set'; setId: string }    // other working set
  ```
  Picker renders four grouped options. Diff comparator uses
  `flistDiffLoadSnapshot` and `selectWorkingSlot` for set-vs-set.
  **No new UI for snapshot-vs-snapshot picker in Tier 7** — out of
  scope per requirements; the engine supports it but only the
  Working-vs-X selector is built. Deferred to BACKLOG.
- **Test to write:** vitest snapshot of the picker with one snapshot
  + two other sets in the data. Diff engine test: working ≠
  snapshot produces the same `modified` row count as working ≠ live
  when the snapshot was taken right after a Live re-pull.

### Step 15 — Visual verification harness

- **Files:** `repo/tests/uxtest/sets-pane.spec.ts` (new),
  `repo/tests/uxtest/seed-sets-archive.py` (new).
- **Scope:** Seed a character archive at `<userData>/characters/9998/`
  with:
  - `live.json` for character "Sample Hero".
  - 24 synthetic images (reuse the existing seed-images-archive PNG
    builder).
  - 3 sets (`Main`, `Modern AU`, `Sub variant`), each with a slightly
    different description.
  - 2 snapshots per set with varied names.
  - 4 backups in `backups/`: 1 `auto-pull`, 2 `manual-set` (one per
    different set), 1 `manual-snapshot`.
  Then launch the Electron app + screenshot:
  1. `tier7-no-character` — sign-out state, snippets-open + the
     two disabled headers.
  2. `tier7-character-loaded-defaults` — Lyra signed in, all three
     sections, Snippets collapsed, Working sets + Backups open,
     active set's snapshots expanded.
  3. `tier7-working-set-expanded` — non-active set expanded.
  4. `tier7-backups-list` — Backups section scrolled mid-list.
  5. `tier7-right-click-set` — context menu open on a set row.
  6. `tier7-right-click-snapshot`, `tier7-right-click-backup`.
- **Test to write:** the spec file itself. Output to
  `tests/screenshots/` (gitignored) per the harness conventions.
  Owner uses these instead of asking for screenshots during review.

### Step 16 — Cleanup + back-compat removal

- **Files:** `repo/sidecar/server.py` (delete legacy `/working`
  routes), `repo/renderer/src/state.ts` (delete the old
  `flistWorking` field — keep only the selector).
- **Scope:** Final PR. Lands after Steps 1-15 ship to `dev` and a
  human-tested round-trip on real data. Removes the back-compat
  redirects, removes the renamed-out fields, bumps the
  `WORKING_SCHEMA_VERSION` comment to note v5 readers are
  unsupported.
- **Test to write:** none new — existing suite must continue passing.

---

## Test plan

### pytest (sidecar)

New files:

- `tests/test_set_migration.py` — covers Step 1 cases.
- `tests/test_sets_api.py` — covers Step 2.
- `tests/test_snapshots_api.py` — covers Step 3.
- `tests/test_backups_zip_api.py` — covers Step 4.
- `tests/test_pull_auto_backup.py` — covers Step 5 (uses
  `pytest-httpx` for the F-list mocks, matches Tier 1's pattern).
- `tests/test_working_legacy_compat.py` — covers Step 6.

Extensions to existing files:

- `tests/test_character_archive.py` — add v6 round-trip cases for
  the new helper functions.
- `tests/test_zip_serialise.py` — add `test_build_zip_from_snapshot_payload`
  asserting the ZIP shape is identical to `build_zip(working_payload)`
  (snapshot payloads are just frozen working payloads).

### vitest (renderer)

New files:

- `state/__tests__/state-flist-sets.test.ts` (Step 7).
- `state/__tests__/state-undo.test.ts` (Step 13).
- `features/sidebar/__tests__/AccordionPane.test.tsx` (Step 9).
- `features/sidebar/__tests__/WorkingSetsSection.test.tsx` (Step 10).
- `features/sidebar/__tests__/BackupsSection.test.tsx` (Step 11).
- `features/sidebar/__tests__/UndoRedoStrip.test.tsx` (Step 13).
- `features/flist/__tests__/DiffPane.test.tsx` — extend with the
  snapshot + other-set source cases (Step 14).

Existing snapshot updates: `EditorPane.test.tsx`, `ImagesTab.test.tsx`,
`ProfileFieldsTab.test.tsx` — re-snapshot after the
`selectWorkingSlot` migration. Should be a single text replace per
test.

### Playwright (e2e)

`repo/tests/e2e/flist-sets.spec.ts` (new) — 4 cases gated on
`FLIST_TEST_ACCOUNT`:

1. Sign in → seed character → create a second set ("Variant A") via
   the `[+ New set ▾]` button with `Fork from Main` → assert
   `flistSets` carries two entries → relaunch → still two entries.
2. Active set's description edit → take snapshot "S1" → edit again →
   revert to S1 → safety snapshot appears → assert description
   matches pre-S1 state → Undo on revert reverts again to safety
   snapshot.
3. Trigger a Pull → assert one new `auto-pull` backup in
   `backups/` → assert backup ZIP can be downloaded via
   `GET /backups/{filename}/download` and that the bytes are a valid
   ZIP with `character.json`.
4. Manual backup from a snapshot → backup row appears with `🔵
   Snapshot: <name>` badge → right-click → Delete → confirm modal
   appears, dismiss-by-backdrop is suppressed → confirm → row gone.

### Playwright (UX harness — visual verification)

Step 15 spec file. Runs under `DISPLAY=:99 npx playwright test
--config=playwright.uxtest.config.ts tests/uxtest/sets-pane.spec.ts`
per the existing convention.

### Migration round-trip test

`test_set_migration.py::test_full_roundtrip` — start from a fully-
populated v5 directory (working.json + 3 backups + 24 images +
inlines/ + avatar) → run migration → assert (a) bytes-on-disk for
images/inlines/avatars unchanged (sha256 match before and after),
(b) old `working.json` is gone, (c) `sets/<id>/payload.json` reads
back through `read_set_payload` to bytes-equal to the original
working.json post-schema-bump, (d) legacy `*.json` backups still
listable as `legacy-json`, (e) re-running migration is a no-op.

### Manual smoke (appended to evolving Tier 1-6 checklist)

- Sign in → pick character → open accordion → confirm Snippets
  collapses on character-load.
- Create a second set, edit description in each, switch back and
  forth → autosave + dirty + Saved-Xm-ago each switch.
- Pull → check `🟢 Auto pull` backup appears.
- Take snapshot → revert → Undo the revert.
- Right-click backup → Reveal in folder → file is highlighted in
  Explorer/Finder.
- Edit description 60 times in quick succession → undo 50 times →
  redo 50 times → no off-by-one, redo button never gets stuck.

---

## Open questions

1. **Tools-menu vs Character-menu placement.** Step 12 — adding 4-5
   new items under Tools may overflow it. If review confirms,
   introduce a top-level `Character` menu between `Logs` and `Tools`.
   Owner decides during the menu-PR review.
2. **`legacy-json` backups: rebuild-as-ZIP affordance?** Per Step 4
   the legacy `*.json` rows are read-only. A right-click "Rebuild as
   ZIP using current `images/`" would convert old archives to the new
   shape. Useful but adds product surface; backlog item unless owner
   wants it in Tier 7.
3. **Snapshot rename modal vs inline edit.** Inline matches the
   snippet-rename pattern but the snapshot row is already crowded.
   Default to inline; revisit if QA review surfaces a UX issue.
4. **Set deletion: confirm copy when no snapshots exist.** "Discard
   set 'Modern AU' permanently?" is unambiguous, but a set with N
   snapshots needs explicit "and its N snapshots." Sort during the
   Step 10 PR.
5. **Auto-backup naming when name collision happens.** Two backups
   at `2026-06-02T18-44-00` should be rare but possible (pull + manual
   in the same second). Filename grows a numeric suffix `(2)` after
   the hash. Trivial; document in Step 4.
6. **`flistRecordPatch` on programmatic edits.** Patches recorded by
   API-driven mutations (e.g. drift-banner-driven Live re-seed) should
   NOT push onto the undo stack. Mark each affected action explicitly
   in Step 13 with a `recordUndo: false` flag.
7. **Undo across set switch.** Owner accepted in-memory only. Confirm
   during Step 13 that the right-click-menu's Activate action does
   not clear the previous set's stacks — they live in
   `flistSetUndoStack` keyed by setId, so swapping is automatic.
   Just verify.

---

## Risks

**R-1 — Migration data loss.** v5 → v6 reads `working.json`, writes
`sets/<id>/payload.json`, then deletes `working.json`. A crash between
write and delete leaves both — the v6 reader prefers `sets/<id>/` when
present, so re-reading works; on next launch the unlinked `working.json`
is detected and deleted (idempotent). Mitigation: bytes-equal sha256
check before delete (Step 1's `_atomic_write_json`-equivalent). Test
covers the partial-failure case via fault injection.

**R-2 — Undo memory footprint.** Up to ~45 MB total across three
active sets at 50-step cap × ~300 KB per `replace-overlay`. Acceptable
on desktop; concerning if a user runs Workbench on a 4 GB-RAM machine
alongside LM Studio. Mitigation: monitor in field; if reports surface,
fold `replace-overlay` into a compact JSON-Pointer-patch shape (jsondiffpatch
or similar) — that's the v2 of this Tier and not a Tier 7 work item.

**R-3 — Backup ZIP disk usage growth.** Owner picked keep-forever.
Typical character: 50-300 MB of images. A user with 10 characters
pulling weekly accumulates 5-30 GB / month of backup ZIPs. Mitigation:
the backups list header shows a total size + a `(?)` hint linking to
docs that explain manual delete. Per-character size cap or
auto-prune is explicitly out of scope per requirements.

**R-4 — Auto-backup race with concurrent pull cancellation.** The auto-
backup hook runs after `pull_state` is sealed; cancellation during the
hook itself is allowed to fail silently (try/except wrapper). Risk:
the hook completes but the user has cancelled — the backup is harmless
extra disk usage. Mitigation: hook is idempotent (re-running creates a
new file with a different ISO timestamp); not worth checking
`request.is_disconnected()` for marginal wins.

**R-5 — Active-set pointer corruption.** A truncated
`active_set.json` would leave no active set. Mitigation: `read_active_set_id`
falls back to "first set sorted by createdAt" when the file is missing
or invalid, and rewrites the pointer on the first successful set
operation. Logged but not fatal.

**R-6 — Snapshot bytes-on-disk drift.** A snapshot references images
by `image_id`; the user can delete those images from the pool view
between taking the snapshot and reverting / building a backup from it.
Owner accepted "the row drops from the resulting ZIP." Risk: a
snapshot named "Pre-rewrite" silently degrades over time. Mitigation:
when listing snapshots, the renderer compares the snapshot's gallery
ids to disk presence and surfaces a `⚠ N image(s) missing` chip on
rows where the ratio is non-zero. Cheap; lives in the Step 10 PR.

**R-7 — Accordion height misjudgement.** 400 px assumption may break
on very small windows (sub-600 px tall). Each section's body has its
own `max-height: clamp(80px, 30vh, 240px)`. Tested in Step 15's
screenshots at the harness default size. Owner is on a desktop;
likely never an issue, but the clamp protects against the laptop
small-window case.

---

## Sequencing — "with", not "before/after"

1. Steps 1-5 land the sidecar foundation. Each is independently
   mergeable. Step 5 (auto-backup hook) blocks on Step 4 (backup
   write API).
2. Step 6 (back-compat redirects) ships with Step 1-5 so the existing
   renderer keeps working through the transition.
3. Steps 7-8 are the renderer state-slice migration; mechanical
   sweep, low risk.
4. Steps 9-11 build the accordion UI; can run in parallel against
   Step 7-8 once the API client is mocked.
5. Step 12 (native menu) lands after Step 10-11 so the menu items
   have real actions to dispatch.
6. Step 13 (undo/redo wiring) is the cross-cutting piece — easiest
   to land after the new UI is shipped so each surface's mutator
   set is stable.
7. Step 14 (Diff extension) ships standalone after Step 13.
8. Step 15 (UX harness) lands once the accordion is stable. Owner
   uses it for visual review without round-tripping screenshots.
9. Step 16 (cleanup) is the last PR — removes the back-compat
   redirects and tidies the legacy `flistWorking` field.

A UX + QA subagent pass runs after Steps 1-13 ship to `dev`; combined
fix batch + integration verifier matches the Tier 2/3 / Tier 4
autonomous-round pattern (per CLAUDE.md memory).
