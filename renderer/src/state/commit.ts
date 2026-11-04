// The one commit point for a character's Workbench slot.
//
// Every new payload the window puts into `flistWorking[characterId]`
// goes through the store's `_commit` (state.ts), which builds the slot
// here and then reports the commit to the listeners below. A commit is
// one of three kinds:
//
//   edit     the window changed the payload: the slot turns unsaved and
//            the autosave is scheduled.
//   written  the slot now holds what the sidecar wrote or answered
//            (reset to Live, Restore, a reload after an external
//            change, the Trash taking images off the gallery): it adopts
//            that etag and is not unsaved, so nothing is scheduled.
//   view     not a change to the Workbench at all: a read-only view
//            (Live, a Backup being browsed), opening a character (its
//            read, or the seed from Live), or the slot being dropped
//            (a Pull landing, sign-out). A view has no label.
//
// The undo stack (#110) hangs off this point: edit and written commits
// are changes it can record with their label, a view never is.

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

/** The label for taking over another writer's change, from the origin
 *  its event carried. */
export function externalLabel(origin: string): ExternalLabel {
  return /^(mcp|extension|internal):./.test(origin) ? (origin as ExternalLabel) : 'unknown'
}

export type Commit =
  | {
      kind: 'edit'
      label: CommitLabel
      payload: WorkingPayload
      /** Clear the slot's save error. By default an edit keeps it, so
       *  a conflict message is not dismissed by the next keystroke. */
      clearSaveError?: boolean
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
    }
  | {
      kind: 'view'
      /** The slot to show, or null to drop it. */
      slot: FlistWorkingSlot | null
    }

/** What a commit did, for the listeners. `previous` is the payload the
 *  slot held before, null when there was no slot. */
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
      if (commit.keepPending) {
        if (!current) return undefined
        return { ...current, payload, overlay, etag: commit.etag, materialised }
      }
      return {
        ...emptyWorkingSlot(),
        payload,
        overlay,
        etag: commit.etag,
        materialised,
        lastSavedAt: commit.lastSavedAt ?? null
      }
    }
  }
}

const listeners = new Set<(event: CommitEvent) => void>()

/** Hear about every commit, after the store has taken it. Returns the
 *  function that stops listening. */
export function onWorkbenchCommit(listener: (event: CommitEvent) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifyCommit(event: CommitEvent): void {
  for (const listener of listeners) listener(event)
}
