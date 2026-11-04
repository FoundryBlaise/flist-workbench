// The Workbench slice: the one editable copy of each character's
// profile as the window holds it. Opening a character (with the
// open-race guard), the editor showing it, the save pipeline with its
// autosave timers, single-flight saves and the etag, changes another
// writer made and the merge with them, Undo and Redo, reset to Live,
// Restore, and the edit actions of every tab (profile fields, kinks,
// custom kinks, the gallery, the Diff tab's reset).
//
// What the Workbench needs of the other slices goes through their
// actions: Live and an ended browse through the Archive
// (`flistEnsureLive`, `flistEndBrowse`), the Log filter through Logs,
// leaving the Foreign profile through Foreign. The Account and the
// Archive in turn reach the Workbench only through the actions here.

import {
  api,
  errorDetail,
  HttpError,
  RefusalError,
  refusalCode,
  workbenchConflict,
  type FlistTrashItem,
  type InlineImage
} from '../../lib/api'
import {
  DESCRIPTION_PATH,
  applyEdit as flistApplyEdit,
  applyReset as flistApplyReset,
  descriptionOf,
  detectLiveDrift,
  emptyWorkingSlot,
  extractInlines as flistExtractInlines,
  isDeepEqual,
  seedWorkingFromLive,
  type FlistWorkingSlot,
  type GalleryRow,
  type WorkingPayload
} from '../flist'
import {
  commitSlot,
  externalLabel,
  type Commit,
  type CommitEvent,
  type CommitLabel,
  type TheirVersion
} from '../commit'
import {
  endTyping,
  hiddenWorkbench,
  hideWorkbench,
  recordChange,
  resetUndoStacks,
  takeRedo,
  takeUndo,
  unhideWorkbench
} from '../undoStack'
import { imagesToFind, putBackNote, renameGalleryRows, stepName } from '../undoTrash'
import type { UndoAction } from '../../lib/undoRedo'
import { mergeWorkbench, type MergeSide } from '../merge'
import type { State } from '../../state'
import type { SliceCreator } from './slice'

// Auto-pull threshold. Matches the picker's own staleness display so
// the UI and the auto-pull policy can't drift apart. F-list's hourly
// API cap is 200 — even a user hopping between 30 characters all day
// stays well under it at this rate.
const STALE_AGE_SEC = 30 * 60

export type WorkbenchState = {
  editorContent: string
  editorTitle: string
  editorInlines: Record<string, InlineImage>
  editorFetchStatus: 'idle' | 'fetching' | 'ok' | 'error'
  editorFetchError: string | null
  editorDirty: boolean

  saveStatus: 'idle' | 'saving' | 'saved' | 'error'
  saveError: string | null
  /** Set by EditorPane after an idle window; "draft has been flushed". */
  draftStatus: 'idle' | 'saving' | 'saved' | 'error'

  // ---- F-list character archive (Phase 7 Tier 1) ----
  /** ID of the F-list character whose Live/Backup docs the user is
   *  currently viewing. Distinct from `activeCharacter` (the F-Chat-log
   *  filter) because the two rosters don't always overlap. */
  flistActiveCharacterId: string | null
  /** Per-character working copies, persisted to
   *  `<userdata>/characters/<character_id>/working.json` (Tier 2 §1).
   *  The slot tracks the full JSON-API payload, the dotted overlay of
   *  user-edited paths, the sha256 etag for optimistic concurrency, and
   *  per-slot save status so the editor can surface a "saving / saved /
   *  error" chip without storing UI-only data on disk.
   *
   *  The one Workbench slot: the editor edits it and autosave writes it
   *  through the Workbench endpoint. */
  flistWorking: Record<string, FlistWorkingSlot>
  flistWorkingLoadStatus: Record<string, 'idle' | 'loading' | 'ready' | 'error'>
  /** When each character's Workbench was last changed (epoch seconds),
   *  or null while it has none. Absent until `flistLoadWorkbenchInfo`
   *  has asked. */
  flistWorkbenchInfo: Record<string, { updatedAt: number } | null>
  /** Why the last Restore of each character was turned down, shown in
   *  the Backup list; null once one goes through or it is dismissed. */
  flistRestoreRefusal: Record<string, string | null>
  /** True while the window shows a character's Live instead of its
   *  Workbench. The window's own choice: nothing on disk records it, so
   *  looking at Live writes nothing and no other writer can flip it. */
  flistViewingLive: Record<string, boolean>
  /** A change to a Workbench that this window did not make (almost
   *  always a model editing through MCP, or a save refused as stale)
   *  whose read is still out. Keyed by character id; null or absent
   *  when none is. The read takes the change in, or merges it with the
   *  window's unsaved edits. */
  flistExternalChange: Record<
    string,
    { etag: string | null; origin: string; at: number } | null
  >
  /** A merge with another writer's version that found fields both sides
   *  changed differently: the window asks "Keep mine" / "Take theirs"
   *  for each of `fields` (merge field keys, state/merge.ts) before
   *  anything is committed. `theirs` is that version, on disk at
   *  `etag`; `label` names the writer; `answered` holds the answers
   *  already given when a later edit raised new fields to ask about.
   *  Keyed by character id. */
  flistMergeQuestion: Record<
    string,
    | (TheirVersion & {
        fields: string[]
        answered?: Record<string, MergeSide>
        at: number
      })
    | null
  >
  /** The last thing the window did to a Workbench by itself or on
   *  Ctrl+Z / Ctrl+Y that the user should be told about: another
   *  writer's change taken in (`updated`), or an undo / redo stepping
   *  over a change, with that change's label. The note fades in the
   *  window; null when there is nothing to say. */
  flistWorkbenchNote: {
    characterId: string
    action: 'updated' | UndoAction
    label: CommitLabel
    at: number
  } | null
  /** What an undo or redo did about gallery images whose files were not
   *  in the pool: put back from the Trash, or missing. Keyed by
   *  character id; the window shows the active character's and fades it. */
  flistUndoNotes: Record<string, { text: string; at: number }>
  /** "F-list-side change in N fields since you started editing — review."
   *  Set after a Live re-pull when the new Live differs from what the
   *  working copy is showing on a path the user has NOT edited. Keyed
   *  by character id so per-character switches keep their own banner. */
  flistDriftBanners: Record<string, { paths: string[]; dismissedAt: number | null }>
  /** Tier 4 — per-character right-hand source for the Diff tab.
   *  Ephemeral (no disk persistence — default = Live each session). */
  flistDiffRightSource: Record<
    string,
    { kind: 'live' } | { kind: 'backup'; filename: string }
  >
  /** Tier 4 — lazy-loaded backup payloads. Keyed by
   *  `${characterId}:${filename}`. Read-only and rarely re-opened, so
   *  no LRU (R-2). Cleared on sign-out. */
  flistDiffBackupCache: Record<string, Record<string, unknown>>
  /** Tier 4 — per-(characterId, filename) load status so DiffPane can
   *  distinguish "still fetching" from "404 / network error" (QA P3-3
   *  / UX P1-3). */
  flistDiffBackupStatus: Record<string, 'loading' | 'loaded' | 'error'>
  /** Tier 3 — ephemeral UI state for the custom-kinks editor. */
  flistCustomKinksUI: Record<
    string,
    {
      selectedKinkId: string | null
      /** Multi-selection for bulk operations (Tier 3 PR4). Order is
       *  insignificant; rendered as a count chip in the bar. */
      selectedKinkIds: string[]
      showDeleted: boolean
      sort: 'insertion' | 'name' | 'choice'
      filter: string
    }
  >
  /** When true, EditorPane/PreviewPane/Toolbar all switch to read-only
   *  mode. Set whenever the user opens a Live or historical Backup
   *  document. */
  editorReadOnly: boolean
}

