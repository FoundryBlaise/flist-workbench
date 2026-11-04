// The window's undo stack: one per character, of whole Workbench
// payloads, each labelled with where the change came from.
//
// The store's commit point records the payload a change replaced;
// undo hands that payload back for the store to commit, and keeps the
// payload it replaces for redo. A new change drops the redo entries.
// The stacks live as long as the app runs (ADR 0003): anything older
// is recovered from a Backup.
//
// Typing is coalesced here: the first keystroke in a text field
// records the payload from before it, and further keystrokes in the
// same field record nothing until the burst ends: a pause of
// TYPING_PAUSE_MS, the field losing focus (endTyping), any other
// change, an undo or redo, or the Workbench being shown afresh.
//
// No store import: the store calls in, so this file can move with the
// store's split into modules without dragging it along.

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
 *  whole payload, so the oldest go first. */
export const MAX_UNDO_ENTRIES = 500

/** How long typing may stop before the next keystroke starts a new
 *  undo entry. */
export const TYPING_PAUSE_MS = 1_000

const stacks = new Map<string, Stack>()

/** A character's open burst of typing: the text field being typed in
 *  and when its last keystroke landed. While it is open, keystrokes in
 *  that field add nothing to the stack: the entry its first keystroke
 *  recorded steps back over the whole burst. */
interface Burst {
  field: string
  lastAt: number
}

const bursts = new Map<string, Burst>()

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
 *  entries are gone. `typing` names the text field when the change is a
 *  keystroke: a keystroke in the field of the open burst, before the
 *  pause, is part of that burst's entry and records nothing. Any other
 *  change ends the burst. */
export function recordChange(
  characterId: string,
  label: CommitLabel,
  previous: WorkingPayload,
  typing?: string
): void {
  const now = Date.now()
  const burst = bursts.get(characterId)
  if (
    typing !== undefined &&
    burst?.field === typing &&
    now - burst.lastAt < TYPING_PAUSE_MS
  ) {
    burst.lastAt = now
    return
  }
  if (typing !== undefined) bursts.set(characterId, { field: typing, lastAt: now })
  else bursts.delete(characterId)
  const stack = stackOf(characterId)
  pushCapped(stack.past, { label, payload: previous })
  stack.future = []
}

/** End the character's open burst of typing (the text field lost focus,
 *  or the Workbench was shown afresh): the next keystroke starts a new
 *  entry. */
export function endTyping(characterId: string): void {
  bursts.delete(characterId)
}

/** Take the next undo: the entry whose payload goes back in, with the
 *  label of the change it undoes. `current` is kept for redo. Null when
 *  there is nothing to undo. */
export function takeUndo(characterId: string, current: WorkingPayload): UndoEntry | null {
  endTyping(characterId)
  const stack = stacks.get(characterId)
  const entry = stack?.past.pop()
  if (!stack || !entry) return null
  pushCapped(stack.future, { label: entry.label, payload: current })
  return entry
}

/** Take the next redo, the mirror of takeUndo. */
export function takeRedo(characterId: string, current: WorkingPayload): UndoEntry | null {
  endTyping(characterId)
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
  bursts.clear()
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
