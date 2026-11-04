// The undo module: Undo and Redo of a character's Workbench, as the
// Workbench slice uses them (ADR 0003).
//
// - Recording: the slice's one commit point (`_commit` in
//   slices/workbench.ts) hands every commit to `recordCommit`, which
//   puts the payload it replaced on the character's stack.
// - Stepping: `undoStep` takes the next undo or redo off the stack and
//   commits it through that same commit point, as an edit.
// - Putting back: a step that brings back a gallery image whose file
//   went to the Trash puts the file back before the step is saved.
//
// Its parts: the stacks (undoStack.ts, which knows no store), the pure
// parts of putting back (undoTrash.ts), and this file, which knows the
// store. The Workbench slice reaches undo only through this file. The
// module changes the store only through the host the slice hands it
// (`UndoHost`): a `set` that writes Workbench fields only, and the
// slice's commit point.

import { api, type FlistTrashItem } from '../lib/api'
import type { UndoAction } from '../lib/undoRedo'
import type { State } from '../state'
import type { Commit, CommitEvent, CommitLabel } from './commit'
import { isDeepEqual, type WorkingPayload } from './flist'
import type { SlotSet, WorkbenchState } from './slices/workbench'
import {
  endTyping,
  hiddenWorkbench,
  hideWorkbench,
  recordChange,
  takeRedo,
  takeUndo,
  unhideWorkbench
} from './undoStack'
import { imagesToFind, putBackNote, renameGalleryRows, stepName } from './undoTrash'

export { endTyping, resetUndoStacks } from './undoStack'

/** What the undo module needs of the Workbench slice. */
export interface UndoHost {
  get: () => State
  /** Writes Workbench fields only: the undo notes. */
  set: SlotSet
  /** The Workbench's one commit point. */
  commit: (
    characterId: string,
    commit: Commit,
    also?: (s: State) => Partial<WorkbenchState>
  ) => void
  /** Run `work` as a link in the character's flush chain, so the
   *  autosave a step scheduled waits for it. Never rejects. */
  beforeSave: (characterId: string, work: () => Promise<void>) => void
}

/** True while the window shows a character's Live or a Backup being
 *  browsed in its Workbench slot: nothing may be written from there. */
function showsReadOnlyView(s: State, characterId: string): boolean {
  return !!s.flistViewingLive[characterId] || s.flistBrowseBackup?.characterId === characterId
}

/** True while a character's slot holds Live or a browsed Backup instead
 *  of the Workbench, which the undo stack then keeps aside. A Backup
 *  still loading for browse is not in the slot yet. */
function slotHoldsView(s: State, characterId: string): boolean {
  const browse = s.flistBrowseBackup
  return (
    !!s.flistViewingLive[characterId] ||
    (browse?.characterId === characterId && browse.status === 'ready')
  )
}

/** Record a commit the Workbench's commit point made: `before` is the
 *  store as the commit found it, `after` the store it left. Every edit,
 *  written and merged commit records the payload it replaced, with its
 *  label; a view never does (it ends the typing burst instead), nor does
 *  an undo or redo step. Under a view the slot holds Live or a Backup,
 *  not the Workbench: a change made from there replaced the Workbench
 *  the view hides, which is what is recorded. */
export function recordCommit(
  commit: Commit,
  event: CommitEvent,
  before: State,
  after: State
): void {
  const { characterId } = event
  const covered = slotHoldsView(before, characterId)
  const coveredAfter = slotHoldsView(after, characterId)
  if (commit.kind === 'view') endTyping(characterId)
  else {
    const replaced = covered ? hiddenWorkbench(characterId) : event.previous
    if (replaced && !(commit.kind === 'edit' && commit.undoStep)) {
      recordChange(
        characterId,
        commit.label,
        replaced,
        commit.kind === 'edit' ? commit.typing : undefined
      )
    }
  }
  if (!coveredAfter) unhideWorkbench(characterId)
  else if (!covered && event.previous) hideWorkbench(characterId, event.previous)
  else if (commit.kind !== 'view' && event.next) hideWorkbench(characterId, event.next)
}

/** True while a view hides the character's Workbench from the slot. */
export function viewHidesWorkbench(characterId: string): boolean {
  return hiddenWorkbench(characterId) !== null
}

/** Another writer's change, taken in while a view hides the Workbench
 *  (the slot is left alone): it is the Workbench's entry now, stepping
 *  from the Workbench the view hid. A change that brings nothing new
 *  (the event of a write an earlier read already took in) is not one. */
