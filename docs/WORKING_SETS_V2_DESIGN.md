# Working sets v2 — UI-only design

Scope-locked design pass. Owner-aligned via chat 2026-06-02 (post-Tier 7
revert). All changes live inside **area 2 — Character Working area**
(the `FlistCharacterZone` component). Areas 1 and 3 unchanged.

This doc is for sign-off **before any code lands**. The goal is to nail
the visual layout + interactions so we don't ship twice.

---

## Hard scope

In scope this round:

- New layout for area 2: From-F-list as a permanent read-only row,
  separator, list of user-created working sets below.
- `[+ New working set]` button → naming dialog → creates a new set
  seeded from the current F-list pull.
- Click a working set → it becomes active (loads in the editor). Click
  `From F-list` → read-only live view. State preserved per set on every
  switch.
- Right-click a working set → menu: **Rename**, **Create a copy**,
  **Delete** (with confirm modal).

Out of scope this round (deliberately):

- Backups (none of the current backup UI survives in this round —
  `Save snapshot`, `Saved snapshots (N)` list all removed from the UI).
- Snapshots — no snapshot feature in the UI at all this round.
- `Export for restore…` button — removed from UI; code path kept with
  `// TODO(working-sets v2): re-surface or delete` marker.
- `Copy as new draft` button — removed from UI; code path kept with the
  same TODO marker.
- Persistence shape (sets on disk, sidecar API, migration) — we'll
  revisit once this UI is signed off.
- Undo / redo, native menu hooks, Diff right-source picker — all
  deferred.

---

## Layout — area 2 only

### Empty state (first launch after this update)

```
┌────────────────────────────────────────┐
│ Lady Amber Blaise         [↻ Refresh] │ ← unchanged header
│ [+ New working set]                    │ ← NEW button, full width
│ ────────────────────────────────────── │
│ ● From F-list · pulled 12m ago         │ ← read-only, always row 1
└────────────────────────────────────────┘
```

No working sets yet. The pane is one row tall (plus header). Clicking
`From F-list` opens the live pull in the editor read-only. There is no
"My edits" anywhere; the user *must* click `+ New working set` to start
editing.

### Populated state

```
┌────────────────────────────────────────┐
│ Lady Amber Blaise         [↻ Refresh] │
│ [+ New working set]                    │
│ ────────────────────────────────────── │
│ ● From F-list · pulled 12m ago         │ ← row 1, fixed
│ ────────────────────────────────────── │ ← visual separator
│ ✱ Main                · saved 3m ago   │ ← active set (blue ✱)
│   Modern AU           · saved 2d ago   │
│   Sub variant         · saved 1w ago   │
└────────────────────────────────────────┘
```

- The active set is marked with `✱` (filled, accent color) and given
  the row background that the current `My edits` row uses today. Same
  affordance, just per-set.
- Inactive sets show a small `·` marker and the row hover state.
- Click any row to activate it. Clicking the already-active row is a
  no-op (no toggle-collapse since there is no inner content to expand).
- Sets are ordered **most-recently-updated first**. New sets land at
  the top.
- The `· saved Xm ago` suffix updates from the same `relativeTime`
  helper used by today's `My edits` row.

### "Currently viewing F-list" state

When the user clicks `From F-list`, the row highlights and the editor
loads the live (read-only) view. Per row mocks:

```
│ ✱ From F-list · pulled 12m ago         │ ← active read-only
│   Main          · saved 3m ago         │
│   Modern AU     · saved 2d ago         │
```

Only one row is active at a time — either F-list or one working set.

---

## `+ New working set` button + dialog

The button is full-width, sits directly under the header, and is always
visible (whether or not any working sets exist).

```
┌────────────────────────────────────────┐
│ [+ New working set]                    │
└────────────────────────────────────────┘
```

Clicking it opens a small modal dialog (reuses the existing modal-
backdrop primitive; **no backdrop-click dismiss** per the project's
modal rule — Esc / ✕ / Cancel only):

```
┌──────────────────────────────────────────┐
│ Create working set                    ✕  │
├──────────────────────────────────────────┤
│                                          │
│ Name                                     │
│ ┌──────────────────────────────────────┐ │
│ │ Working set 1                        │ │ ← pre-filled, selected
│ └──────────────────────────────────────┘ │
│                                          │
│ Seeded from the current F-list pull.     │
│                                          │
├──────────────────────────────────────────┤
│                       [Cancel] [Create]  │
└──────────────────────────────────────────┘
```

- Default name is `Working set N` where N is `1 + (highest existing
  "Working set <n>" suffix)`. First creation → `Working set 1`. Second
  → `Working set 2`. After a delete, the next default reuses the lowest
  free number.
