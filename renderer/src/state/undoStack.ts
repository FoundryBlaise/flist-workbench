// The window's undo stack: one per character, of whole Workbench
// payloads, each labelled with where the change came from (#110).
//
// The store's commit point records the payload a change replaced;
// undo hands that payload back for the store to commit, and keeps the
// payload it replaces for redo. A new change drops the redo entries.
// The stacks live as long as the app runs (ADR 0003): anything older
// is recovered from a Backup.
//
// No store import: the store calls in, so this file can move with the
// store's split (spec #8) without dragging it along.

import type { CommitLabel } from './commit'
import type { WorkingPayload } from './flist'

export interface UndoEntry {
  /** Where the change this entry steps over came from. */
  label: CommitLabel
  /** The payload the step puts back. */
  payload: WorkingPayload
}

interface Stack {
  /** Oldest first; the last one is the next undo. */
  past: UndoEntry[]
  /** Oldest first; the last one is the next redo. */
  future: UndoEntry[]
}

/** How many changes back a character's stack reaches. Every entry is a
 *  whole payload, and until typing is coalesced (#111) each keystroke
 *  in the description is one, so the oldest go first. */
export const MAX_UNDO_ENTRIES = 500

const stacks = new Map<string, Stack>()

function stackOf(characterId: string): Stack {
  let stack = stacks.get(characterId)
  if (!stack) {
    stack = { past: [], future: [] }
    stacks.set(characterId, stack)
  }
  return stack
}

function pushCapped(entries: UndoEntry[], entry: UndoEntry): void {
  entries.push(entry)
  if (entries.length > MAX_UNDO_ENTRIES) entries.splice(0, entries.length - MAX_UNDO_ENTRIES)
}

/** A change replaced `previous`: it becomes the next undo, and the redo
 *  entries are gone. */
export function recordChange(
  characterId: string,
  label: CommitLabel,
  previous: WorkingPayload
): void {
  const stack = stackOf(characterId)
  pushCapped(stack.past, { label, payload: previous })
  stack.future = []
}

/** Take the next undo: the entry whose payload goes back in, with the
 *  label of the change it undoes. `current` is kept for redo. Null when
 *  there is nothing to undo. */
export function takeUndo(characterId: string, current: WorkingPayload): UndoEntry | null {
  const stack = stacks.get(characterId)
  const entry = stack?.past.pop()
  if (!stack || !entry) return null
  pushCapped(stack.future, { label: entry.label, payload: current })
  return entry
}

/** Take the next redo, the mirror of takeUndo. */
export function takeRedo(characterId: string, current: WorkingPayload): UndoEntry | null {
  const stack = stacks.get(characterId)
  const entry = stack?.future.pop()
  if (!stack || !entry) return null
  pushCapped(stack.past, { label: entry.label, payload: current })
  return entry
}

export function canUndo(characterId: string): boolean {
  return (stacks.get(characterId)?.past.length ?? 0) > 0
}

export function canRedo(characterId: string): boolean {
  return (stacks.get(characterId)?.future.length ?? 0) > 0
}

/** Forget every character's stack: sign-out, and tests between runs. */
export function resetUndoStacks(): void {
  stacks.clear()
  hidden.clear()
}

// A read-only view (Live, a Backup being browsed) borrows the slot and
// hides the Workbench. A Restore or reset to Live made from there
// replaces the Workbench, not the view, so its undo entry has to be the
// Workbench the view hid. Kept here so sign-out and the tests' reset
// forget it with the stacks.
const hidden = new Map<string, WorkingPayload>()

/** A view now covers the Workbench whose payload is `workbench`, or a
 *  change made under a view left the Workbench at `workbench`. */
export function hideWorkbench(characterId: string, workbench: WorkingPayload): void {
  hidden.set(characterId, workbench)
}

/** The Workbench a view covers, or null when no view covers one. */
export function hiddenWorkbench(characterId: string): WorkingPayload | null {
  return hidden.get(characterId) ?? null
}

/** The Workbench is in the slot again. */
export function unhideWorkbench(characterId: string): void {
  hidden.delete(characterId)
}