export type WorkbenchSlice = WorkbenchState & {
  selectCharacter: (name: string | null) => void
  setEditorContent: (value: string) => void
  fetchProfile: (name: string) => Promise<void>
  resetEditorDirty: () => void

  // ---- F-list actions ----
  flistSelectCharacter: (characterId: string | null) => Promise<void>
  /** No F-list character is open any more (a Log-only character was
   *  picked, the sign-in lapsed): the editor is editable again. What
   *  the window holds of each Workbench stays. */
  flistCloseCharacter: () => void
  /** Back to the character's Workbench from a read-only view: the editor
   *  is editable at once, and the Workbench is opened again. */
  flistBackToWorkbench: (characterId: string) => Promise<void>
  // ---- v5 image actions ----
  /** Append `imageId` to working.json's gallery (move pool→profile).
   *  No-op if the id is already in the gallery. */
  flistMoveImageToProfile: (
    characterId: string,
    imageId: string
  ) => void
  /** Append several images to the gallery in the order given, as one
   *  change (one undo entry). Ids already in the gallery are skipped. */
  flistAddImagesToProfile: (characterId: string, imageIds: string[]) => void
  /** Drop `imageId` from working.json's gallery (move profile→pool).
   *  The file stays in the pool — flistTrashImages moves it to the Trash. */
  flistMoveImageToPool: (
    characterId: string,
    imageId: string
  ) => void
  /** `typing` names the caption typed in (`images.<id>.description`):
   *  keystrokes in it without a pause are one undo entry. */
  flistSetGalleryImages: (
    characterId: string,
    images: { image_id: string; description: string; sort_order: number }[],
    opts?: { typing?: string }
  ) => void
  flistOpenLive: (characterId: string) => Promise<void>
  /** Load the editor with this character's working copy.
   *  Falls back to the Live description when no working copy exists
   *  yet (materialise-on-first-edit, §1.6). The previous character's
   *  edits stay in `flistWorking` so a later switch-back restores them
   *  verbatim. */
  flistOpenWorking: (characterId: string) => Promise<void>
  /** Ask the sidecar whether the character has a Workbench yet and
   *  when it last changed, for the Workbench row. Creates nothing. */
  flistLoadWorkbenchInfo: (characterId: string) => Promise<void>
  /** Show the character's Live, read-only, in place of its Workbench.
   *  Saves pending Workbench edits first. */
  flistShowLive: (characterId: string) => Promise<void>
  /** Restore: replace the Workbench contents with a Backup's. The
   *  sidecar saves the Workbench as a Backup first, always. False when
   *  nothing was restored. */
  flistLoadBackupIntoWorkbench: (
    characterId: string,
    filename: string
  ) => Promise<boolean>
  /** Hide the reason the last Restore was turned down. */
  flistDismissRestoreRefusal: (characterId: string) => void
  /** Record that something outside this window changed the Workbench.
   *  Called by the `/events` subscription; ignored when the change is
   *  one we made ourselves. */
  flistNoteExternalChange: (
    characterId: string,
    change: { etag: string | null; origin: string }
  ) => void
  /** Answer the merge question: for each field asked about, keep mine
   *  or take theirs (a field left out keeps mine). The merge is then one
   *  commit, one undo entry, saved over the other writer's etag; unless
   *  an edit since the question was asked changed another field they
   *  changed too, which is then asked about first. */
  flistAnswerMerge: (characterId: string, choices: Record<string, MergeSide>) => void
  // ---- What the Archive slice asks of the Workbench ----
  /** A Pull brought the character a new Live. A Workbench nobody
   *  edited and never saved is seeded from it again; a saved one open
   *  in the editor is read again, with a banner naming the fields F-list
   *  changed underneath it. */
  flistNoteNewLive: (characterId: string) => void
  /** Show a Live or Backup payload read-only in the character's
   *  Workbench slot, in place of the Workbench, which the undo stack
   *  keeps aside. Nothing is saved from it. */
  flistShowReadOnlyView: (characterId: string, payload: Record<string, unknown>) => void
  /** Before the sidecar takes any of `imageIds` off the Workbench's
   *  gallery: what was typed is saved (after any save in flight), or
   *  the sidecar's write would make it stale. Throws when it could not
   *  be saved. Does nothing when none of them is on the gallery. */
  flistSaveBeforeGalleryWrite: (characterId: string, imageIds: string[]) => Promise<void>
  /** The sidecar took `imageIds` off the Workbench's gallery and wrote
   *  it at `etag`: the slot shows that and saves the next edit over it.
   *  Anything typed meanwhile stays unsaved and goes with it. */
  flistTakeOffGallery: (characterId: string, imageIds: string[], etag: string | null) => void

  // ---- Tier 2 working-copy actions ----
  /** `typing`: the value is a keystroke in that field's text, and
   *  keystrokes in one field without a pause are one undo entry. */
  flistSetWorkingField: (
    characterId: string,
    path: string,
    value: unknown,
    opts?: { typing?: boolean }
  ) => void
  /** The text field being typed in lost focus: the next keystroke
   *  starts a new undo entry, however soon it comes. */
  flistEndTyping: (characterId: string) => void
  flistResetWorkingField: (characterId: string, path: string) => void
  /** Restore a single image row in working.json's gallery to match Live —
   *  add/remove/update the entry for `imageId` so working aligns with
   *  Live for that one image, leaving other gallery edits intact. */
  flistResetImageRow: (characterId: string, imageId: string) => void
  flistFlushWorking: (characterId: string) => Promise<void>
  /** Ctrl+Z on a Workbench: puts back the payload from before the
   *  character's last change, as an unsaved edit the autosave writes
   *  over the etag the window holds. Does nothing while the window
   *  shows Live or a browsed Backup, or with nothing to undo. Returns
   *  the label of the change it undid, or null. */
  flistUndo: (characterId: string) => CommitLabel | null
  /** Ctrl+Y: the mirror of flistUndo, applying the undone change again. */
  flistRedo: (characterId: string) => CommitLabel | null
  flistDismissUndoNote: (characterId: string) => void
  /** Saves every character's pending edits now, waiting out the
   *  autosave's debounce and any save already on its way. */
  flistFlushAllWorking: () => Promise<void>
  /** Sign-out's end of the Workbenches: cancels the autosaves still
   *  waiting (flush them first) and drops every character's Workbench,
   *  its undo history and what the window showed of it, so the account
   *  signing in next finds none of this one's. */
  flistDropAllWorkbenches: () => void
  flistResetWorkingToLive: (characterId: string) => Promise<void>
  flistDismissDriftBanner: (characterId: string) => void
  // ---- Tier 3 custom-kinks slice ----
  flistCustomKinksSelect: (characterId: string, kinkId: string | null) => void
  flistCustomKinksAdd: (characterId: string) => string
  flistCustomKinksEdit: (
    characterId: string,
    kinkId: string,
    field: 'name' | 'description' | 'choice',
    value: string
  ) => void
  flistCustomKinksTombstone: (characterId: string, kinkId: string) => void
  flistCustomKinksUndelete: (characterId: string, kinkId: string) => void
  flistCustomKinksReorder: (characterId: string, nextOrder: string[]) => void
  flistCustomKinksResetField: (
    characterId: string,
    kinkId: string,
    field: 'name' | 'description' | 'choice'
  ) => void
  flistCustomKinksBulkSetChoice: (
    characterId: string,
    kinkIds: string[],
    choice: string
  ) => void
  flistCustomKinksSetUI: (
    characterId: string,
    patch: Partial<{
      showDeleted: boolean
      sort: 'insertion' | 'name' | 'choice'
      filter: string
    }>
  ) => void
  flistCustomKinksToggleMulti: (
    characterId: string,
    kinkId: string,
    opts?: { range?: boolean; rowsInOrder?: string[] }
  ) => void
  flistCustomKinksClearMulti: (characterId: string) => void
  flistCustomKinksBulkTombstone: (characterId: string, kinkIds: string[]) => void
  flistStandardKinkSet: (characterId: string, kinkId: string, choice: string) => void
  flistStandardKinksBulkSetChoice: (
    characterId: string,
    kinkIds: string[],
    choice: string
  ) => void
  /** Tier 4 — set the Diff tab's right-hand source. */
  flistDiffSetRightSource: (
    characterId: string,
    source: { kind: 'live' } | { kind: 'backup'; filename: string }
  ) => void
  /** Tier 4 — fetch + cache a backup payload (idempotent). */
  flistDiffLoadBackup: (characterId: string, filename: string) => Promise<void>
  /** The Diff tab's "reset to this": with Live picked, reset the
   *  Workbench to Live; with a Backup picked, Restore that Backup. Both
   *  are the same actions as elsewhere, so the sidecar keeps the
   *  replaced Workbench as a `before-restore` Backup either way. */
  flistDiffResetToSource: (characterId: string) => Promise<void>
}

/** The Workbench state as the window starts: no character open,
 *  nothing in memory. Tests reset the slice with
 *  `useStore.setState(workbenchInitialState())`. */
export function workbenchInitialState(): WorkbenchState {
  return {
    editorContent: '',
    editorTitle: '',
    editorInlines: {},
    editorFetchStatus: 'idle',
    editorFetchError: null,
    editorDirty: false,

    saveStatus: 'idle',
    saveError: null,
    draftStatus: 'idle',

    flistActiveCharacterId: null,
    flistWorking: {},
    flistWorkingLoadStatus: {},
    flistWorkbenchInfo: {},
    flistRestoreRefusal: {},
    flistViewingLive: {},
    flistExternalChange: {},
    flistMergeQuestion: {},
    flistWorkbenchNote: null,
    flistUndoNotes: {},
    flistDriftBanners: {},
    flistDiffRightSource: {},
    flistDiffBackupCache: {},
    flistDiffBackupStatus: {},
    flistCustomKinksUI: {},
    editorReadOnly: false
  }
}

// Per-character autosave debouncers (Tier 2 §1.5 — 500 ms quiet time).
// Keyed by character id so per-character switches don't race.
const _autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Per-character tail of the flush chain: the last flistFlushWorking
// call, which settles only after every flush queued before it has.
// Overlapping calls run one after another, so a later flush can't race
// a still-running PUT and "succeed" on a stale payload (QA P1-4), and
// two queued flushes can't send PUTs over the same etag.
const _flushInflight = new Map<string, Promise<void>>()
const AUTOSAVE_DEBOUNCE_MS = 500

// Per-character request token for flistOpenWorking: the number of the
// newest open. Clicking quickly between characters leaves several
// reads in flight, landing in any order; only the newest open of a
// character may apply its read, so an older one can never put a stale
// payload (or a stale etag) back over a newer one.
const _openTokens = new Map<string, number>()

function _beginOpen(characterId: string): number {
  const token = (_openTokens.get(characterId) ?? 0) + 1
  _openTokens.set(characterId, token)
  return token
}

function _isNewestOpen(characterId: string, token: number): boolean {
  return _openTokens.get(characterId) === token
}

/** The editor patch that shows a character's Workbench as the slot in
 *  memory holds it, unsaved keystrokes included. */
function _workbenchInEditor(s: State, characterId: string): Partial<WorkbenchState> {
  const slot = s.flistWorking[characterId]
  const live = s.flistArchive[characterId]?.live ?? null
  const entry = s.flistRoster.find((r) => String(r.id ?? '') === characterId)
  // "Workbench", not "My edits": the sidebar row, the window title
  // and the read-only hints all name the same one thing now. Two
  // names for it was half the reason testers could not say what they
  // were editing.
  const name = entry?.name ?? 'Workbench'
  const titleSuffix = slot?.unsavedDirty ? ' (unsaved)' : ''
  return {
    editorContent: slot ? descriptionOf(slot.payload) : '',
    editorTitle: `${name} — Workbench${titleSuffix}`,
    editorInlines: live ? flistExtractInlines(live) : {},
    editorReadOnly: false,
    editorDirty: !!slot?.unsavedDirty,
    saveStatus: 'idle',
    saveError: null,
    draftStatus: 'idle'
  }
}

/** The editor patch for a switch to a character whose Workbench is not
 *  in memory yet: empty and read-only under the new character's name
 *  until the read lands. Showing the character being left would save
 *  its text into this one on the next keystroke, and a keystroke with
 *  no slot to land in would be dropped when the read replaced it. */
function _workbenchLoadingInEditor(s: State, characterId: string): Partial<WorkbenchState> {
  const entry = s.flistRoster.find((r) => String(r.id ?? '') === characterId)
  const name = entry?.name ?? 'Workbench'
  return {
    editorContent: '',
    editorTitle: `${name} — Workbench (loading)`,
    editorInlines: {},
    editorReadOnly: true,
    editorDirty: false,
    saveStatus: 'idle',
    saveError: null,
    draftStatus: 'idle'
  }
}

function _scheduleFlush(characterId: string, fn: () => void): void {
  const prev = _autosaveTimers.get(characterId)
  if (prev) clearTimeout(prev)
  const t = setTimeout(() => {
    _autosaveTimers.delete(characterId)
    fn()
  }, AUTOSAVE_DEBOUNCE_MS)
  _autosaveTimers.set(characterId, t)
}

// A helper's set: it writes only Workbench fields, and reaches the other
// slices through their actions.
type SlotSet = (fn: (s: State) => Partial<WorkbenchState>) => void

/** The editor follows the active character's slot: whatever a commit
 *  leaves in the payload is the description the editor shows. Edits and
 *  written commits reach it only while it shows the Workbench (not a
 *  read-only view); a view sets what it shows itself. */
function _editorFollows(
  s: State,
  characterId: string,
  next: FlistWorkingSlot | null,
  commit: Commit
): Partial<WorkbenchState> {
  if (!next || s.flistActiveCharacterId !== characterId) return {}
  const editorContent = descriptionOf(next.payload)
  if (commit.kind === 'view') return { editorContent, editorDirty: false }
  if (s.editorReadOnly) return {}
  if (commit.kind === 'edit' || commit.kind === 'merged') {
    return { editorContent, editorDirty: s.editorDirty || editorContent !== s.editorContent }
  }
  return commit.keepPending ? { editorContent } : { editorContent, editorDirty: false }
}