- Field is pre-selected on focus so Enter accepts the default.
- Enter submits (same as clicking Create); Esc cancels.
- Trim whitespace; reject empty strings; **allow duplicates** —
  uniqueness is not enforced (the user can have two sets named the
  same; the underlying id keeps them distinct).
- On Create: new set is appended to the top of the list, becomes the
  active set, editor reloads with the seeded payload.

---

## Right-click menu (on a working set row)

```
┌──────────────────────────┐
│ Rename…                  │
│ Create a copy            │
│ ──────────────────────── │
│ Delete…                  │ ← red text, destructive
└──────────────────────────┘
```

- **Rename…** — opens the same dialog as `+ New working set`, but
  title is `Rename working set`, the name field is pre-filled with the
  current name, and Create becomes Save. Same Enter / Esc behavior.
- **Create a copy** — instant. Adds a new set named `<current name>
  (copy)` (or `<current name> (copy 2)` if collision), with the same
  payload as the source. Becomes active. No dialog — instant feedback
  matches Photoshop's "Duplicate layer" muscle memory.
- **Delete…** — opens a confirm modal. Same dismissal rules (Esc / ✕ /
  Cancel only). On confirm: the set is removed, and the active set
  flips to whichever set is now at the top of the list. If the deleted
  set was the only one, the active selection flips to `From F-list`.

The `From F-list` row has **no right-click menu** in this round.

---

## Behavior contract

1. **Switching is non-destructive.** Clicking any row activates it
   without flushing or discarding the previously-active set's edits.
   Switching to F-list and back to a working set leaves that set
   exactly as it was.

2. **Per-set state is persisted.** Each working set has its own
   description, infotags, kinks, custom kinks, and gallery state. We'll
   spec the on-disk shape in the follow-up; for this round, the in-
   memory contract is "every set is its own slot".

3. **The active set is the only thing the editor edits.** The
   `Profile fields` / `Kinks` / `Images` / `Diff` tabs read from and
   write to the active set's payload.

4. **`From F-list` is read-only everywhere.** No tab can edit it. The
   editor renders it in the same read-only mode the current `From
   F-list` row already triggers.

5. **The current header (name + Refresh) is unchanged.** Refresh still
   pulls the live profile; the result lands in `live.json` exactly as
   today and is shown in the `From F-list` row.

---

## What disappears from area 2

| Old element                                          | Where it goes        |
|------------------------------------------------------|----------------------|
| `My edits` row                                       | Replaced by working-set list (user creates explicitly) |
| `⬇ Export for restore…` button                       | Removed from UI; code kept with TODO marker |
| `✎ Copy as new draft` button                         | Removed from UI; code kept with TODO marker |
| `💾 Save snapshot` button                            | Removed from UI; code kept with TODO marker |
| `▾ Saved snapshots (N)` toggle + list                | Removed entirely from UI; backend backups dir untouched |

The Tier 1 backup file format on disk (`backups/<unix>.json`) is **not
touched** — we're only removing the UI surface. Existing backup files
on disk remain unreferenced from the UI for this round; we'll redesign
the backup surface in a follow-up round.

---

## Storage + persistence

