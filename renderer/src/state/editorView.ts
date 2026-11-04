// What the editor shows, read from the active character's Workbench slot.
//
// The store keeps no copy of the description, its inline images or the
// editor's title: each is derived here from the slot the window holds for
// the active character (the Workbench, or the Live or Backup view that
// stands in its place), so a Restore, a merge, an undo or a reload shows
// in the editor because the payload changed, with nothing to sync.
// Typing goes the other way through the Workbench slice's
// `setEditorContent`, an edit to the payload like any other.

import type { InlineImage } from '../lib/api'
import type { State } from '../state'
import { descriptionOf, extractInlines, type FlistWorkingSlot } from './flist'

function activeSlot(s: State): FlistWorkingSlot | undefined {
  const id = s.flistActiveCharacterId
  return id === null ? undefined : s.flistWorking[id]
}

/** The description the editor shows: the active character's payload's,
 *  empty while no character is open or its Workbench is still read. */
export function selectEditorDescription(s: State): string {
  const slot = activeSlot(s)
  return slot ? descriptionOf(slot.payload) : ''
}

/** True while the editor shows a Workbench with edits not saved yet. */
export function selectEditorDirty(s: State): boolean {
  return !s.editorReadOnly && !!activeSlot(s)?.unsavedDirty
}

/** The editor's title: the character and its Workbench, "(loading)" while
 *  the Workbench is read. Unsaved edits are marked beside it
 *  (selectEditorDirty), not in it. */
export function selectEditorTitle(s: State): string {
  const id = s.flistActiveCharacterId
  if (id === null) return ''
  const entry = s.flistRoster.find((r) => String(r.id ?? '') === id)
  // "Workbench", not "My edits": the sidebar row, the window title and
  // the read-only hints all name the same one thing.
  const name = entry?.name ?? 'Workbench'
  const slot = s.flistWorking[id]
  if (!slot) {
    return s.flistWorkingLoadStatus[id] === 'error'
      ? `${name} — Workbench`
      : `${name} — Workbench (loading)`
  }
  return `${name} — Workbench`
}

// One answer per (payload, Live) pair, so a component selecting the
// inline images re-renders only when one of them changed.
let lastInlines: {
  payload: unknown
  live: unknown
  inlines: Record<string, InlineImage>
} | null = null

/** The inline images the description's `[img=<id>]` tags resolve to: the
 *  payload's own, with the character's Live filling in any it does not
 *  name (an inline uploaded on F-list after the Workbench was made). */
export function selectEditorInlines(s: State): Record<string, InlineImage> {
  const id = s.flistActiveCharacterId
  const payload = activeSlot(s)?.payload ?? null
  const live = id === null ? null : (s.flistArchive[id]?.live ?? null)
  if (lastInlines && lastInlines.payload === payload && lastInlines.live === live) {
    return lastInlines.inlines
  }
  const inlines = { ...extractInlines(live), ...extractInlines(payload) }
  lastInlines = { payload, live, inlines }
  return inlines
}