/** The one commit point: the only code that puts a new payload into a
 *  character's Workbench slot (see state/commit.ts for the kinds). An
 *  edit marks the slot unsaved and schedules the autosave; a written
 *  commit adopts the sidecar's etag; a view replaces or drops the slot
 *  without being a change. `also` adds to the same store update, so the
 *  slot and whatever goes with it change together. */
function _commit(
  get: () => State,
  set: SlotSet,
  characterId: string,
  commit: Commit,
  also?: (s: State) => Partial<WorkbenchState>
): void {
  // Filled in by the update below; a callback assignment TypeScript
  // would not see through a plain `let`.
  const done: { event: CommitEvent | null; covered: boolean; coveredAfter: boolean } = {
    event: null,
    covered: false,
    coveredAfter: false
  }
  set((s) => {
    const current = s.flistWorking[characterId]
    const next = commitSlot(current, commit)
    if (next === undefined) return {}
    const flistWorking = { ...s.flistWorking }
    if (next) flistWorking[characterId] = next
    else delete flistWorking[characterId]
    done.event = {
      characterId,
      kind: commit.kind,
      label: commit.kind === 'view' ? null : commit.label,
      previous: current?.payload ?? null,
      next: next?.payload ?? null
    }
    const patch = {
      ...also?.(s),
      flistWorking,
      ..._editorFollows(s, characterId, next, commit)
    }
    done.covered = _slotHoldsView(s, characterId)
    done.coveredAfter = _slotHoldsView({ ...s, ...patch }, characterId)
    return patch
  })
  const event = done.event
  if (!event) return
  if (commit.kind === 'view') endTyping(characterId)
  else {
    // Under a view the slot holds Live or a Backup, not the Workbench: a
    // change made from there replaced the Workbench the view hides.
    const replaced = done.covered ? hiddenWorkbench(characterId) : event.previous
    if (replaced && !(commit.kind === 'edit' && commit.undoStep)) {
      recordChange(
        characterId,
        commit.label,
        replaced,
        commit.kind === 'edit' ? commit.typing : undefined
      )
    }
  }
  if (!done.coveredAfter) unhideWorkbench(characterId)
  else if (!done.covered && event.previous) hideWorkbench(characterId, event.previous)
  else if (commit.kind !== 'view' && event.next) hideWorkbench(characterId, event.next)
  if (commit.kind === 'edit' || commit.kind === 'merged') {
    _scheduleFlush(characterId, () => {
      void get().flistFlushWorking(characterId)
    })
  }
}

/** True while the window shows a character's Live or a Backup being
 *  browsed in its Workbench slot: nothing may be written from there. */
function _showsReadOnlyView(s: State, characterId: string): boolean {
  return !!s.flistViewingLive[characterId] || s.flistBrowseBackup?.characterId === characterId
}

/** True while a character's slot holds Live or a browsed Backup instead
 *  of the Workbench, which the undo stack then keeps aside. A Backup
 *  still loading for browse is not in the slot yet. */
function _slotHoldsView(s: State, characterId: string): boolean {
  const browse = s.flistBrowseBackup
  return (
    !!s.flistViewingLive[characterId] ||
    (browse?.characterId === characterId && browse.status === 'ready')
  )
}

/** One undo or redo step: the stack moves and hands back the payload to
 *  put in, which is committed as an edit, so it is unsaved and the
 *  autosave writes it over the etag the slot holds. The note says which
 *  change was stepped over. */
function _undoStep(
  get: () => State,
  set: SlotSet,
  characterId: string,
  action: UndoAction
): CommitLabel | null {
  const take = action === 'undo' ? takeUndo : takeRedo
  const s = get()
  const slot = s.flistWorking[characterId]
  if (!slot || _showsReadOnlyView(s, characterId)) return null
  const entry = take(characterId, slot.payload)
  if (!entry) return null
  const pool = s.flistCharacterImages[characterId]
  const toFind = imagesToFind(entry.payload, slot.payload, pool?.byId ?? null)
  _commit(
    get,
    set,
    characterId,
    { kind: 'edit', label: 'edit', payload: entry.payload, undoStep: true },
    () => ({ flistWorkbenchNote: { characterId, action, label: entry.label, at: Date.now() } })
  )
  if (toFind.length > 0) {
    _putBackBeforeSave(get, set, characterId, toFind, action)
  }
  return entry.label
}

/** An undo or redo brought back gallery images the pool may not hold.
 *  Their files are put back from the Trash before the payload is saved:
 *  the work is a link in the character's flush chain (see
 *  flistFlushWorking), so the autosave the step scheduled waits for it.
 *  Never rejects; what happened goes into the character's undo note. */
function _putBackBeforeSave(
  get: () => State,
  set: SlotSet,
  characterId: string,
  imageIds: string[],
  action: UndoAction
): void {
  const prior = _flushInflight.get(characterId)
  const link = (async () => {
    if (prior) await prior.catch(() => {})
    await _putBackFromTrash(get, set, characterId, imageIds, action)
  })()
  _flushInflight.set(characterId, link)
  const done = () => {
    if (_flushInflight.get(characterId) === link) _flushInflight.delete(characterId)
  }
  void link.then(done, done)
}