Persistence is in scope for this round. Every working set lives on
disk under the user-data folder; autosave writes through to disk on
every edit (debounced, same pattern as today's `My edits`).

### Per-character folder layout

```
<userData>/characters/<character_id>/
  live.json                         ← unchanged (the F-list pull)
  pull_state.json                   ← unchanged
  images/<image_id>.<ext>           ← unchanged, character-wide
  inlines/<hash>.<ext>              ← unchanged
  sets/                             ← NEW
    <set_id>/
      payload.json                  ← the working payload
      meta.json                     ← {id, name, createdAt, updatedAt}
  active_set.json                   ← NEW {active_set_id: "<uuid>" | null}
```

- `<set_id>` is a `uuid4().hex[:12]`. Folder named by id, not by
  display name, so renames are cheap (only `meta.json` changes).
- Images live at character level, not per-set — sets reference image
  ids; the bytes are shared.
- The `backups/` directory from earlier rounds is **untouched** —
  existing files stay where they are; UI doesn't surface them.

### Set payload shape

`payload.json` is structurally identical to today's `working.json`:
`{_schema_version, _overlay, character, kinks, custom_kinks, infotags,
inlines, images}`. The schema version bumps to **v6** to mark "this
file lives inside a per-set folder."

`meta.json`:

```json
{
  "id": "abc123def456",
  "name": "Main",
  "createdAt": 1717340000,
  "updatedAt": 1717343600
}
```

`updatedAt` is what the `· saved Xm ago` suffix reads. Bumps on every
autosave round-trip.

### Active set pointer

`active_set.json`:

```json
{ "active_set_id": "abc123def456" }
```

`null` when the user has clicked `From F-list` or has no sets yet. The
renderer reads this on character switch so the right row stays
highlighted across app restarts.

### Migration policy (existing users with `working.json`)

**Locked: M3.** Owner confirmed 2026-06-02 — all current users are
test users, build is not public, data loss is acceptable for a clean
disk. On first read of any v5-era character directory in the new
build, the renderer-triggered sidecar call unlinks `working.json` and
the directory drops to the v6 shape (sets/ + active_set.json, both
initially empty). The user sees zero sets and `From F-list` selected,
exactly like a fresh install.

For reference, the rejected options were:
- M1 — auto-import into a set named "Imported" (most conservative,
  no data loss).
- M2 — leave `working.json` orphaned on disk (invisible to the UI but
  recoverable later).

### Autosave + etag

Per-set autosave is the existing Tier 2 pattern, scoped to the active
set. Each `PUT /sets/<set_id>/payload` carries an `If-Match: <sha256>`
header; mismatch returns 409 and the renderer surfaces the existing
drift banner. Switching sets flushes any pending autosave on the
previous set before the new one becomes active.

### Seed-from-F-list on create

`+ New working set` reads `live.json` and deep-copies into the new
`payload.json`. If no `live.json` exists yet (character has never been
pulled), the `+ New working set` button is **disabled** with the
tooltip "Pull this character first." That keeps the seed contract
trivial.

### Delete

Removing a set: server unlinks `sets/<set_id>/`. The active-set
pointer flips to whichever set is at the top of the (updatedAt-sorted)
list. If the last set is deleted, `active_set.json` clears to `null`
and the UI falls back to highlighting `From F-list`.

### Rename + Duplicate

Both leave the on-disk `<set_id>` folder unchanged. Rename only
rewrites `meta.json`. Duplicate copies `payload.json` + a fresh
`meta.json` under a new `<set_id>`. Image bytes are not duplicated
(they're character-wide).

### Sidecar API surface (proposed)

| Method | Path                                              | Purpose                              |
|--------|---------------------------------------------------|--------------------------------------|
| GET    | `/flist/character/{id}/sets`                      | list sets + `active_set_id`          |
| POST   | `/flist/character/{id}/sets`                      | create from live (only seed)         |
| PATCH  | `/flist/character/{id}/sets/{set_id}`             | rename                               |
| DELETE | `/flist/character/{id}/sets/{set_id}`             | delete                               |
| POST   | `/flist/character/{id}/sets/{set_id}/duplicate`   | duplicate                            |
| POST   | `/flist/character/{id}/sets/{set_id}/activate`    | flip the active-set pointer          |
| GET    | `/flist/character/{id}/sets/{set_id}/payload`     | read payload + etag                  |
| PUT    | `/flist/character/{id}/sets/{set_id}/payload`     | write payload (If-Match)             |
| POST   | `/flist/character/{id}/from-flist/activate`       | clear active set (view F-list only)  |

No snapshot, backup, or undo routes in this round.

### What "the working set is always safe" means concretely

1. Any autosave-eligible edit writes through to disk before the next
   tab switch.
2. Switching sets flushes pending edits on the outgoing set
   synchronously.
3. Clicking `From F-list` is also a switch — pending edits flush
   first.
4. App reload restores: the active-set pointer, the list of sets,
   their meta, and every set's payload-as-saved.

---

## What this design does NOT decide

Deferred to next rounds:

- Backups (we're not touching the backup UI this round; the old
  `backups/` dir on disk is unreferenced from the UI but left intact).
- Snapshots — no snapshot feature at all this round.
- Undo / redo across sets.
- Diff right-source picker extension.
- Cross-device sync.

---

## Sign-off checklist

Confirm these and I start coding:

- [ ] Layout (empty + populated + F-list-active) as drawn above.
- [ ] `+ New working set` dialog with `Working set N` default,
  Enter-to-accept, allow duplicates.
- [ ] Right-click menu: Rename / Create a copy / Delete (with confirm).
- [ ] Remove `My edits` row, `Export for restore`, `Copy as new draft`,
  `Save snapshot`, `Saved snapshots (N)` list from the UI. Code paths
  for the first three kept with `// TODO(working-sets v2)` markers.
- [ ] Storage layout (`sets/<set_id>/{payload,meta}.json` +
  `active_set.json`).
- [x] Migration choice: **M3 — delete `working.json` on first read**.
- [ ] `+ New working set` disabled until first pull (no live to seed).
- [ ] `· saved Xm ago` from `meta.updatedAt`.
- [ ] No undo / no backups / no snapshots / no Diff picker changes in
  this round.