export function recordChangeUnderView(
  characterId: string,
  label: CommitLabel,
  theirs: WorkingPayload
): void {
  const hidden = hiddenWorkbench(characterId)
  if (hidden && !isDeepEqual(hidden, theirs)) {
    recordChange(characterId, label, hidden)
    hideWorkbench(characterId, { ...theirs })
  }
}

/** One undo or redo step: the stack moves and hands back the payload to
 *  put in, which is committed as an edit, so it is unsaved and the
 *  autosave writes it over the etag the slot holds. The note says which
 *  change was stepped over. Null when there was nothing to step over. */
export function undoStep(
  host: UndoHost,
  characterId: string,
  action: UndoAction
): CommitLabel | null {
  const take = action === 'undo' ? takeUndo : takeRedo
  const s = host.get()
  const slot = s.flistWorking[characterId]
  if (!slot || showsReadOnlyView(s, characterId)) return null
  const entry = take(characterId, slot.payload)
  if (!entry) return null
  const pool = s.flistCharacterImages[characterId]
  const toFind = imagesToFind(entry.payload, slot.payload, pool?.byId ?? null)
  host.commit(
    characterId,
    { kind: 'edit', label: 'edit', payload: entry.payload, undoStep: true },
    () => ({ flistWorkbenchNote: { characterId, action, label: entry.label, at: Date.now() } })
  )
  if (toFind.length > 0) {
    host.beforeSave(characterId, () => putBackFromTrash(host, characterId, toFind, action))
  }
  return entry.label
}

/** An undo or redo brought back gallery images the Pool may not hold.
 *  Their files are put back from the Trash before the payload is saved.
 *  Never rejects; what happened goes into the character's undo note. */
async function putBackFromTrash(
  host: UndoHost,
  characterId: string,
  imageIds: string[],
  action: UndoAction
): Promise<void> {
  const { get, set } = host
  const note = (text: string | null) => {
    if (!text) return
    set((s) => ({
      flistUndoNotes: { ...s.flistUndoNotes, [characterId]: { text, at: Date.now() } }
    }))
  }
  try {
    // Only a Pool the window has read can say which files are missing.
    if (get().flistCharacterImages[characterId]?.status !== 'ready') {
      await get().flistLoadCharacterImages(characterId)
    }
    const pool = get().flistCharacterImages[characterId]
    if (pool?.status !== 'ready') throw new Error('the Pool could not be read')
    const missing = imageIds.filter((id) => !(id in pool.byId))
    if (missing.length === 0) return

    // The Trash lists the newest delete first: of several files trashed
    // under one id, the newest is the one the gallery last showed.
    const { items } = await api.flistTrashList(characterId)
    const inTrash = new Map<string, FlistTrashItem>()
    for (const item of items) {
      if (missing.includes(item.image_id) && !inTrash.has(item.image_id)) {
        inTrash.set(item.image_id, item)
      }
    }
    const putBack: string[] = []
    const back = new Set<string>()
    const renames = new Map<string, string>()
    if (inTrash.size > 0) {
      const res = await api.flistTrashPutBack(
        characterId,
        [...inTrash.values()].map((i) => i.trash_id)
      )
      for (const r of res.restored) {
        const item = [...inTrash.values()].find((i) => i.trash_id === r.from)
        if (!item) continue
        back.add(item.image_id)
        putBack.push(item.source_name ?? item.filename)
        if (r.image_id !== item.image_id) renames.set(item.image_id, r.image_id)
      }
      await get().flistLoadCharacterImages(characterId)
    }
    const leftInTrash = missing.filter((id) => inTrash.has(id) && !back.has(id))
    const gone = missing.filter((id) => !inTrash.has(id))

    // A file the Pool already had (same bytes) or that came back under
    // `local-<sha8>` keeps its picture on the profile under that id.
    const s = get()
    const slot = s.flistWorking[characterId]
    const renamed = slot && !showsReadOnlyView(s, characterId)
      ? renameGalleryRows(slot.payload, renames)
      : null
    if (renamed) {
      host.commit(characterId, {
        kind: 'edit',
        label: 'edit',
        payload: renamed,
        undoStep: true
      })
    }
    note(putBackNote(action, { putBack, leftInTrash, missing: gone }))
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    note(
      `${stepName(action)} brought back ${imageIds.join(', ')}, but the Trash could not be checked: ${why}.`
    )
  }
}