async function _putBackFromTrash(
  get: () => State,
  set: SlotSet,
  characterId: string,
  imageIds: string[],
  action: UndoAction
): Promise<void> {
  const note = (text: string | null) => {
    if (!text) return
    set((s) => ({
      flistUndoNotes: { ...s.flistUndoNotes, [characterId]: { text, at: Date.now() } }
    }))
  }
  try {
    // Only a pool the window has read can say which files are missing.
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

    // A file the pool already had (same bytes) or that came back under
    // `local-<sha8>` keeps its picture on the profile under that id.
    const s = get()
    const slot = s.flistWorking[characterId]
    const renamed = slot && !_showsReadOnlyView(s, characterId)
      ? renameGalleryRows(slot.payload, renames)
      : null
    if (renamed) {
      _commit(get, set, characterId, {
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

type ExternalChange = NonNullable<State['flistExternalChange'][string]>

/** Take another writer's version of a character's Workbench: read it
 *  and commit it over its etag, an undo entry labelled with the writer.
 *  With unsaved edits in the slot, made before the read or while it was
 *  out (typing included), the two versions are merged field by field
 *  instead (_mergeExternal). A failed read drops the change: the next
 *  save goes over the stale etag, is refused, and reads again. */
async function _takeExternalChange(
  get: () => State,
  set: SlotSet,
  characterId: string,
  change: ExternalChange
): Promise<void> {
  const before = get().flistWorking[characterId]
  let res: Awaited<ReturnType<typeof api.flistWorkbenchPayloadRead>>
  try {
    res = await api.flistWorkbenchPayloadRead(characterId, { create: false })
  } catch {
    set((st) =>
      st.flistExternalChange[characterId] === change
        ? { flistExternalChange: { ...st.flistExternalChange, [characterId]: null } }
        : {}
    )
    return
  }
  const s = get()
  // A newer change came in while this read was out; its own read
  // brings the newer payload.
  if (s.flistExternalChange[characterId] !== change) return
  const slot = s.flistWorking[characterId]
  if (slot !== before && !slot?.unsavedDirty) {
    // Still nothing unsaved (the slot became a view, say): read again
    // against what the slot holds now.
    void _takeExternalChange(get, set, characterId, change)
    return
  }
  const label = externalLabel(change.origin)
  const payload = res.payload as WorkingPayload
  const cleared = (st: State): Partial<WorkbenchState> => ({
    flistExternalChange: { ...st.flistExternalChange, [characterId]: null }
  })
  // Taken in by itself: say who changed it, the part the user cannot see.
  const settled = (st: State): Partial<WorkbenchState> => ({
    ...cleared(st),
    flistWorkbenchNote: { characterId, action: 'updated' as const, label, at: Date.now() }
  })
  const hidden = hiddenWorkbench(characterId)
  if (s.flistViewingLive[characterId] || hidden) {
    // The slot shows Live or a Backup, not the Workbench (or is about to
    // get the Workbench back from its own read): leave the slot alone.
    // Going back to the Workbench reads it from disk; the change is its
    // entry now, stepping from the Workbench the view hid. A read that
    // brings nothing new (the event of a write an earlier read already
    // took in) is not a change.
    if (hidden && !isDeepEqual(hidden, payload)) {
      recordChange(characterId, label, hidden)
      hideWorkbench(characterId, { ...payload })
    }
    set(settled)
    return
  }
  // Nothing to take: the slot is gone, or already on this version.
  if (!slot || slot.etag === res.etag) {
    set(cleared)
    return
  }
  if (slot.unsavedDirty) {
    // Typing while the read was out is in the slot already: it is mine.
    _mergeExternal(get, set, characterId, { label, theirs: payload, etag: res.etag }, settled, cleared)
    return
  }
  _commit(
    get,
    set,
    characterId,
    { kind: 'written', label, payload, etag: res.etag, lastSavedAt: Date.now() },
    settled
  )
}

/** Merge the slot's unsaved edits with another writer's version
 *  (`their.theirs`, on disk at `their.etag`), field by field against the payload
 *  last saved (state/merge.ts). Settled at once, the merge is committed:
 *  one undo entry, saved over the other writer's etag. Fields both sides
 *  changed are asked about first (flistMergeQuestion), and the answer
 *  commits (flistAnswerMerge). `merged` and `asked` add to the store
 *  update of each outcome. */
function _mergeExternal(
  get: () => State,
  set: SlotSet,
  characterId: string,
  their: TheirVersion,
  merged: (s: State) => Partial<WorkbenchState>,
  asked: (s: State) => Partial<WorkbenchState>
): void {
  const slot = get().flistWorking[characterId]
  if (!slot) return
  const { payload, conflicts } = mergeWorkbench(slot.saved, slot.payload, their.theirs)
  if (conflicts.length > 0) {
    set((s) => ({
      ...asked(s),
      flistMergeQuestion: {
        ...s.flistMergeQuestion,
        [characterId]: { ...their, fields: conflicts, at: Date.now() }
      }
    }))
    return
  }
  _commitMerge(get, set, characterId, payload, their, merged)
}

/** A merge's one commit. A merge that comes out as their version (every
 *  unsaved edit was one they made too) is simply theirs, saved; anything
 *  else is unsaved and goes over their etag. */
function _commitMerge(
  get: () => State,
  set: SlotSet,
  characterId: string,
  payload: WorkingPayload,
  { label, theirs, etag }: TheirVersion,
  also: (s: State) => Partial<WorkbenchState>
): void {
  const commit: Commit = isDeepEqual(payload, theirs)
    ? { kind: 'written', label, payload: theirs, etag, lastSavedAt: Date.now() }
    : { kind: 'merged', label, payload, etag, saved: theirs }
  _commit(get, set, characterId, commit, also)
}

/** Sign-out's commit: every slot dropped at once, as a view. */
function _dropAllWorkbenches(set: SlotSet, also: (s: State) => Partial<WorkbenchState>): void {
  set((s) => ({ ...also(s), flistWorking: {} }))
  // Another account may sign in next: nothing of this one's to undo.
  resetUndoStacks()
}

function _cancelFlush(characterId: string): void {
  const prev = _autosaveTimers.get(characterId)
  if (prev) {
    clearTimeout(prev)
    _autosaveTimers.delete(characterId)
  }
}

function _cancelAllPendingTimers(): void {
  for (const [, t] of _autosaveTimers) clearTimeout(t)
  _autosaveTimers.clear()
}

/** One save of a character's Workbench: the PUT itself, with no
 *  queueing. Only flistFlushWorking calls this, as the last step of its
 *  per-character chain, so two saves never leave for the same character
 *  at once. */
async function _flushWorkingNow(
  characterId: string,
  get: () => State,
  set: SlotSet
): Promise<void> {
  const slot = get().flistWorking[characterId]
  if (!slot || !slot.unsavedDirty) {
    // Second cancel post-early-return — a scheduleFlush may have armed
    // while this flush waited its turn; we'd otherwise leave a stranded
    // timer (QA P3-3).
    _cancelFlush(characterId)
    return
  }
  // Every save sends the etag the window read; the sidecar refuses a
  // write without one. A slot that was never materialised has no etag:
  // the window found no Workbench when it opened the character and
  // seeded the editor from Live (materialise-on-first-edit: looking at
  // a character creates nothing, the first edit does). Ask for the
  // Workbench now, which makes it from Live, and save over that. If it
  // already existed, something else made it since the window looked,
  // and it may hold edits this slot never saw: that is a conflict, not
  // a copy to overwrite.
  //
  // This used to return early and drop the write. Nothing said so —
  // saveStatus stayed 'idle' — and the edits died with the next
  // character switch.
  let baseEtag = slot.materialised ? slot.etag : null
  if (!slot.materialised) {
    let bench: Awaited<ReturnType<typeof api.flistWorkbenchPayloadRead>> | null = null
    let readError = ''
    try {
      bench = await api.flistWorkbenchPayloadRead(characterId)
    } catch (err) {
      // `no_workbench`: no Live to make one from, a character that was
      // never pulled. Anything else is the read itself failing.
      readError =
        err instanceof RefusalError && err.code === 'no_workbench'
          ? 'No Workbench yet — pull this character first.'
          : err instanceof Error
            ? err.message
            : String(err)
    }
    if (!bench) {
      // Keep the edits in memory and say so, rather than pretending
      // they were saved.
      set((st) => {
        const existing = st.flistWorking[characterId]
        if (!existing) return {}
        return {
          flistWorking: {
            ...st.flistWorking,
            [characterId]: {
              ...existing,
              saveStatus: 'error',
              saveError: readError
            }
          }
        }
      })
      _cancelFlush(characterId)
      return
    }
    if (!bench.created) {
      _noteSaveConflict(get, set, characterId, null, bench.etag)
      return
    }
    baseEtag = bench.etag
  }
  // Pin the exact payload we're shipping so the success branch can
  // tell whether new edits arrived during the round-trip.
  const sentPayload = slot.payload
  set((s) => {
    const existing = s.flistWorking[characterId]
    if (!existing) return {}
    return {
      flistWorking: {
        ...s.flistWorking,
        [characterId]: { ...existing, saveStatus: 'saving', saveError: null }
      }
    }
  })
  try {
    const { etag } = await api.flistWorkbenchPayloadPut(characterId, sentPayload, baseEtag)
    set((s) => {
      const existing = s.flistWorking[characterId]
      if (!existing) return {}
      const info = {
        // The Workbench row's "last changed" follows the save.
        flistWorkbenchInfo: {
          ...s.flistWorkbenchInfo,
          [characterId]: { updatedAt: Math.floor(Date.now() / 1000) }
        }
      }
      // Another writer's version was taken in while this save was out
      // (a merge or a reload): the slot sits on that newer version, which
      // already holds this save, and must not go back to this etag.
      if (existing.etag !== slot.etag) return info
      // If the user typed something newer while we were saving, the
      // newer slot's `payload` won't match `sentPayload` — keep
      // unsavedDirty=true so the next flush picks up the delta.
      const isFresh = existing.payload === sentPayload
      const nextSlot: FlistWorkingSlot = {
        ...existing,
        etag,
        unsavedDirty: isFresh ? false : existing.unsavedDirty,
        saveStatus: isFresh ? 'saved' : existing.saveStatus,
        saveError: null,
        lastSavedAt: Date.now(),
        materialised: true,
        saved: sentPayload
      }
      return { ...info, flistWorking: { ...s.flistWorking, [characterId]: nextSlot } }
    })
    // If a newer payload is waiting, schedule a follow-up flush so
    // the user's most recent edits land without needing another
    // keystroke.
    const next = get().flistWorking[characterId]
    if (next?.unsavedDirty) {
      _scheduleFlush(characterId, () => {
        void get().flistFlushWorking(characterId)
      })
    }
  } catch (err) {
    const conflict = workbenchConflict(err)
    if (conflict) {
      _noteSaveConflict(get, set, characterId, baseEtag, conflict.currentEtag)
      return
    }
    const raw = errorDetail(err)
    set((s) => {
      const existing = s.flistWorking[characterId]
      if (!existing) return {}
      return {
        flistWorking: {
          ...s.flistWorking,
          [characterId]: { ...existing, saveStatus: 'error', saveError: raw, unsavedDirty: true }
        }
      }
    })
  }
}

/** A save the sidecar refused because the Workbench on disk is not the
 *  one the window read: something else wrote it. The edits stay in the
 *  slot, and the other version is read and merged with them, as for a
 *  change the event stream announced. `sentEtag` is the etag the save
 *  went over: a slot that has moved off it meanwhile was already merged
 *  onto the newer version, and its next save goes over that one. */
function _noteSaveConflict(
  get: () => State,
  set: SlotSet,
  characterId: string,
  sentEtag: string | null,
  currentEtag: string | null
): void {
  const s = get()
  const slot = s.flistWorking[characterId]
  if (!slot) return
  if (slot.etag !== sentEtag) {
    set((st) => {
      const existing = st.flistWorking[characterId]
      if (!existing) return {}
      return {
        flistWorking: { ...st.flistWorking, [characterId]: { ...existing, saveStatus: 'idle' } }
      }
    })
    if (get().flistWorking[characterId]?.unsavedDirty) {
      _scheduleFlush(characterId, () => {
        void get().flistFlushWorking(characterId)
      })
    }
    return
  }
  set((st) => {
    const existing = st.flistWorking[characterId]
    if (!existing) return {}
    return {
      flistWorking: {
        ...st.flistWorking,
        [characterId]: {
          ...existing,
          saveStatus: 'error',
          saveError: 'Someone else changed this Workbench. Merging their version with yours.',
          // The server etag is deliberately NOT adopted here. Adopting
          // it would let the next keystroke's autosave succeed and
          // silently overwrite the other writer; only the merge, which
          // holds their version, moves the slot onto it.
          etag: existing.etag,
          unsavedDirty: true
        }
      }
    }
  })
  // A read already out, or a question already asked about this very
  // version, brings the merge.
  const asked = s.flistMergeQuestion[characterId]
  if (s.flistExternalChange[characterId] || (asked && asked.etag === currentEtag)) return
  const change: ExternalChange = { etag: currentEtag, origin: 'unknown', at: Date.now() }
  set((st) => ({ flistExternalChange: { ...st.flistExternalChange, [characterId]: change } }))
  void _takeExternalChange(get, set, characterId, change)
}

/** Save what was typed into the Workbench now, instead of after the
 *  autosave's pause, chained after any save still in flight. For
 *  anything that replaces the slot or the Workbench (showing Live, a
 *  Restore, reset to Live): the sidecar keeps the Workbench as a Backup
 *  before replacing it, so that Backup has to hold what was typed.
 *  False when typed text is still unsaved (a conflict, the sidecar
 *  gone): the caller stops, since replacing now would lose it, and the
 *  slot's save error already says why. */
async function _saveTypedEdits(get: () => State, characterId: string): Promise<boolean> {
  if (get().flistWorking[characterId]?.unsavedDirty) {
    _cancelFlush(characterId)
    try {
      await get().flistFlushWorking(characterId)
    } catch {
      // saveError on the slot is the user's signal
    }
  }
  return !get().flistWorking[characterId]?.unsavedDirty
}

/** The slot for a Workbench payload the sidecar answered with, and the
 *  etag the next save goes over. */

/** The gallery rows of a Workbench slot's payload; none without one. */
function galleryOf(slot: FlistWorkingSlot | undefined): GalleryRow[] {
  return slot && Array.isArray((slot.payload as { images?: unknown }).images)
    ? (slot.payload as { images: GalleryRow[] }).images
    : []
}

/** The slot's overlay with `paths` added, each once, in order. */
function _withOverlay(slot: FlistWorkingSlot, paths: string[]): string[] {
  return Array.from(new Set([...slot.overlay, ...paths]))
}

function _workbenchSlot(payload: WorkingPayload, etag: string): FlistWorkingSlot {
  return {
    ...emptyWorkingSlot(),
    payload,
    overlay: Array.isArray(payload._overlay) ? payload._overlay : [],
    etag,
    materialised: true,
    saved: payload
  }
}

/** Show the Workbench the sidecar just wrote (a Restore, a reset to
 *  Live), replacing the slot whatever it held: the Workbench before, or
 *  the Live view or browsed Backup it was made from, which ends. */
function _showWorkbench(
  get: () => State,
  set: SlotSet,
  characterId: string,
  commit: Commit & { kind: 'written' }
): void {
  // A browsed Backup ends too: Live goes back to what the browse stood
  // in for. Ended before the commit, the Backup still sits in the slot
  // as a view (flistShowReadOnlyView set flistViewingLive), so the
  // commit still finds the Workbench that view hid and records it as
  // the undo entry.
  if (get().flistBrowseBackup?.characterId === characterId) get().flistEndBrowse()
  _commit(get, set, characterId, commit, (s) => ({
    flistViewingLive: { ...s.flistViewingLive, [characterId]: false }
  }))
  if (get().flistActiveCharacterId === characterId) {
    set((s) => _workbenchInEditor(s, characterId))
  }
}

/** The payload with N tombstones applied in a single pass — keeps the
 *  bulk action cheap even for large selections and ensures one commit
 *  lands per click rather than N (QA P1-2 / P2-6). */
function _tombstonedPayload(slot: FlistWorkingSlot, kinkIds: string[]): WorkingPayload {
  const payload = JSON.parse(JSON.stringify(slot.payload)) as WorkingPayload
  const ck = (payload.custom_kinks ?? {}) as Record<string, Record<string, unknown>>
  let overlay = [...slot.overlay]
  const overlaySet = new Set(overlay)
  let order = Array.isArray(payload._custom_kinks_order)
    ? [...(payload._custom_kinks_order as string[])]
    : Object.keys(ck)
  for (const kinkId of kinkIds) {
    const isLocal = kinkId.startsWith('local:')
    if (isLocal) {
      delete ck[kinkId]
      order = order.filter((x) => x !== kinkId)
      overlay = overlay.filter((p) => !p.startsWith(`custom_kinks.${kinkId}.`))
    } else {
      if (!ck[kinkId]) ck[kinkId] = {}
      ck[kinkId]._deleted = true
      if (!overlaySet.has(`custom_kinks.${kinkId}._deleted`)) {
        overlay.push(`custom_kinks.${kinkId}._deleted`)
        overlaySet.add(`custom_kinks.${kinkId}._deleted`)
      }
    }
  }
  payload.custom_kinks = ck
  payload._custom_kinks_order = order
  payload._overlay = overlay
  return payload
}

/** Collect the dotted overlay candidate paths Tier 2 currently tracks
 *  for drift detection: description + each infotag id present in either
 *  payload. Tier 3 will extend with custom-kinks paths. */
function collectOverlayCandidates(payload: WorkingPayload): string[] {
  const paths = new Set<string>([DESCRIPTION_PATH])
  const infotags = payload.infotags
  if (infotags && typeof infotags === 'object' && !Array.isArray(infotags)) {
    for (const id of Object.keys(infotags as Record<string, unknown>)) {
      paths.add(`infotags.${id}`)
    }
  }
  return Array.from(paths)
}

// F-list serves descriptions with literal CRLF / CR. Normalise before
// they hit CodeMirror + the BBCode→HTML preview so they don't render
// as doubled blank lines.
function normaliseNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

// character-data.php returns `inlines` as a top-level dict mapping
// inline-image id → {hash, extension, nsfw}. The renderer's BBCode
// transformer needs that dict to resolve `[img=<id>]` tags to CDN
// URLs (`static.f-list.net/images/charinline/<hash>.<ext>`). Without
// it, every inline tag renders as a broken image — caught after the
// JSON-API swap because the working/Live/Backup loaders hardcoded
// `editorInlines: {}` and only the old Fetch-profile path extracted
// them properly.
function extractInlines(payload: unknown): Record<string, InlineImage> {
  if (!payload || typeof payload !== 'object') return {}
  const raw = (payload as { inlines?: unknown }).inlines
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, InlineImage> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (
      v &&
      typeof v === 'object' &&
      typeof (v as { hash?: unknown }).hash === 'string' &&
      typeof (v as { extension?: unknown }).extension === 'string'
    ) {
      const entry = v as { hash: string; extension: string; nsfw?: unknown }
      out[String(k)] = {
        hash: entry.hash,
        extension: entry.extension,
        nsfw: Boolean(entry.nsfw)
      }
    }
  }
  return out
}

// Pulled out so fetchProfile can reset shared editor state cleanly.
function editorReplaceState(profile: {
  bbcode: string
  title: string
  inlines: Record<string, InlineImage>
}) {
  return {
    editorContent: profile.bbcode,
    editorTitle: profile.title,
    editorInlines: profile.inlines,
    editorDirty: false,
    saveStatus: 'idle' as const,
    saveError: null,
    draftStatus: 'idle' as const
  }
}

export const createWorkbenchSlice: SliceCreator<WorkbenchSlice> = (set, get) => ({
  ...workbenchInitialState(),

  // ---- F-list actions ----------------------------------------------------

  async flistSelectCharacter(characterId) {
    // Hard-flush any pending autosave for the previously active character
    // before switching. Per Tier 2 §1.5: a 500 ms quiet-time autosave
    // window can otherwise strand the last edit if the user hops away
    // quickly. Survives a SIGKILL after this point because the bytes
    // are already on disk.
    const prevId = get().flistActiveCharacterId
    if (prevId && prevId !== characterId) {
      try {
        await get().flistFlushWorking(prevId)
      } catch {
        // Best-effort — the failed save's saveStatus = 'error' is the
        // signal; don't block the switch on it.
      }
    }
    // Close any open Browse-Backup view — it's scoped to whoever
    // opened it, and carrying it across a character switch would
    // surprise the user. The character it was opened on gets its Live
    // back, which the browse stood in for.
    get().flistEndBrowse()
    set({ flistActiveCharacterId: characterId })
    if (characterId === null) {
      set({ editorReadOnly: false })
      return
    }
    get().flistRememberCharacter(characterId)
    await get().flistLoadArchive(characterId)
  },

  flistCloseCharacter() {
    set({ flistActiveCharacterId: null, editorReadOnly: false })
  },

  async flistBackToWorkbench(characterId) {
    set({ editorReadOnly: false })
    await get().flistOpenWorking(characterId)
  },

  flistMoveImageToProfile(characterId, imageId) {
    get().flistAddImagesToProfile(characterId, [imageId])
  },

  flistAddImagesToProfile(characterId, imageIds) {
    const slot = get().flistWorking[characterId]
    if (!slot) return
    const images = [...galleryOf(slot)]
    let nextOrder =
      images.length === 0
        ? 0
        : Math.max(...images.map((e) => e.sort_order)) + 1
    for (const imageId of imageIds) {
      if (images.some((e) => e.image_id === imageId)) continue
      images.push({ image_id: imageId, description: '', sort_order: nextOrder++ })
    }
    if (images.length === galleryOf(slot).length) return
    get().flistSetGalleryImages(characterId, images)
  },

  flistMoveImageToPool(characterId, imageId) {
    const slot = get().flistWorking[characterId]
    if (!slot) return
    const images = galleryOf(slot)
    if (!images.some((e) => e.image_id === imageId)) return
    get().flistSetGalleryImages(
      characterId,
      images.filter((e) => e.image_id !== imageId)
    )
  },

  flistSetGalleryImages(characterId, images, opts) {
    // Every other mutation schedules the autosave; this one did not,
    // and it is the one behind "Add to profile", "Move to pool",
    // reordering and their undo. Moving three images onto a profile
    // therefore left the set at "unsaved edits" forever: the change
    // was on screen, the restore ZIP still held the version from
    // before, and the extension uploaded a profile without them. The
    // only way to get it written was to touch the description.
    //
    // Debounced like the rest rather than written on the spot, so
    // clicking the reorder arrows four times sends one PUT, not four.
    const slot = get().flistWorking[characterId]
    if (!slot) return
    _commit(get, set, characterId, {
      kind: 'edit',
      label: 'edit',
      payload: { ...slot.payload, images, _overlay: _withOverlay(slot, ['images']) },
      typing: opts?.typing
    })
  },

  async flistOpenLive(characterId) {
    const archive = get().flistArchive[characterId]
    const live = archive?.live ?? (await api.flistLive(characterId).catch(() => null))
    if (!live) return
    const character = (live.character ?? live) as Record<string, unknown>
    const name =
      (typeof character.name === 'string' && character.name) ||
      (typeof live.name === 'string' && (live.name as string)) ||
      'Live'
    const rawBbcode =
      (typeof character.description === 'string' && (character.description as string)) ||
      (typeof live.description === 'string' && (live.description as string)) ||
      ''
    set({
      editorContent: normaliseNewlines(rawBbcode),
      editorTitle: `${name} — Live.bbcode`,
      editorInlines: extractInlines(live),
      editorReadOnly: true,
      editorDirty: false,
      saveStatus: 'idle',
      saveError: null,
      draftStatus: 'idle'
    })
  },

  async flistOpenWorking(characterId) {
    const token = _beginOpen(characterId)
    // Ensure Live is loaded into flistArchive BEFORE the legacy read
    // handles a 404 — its seed-from-Live branch
    // reads from flistArchive, so a race against the loader produces
    // an empty `character` block and the first edit ships a bare
    // payload (QA P1-3).
    await get().flistEnsureLive(characterId)
    // Opening the Workbench is what the Workbench row means, from a
    // click on it, on the character, or a Pull landing.
    set((s) => ({ flistViewingLive: { ...s.flistViewingLive, [characterId]: false } }))
    // What the slot held when the read went out. Anything that replaces
    // it meanwhile (a keystroke, a save landing with its new etag) is
    // newer than what the read can bring back.
    const before = get().flistWorking[characterId]
    // The Workbench itself, fetched fresh. This used to seed from Live
    // whenever the window had not hydrated its pointer, on the theory
    // that the slot was only a mirror nobody displayed. The editor
    // displays it: after switching away and back, the Workbench row was
    // selected while the panel showed the published profile. No
    // Workbench yet (`create: false` keeps a mere open from making one):
    // the slot is seeded from Live in memory and not written, and the
    // first edit makes the Workbench (materialise-on-first-edit).
    let read: FlistWorkingSlot | null
    try {
      const res = await api.flistWorkbenchPayloadRead(characterId, { create: false })
      read = _workbenchSlot(res.payload as WorkingPayload, res.etag)
    } catch (err) {
      if (err instanceof RefusalError && err.code === 'no_workbench') {
        const liveForSeed = get().flistArchive[characterId]?.live ?? null
        read = {
          ...emptyWorkingSlot(),
          payload: liveForSeed ? seedWorkingFromLive(liveForSeed) : { ...emptyWorkingSlot().payload },
          materialised: false
        }
        // Nothing on disk yet: the first save makes the Workbench from
        // Live, so the seed is what a merge compares against.
        read.saved = read.payload
      } else {
        read = null
      }
    }
    if (!_isNewestOpen(characterId, token)) return
    // Never reseed over unsaved edits, and decide that only now, after
    // the read, right before applying it. Autosave waits 500 ms for
    // quiet time, and the picker calls this on every click — including
    // a click on the character already open, which is how a user gets
    // out of a read-only Live view. Reseeding then replaced the slot,
    // and the armed flush, finding nothing dirty, dropped the write:
    // what the user had just typed was gone with nothing said. Checked
    // before the read, a slow read still overwrote whatever was typed
    // while it was in flight. The edits live in the slot; leave them
    // there and let the pending flush do its job.
    const current = get().flistWorking[characterId]
    const untouched = current === before && !current?.unsavedDirty
    if (read && untouched) {
      _commit(get, set, characterId, { kind: 'view', slot: read }, (s) => ({
        flistWorkingLoadStatus: {
          ...s.flistWorkingLoadStatus,
          [characterId]: 'ready'
        }
      }))
    } else {
      set((s) => ({
        flistWorkingLoadStatus: {
          ...s.flistWorkingLoadStatus,
          [characterId]: read || current ? 'ready' : 'error'
        }
      }))
    }
    // The editor shows the active character. A read that lands after
    // the user moved on to someone else leaves it alone; otherwise the
    // next keystroke would save this character's text into theirs.
    if (get().flistActiveCharacterId !== characterId) return
    set(_workbenchInEditor(get(), characterId))
  },

  flistSetWorkingField(characterId, path, value, opts) {
    const slot = get().flistWorking[characterId]
    if (!slot) return
    const next = flistApplyEdit(slot, path, value)
    _commit(get, set, characterId, {
      kind: 'edit',
      label: 'edit',
      payload: next.payload,
      typing: opts?.typing ? path : undefined
    })
  },

  flistEndTyping(characterId) {
    endTyping(characterId)
  },

  flistResetImageRow(characterId, imageId) {
    const slot = get().flistWorking[characterId]
    if (!slot) return
    const live = get().flistArchive[characterId]?.live ?? null
    const readGallery = (payload: unknown): GalleryRow[] => {
      if (!payload || typeof payload !== 'object') return []
      const raw = (payload as { images?: unknown }).images
      if (!Array.isArray(raw)) return []
      const out: GalleryRow[] = []
      for (const e of raw) {
        if (!e || typeof e !== 'object') continue
        const r = e as { image_id?: unknown; description?: unknown; sort_order?: unknown }
        if (typeof r.image_id !== 'string') continue
        const so =
          typeof r.sort_order === 'number'
            ? r.sort_order
            : Number(r.sort_order ?? out.length) || out.length
        out.push({
          image_id: r.image_id,
          description: typeof r.description === 'string' ? r.description : '',
          sort_order: so
        })
      }
      out.sort((a, b) => a.sort_order - b.sort_order)
      return out
    }
    const liveGallery = readGallery(live)
    const workingGallery = readGallery(slot.payload)
    const target = liveGallery.find((e) => e.image_id === imageId)
    let next: GalleryRow[]
    if (!target) {
      // Live doesn't have this image — reset = drop from working.
      next = workingGallery.filter((e) => e.image_id !== imageId)
    } else {
      const without = workingGallery.filter((e) => e.image_id !== imageId)
      // Live's position is authoritative for where the reset row lands.
      // Clamp against the post-removal length so an out-of-range index
      // still inserts at the tail rather than throwing.
      const insertAt = Math.max(0, Math.min(target.sort_order, without.length))
      next = [
        ...without.slice(0, insertAt),
        { ...target },
        ...without.slice(insertAt)
      ]
    }
    const renumbered = next.map((e, i) => ({ ...e, sort_order: i }))
    _commit(get, set, characterId, {
      kind: 'edit',
      label: 'edit',
      payload: { ...slot.payload, images: renumbered, _overlay: _withOverlay(slot, ['images']) }
    })
  },

  flistResetWorkingField(characterId, path) {
    const slot = get().flistWorking[characterId]
    if (!slot) return
    const live = get().flistArchive[characterId]?.live ?? null
    // A reset of the description reaches the open editor through the
    // commit, which reads the editor text back from the payload.
    const next = flistApplyReset(slot, live, path)
    _commit(get, set, characterId, {
      kind: 'edit',
      label: 'edit',
      payload: next.payload,
      clearSaveError: true
    })
  },

  async flistFlushWorking(characterId) {
    _cancelFlush(characterId)
    // Per-character single-flight: every flush is a link in one chain
    // and starts only once the flush before it has finished. Otherwise
    // the in-flight PUT could race a fresh one carrying a newer payload
    // — the older PUT could win, leaving the user's later keystrokes
    // unsaved while saveStatus shows 'saved' (QA P1-4). Waiting on the
    // previous link (not on the PUT in flight) is what keeps two
    // flushes queued behind a slow save from both waking when it lands
    // and sending two PUTs over the same etag: the second would 409 and
    // raise a conflict banner for a conflict the window had with itself.
    const prior = _flushInflight.get(characterId)
    const link = (async () => {
      if (prior) {
        await prior.catch(() => {})
        // Re-cancel any debounce that may have re-armed during the wait
        // so we don't double-fire.
        _cancelFlush(characterId)
      }
      await _flushWorkingNow(characterId, get, set)
    })()
    _flushInflight.set(characterId, link)
    try {
      await link
    } finally {
      if (_flushInflight.get(characterId) === link) {
        _flushInflight.delete(characterId)
      }
    }
  },

  flistUndo(characterId) {
    return _undoStep(get, set, characterId, 'undo')
  },

  flistRedo(characterId) {
    return _undoStep(get, set, characterId, 'redo')
  },

  flistDismissUndoNote(characterId) {
    set((s) => {
      if (!s.flistUndoNotes[characterId]) return {}
      const flistUndoNotes = { ...s.flistUndoNotes }
      delete flistUndoNotes[characterId]
      return { flistUndoNotes }
    })
  },

  async flistFlushAllWorking() {
    const ids = new Set([
      ...Object.keys(get().flistWorking),
      ..._autosaveTimers.keys(),
      ..._flushInflight.keys()
    ])
    // flistFlushWorking chains after a save in flight and skips a
    // character with nothing unsaved.
    await Promise.all([...ids].map((id) => get().flistFlushWorking(id).catch(() => {})))
  },

  flistDropAllWorkbenches() {
    _cancelAllPendingTimers()
    _dropAllWorkbenches(set, () => ({
      flistActiveCharacterId: null,
      editorReadOnly: false,
      flistWorkingLoadStatus: {},
      flistWorkbenchInfo: {},
      flistRestoreRefusal: {},
      flistViewingLive: {},
      flistExternalChange: {},
      flistMergeQuestion: {},
      flistWorkbenchNote: null,
      flistUndoNotes: {},
      flistDriftBanners: {},
      flistDiffRightSource: {},
      flistDiffBackupCache: {},
      flistDiffBackupStatus: {},
      flistCustomKinksUI: {}
    }))
  },

  async flistResetWorkingToLive(characterId) {
    const slot = get().flistWorking[characterId]
    if (!slot) return
    if (!(await _saveTypedEdits(get, characterId))) return
    const current = get().flistWorking[characterId] ?? slot

    let fresh: Commit & { kind: 'written' }
    let kept = false
    if (current.materialised) {
      try {
        const res = await api.flistWorkbenchResetToLive(characterId)
        fresh = {
          kind: 'written',
          label: 'reset-to-live',
          payload: res.payload as WorkingPayload,
          etag: res.etag,
          lastSavedAt: Date.now()
        }
        kept = res.backed_up_first !== null
      } catch (err) {
        // Nothing was replaced, so nothing changes here either; the
        // reason shows where a failed save does.
        const reason = err instanceof Error ? err.message : String(err)
        set((s) => {
          const now = s.flistWorking[characterId]
          if (!now) return {}
          return {
            flistWorking: {
              ...s.flistWorking,
              [characterId]: { ...now, saveStatus: 'error', saveError: reason }
            }
          }
        })
        return
      }
    } else {
      // No Workbench on disk yet: there is nothing to replace or keep,
      // so the fresh copy of Live stays in memory until the first edit.
      const live = get().flistArchive[characterId]?.live ?? null
      const seeded = live ? seedWorkingFromLive(live) : emptyWorkingSlot().payload
      fresh = {
        kind: 'written',
        label: 'reset-to-live',
        payload: seeded,
        etag: null,
        materialised: false
      }
    }
    // The fresh Workbench is shown, even from Live or a browsed Backup;
    // the replaced one becomes the undo entry.
    _showWorkbench(get, set, characterId, fresh)
    // The Backup the sidecar just kept belongs in the list.
    if (kept) void get().flistLoadBackups(characterId)
  },

  // ---- The Live and Workbench rows ----------------------------------

  async flistLoadWorkbenchInfo(characterId) {
    try {
      const res = await api.flistWorkbench(characterId, false)
      const info = res.workbench ? { updatedAt: res.workbench.updated_at } : null
      set((s) => ({
        flistWorkbenchInfo: { ...s.flistWorkbenchInfo, [characterId]: info }
      }))
    } catch {
      // The row keeps what it showed; nothing to correct.
    }
  },

  async flistLoadBackupIntoWorkbench(characterId, filename) {
    if (!(await _saveTypedEdits(get, characterId))) return false
    try {
      const res = await api.flistWorkbenchLoadBackup(characterId, filename)
      set((s) => ({
        flistWorkbenchInfo: {
          ...s.flistWorkbenchInfo,
          [characterId]: { updatedAt: res.workbench.updated_at }
        }
      }))
      // The restored Workbench goes into the editor even when the
      // Workbench is already shown, and switches the view from Live.
      _showWorkbench(get, set, characterId, {
        kind: 'written',
        label: 'restore',
        payload: res.payload as WorkingPayload,
        etag: res.etag
      })
      get().flistDismissRestoreRefusal(characterId)
      // The Backup kept of the replaced Workbench belongs in the list.
      if (res.backed_up_first) await get().flistLoadArchive(characterId)
      return true
    } catch (err) {
      // Nothing was replaced. Say why where the Backups are listed,
      // rather than leaving the click without an answer.
      const reason = errorDetail(err)
      set((s) => ({
        flistRestoreRefusal: { ...s.flistRestoreRefusal, [characterId]: reason }
      }))
      return false
    }
  },

  flistDismissRestoreRefusal(characterId) {
    set((s) => ({
      flistRestoreRefusal: { ...s.flistRestoreRefusal, [characterId]: null }
    }))
  },

  flistNoteExternalChange(characterId, change) {
    const slot = get().flistWorking[characterId]
    // A change we made ourselves arrives with the etag we already
    // hold; there is nothing to tell the user about.
    if (slot && change.etag && slot.etag === change.etag) return
    // Nothing open for this character: opening it reads the Workbench
    // from disk, the change included.
    if (!slot) return
    const pending = { ...change, at: Date.now() }
    set((s) => ({ flistExternalChange: { ...s.flistExternalChange, [characterId]: pending } }))
    // Read it: taken in as it is, or merged with what is unsaved.
    void _takeExternalChange(get, set, characterId, pending)
  },

  flistAnswerMerge(characterId, choices) {
    const question = get().flistMergeQuestion[characterId]
    const slot = get().flistWorking[characterId]
    if (!question || !slot) return
    // Mine as it is now: the merge is made again with the answers.
    const answered = { ...question.answered, ...choices }
    const { payload, conflicts } = mergeWorkbench(slot.saved, slot.payload, question.theirs, answered)
    if (conflicts.length > 0) {
      set((s) => ({
        flistMergeQuestion: {
          ...s.flistMergeQuestion,
          [characterId]: { ...question, fields: conflicts, answered, at: Date.now() }
        }
      }))
      return
    }
    _commitMerge(get, set, characterId, payload, question, (s) => ({
      flistMergeQuestion: { ...s.flistMergeQuestion, [characterId]: null }
    }))
  },

  async flistShowLive(characterId) {
    // Edits that could not be saved stay on screen, with the slot's
    // save error saying why: the Live view replaces the slot.
    if (!(await _saveTypedEdits(get, characterId))) return
    // Build a read-only view slot from the local live.json. The tabs
    // (Profile / Kinks / Images / Editor) read this slot; the editor
    // and any edit handlers honor editorReadOnly to block mutations.
    const live = get().flistArchive[characterId]?.live ?? null
    const payload = live
      ? seedWorkingFromLive(live)
      : { ...emptyWorkingSlot().payload }
    const slot: FlistWorkingSlot = {
      payload,
      overlay: [],
      etag: null,
      unsavedDirty: false,
      saveStatus: 'idle',
      saveError: null,
      lastSavedAt: null,
      materialised: true,
      saved: null
    }
    _commit(get, set, characterId, { kind: 'view', slot }, (s) => ({
      flistViewingLive: { ...s.flistViewingLive, [characterId]: true },
      editorReadOnly: true
    }))
  },

  // ---- What the Archive slice asks of the Workbench -----------------

  flistNoteNewLive(characterId) {
    // If the user is sitting on this character's working copy and
    // hasn't typed anything yet, refresh the editor with the
    // freshly-pulled Live content. Skip when the working copy is
    // dirty OR when the live editorContent has already diverged
    // from the seeded content — covers the race where keystrokes
    // arrived between the dirty=false snapshot we took and now.
    const isActive =
      get().flistActiveCharacterId === characterId &&
      !get().editorReadOnly
    const working = get().flistWorking[characterId]
    // After a Live re-pull, only stream the new description into
    // a non-materialised seed-from-Live slot (no edits yet AND
    // never written to disk). Materialised working copies are
    // user-authoritative — drift detection runs via the banner
    // (§5.1) instead.
    const safe =
      isActive && (!working || (!working.materialised && !working.unsavedDirty))
    if (safe) {
      if (working) {
        // Drop the seeded slot so flistOpenWorking re-seeds from
        // the new Live on the next open.
        _commit(get, set, characterId, { kind: 'view', slot: null })
      }
      void get().flistOpenWorking(characterId)
    } else if (isActive && working?.materialised) {
      // Materialised working copy active: surface drift for non-
      // overlaid paths against the new Live.
      const newLive = get().flistArchive[characterId]?.live ?? null
      const oldLive = working.payload as Record<string, unknown>
      const allPaths = collectOverlayCandidates(working.payload)
      const ignore = new Set(working.overlay)
      const drift = detectLiveDrift(
        oldLive,
        newLive as Record<string, unknown>,
        allPaths,
        [...ignore]
      )
      if (drift.length > 0) {
        set((s) => ({
          flistDriftBanners: {
            ...s.flistDriftBanners,
            [characterId]: { paths: drift, dismissedAt: null }
          }
        }))
      }
      // A saved workbench stays user-authoritative, but the slot
      // still in memory is a snapshot from whenever it was last
      // opened — after an external change (another session wrote
      // the file, a bundle import) the window showed a gallery or
      // fields that no longer matched what is on disk, and only
      // clicking back into the character fixed it. Re-reading the
      // persisted set is what "Refresh" should mean for the open
      // window: disk is the truth for a saved copy. flistOpenWorking
      // keeps unsaved keystrokes and refuses to reseed over them.
      void get().flistOpenWorking(characterId)
    }
  },

  flistShowReadOnlyView(characterId, payload) {
    // A Backup's working.json mostly matches live shape — both carry
    // the same {character, settings, infotags, kinks, custom_kinks,
    // images, inlines} container. seedWorkingFromLive() is defensive
    // about either shape, so it serves for both.
    const slot: FlistWorkingSlot = {
      payload: seedWorkingFromLive(payload),
      overlay: [],
      etag: null,
      unsavedDirty: false,
      saveStatus: 'idle',
      saveError: null,
      lastSavedAt: null,
      materialised: true,
      saved: null
    }
    _commit(get, set, characterId, { kind: 'view', slot }, (s) => {
      const patch: Partial<WorkbenchState> = {
        flistViewingLive: { ...s.flistViewingLive, [characterId]: true },
        editorReadOnly: true
      }
      // The commit puts the payload's description into the editor.
      if (s.flistActiveCharacterId === characterId) {
        patch.editorInlines = extractInlines(payload)
        patch.saveStatus = 'idle'
        patch.saveError = null
      }
      return patch
    })
  },

  async flistSaveBeforeGalleryWrite(characterId, imageIds) {
    if (!galleryOf(get().flistWorking[characterId]).some((e) => imageIds.includes(e.image_id))) {
      return
    }
    _cancelFlush(characterId)
    await get().flistFlushWorking(characterId).catch(() => {})
    if (get().flistWorking[characterId]?.unsavedDirty) {
      throw new Error('the Workbench has edits that could not be saved')
    }
  },

  flistTakeOffGallery(characterId, imageIds, etag) {
    const slot = get().flistWorking[characterId]
    if (!slot || !etag || imageIds.length === 0) return
    const off = (payload: WorkingPayload): WorkingPayload => ({
      ...payload,
      images: galleryOf({ ...slot, payload })
        .filter((e) => !imageIds.includes(e.image_id))
        .map((e, i) => ({ ...e, sort_order: i })),
      _overlay: Array.from(new Set([...(payload._overlay ?? []), 'images']))
    })
    _commit(get, set, characterId, {
      kind: 'written',
      label: 'edit',
      payload: off(slot.payload),
      etag,
      keepPending: true,
      // On disk now: what was saved, less those images. Typing
      // since is not in it.
      saved: slot.saved ? off(slot.saved) : undefined
    })
  },

  // ---- Tier 4: diff + reset-to-backup -------------------------------

  flistDiffSetRightSource(characterId, source) {
    set((s) => ({
      flistDiffRightSource: { ...s.flistDiffRightSource, [characterId]: source }
    }))
  },

  async flistDiffLoadBackup(characterId, filename) {
    const cacheKey = `${characterId}:${filename}`
    if (get().flistDiffBackupCache[cacheKey]) return
    if (get().flistDiffBackupStatus[cacheKey] === 'loading') return
    set((s) => ({
      flistDiffBackupStatus: {
        ...s.flistDiffBackupStatus,
        [cacheKey]: 'loading'
      }
    }))
    try {
      const { payload } = await api.flistZipBackupPayload(characterId, filename)
      set((s) => ({
        flistDiffBackupCache: {
          ...s.flistDiffBackupCache,
          [cacheKey]: payload
        },
        flistDiffBackupStatus: {
          ...s.flistDiffBackupStatus,
          [cacheKey]: 'loaded'
        }
      }))
    } catch {
      // DiffPane reads `flistDiffBackupStatus` to distinguish "still
      // loading" from "404 / disk error" — gives the user a real
      // signal vs the previous indefinite spinner (UX P1-3).
      set((s) => ({
        flistDiffBackupStatus: {
          ...s.flistDiffBackupStatus,
          [cacheKey]: 'error'
        }
      }))
    }
  },

  async flistDiffResetToSource(characterId) {
    const source = get().flistDiffRightSource[characterId] ?? { kind: 'live' }
    if (source.kind === 'live') {
      await get().flistResetWorkingToLive(characterId)
    } else if (source.kind === 'backup') {
      await get().flistLoadBackupIntoWorkbench(characterId, source.filename)
    }
  },

  flistDismissDriftBanner(characterId) {
    set((s) => {
      if (!s.flistDriftBanners[characterId]) return {}
      const next = { ...s.flistDriftBanners }
      delete next[characterId]
      return { flistDriftBanners: next }
    })
  },

  // ---- Tier 3 custom-kinks ------------------------------------------

  flistCustomKinksSelect(characterId, kinkId) {
    set((s) => {
      const cur = s.flistCustomKinksUI[characterId] ?? {
        selectedKinkId: null,
        selectedKinkIds: [],
        showDeleted: false,
        sort: 'insertion',
        filter: ''
      }
      return {
        flistCustomKinksUI: {
          ...s.flistCustomKinksUI,
          [characterId]: { ...cur, selectedKinkId: kinkId, selectedKinkIds: [] }
        }
      }
    })
  },

  flistCustomKinksToggleMulti(characterId, kinkId, opts) {
    set((s) => {
      const cur = s.flistCustomKinksUI[characterId] ?? {
        selectedKinkId: null,
        selectedKinkIds: [],
        showDeleted: false,
        sort: 'insertion',
        filter: ''
      }
      let next: string[]
      if (opts?.range && cur.selectedKinkId && opts.rowsInOrder) {
        const start = opts.rowsInOrder.indexOf(cur.selectedKinkId)
        const end = opts.rowsInOrder.indexOf(kinkId)
        if (start === -1 || end === -1) {
          next = Array.from(new Set([...cur.selectedKinkIds, kinkId]))
        } else {
          const [lo, hi] = start < end ? [start, end] : [end, start]
          next = Array.from(
            new Set([...cur.selectedKinkIds, ...opts.rowsInOrder.slice(lo, hi + 1)])
          )
        }
      } else {
        next = cur.selectedKinkIds.includes(kinkId)
          ? cur.selectedKinkIds.filter((id) => id !== kinkId)
          : [...cur.selectedKinkIds, kinkId]
      }
      return {
        flistCustomKinksUI: {
          ...s.flistCustomKinksUI,
          [characterId]: { ...cur, selectedKinkIds: next }
        }
      }
    })
  },

  flistCustomKinksClearMulti(characterId) {
    set((s) => {
      const cur = s.flistCustomKinksUI[characterId]
      if (!cur) return {}
      return {
        flistCustomKinksUI: {
          ...s.flistCustomKinksUI,
          [characterId]: { ...cur, selectedKinkIds: [] }
        }
      }
    })
  },

  flistCustomKinksBulkTombstone(characterId, kinkIds) {
    if (kinkIds.length === 0) return
    const prevSlot = get().flistWorking[characterId]
    if (!prevSlot) return
    _commit(get, set, characterId, {
      kind: 'edit',
      label: 'edit',
      payload: _tombstonedPayload(prevSlot, kinkIds)
    })
    get().flistCustomKinksClearMulti(characterId)
  },

  flistStandardKinksBulkSetChoice(characterId, kinkIds, choice) {
    const slot = get().flistWorking[characterId]
    if (!slot) return
    const payload = JSON.parse(JSON.stringify(slot.payload)) as WorkingPayload
    const existing =
      (payload.kinks && typeof payload.kinks === 'object' && !Array.isArray(payload.kinks)
        ? (payload.kinks as Record<string, unknown>)
        : {}) as Record<string, unknown>
    for (const id of kinkIds) {
      existing[id] = choice
    }
    payload.kinks = existing
    payload._overlay = _withOverlay(slot, kinkIds.map((id) => `kinks.${id}`))
    _commit(get, set, characterId, { kind: 'edit', label: 'edit', payload })
  },

  flistCustomKinksAdd(characterId) {
    const localId = `local:${
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36)
    }`
    const slot = get().flistWorking[characterId]
    if (!slot) return localId
    const payload = JSON.parse(JSON.stringify(slot.payload)) as WorkingPayload
    const ck = (payload.custom_kinks ?? {}) as Record<string, Record<string, unknown>>
    ck[localId] = {
      name: '',
      description: '',
      choice: 'undecided',
      children: []
    }
    payload.custom_kinks = ck
    const order = Array.isArray(payload._custom_kinks_order)
      ? [...(payload._custom_kinks_order as string[])]
      : Object.keys(ck)
    if (!order.includes(localId)) order.push(localId)
    payload._custom_kinks_order = order
    // Only `_order` is overlaid at Add time — `.name`/`.description`/
    // `.choice` join the overlay when the user actually edits them
    // (QA P2-1). Otherwise a brand-new `local:` row's first reset
    // would clobber the empty name with itself.
    payload._overlay = _withOverlay(slot, ['custom_kinks._order'])
    const commit: Commit = { kind: 'edit', label: 'edit', payload, clearSaveError: true }
    _commit(get, set, characterId, commit, (s) => ({
      flistCustomKinksUI: {
        ...s.flistCustomKinksUI,
        [characterId]: {
          ...(s.flistCustomKinksUI[characterId] ?? {
            selectedKinkId: null,
            selectedKinkIds: [],
            showDeleted: false,
            sort: 'insertion',
            filter: ''
          }),
          selectedKinkId: localId
        }
      }
    }))
    return localId
  },

  flistCustomKinksEdit(characterId, kinkId, field, value) {
    const path = `custom_kinks.${kinkId}.${field}`
    get().flistSetWorkingField(characterId, path, value)
  },

  flistCustomKinksTombstone(characterId, kinkId) {
    const prevSlot = get().flistWorking[characterId]
    if (!prevSlot) return
    _commit(get, set, characterId, {
      kind: 'edit',
      label: 'edit',
      payload: _tombstonedPayload(prevSlot, [kinkId])
    })
  },

  flistCustomKinksUndelete(characterId, kinkId) {
    const slot = get().flistWorking[characterId]
    if (!slot) return
    const payload = JSON.parse(JSON.stringify(slot.payload)) as WorkingPayload
    const ck = (payload.custom_kinks ?? {}) as Record<string, Record<string, unknown>>
    if (ck[kinkId]) {
      delete ck[kinkId]._deleted
      payload.custom_kinks = ck
    }
    payload._overlay = slot.overlay.filter(
      (p) => p !== `custom_kinks.${kinkId}._deleted`
    )
    _commit(get, set, characterId, { kind: 'edit', label: 'edit', payload, clearSaveError: true })
  },

  flistCustomKinksReorder(characterId, nextOrder) {
    const slot = get().flistWorking[characterId]
    if (!slot) return
    const payload = JSON.parse(JSON.stringify(slot.payload)) as WorkingPayload
    payload._custom_kinks_order = [...nextOrder]
    payload._overlay = _withOverlay(slot, ['custom_kinks._order'])
    _commit(get, set, characterId, { kind: 'edit', label: 'edit', payload, clearSaveError: true })
  },

  flistCustomKinksResetField(characterId, kinkId, field) {
    const path = `custom_kinks.${kinkId}.${field}`
    get().flistResetWorkingField(characterId, path)
  },

  flistCustomKinksBulkSetChoice(characterId, kinkIds, choice) {
    const slot = get().flistWorking[characterId]
    if (!slot) return
    const payload = JSON.parse(JSON.stringify(slot.payload)) as WorkingPayload
    const ck = (payload.custom_kinks ?? {}) as Record<string, Record<string, unknown>>
    // Validate ids against the dict before mutating — a stale selection
    // surviving a tombstone-purge of a `local:` id would otherwise
    // resurrect that id as an empty stub (QA P3-4).
    const additions: string[] = []
    for (const kinkId of kinkIds) {
      if (!ck[kinkId]) continue
      ck[kinkId].choice = choice
      additions.push(`custom_kinks.${kinkId}.choice`)
    }
    if (additions.length === 0) return
    payload.custom_kinks = ck
    payload._overlay = _withOverlay(slot, additions)
    _commit(get, set, characterId, { kind: 'edit', label: 'edit', payload })
  },

  flistCustomKinksSetUI(characterId, patch) {
    set((s) => {
      const cur = s.flistCustomKinksUI[characterId] ?? {
        selectedKinkId: null,
        selectedKinkIds: [],
        showDeleted: false,
        sort: 'insertion',
        filter: ''
      }
      return {
        flistCustomKinksUI: {
          ...s.flistCustomKinksUI,
          [characterId]: { ...cur, ...patch }
        }
      }
    })
  },

  flistStandardKinkSet(characterId, kinkId, choice) {
    // Defensive: if `payload.kinks` is still the F-list empty-array
    // shape `[]`, pathSet would set a non-numeric property on an Array
    // and JSON.stringify would drop it (QA P1-4). Coerce to dict before
    // the regular field edit, as part of the same commit.
    const slot = get().flistWorking[characterId]
    if (!slot) return
    const base = Array.isArray(slot.payload.kinks)
      ? { ...slot, payload: { ...slot.payload, kinks: {} } }
      : slot
    const next = flistApplyEdit(base, `kinks.${kinkId}`, choice)
    _commit(get, set, characterId, { kind: 'edit', label: 'edit', payload: next.payload })
  },

  selectCharacter(name) {
    // Picking a real character leaves the Foreign slot. What the slot
    // holds is kept, so going back to it shows the same profile again
    // without another F-list call.
    get().setActiveCharacter(name)
    get().foreignLeaveSlot()
    // Close any open Browse-Backup view on a character pick — the
    // sidebar Backups list is now showing a different character's
    // archive, and the viewer body would otherwise still be on the
    // old character's backup (QA-S2 from the 2026-06-17 review). Its
    // character gets its Live back.
    get().flistEndBrowse()
    if (!name) {
      get().flistCloseCharacter()
      return
    }
    // Mirror the pick into the F-list slice when the name matches a
    // roster entry that has an F-list id. Keeps the one-active-character
    // mental model coherent — the same selection drives both the logs
    // filter and the F-list zone's Live/Backup docs.
    const match = get().flistRoster.find(
      (r) => r.name.toLowerCase() === name.toLowerCase()
    )
    if (match && match.id !== null) {
      const id = String(match.id)
      const switched = get().flistActiveCharacterId !== id
      // Drain the character being left, the way flistSelectCharacter
      // does. Fire-and-forget: the picker must not wait on a PUT, and
      // a failed save raises saveStatus 'error' where the user can see
      // it rather than blocking the click.
      const prevId = get().flistActiveCharacterId
      if (switched && prevId) {
        void get().flistFlushWorking(prevId).catch(() => {})
      }
      if (switched) {
        get().flistRememberCharacter(id)
        set({ flistActiveCharacterId: id })
        // From here on a keystroke is saved into this character's
        // Workbench, so the editor must stop showing the one being left.
        // A Workbench already in memory is shown straight away; the
        // read below refreshes it unless the user types first. Without
        // one the editor waits, read-only, for the read to land.
        set(
          get().flistWorking[id]
            ? _workbenchInEditor(get(), id)
            : _workbenchLoadingInEditor(get(), id)
        )
        void get().flistLoadArchive(id)
      }
      // Always reload the working copy on a picker click, even when
      // the character id didn't change. Otherwise a user who's
      // currently viewing the Live or a Backup (editor in read-only
      // mode) and re-picks the same character stays stuck in read-only
      // — the picker click looks ignored. flistOpenWorking is a no-op
      // if the working slot already exists with the user's edits, so
      // re-loading the same character costs nothing.
      void get().flistOpenWorking(id)
      // Auto-pull on select when the Live snapshot is missing or older
      // than the staleness threshold. User can still trigger a manual
      // refresh via the FlistCharacterZone's button at any time.
      const slot = get().flistArchive[id]
      const lastPullAt = slot?.lastPullAt ?? match.last_pulled_at ?? null
      const ageSec = lastPullAt
        ? Date.now() / 1000 - lastPullAt
        : Number.POSITIVE_INFINITY
      const pullInFlight =
        slot?.pullStatus === 'queued' || slot?.pullStatus === 'running'
      // Only auto-pull when a session is active — otherwise the pull
      // immediately fails with "not signed in to F-list" and leaves a
      // stale red banner that survives sign-in (the sign-in handler
      // clears these, but better not to set them in the first place).
      const sessionActive = get().flistSession.active
      if (sessionActive && ageSec >= STALE_AGE_SEC && !pullInFlight) {
        void get().flistPullCharacter(match.name, id)
      }
    } else if (get().flistActiveCharacterId !== null) {
      // Picked a log-only character that isn't on F-list — clear the
      // F-list zone so it doesn't show stale Live/Backup docs from the
      // previous character.
      get().flistCloseCharacter()
    }
  },

  setEditorContent(value) {
    const s = get()
    const before = s.editorContent
    // Mark draft stale as soon as the user types — the autosave
    // effect will pick this up and flush after the idle window.
    set({ draftStatus: 'idle' })
    // Working-copy mode: editor is showing an F-list character's
    // editable copy (no local doc active, not in read-only Live /
    // Backup view). The description is an edit to the Workbench like
    // any other: it goes into the payload, and the editor text is read
    // back from there by the commit, so the two cannot drift.
    const characterId = s.flistActiveCharacterId
    const isWorkingCopyMode = characterId !== null && !s.editorReadOnly
    if (isWorkingCopyMode && value !== before && s.flistWorking[characterId]) {
      get().flistSetWorkingField(characterId, DESCRIPTION_PATH, value, { typing: true })
      return
    }
    set((st) => ({
      editorContent: value,
      editorDirty: st.editorDirty || value !== before
    }))
  },

  resetEditorDirty() {
    set({ editorDirty: false })
  },

  async fetchProfile(name) {
    // Synchronous guard against rapid duplicate clicks: a `disabled`
    // button alone doesn't help because React hasn't repainted between
    // a burst of click events. Reading `editorFetchStatus` here AND
    // setting it before the first await closes that race.
    if (get().editorFetchStatus === 'fetching') return
    set({ editorFetchStatus: 'fetching', editorFetchError: null })
    try {
      const profile = await api.profile(name)
      const previousContent = get().editorContent
      set({
        ...editorReplaceState({
          bbcode: profile.bbcode,
          title: `${profile.name}.bbcode`,
          inlines: profile.inlines ?? {}
        }),
        editorFetchStatus: 'ok',
        editorFetchError: null,
        editorDirty: previousContent !== profile.bbcode
      })
    } catch (err) {
      set({
        editorFetchStatus: 'error',
        editorFetchError: humanizeFetchError(err, name)
      })
    }
  }
})

/** What a failed profile look-up says, chosen by the refusal's code
 *  and status, never by its words. */
function humanizeFetchError(err: unknown, name: string): string {
  // The look-up needs a sign-in. Surface a clear CTA.
  const code = refusalCode(err)
  if (code === 'not_signed_in') {
    return 'Sign in to F-list to fetch profiles. Click the chip in the sidebar.'
  }
  if (code === 'not_found') return `No character named "${name}" on F-list.`
  // fetch rejects with a TypeError when the sidecar is down.
  if (err instanceof TypeError) {
    return "Can't reach the app's sidecar. Restart the app and try again."
  }
  if (err instanceof HttpError && err.status >= 500) {
    return 'F-list is having trouble right now. Try again in a moment.'
  }
  if (err instanceof HttpError) return `F-list refused that name (${errorDetail(err)}).`
  return errorDetail(err)
}
