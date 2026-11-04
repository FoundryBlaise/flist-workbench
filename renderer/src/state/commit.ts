// The one commit point for a character's Workbench slot.
//
// Every new payload the window puts into `flistWorking[characterId]`
// goes through the store's `_commit` (state.ts), which builds the slot
// here. A commit is one of four kinds:
//
//   edit     the window changed the payload: the slot turns unsaved and
//            the autosave is scheduled.
//   written  the slot now holds what the sidecar wrote or answered
//            (reset to Live, Restore, a reload after an external
//            change, the Trash taking images off the gallery): it adopts
//            that etag and is not unsaved, so nothing is scheduled.
//   merged   the window's unsaved edits merged onto another writer's
//            version (state/merge.ts): the slot now sits on that
//            version's etag, is unsaved, and the autosave is scheduled.
//   view     not a change to the Workbench at all: a read-only view
//            (Live, a Backup being browsed), opening a character (its
//            read, or the seed from Live), or the slot being dropped
//            (a Pull landing, sign-out). A view has no label.
//
// `_commit` also records the change on the undo stack
// (state/undoStack.ts): every edit, written and merged commit records
// the payload it replaced, with its label; a view never does, nor does
// an undo or redo step itself. Keystrokes (an edit with `typing`)
// record only the first of a burst.

import { emptyWorkingSlot, type FlistWorkingSlot, type WorkingPayload } from './flist'

/** Another writer's change, as its event names it: `mcp:<tool>` for a
 *  connected model, `extension:<what>` for the browser extension,
 *  `internal:<pass>` for a maintenance pass in the app, `unknown` for a
 *  save refused because something wrote the Workbench meanwhile. */
export type ExternalLabel =
  | `mcp:${string}`
  | `extension:${string}`
  | `internal:${string}`
  | 'unknown'

/** Where a change to a Workbench came from. */
export type CommitLabel =
  /** The user, in this window. */
  | 'edit'
  /** A Backup loaded into the Workbench. */
  | 'restore'
  /** The Workbench replaced by a fresh copy of Live. */
  | 'reset-to-live'
  | ExternalLabel

/** A writer an origin names: `mcp:<tool>`, `extension:<what>`,
 *  `internal:<pass>`, or a bare `mcp` (a model, tool not named). Null
 *  for anything else (`ui`, `unknown`). The one reader of origins. */
export function parseOrigin(
  origin: string
): { writer: 'mcp' | 'extension' | 'internal'; name: string } | null {
  const m = /^(mcp|extension|internal)(?::(.+))?$/.exec(origin)
  if (!m) return null
  const writer = m[1] as 'mcp' | 'extension' | 'internal'
  if (!m[2] && writer !== 'mcp') return null
  return { writer, name: m[2] ?? '' }
}

/** The label for taking over another writer's change, from the origin
 *  its event carried. */
export function externalLabel(origin: string): ExternalLabel {
  return parseOrigin(origin)?.name ? (origin as ExternalLabel) : 'unknown'
}

/** Another writer's version of a Workbench, read after its change:
 *  the payload it left (`theirs`), the etag that is on disk at, and the
 *  label its change is recorded under. */
export interface TheirVersion {
  label: CommitLabel
  theirs: WorkingPayload
  etag: string
}

export type Commit =
  | {
      kind: 'edit'
      label: CommitLabel
      payload: WorkingPayload
      /** Clear the slot's save error. By default an edit keeps it, so
       *  a conflict message is not dismissed by the next keystroke. */
      clearSaveError?: boolean
      /** An undo or redo step: the undo stack has already moved, so
       *  this commit is not recorded as a new change. */
      undoStep?: boolean
      /** A keystroke, naming the text field typed in (its payload
       *  path): keystrokes in one field without a pause between them
       *  are one undo entry. */
      typing?: string
    }
  | {
      kind: 'written'
      label: CommitLabel
      payload: WorkingPayload
      /** The etag the next save goes over; null when nothing is on
       *  disk yet (a reset to Live of a character never saved). */
      etag: string | null
      /** False only for a slot nothing has been written for yet. */
      materialised?: boolean
      lastSavedAt?: number | null
      /** Keep what the slot had pending (unsaved flag, save status):
       *  the sidecar changed one part of the payload, and anything typed
       *  meanwhile still waits for its save. Without it the slot is
       *  replaced whole and is clean. */
      keepPending?: boolean
      /** What is on disk at `etag`, when that is not `payload` itself
       *  (keepPending with typing still unsaved). */
      saved?: WorkingPayload
    }
  | {
      kind: 'merged'
      label: CommitLabel
      payload: WorkingPayload
      /** The other writer's etag: the merge is saved over it. */
      etag: string
      /** The other writer's version, now the base of the next merge. */
      saved: WorkingPayload
    }
  | {
      kind: 'view'
      /** The slot to show, or null to drop it. */
      slot: FlistWorkingSlot | null
    }

/** What a commit did. `previous` is the payload the slot held before,
 *  null when there was no slot. */
export interface CommitEvent {
  characterId: string
  kind: Commit['kind']
  /** Null for a view, which is not a change. */
  label: CommitLabel | null
  previous: WorkingPayload | null
  next: WorkingPayload | null
}

function overlayOf(payload: WorkingPayload): string[] {
  return Array.isArray(payload._overlay) ? [...payload._overlay] : []
}

/** The slot a commit leaves behind, or undefined when it does nothing
 *  (an edit with no slot to edit). Every edit and written commit
 *  installs a new payload object: the save compares payloads by
 *  identity to tell whether something changed while it was in flight. */
export function commitSlot(
  current: FlistWorkingSlot | undefined,
  commit: Commit
): FlistWorkingSlot | null | undefined {
  switch (commit.kind) {
    case 'view':
      return commit.slot
    case 'edit': {
      if (!current) return undefined
      const payload = { ...commit.payload }
      return {
        ...current,
        payload,
        overlay: overlayOf(payload),
        unsavedDirty: true,
        saveStatus: 'idle',
        saveError: commit.clearSaveError ? null : current.saveError
      }
    }
    case 'written': {
      const payload = { ...commit.payload }
      const overlay = overlayOf(payload)
      const materialised = commit.materialised ?? true
      const saved = commit.saved ?? payload
      if (commit.keepPending) {
        if (!current) return undefined
        return { ...current, payload, overlay, etag: commit.etag, materialised, saved }
      }
      return {
        ...emptyWorkingSlot(),
        payload,
        overlay,
        etag: commit.etag,
        materialised,
        lastSavedAt: commit.lastSavedAt ?? null,
        saved
      }
    }
    case 'merged': {
      if (!current) return undefined
      const payload = { ...commit.payload }
      return {
        ...current,
        payload,
        overlay: overlayOf(payload),
        etag: commit.etag,
        saved: commit.saved,
        materialised: true,
        unsavedDirty: true,
        saveStatus: 'idle',
        saveError: null
      }
    }
  }
}
