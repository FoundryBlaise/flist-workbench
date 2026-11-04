import { create } from 'zustand'
import {
  api,
  errorDetail,
  RefusalError,
  type CharacterEntry,
  type FlistAccountCharacter,
  type FlistBackupAllHandlers,
  type FlistPullHandlers,
  type FlistZipBackupEntry,
  type FlistCharacterImage,
  type FlistTrashItem,
  type FlistRosterEntry,
  type FlistSessionStatus,
  type ForeignProfilePayload,
  type InlineImage,
  type Job,
  type LogMessage,
  type PartnerEntry
} from './lib/api'
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
} from './state/flist'
import {
  commitSlot,
  externalLabel,
  type Commit,
  type CommitEvent,
  type CommitLabel,
  type TheirVersion
} from './state/commit'
import {
  endTyping,
  hiddenWorkbench,
  hideWorkbench,
  recordChange,
  resetUndoStacks,
  takeRedo,
  takeUndo,
  unhideWorkbench
} from './state/undoStack'
import { imagesToFind, putBackNote, renameGalleryRows, stepName } from './state/undoTrash'
import type { UndoAction } from './lib/undoRedo'
import { mergeWorkbench, type MergeSide } from './state/merge'

export type {
  FlistSaveStatus,
  FlistWorkingSlot,
  WorkingPayload
} from './state/flist'

export { selectWorkingSlot } from './state/flist'
export { selectDiffSources, type DiffSource } from './state/diffSources'

import {
  readAutoRefreshEnabled,
  readAutoRefreshHours
} from './features/settings/SettingsModal'

export type Mode = 'editor' | 'logs'

const LAST_SEEN_KEY = 'flist-workbench:char-last-seen'
const FLIST_ACCOUNT_KEY = 'flist-workbench:last-account'
const FLIST_LAST_CHAR_KEY = 'flist-workbench:last-flist-char-id'
// Auto-pull threshold. Matches the picker's own staleness display so
// the UI and the auto-pull policy can't drift apart. F-list's hourly
// API cap is 200 — even a user hopping between 30 characters all day
// stays well under it at this rate.
const STALE_AGE_SEC = 30 * 60

function readLastSeen(): Record<string, number> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(LAST_SEEN_KEY)
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function writeLastSeen(map: Record<string, number>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(map))
  } catch {
    // private mode / storage full — fine, dots just won't persist
  }
}

type State = {
  characters: CharacterEntry[]
  charactersStatus: 'idle' | 'loading' | 'ready' | 'error'
  charactersError: string | null
  /** Last time the user opened the log tab for each character (epoch seconds). */
  charLastSeen: Record<string, number>

  activeCharacter: string | null
  mode: Mode
  /** When true, the logs main pane shows the cross-conversation search view. */
  crossSearchOpen: boolean

  /** The "Foreign profile" slot: a stand-in character the picker
   *  offers alongside the real ones. Selecting it puts the editor
   *  panel into a read-only state showing somebody else's profile.
   *
   *  It is a slot, not a character. It has no id, no archive entry, no
   *  Workbench and no `flistActiveCharacterId` — which is exactly
   *  what stops every edit, pull, backup and export path from finding
   *  anything to act on. The slot itself is not persisted: it lives in
   *  memory for as long as the app runs and is never written to the
   *  character archive. The sidecar's Foreign profile cache keeps the
   *  profile on disk until its size cap evicts it. */
  foreignActive: boolean
  foreignName: string | null
  foreignProfile: ForeignProfilePayload | null
  foreignFromCache: boolean
  foreignAgeSec: number | null
  /** Set when a refresh failed and the cached copy is being shown. */
  foreignStale: boolean
  foreignRefreshError: string | null
  foreignStatus: 'idle' | 'loading' | 'ready' | 'error'
  foreignError: string | null

  partners: Record<string, PartnerEntry[]>
  partnersStatus: Record<string, 'loading' | 'ready' | 'error'>

  activePartner: string | null

  /** When set, a RAG-ingest progress dialog is open over the app.
   *  forceRewipe=true makes the dialog start the job with wipe-and-
   *  reingest semantics; used by the Settings → RAG "Re-ingest all"
   *  button after the user confirms. Default false. */
  ingestTarget:
    | {
        scope: { character?: string | null; partner?: string | null }
        label: string
        forceRewipe: boolean
      }
    | null
  /** Bumped whenever the sidecar says the Index changed (an ingest
   *  started or ended, a wipe). Views that show the Index status
   *  re-read it when this moves. */
  indexRevision: number
  /** Bumped whenever another writer changed Labels (a model labelled
   *  or cleared them). Views listing cleared Labels re-read it. */
  labelsRevision: number

  messagesByPartner: Record<string, LogMessage[]>
  messagesStatus: Record<string, 'loading' | 'ready' | 'error'>
  messagesError: Record<string, string | null>
  /** Counts settings changes made outside this window. An open
   *  Settings re-reads them when it moves. */
  settingsRevision: number

  editorContent: string
  editorTitle: string
  editorInlines: Record<string, InlineImage>
  editorFetchStatus: 'idle' | 'fetching' | 'ok' | 'error'
  editorFetchError: string | null
  editorDirty: boolean
  /** Which editor tab is active. Mirrored from EditorTabsHost so the
   *  preview pane can swap content per tab (e.g. show a website-style
   *  Info-pane view when the user is on Profile fields). */
  editorActiveTab: string
  /** Description-tab view mode. Only applied while the active tab is
   *  Description (other tabs always render side-by-side). Persisted
   *  in localStorage. */
  editorViewMode: 'split' | 'preview' | 'code'

  saveStatus: 'idle' | 'saving' | 'saved' | 'error'
  saveError: string | null
  /** Set by EditorPane after an idle window; "draft has been flushed". */
  draftStatus: 'idle' | 'saving' | 'saved' | 'error'

  // ---- F-list character archive (Phase 7 Tier 1) ----
  /** Whether the user has signed in to F-list this session. The sidecar
   *  holds the ticket; the renderer mirrors enough state to render the
   *  chip + footer. */
  flistSession: FlistSessionStatus
  /** Account-roster characters returned by the most recent sign-in. */
  flistAccountCharacters: FlistAccountCharacter[]
  /** Unified roster (account + archived + log-only) from /flist/characters. */
  flistRoster: FlistRosterEntry[]
  flistRosterStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** Account-wide pull sweep status. Set while the sign-in
   *  auto-refresh or the manual "Refresh all" is walking the roster. */
  flistAccountSweepStatus: 'idle' | 'running'
  /** ID of the F-list character whose Live/Backup docs the user is
   *  currently viewing. Distinct from `activeCharacter` (the F-Chat-log
   *  filter) because the two rosters don't always overlap. */
  flistActiveCharacterId: string | null
  /** Per-character archive state. Keyed by character_id string. */
  flistArchive: Record<
    string,
    {
      live: Record<string, unknown> | null
      /** ZIP-backup files in `characters/<id>/backups/`, newest first.
       *  The Backups sidebar list reads from this slot. `undefined` means
       *  "not yet loaded for this character"; an empty array means
       *  "loaded, none exist". */
      zipBackups?: FlistZipBackupEntry[]
      zipBackupsStatus?: 'idle' | 'loading' | 'ready' | 'error'
      zipBackupsError?: string | null
      pullStatus: 'idle' | 'queued' | 'running' | 'done' | 'error'
      pullStage?: string
      pullProgress?: { done: number; total: number }
      pullError?: string | null
      /** The running Pull job, for Cancel. */
      pullJobId?: string | null
      lastPullAt?: number | null
      // On-disk integrity status: was the prior pull complete, or was
      // it interrupted / did some images fail? Sourced from
      // /flist/characters (server walks images_dir) and updated when a
      // new pull's "done" event arrives. Drives the "Pull incomplete"
      // affordance in FlistCharacterZone.
      integrity?: {
        status: 'complete' | 'partial' | 'interrupted' | 'unknown' | 'never_pulled'
        missing: number
      }
    }
  >
  /** Open-restore-preview-modal target. When non-null, the export
   *  preview modal is open for this character; clicking "Download" in
   *  the modal navigates to the export.zip route. Lives in the store so
   *  the menu / sidebar / Images tab can all open it from anywhere. */
  flistExportRestoreCharacterId: string | null
  /** Currently-open read-only backup browse target, or null when
   *  the user is editing their live working copy. When set, the
   *  editor pane renders the backup's contents via the
   *  `flistDiffBackupCache` (Tier 4's existing backup-loader) with
   *  every tab in readOnly mode. Right-click → Browse backup in the
   *  Backups sidebar list sets this; switching character or closing
   *  via the header pill clears it. See features/flist/BrowseBackup
   *  for the rendering path. */
  flistBrowseBackup: {
    characterId: string
    filename: string
    /** 'loading' → backup ZIP being fetched and parsed.
     *  'ready'   → payload available, tabs can render.
     *  'error'   → fetch failed, header pill shows reason. The most
     *              common error is 409 `backup_too_old` — backup
     *              predates the Browse-support write that bundles
     *              working.json into the ZIP. */
    status: 'loading' | 'ready' | 'error'
    /** The decoded working.json payload from the ZIP. Set when
     *  status === 'ready'; null otherwise. */
    payload: Record<string, unknown> | null
    error?: string | null
    /** Why this backup was created. Read from the ZIP's
     *  `backup-meta.json` (added 2026-06-17). Older backups without
     *  that file fall back to `'unknown'`. Surfaced in the header
     *  banner: "Viewing backup · <date> · Manual" and in the
     *  sidebar Backups list. */
    kind?: 'manual_single' | 'manual_bulk' | 'import' | 'scheduled' | 'unknown'
    /** Human-readable backup creation timestamp for the header banner
     *  (already-formatted, so the renderer doesn't keep reformatting
     *  on every keystroke during browse). */
    dateLabel?: string
    /** Stashed state restored on close. Browse mode hijacks
     *  `flistArchive[id].live` so the existing From-F-list rendering
     *  pipeline (ProfileFieldsPreview / KinksPane / ImagesTab /
     *  PreviewPane with inlines + F-list theme) renders the backup
     *  byte-for-byte identically to the live view — we revert the
     *  hijack here on close so the user's actual data isn't damaged. */
    previousLive: Record<string, unknown> | null
    /** Whether the Live row was shown, so close returns to it. */
    previousViewingLive: boolean
  } | null
  /** Per-character snapshot of files in `<char>/images/` (the v5
   *  unified store — there's no separate sha-keyed pool). Keyed by
   *  image_id with the file extension + mtime cached so the renderer
   *  can render thumbs and sort Pool view newest-first without a
   *  second round-trip. Anything in this map whose image_id isn't
   *  referenced by working.json's gallery is "in the pool" view. */
  flistCharacterImages: Record<
    string,
    {
      byId: Record<
        string,
        { extension: string; size: number; added_at?: number }
      >
      status: 'idle' | 'loading' | 'ready' | 'error'
    }
  >
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
  /** Cached mapping-list payload. Tier 2 fetches once on first mount of
   *  the Profile-fields tab; ↻ on the staleness chip re-fetches with
   *  force=true. Purged on sign-out. */
  flistMapping: {
    status: 'idle' | 'loading' | 'ready' | 'error'
    payload: (Record<string, unknown> & { _etag: string | null; _fetched_at: number | null }) | null
    fetchedAt: number | null
    etag: string | null
    error: string | null
  }
  /** Tools → "Back up all characters" progress. `running` while the SSE
   *  stream is open; the banner reads currentName + (done/total) live,
   *  then summary `phase = 'done'` for 6s before auto-clearing. */
  flistBackupAllStatus: {
    phase: 'idle' | 'running' | 'done' | 'cancelled' | 'error'
    total: number
    done: number
    saved: number
    unchanged: number
    failed: number
    currentName: string | null
    errorMessage: string | null
    /** The running Back up all job, for Cancel. Null for a single
     *  character's Backup, which is no job. */
    jobId?: string | null
  }
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
  /** AbortController for the in-flight character pull. Sign-out
   *  aborts this before clearing the ticket so a long-running pull
   *  doesn't continue writing to disk against a torn-down session. */
  flistPullAbortController: AbortController | null
  /** When true, EditorPane/PreviewPane/Toolbar all switch to read-only
   *  mode. Set whenever the user opens a Live or historical Backup
   *  document. */
  editorReadOnly: boolean
  /** Which F-list theme palette the preview pane mimics. Values match
   *  F-list's own theme picker (Settings → Display). Persisted in
   *  localStorage so it sticks across launches. */
  previewTheme: 'dark' | 'default' | 'light'
  setPreviewTheme: (next: 'dark' | 'default' | 'light') => void
  /** Modal visibility for the sign-in dialog. */
  flistSignInOpen: boolean
  /** Last error from a sign-in attempt; passed verbatim from F-list per
   *  the Tier 1 decision. */
  flistSignInError: string | null
  flistSignInStatus: 'idle' | 'submitting' | 'error'
  /** Saved-credential metadata, read from the OS keychain via the
   *  Electron preload. `account` is the saved username (or null if
   *  nothing is saved). `autoLogin` indicates whether the next launch
   *  should silently attempt sign-in. `hasPassword` mirrors whether
   *  the encrypted blob exists on disk. `encryptionAvailable` reflects
   *  Electron's safeStorage availability — false means we can't save
   *  even if the user asks. */
  flistSavedCreds: {
    account: string | null
    autoLogin: boolean
    encryptionAvailable: boolean
    hasPassword: boolean
  }
  /** True while the renderer is in the middle of the startup
   *  auto-login attempt. Used to suppress the sign-in modal so it
   *  doesn't flash open before the silent sign-in completes. */
  flistAutoLoginInFlight: boolean

  loadCharacters: () => Promise<void>
  selectCharacter: (name: string | null) => void
  markCharacterSeen: (name: string) => void
  setMode: (mode: Mode) => void
  setCrossSearchOpen: (open: boolean) => void
  /** Select the Foreign slot. Leaves the real active character alone
   *  so going back to it restores exactly what was open. */
  foreignOpenSlot: () => void
  /** Leave the Foreign slot without clearing what it holds. */
  foreignLeaveSlot: () => void
  /** Fetch (or re-fetch) a foreign profile into the slot. */
  foreignLoad: (name: string, refresh?: boolean) => Promise<void>
  /** Drop the loaded profile, back to the lookup form. */
  foreignUnload: () => void
  loadPartners: (char: string) => Promise<void>
  selectPartner: (name: string | null) => void
  loadMessages: (char: string, partner: string, opts?: { force?: boolean }) => Promise<void>
  invalidateMessages: (char: string, partner: string) => void
  /** Something outside this window changed settings (the
   *  `settings-changed` event); `fields` names them, as the sidecar's
   *  settings service does (`labels.threshold_chars`, `rag.top_k`). */
  noteSettingsChanged: (fields: string[]) => void
  openIngest: (
    scope: { character?: string | null; partner?: string | null },
    label: string,
    opts?: { forceRewipe?: boolean }
  ) => void
  closeIngest: () => void
  /** The Index changed elsewhere: views showing its status re-read. */
  noteIndexChanged: () => void
  /** Labels changed elsewhere: views listing cleared Labels re-read. */
  noteLabelsChanged: () => void
  /** One message by hash, or every message in a set of hashes. */
  applyLabelOverride: (
    char: string,
    partner: string,
    hash: string | ReadonlySet<string>,
    patch: {
      label?: 'IC' | 'OOC'
      label_source?: 'llm' | 'manual'
    } | null
  ) => void
  setEditorContent: (value: string) => void
  setEditorActiveTab: (tab: string) => void
  setEditorViewMode: (mode: 'split' | 'preview' | 'code') => void
  fetchProfile: (name: string) => Promise<void>
  resetEditorDirty: () => void

  // ---- F-list actions ----
  flistOpenSignIn: () => void
  flistCloseSignIn: () => void
  flistSignIn: (
    account: string,
    password: string,
    opts?: { rememberPassword?: boolean; autoLogin?: boolean }
  ) => Promise<void>
  flistSignOut: () => Promise<void>
  /** Read saved-cred metadata from the Electron main process so the
   *  startup flow can decide between auto-login and showing the modal.
   *  Safe to call before sign-in; no-op outside Electron. */
  flistLoadSavedCreds: () => Promise<void>
  /** Try to silently sign in using saved credentials. If auto-login is
   *  on and the keychain has a password, this fires the same sign-in
   *  request the modal would. On failure, the sign-in modal opens with
   *  the error visible — saved creds are left intact. Returns `true`
   *  when an attempt was made (regardless of outcome). */
  flistAttemptAutoLogin: () => Promise<boolean>
  /** Remove the saved password + metadata from disk. Used by Settings'
   *  "Remove saved login" and triggered by Sign Out (no — Sign Out
   *  keeps the saved creds so the user can sign back in next launch). */
  flistClearSavedCreds: () => Promise<void>
  /** Toggle the auto-login flag without re-entering the password.
   *  No-op when no credentials are saved. */
  flistSetSavedAutoLogin: (next: boolean) => Promise<void>
  flistRefreshSession: () => Promise<void>
  flistLoadRoster: () => Promise<void>
  flistSelectCharacter: (characterId: string | null) => Promise<void>
  flistLoadArchive: (characterId: string) => Promise<void>
  /** Pull a character from F-list into its slot. `skipWhenBusy`: when
   *  a job already holds the character, leave the slot without an
   *  error (Refresh all) instead of saying so. */
  flistPullCharacter: (
    name: string,
    characterId?: string | null,
    opts?: { skipWhenBusy?: boolean }
  ) => Promise<void>
  /** Cancel the character's running Pull (a job): it stops at its next
   *  step, keeping what it already wrote. */
  flistCancelPull: (characterId: string) => Promise<void>
  /** Follow the Pulls and Back up all the sidecar is still running, as
   *  after the window reloaded: their progress shows again and they
   *  can be cancelled. */
  flistResumeJobs: () => Promise<void>
  /** Manual "Refresh all" — unconditionally pulls every account
   *  character on the current roster. Single-flight: triggering while
   *  a sweep is running (either this or the sign-in sweep) is a no-op. */
  flistRefreshAllAccount: () => Promise<void>
  // ---- Tier 6 export-restore preview ----
  flistOpenExportRestore: (characterId: string) => void
  flistCloseExportRestore: () => void
  // ---- v5 image actions ----
  flistLoadCharacterImages: (characterId: string) => Promise<void>
  /** Upload a local image. Lands in `images/` as a `local-<sha8>` and
   *  shows up in the Pool view; the caller is responsible for moving
   *  it on-profile via flistMoveImageToProfile if that's the intent. */
  flistUploadImage: (
    characterId: string,
    file: File | Blob
  ) => Promise<FlistCharacterImage>
  /** Delete images, on the profile or only in the pool, in one request:
   *  the sidecar takes gallery images off the Workbench's gallery and
   *  moves every file to the Trash, the same route a model's
   *  `trash_images` takes. Only the ids the sidecar actually moved leave
   *  the pool listing; a failed request throws instead of pretending. */
  flistTrashImages: (
    characterId: string,
    imageIds: string[]
  ) => Promise<string[]>
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
  flistGetLastAccount: () => string
  /** Ask the sidecar whether the character has a Workbench yet and
   *  when it last changed, for the Workbench row. Creates nothing. */
  flistLoadWorkbenchInfo: (characterId: string) => Promise<void>
  /** Re-read the character's Backup list, after a Backup this window
   *  did not make. A failure leaves the list as it was. */
  flistLoadBackups: (characterId: string) => Promise<void>
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
  /** Tools → "Back up all characters". Walks the signed-in account
   *  roster, pulls each character (JSON + images + avatar), and
   *  writes a userscript-restoreable ZIP per character. Single-flight:
   *  a second call while one is running is a no-op. */
  flistBackupAll: () => Promise<void>
  /** Cancel the running Back up all: it stops at its next step; the
   *  Backups it already wrote stay. */
  flistCancelBackupAll: () => Promise<void>
  /** Right-click → "Back up now" on a single character row. Pulls
   *  the character (full, with images), then forces a ZIP backup write
   *  to `characters/<id>/backups/<ISO>.zip`. Uses the same Backup-all
   *  banner UI so the user sees progress, with `total: 1`. */
  /** Pack a character into a restoreable ZIP.
   *
   *  `pull` decides what is being archived. From the read-only
   *  "Live on F-List" row it is true: refresh from the website
   *  first, so the ZIP holds every image byte the userscript would
   *  need. From the Workbench row it must be false — the bench
   *  holds edits that exist nowhere else, and pulling to save them
   *  would move Live underneath them (and fail offline, for a
   *  backup that needs no network at all). */
  flistBackupCharacter: (
    name: string,
    opts?: { pull?: boolean }
  ) => Promise<void>

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
  flistResetWorkingToLive: (characterId: string) => Promise<void>
  flistDismissDriftBanner: (characterId: string) => void
  // ---- mapping list ----
  flistLoadMapping: (opts?: { force?: boolean }) => Promise<void>
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

  /** Right-click → Browse backup on a row in the Backups sidebar
   *  list. Loads the ZIP into the existing diff backup cache,
   *  flips `flistBrowseBackup` so the editor renders read-only
   *  against that backup's payload. No-op when the same target is
   *  already open. Safe to call without a dirty-working guard —
   *  browse mode never mutates working.json. */
  flistOpenBrowseBackup: (
    characterId: string,
    backupFilename: string
  ) => Promise<void>
  /** Header-pill "Back to working copy" / character switch / Escape.
   *  Clears `flistBrowseBackup` so the editor tabs render against
   *  the live working copy again. */
  flistCloseBrowseBackup: () => void
  /** Right-click → Download ZIP… on a Backups row. OS save dialog
   *  defaults the filename to the backup's on-disk name; we don't
   *  invent a friendlier one because the timestamp+UTC marker is
   *  exactly what a user copying the file off-machine wants. */
  flistDownloadZipBackup: (
    characterId: string,
    backupFilename: string
  ) => Promise<{ path: string; bytes: number } | null>
  /** Right-click → Delete backup on a Backups row. The sidecar moves
   *  the ZIP to the character's Trash, where the Trash view can
   *  restore it. Refreshes the sidebar list on success. If the deleted
   *  backup is currently being browsed, also closes browse mode so the
   *  editor doesn't display a Backup that has left the list. */
  flistDeleteZipBackup: (
    characterId: string,
    backupFilename: string
  ) => Promise<boolean>
  /** Right-click → Rename… on a Backups row. The ZIP file itself
   *  isn't modified; the rename is a sidecar-stored label persisted
   *  in `_names.json`. Empty string clears the rename. Patches the
   *  in-memory row + the open Browse-backup banner if applicable. */
  flistRenameZipBackup: (
    characterId: string,
    backupFilename: string,
    name: string
  ) => Promise<boolean>

}

function partnerKey(char: string, partner: string): string {
  return `${char}::${partner}`
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

// Request token for foreignLoad: the number of the newest load. Picking
// profiles quickly leaves several reads in flight, landing in any
// order; only the newest may apply its answer, so the view always ends
// on the profile the user picked last. foreignUnload bumps it as well.
let _foreignLoadToken = 0

/** The editor patch that shows a character's Workbench as the slot in
 *  memory holds it, unsaved keystrokes included. */
function _workbenchInEditor(s: State, characterId: string): Partial<State> {
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
function _workbenchLoadingInEditor(s: State, characterId: string): Partial<State> {
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

type SlotSet = (fn: (s: State) => Partial<State>) => void

/** The editor follows the active character's slot: whatever a commit
 *  leaves in the payload is the description the editor shows. Edits and
 *  written commits reach it only while it shows the Workbench (not a
 *  read-only view); a view sets what it shows itself. */
function _editorFollows(
  s: State,
  characterId: string,
  next: FlistWorkingSlot | null,
  commit: Commit
): Partial<State> {
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
  also?: (s: State) => Partial<State>
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
  const cleared = (st: State): Partial<State> => ({
    flistExternalChange: { ...st.flistExternalChange, [characterId]: null }
  })
  // Taken in by itself: say who changed it, the part the user cannot see.
  const settled = (st: State): Partial<State> => ({
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
  merged: (s: State) => Partial<State>,
  asked: (s: State) => Partial<State>
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
  also: (s: State) => Partial<State>
): void {
  const commit: Commit = isDeepEqual(payload, theirs)
    ? { kind: 'written', label, payload: theirs, etag, lastSavedAt: Date.now() }
    : { kind: 'merged', label, payload, etag, saved: theirs }
  _commit(get, set, characterId, commit, also)
}

/** Sign-out's commit: every slot dropped at once, as a view. */
function _dropAllWorkbenches(set: SlotSet, also: (s: State) => Partial<State>): void {
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

// Tracks whether an account-wide sweep is in flight. Shared between
// the sign-in auto-refresh and the picker's manual "↻ Refresh all",
// so a second trigger while one is running is a no-op rather than
// running two passes over the same characters.
let _flistAccountSweepInFlight = false

/** Re-read a character's Backup list so a Backup the sidecar just
 *  wrote shows up. A failure leaves the list stale. */
function _refreshBackupList(
  characterId: string,
  set: (fn: (s: State) => Partial<State>) => void
): Promise<void> {
  return api
    .flistZipBackups(characterId)
    .then((r) => {
      set((s) => {
        const entry = s.flistArchive[characterId]
        if (!entry) return {}
        return {
          flistArchive: {
            ...s.flistArchive,
            [characterId]: {
              ...entry,
              zipBackups: r.backups,
              zipBackupsStatus: 'ready',
              zipBackupsError: null
            }
          }
        }
      })
    })
    .catch(() => {})
}

/** One save of a character's Workbench: the PUT itself, with no
 *  queueing. Only flistFlushWorking calls this, as the last step of its
 *  per-character chain, so two saves never leave for the same character
 *  at once. */
async function _flushWorkingNow(
  characterId: string,
  get: () => State,
  set: (fn: (s: State) => Partial<State>) => void
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
    if (err instanceof Error && err.message === 'etag_mismatch') {
      const errWith = err as Error & { currentEtag?: string | null }
      _noteSaveConflict(get, set, characterId, baseEtag, errWith.currentEtag ?? null)
      return
    }
    const raw = err instanceof Error ? err.message : String(err)
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
  set: (fn: (s: State) => Partial<State>) => void,
  characterId: string,
  commit: Commit & { kind: 'written' }
): void {
  _commit(get, set, characterId, commit, (s) => {
    const browse = s.flistBrowseBackup
    if (browse?.characterId !== characterId) {
      return { flistViewingLive: { ...s.flistViewingLive, [characterId]: false } }
    }
    // A browsed Backup ends too: Live goes back to what the browse
    // stood in for.
    return {
      flistViewingLive: { ...s.flistViewingLive, [characterId]: false },
      flistBrowseBackup: null,
      flistArchive: {
        ...s.flistArchive,
        [characterId]: {
          ...(s.flistArchive[characterId] ?? { pullStatus: 'idle' }),
          live: browse.previousLive
        }
      }
    }
  })
  if (get().flistActiveCharacterId === characterId) {
    set((s) => _workbenchInEditor(s, characterId))
  }
}

type StoreSet = typeof useStore.setState

const IDLE_BACKUP_ALL_STATUS: State['flistBackupAllStatus'] = {
  phase: 'idle',
  total: 0,
  done: 0,
  saved: 0,
  unchanged: 0,
  failed: 0,
  currentName: null,
  errorMessage: null,
  jobId: null
}

/** The job holding a character that a Pull or Back up all was refused
 *  for (`character_busy`), or null when `err` is another failure. */
function _characterBusyWith(err: unknown): 'pull' | 'backup-all' | null {
  if (!(err instanceof RefusalError) || err.code !== 'character_busy') return null
  return err.details.kind === 'backup-all' ? 'backup-all' : 'pull'
}

/** Follow a Pull job into the character's slot: its progress, its job
 *  id (for Cancel), and on `done` the reloads a finished Pull needs.
 *  `open` starts the Pull or follows one already running; aborting the
 *  signal (sign-out) only stops following, the job runs on. A Pull
 *  refused because a job holds the character says so in plain words,
 *  or with `skipWhenBusy` leaves the slot idle, its stage `busy`. */
async function _followPull(
  get: () => State,
  set: StoreSet,
  targetId: string | null,
  open: (handlers: FlistPullHandlers, signal: AbortSignal) => Promise<void>,
  opts: { skipWhenBusy?: boolean } = {}
): Promise<void> {
  const setStatus = (
    patch: Partial<{
      pullStatus: 'idle' | 'queued' | 'running' | 'done' | 'error'
      pullStage: string
      pullProgress: { done: number; total: number }
      pullError: string | null
      pullJobId: string | null
    }>
  ) => {
    if (!targetId) return
    set((s) => ({
      flistArchive: {
        ...s.flistArchive,
        [targetId]: {
          ...(s.flistArchive[targetId] ?? {
            live: null,
            pullStatus: 'idle'
          }),
          ...patch
        }
      }
    }))
  }
  setStatus({ pullStatus: 'queued', pullError: null })
  const ctrl = new AbortController()
  set({ flistPullAbortController: ctrl })
  try {
    await open({
      onJob: (job) => setStatus({ pullJobId: job.id }),
      onCancelled: () =>
        setStatus({ pullStatus: 'idle', pullStage: 'cancelled', pullError: null, pullJobId: null }),
      onTicket: () =>
        setStatus({ pullStatus: 'running', pullStage: 'ticket' }),
      onFetching: () =>
        setStatus({ pullStatus: 'running', pullStage: 'fetching' }),
      onImages: ({ total }) =>
        setStatus({
          pullStatus: 'running',
          pullStage: 'images',
          pullProgress: { done: 0, total }
        }),
      onImage: ({ index, total, ok, cached }) => {
        setStatus({ pullProgress: { done: index, total } })
        // Refresh the per-character images map so the Images tab's
        // thumbnails update as files arrive. Only every 10th image to
        // avoid hammering the sidecar with one HTTP GET per download
        // (the rate-limited CDN already paces us at ~2/s, so a 10x
        // skip means the Images tab refreshes every ~5 seconds during
        // a long pull). Cached events don't change disk state.
        if (targetId && ok && !cached && (index % 10 === 0 || index === total)) {
          void get().flistLoadCharacterImages(targetId)
        }
      },
      onDone: async (info) => {
        // We know the character_id now even if we didn't before. Make
        // sure the per-id slot exists and gets reloaded.
        set((s) => ({
          flistArchive: {
            ...s.flistArchive,
            [info.character_id]: {
              ...(s.flistArchive[info.character_id] ?? {
                live: null,
                pullStatus: 'idle'
              }),
              pullStatus: 'done',
              pullStage: 'done',
              pullJobId: null
            }
          }
        }))
        await get().flistLoadArchive(info.character_id)
        await get().flistLoadCharacterImages(info.character_id)
        await get().flistLoadRoster()
        // If the user is sitting on this character's working copy and
        // hasn't typed anything yet, refresh the editor with the
        // freshly-pulled Live content. Skip when the working copy is
        // dirty OR when the live editorContent has already diverged
        // from the seeded content — covers the race where keystrokes
        // arrived between the dirty=false snapshot we took and now.
        const isActive =
          get().flistActiveCharacterId === info.character_id &&
          !get().editorReadOnly
        const working = get().flistWorking[info.character_id]
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
            _commit(get, set, info.character_id, { kind: 'view', slot: null })
          }
          void get().flistOpenWorking(info.character_id)
        } else if (isActive && working?.materialised) {
          // Materialised working copy active: surface drift for non-
          // overlaid paths against the new Live.
          const newLive = get().flistArchive[info.character_id]?.live ?? null
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
                [info.character_id]: { paths: drift, dismissedAt: null }
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
          void get().flistOpenWorking(info.character_id)
        }
      },
      onError: ({ message }) => {
        setStatus({ pullStatus: 'error', pullError: message, pullJobId: null })
      }
    }, ctrl.signal)
  } catch (err) {
    // AbortError = user-initiated (sign-out / explicit cancel).
    // Don't surface as a scary error to the user.
    const raw = err instanceof Error ? err.message : String(err)
    const busyWith = _characterBusyWith(err)
    if (err instanceof Error && err.name === 'AbortError') {
      setStatus({ pullStatus: 'idle', pullError: null })
    } else if (busyWith && opts.skipWhenBusy) {
      setStatus({ pullStatus: 'idle', pullStage: 'busy', pullError: null })
    } else if (busyWith) {
      setStatus({
        pullStatus: 'error',
        pullError:
          busyWith === 'backup-all'
            ? 'Back up all is running; it pulls this character too.'
            : 'This character is already being pulled.'
      })
    } else {
      setStatus({ pullStatus: 'error', pullError: raw })
    }
  } finally {
    if (get().flistPullAbortController === ctrl) {
      set({ flistPullAbortController: null })
    }
  }
}

/** Follow a Back up all job into the banner's status. `open` starts it
 *  or follows one already running. */
async function _followBackupAll(
  get: () => State,
  set: StoreSet,
  open: (handlers: FlistBackupAllHandlers) => Promise<void>
): Promise<void> {
  try {
    await open({
      onJob: (job) => {
        set((s) => ({ flistBackupAllStatus: { ...s.flistBackupAllStatus, jobId: job.id } }))
      },
      onCancelled: () => {
        set((s) => ({
          flistBackupAllStatus: {
            ...s.flistBackupAllStatus,
            phase: 'cancelled',
            currentName: null,
            jobId: null
          }
        }))
        _clearBackupAllStatusLater(get, set, 'cancelled')
      },
      onStart: ({ total }) => {
        set((s) => ({
          flistBackupAllStatus: { ...s.flistBackupAllStatus, total }
        }))
      },
      onCharacter: (info) => {
        set((s) => {
          const cur = s.flistBackupAllStatus
          if (info.status === 'fetching') {
            return {
              flistBackupAllStatus: { ...cur, currentName: info.name }
            }
          }
          // Per-character terminal status: bump counters + done.
          const next = {
            ...cur,
            done: cur.done + 1,
            saved: cur.saved + (info.status === 'saved' ? 1 : 0),
            unchanged:
              cur.unchanged + (info.status === 'unchanged' ? 1 : 0),
            failed: cur.failed + (info.status === 'error' ? 1 : 0)
          }
          return { flistBackupAllStatus: next }
        })
        // Refresh the archive slot from disk after each successful
        // per-character pull. Both 'saved' (ZIP written, content
        // changed) and 'unchanged' (ZIP dedup'd, content matched
        // last backup) imply the per-character pull preceded the
        // ZIP step and put fresh live.json + images on disk. Without
        // this, the picker would keep showing 'pulled 16h ago' for
        // every character even though Back up all just
        // updated all of them — wasted disk + network on subsequent
        // manual REFRESH ALL clicks. flistLoadArchive reads from
        // local /flist/character/{id}/live (no F-list network),
        // updates the live payload + zipBackups +
        // lastPullAt in one pass.
        const refreshable =
          (info.status === 'saved' || info.status === 'unchanged') &&
          info.character_id
        if (refreshable) {
          void get().flistLoadArchive(info.character_id!)
        }
      },
      onDone: () => {
        set((s) => ({
          flistBackupAllStatus: {
            ...s.flistBackupAllStatus,
            phase: 'done',
            currentName: null
          }
        }))
        // Auto-clear the summary banner after 6s so it doesn't
        // linger past usefulness.
        setTimeout(() => {
          const cur = get().flistBackupAllStatus
          if (cur.phase === 'done') {
            set({
              flistBackupAllStatus: {
                phase: 'idle',
                total: 0,
                done: 0,
                saved: 0,
                unchanged: 0,
                failed: 0,
                currentName: null,
                errorMessage: null
              }
            })
          }
        }, 6000)
      },
      onError: ({ message }) => {
        set((s) => ({
          flistBackupAllStatus: {
            ...s.flistBackupAllStatus,
            phase: 'error',
            errorMessage: message,
            currentName: null
          }
        }))
      }
    })
  } catch (err) {
    const busyWith = _characterBusyWith(err)
    const message =
      busyWith === 'pull'
        ? 'A Pull is running. Start Back up all again once it has finished.'
        : busyWith === 'backup-all'
          ? 'Back up all is already running.'
          : ((err as Error).message ?? 'backup-all failed')
    set((s) => ({
      flistBackupAllStatus: {
        ...s.flistBackupAllStatus,
        phase: 'error',
        errorMessage: message,
        currentName: null
      }
    }))
  }
}

function _startBackupAllStatus(set: StoreSet, jobId: string | null): void {
  set({
    flistBackupAllStatus: {
      phase: 'running',
      total: 0,
      done: 0,
      saved: 0,
      unchanged: 0,
      failed: 0,
      currentName: null,
      errorMessage: null,
      jobId
    }
  })
}

/** Back to idle after 6 s, unless something else started meanwhile. */
function _clearBackupAllStatusLater(
  get: () => State,
  set: StoreSet,
  phase: 'done' | 'cancelled'
): void {
  setTimeout(() => {
    if (get().flistBackupAllStatus.phase !== phase) return
    set({ flistBackupAllStatus: { ...IDLE_BACKUP_ALL_STATUS } })
  }, 6000)
}

/** The character a running Pull job writes: the one its resource names
 *  (`character:<id>`), else the roster entry with its name, else the id
 *  it reported once F-list answered. */
function _pullTarget(state: State, job: Job): string | null {
  const held = /^character:(\d+)$/.exec(job.resource)
  if (held) return held[1]
  const name = typeof job.params.name === 'string' ? job.params.name.toLowerCase() : null
  const entry = name ? state.flistRoster.find((r) => r.name.toLowerCase() === name) : undefined
  if (entry?.id != null) return String(entry.id)
  const reported = job.progress.character_id
  return typeof reported === 'string' ? reported : null
}

/** Pull every account character on the current roster.
 *  - `thresholdSec === null` → unconditional (manual Refresh all).
 *  - `thresholdSec >= 0`     → skip characters fresher than threshold.
 *  Single-flight: a second call while a sweep is running is a no-op. */
async function _flistAccountSweep(
  get: () => State,
  thresholdSec: number | null
): Promise<void> {
  if (_flistAccountSweepInFlight) return
  _flistAccountSweepInFlight = true
  useStore.setState({ flistAccountSweepStatus: 'running' })
  try {
    const now = Date.now() / 1000
    if (!get().flistSession.active) return
    const roster = get().flistRoster
    // Snapshot the IDs we want to refresh up front — the loop below
    // awaits each pull, so by the time we get to character N the
    // roster could have changed (sign-out + sign-in).
    const targets = roster
      .filter((r) => r.on_account && r.id !== null)
      .map((r) => ({
        name: r.name,
        id: String(r.id),
        lastPulledAt: r.last_pulled_at
      }))
    for (const t of targets) {
      // Bail if the user signed out mid-sweep so we don't keep firing
      // pulls against a session that no longer exists.
      if (!get().flistSession.active) break
      // Already being pulled, and this window follows it.
      const status = get().flistArchive[t.id]?.pullStatus
      if (status === 'queued' || status === 'running') continue
      if (thresholdSec !== null) {
        const age =
          t.lastPulledAt === null
            ? Number.POSITIVE_INFINITY
            : now - t.lastPulledAt
        if (age < thresholdSec) continue
      }
      // selectCharacter would change the active character; we want
      // a silent background refresh, so go straight to the pull.
      // One Pull at a time here; a character another job holds (a
      // Pull the user started by hand, Back up all) is skipped.
      try {
        await get().flistPullCharacter(t.name, t.id, { skipWhenBusy: true })
      } catch {
        // Per-character failures are surfaced via the picker badge
        // (slot.pullError). Don't abort the rest of the sweep.
      }
    }
  } finally {
    _flistAccountSweepInFlight = false
    useStore.setState({ flistAccountSweepStatus: 'idle' })
  }
}

async function _flistAutoRefreshOnLogin(
  get: () => State
): Promise<void> {
  // User opt-in. Default off — see Settings → F-list. The 30-min
  // lazy-pull-on-select keeps the active character fresh without
  // hammering the API for every character on the account.
  if (!readAutoRefreshEnabled()) return
  const thresholdSec = readAutoRefreshHours() * 3600
  await _flistAccountSweep(get, thresholdSec)
}

// In-flight mapping-list promise (QA P3-4): callers awaiting an
// already-running flistLoadMapping get the same promise back so they
// can sequence their work after `payload` is populated.
let _mappingInflight: Promise<void> | null = null

// Monotonic session counter bumped on sign-in / sign-out (QA P2-4).
// Mapping-list responses that arrive after a session change are
// discarded so a prior account's data can't be reinstated.
let _flistSessionEpoch = 0

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

/** Normalise the `kind` field from a backup's `backup-meta.json`.
 *  Backups predating the meta write (or hand-crafted via the file
 *  system) get `'unknown'` so the UI can show "Backup · unknown
 *  reason" rather than a missing badge. */
function normaliseBackupKind(
  raw: unknown
): 'manual_single' | 'manual_bulk' | 'import' | 'scheduled' | 'unknown' {
  if (
    raw === 'manual_single' ||
    raw === 'manual_bulk' ||
    raw === 'import' ||
    raw === 'scheduled'
  ) {
    return raw
  }
  return 'unknown'
}

/** Format a backup's filename (`YYYY-MM-DDTHHMMSSZ.zip`) into the
 *  local-time label shown in the Browse-backup header banner.
 *  Returns the raw filename as a fallback so a malformed name doesn't
 *  hide the affordance entirely. */
function formatBackupDateForBanner(filename: string): string {
  const m = filename.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z/
  )
  if (!m) return filename
  const [, y, mo, d, h, mi] = m
  const date = new Date(
    Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      0
    )
  )
  if (isNaN(date.getTime())) return filename
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Restore the editor state stashed when the user entered Browse mode:
 *  back to Live if that was shown, otherwise back to the Workbench.
 *
 *  Always restores `flistArchive[id].live` to its true value FIRST so
 *  whichever activation we call next reads the right source. Pulled
 *  out so flistCloseBrowseBackup AND flistOpenBrowseBackup (when
 *  switching from one backup to another) can both use it.
 */
function _restoreFromBrowse(
  getter: () => State,
  setter: (
    patch:
      | Partial<State>
      | ((s: State) => Partial<State> | State)
  ) => void,
  browse: NonNullable<State['flistBrowseBackup']>
): void {
  const { characterId, previousLive, previousViewingLive } = browse
  setter((s) => ({
    flistArchive: {
      ...s.flistArchive,
      [characterId]: {
        ...(s.flistArchive[characterId] ?? {
          pullStatus: 'idle'
        }),
        live: previousLive
      }
    },
    flistBrowseBackup: null
  }))
  // Back to the row the user was on. Both overwrite editorReadOnly,
  // editorContent, editorInlines and the working slot, so there is
  // nothing to undo here.
  if (previousViewingLive) {
    void getter().flistShowLive(characterId)
  } else {
    setter({ editorReadOnly: false })
    void getter().flistOpenWorking(characterId)
  }
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

export const useStore = create<State>((set, get) => ({
  characters: [],
  charactersStatus: 'idle',
  charactersError: null,
  charLastSeen: readLastSeen(),

  activeCharacter: null,
  mode: 'editor',
  crossSearchOpen: false,
  foreignActive: false,
  foreignName: null,
  foreignProfile: null,
  foreignFromCache: false,
  foreignAgeSec: null,
  foreignStale: false,
  foreignRefreshError: null,
  foreignStatus: 'idle',
  foreignError: null,

  partners: {},
  partnersStatus: {},
  activePartner: null,

  ingestTarget: null,
  indexRevision: 0,
  labelsRevision: 0,

  messagesByPartner: {},
  messagesStatus: {},
  messagesError: {},
  settingsRevision: 0,

  editorContent: '',
  editorTitle: '',
  editorInlines: {},
  editorFetchStatus: 'idle',
  editorFetchError: null,
  editorDirty: false,
  editorActiveTab: 'description',
  editorViewMode: ((): 'split' | 'preview' | 'code' => {
    try {
      const stored = localStorage.getItem('flist-workbench:editor-view-mode')
      if (stored === 'split' || stored === 'preview' || stored === 'code') {
        return stored
      }
    } catch {
      // ignore
    }
    return 'split'
  })(),

  saveStatus: 'idle',
  saveError: null,
  draftStatus: 'idle',

  flistSession: { active: false },
  flistAccountCharacters: [],
  flistRoster: [],
  flistRosterStatus: 'idle',
  flistAccountSweepStatus: 'idle',
  flistActiveCharacterId: null,
  flistArchive: {},
  flistCharacterImages: {},
  flistExportRestoreCharacterId: null,
  flistBrowseBackup: null,
  flistWorking: {},
  flistWorkingLoadStatus: {},
  flistWorkbenchInfo: {},
  flistRestoreRefusal: {},
  flistViewingLive: {},
  flistExternalChange: {},
  flistMergeQuestion: {},
  flistWorkbenchNote: null,
  flistUndoNotes: {},
  flistMapping: {
    status: 'idle',
    payload: null,
    fetchedAt: null,
    etag: null,
    error: null
  },
  flistBackupAllStatus: {
    phase: 'idle',
    total: 0,
    done: 0,
    saved: 0,
    unchanged: 0,
    failed: 0,
    currentName: null,
    errorMessage: null
  },
  flistDriftBanners: {},
  flistDiffRightSource: {},
  flistDiffBackupCache: {},
  flistDiffBackupStatus: {},
  flistCustomKinksUI: {},
  flistPullAbortController: null,
  editorReadOnly: false,
  previewTheme: ((): 'dark' | 'default' | 'light' => {
    try {
      const raw = localStorage.getItem('workbench.previewTheme')
      if (raw === 'dark' || raw === 'default' || raw === 'light') return raw
    } catch {
      /* localStorage unavailable — fall through */
    }
    return 'default'
  })(),
  setPreviewTheme: (next) => {
    try {
      localStorage.setItem('workbench.previewTheme', next)
    } catch {
      /* best-effort persistence */
    }
    set({ previewTheme: next })
  },
  flistSignInOpen: false,
  flistSignInError: null,
  flistSignInStatus: 'idle',
  flistSavedCreds: {
    account: null,
    autoLogin: false,
    encryptionAvailable: false,
    hasPassword: false
  },
  flistAutoLoginInFlight: false,

  // ---- F-list actions ----------------------------------------------------

  // Return type is annotated on purpose: the body reads back through
  // `useStore`, so without it TypeScript has to infer `useStore` from
  // an initializer that references `useStore` and gives up — turning
  // the whole store into `any` and silently disabling type checking
  // in every component that selects from it.
  flistGetLastAccount(): string {
    // Saved-creds account wins when present so the sign-in modal
    // pre-fills the username the user explicitly chose to remember.
    // Falls back to the localStorage last-used account otherwise.
    const saved: string | null = useStore.getState().flistSavedCreds.account
    if (saved) return saved
    if (typeof localStorage === 'undefined') return ''
    try {
      return localStorage.getItem(FLIST_ACCOUNT_KEY) ?? ''
    } catch {
      return ''
    }
  },

  flistOpenSignIn() {
    set({ flistSignInOpen: true, flistSignInError: null, flistSignInStatus: 'idle' })
  },

  async flistLoadSavedCreds() {
    const credsApi = window.workbench?.creds
    if (!credsApi) return
    try {
      const meta = await credsApi.getMeta()
      set({ flistSavedCreds: meta })
    } catch (err) {
      console.warn('[creds] load meta failed:', err)
    }
  },

  async flistAttemptAutoLogin() {
    const credsApi = window.workbench?.creds
    if (!credsApi) return false
    const { flistSavedCreds, flistSession } = get()
    if (flistSession.active) return false
    if (!flistSavedCreds.autoLogin || !flistSavedCreds.account) return false
    set({ flistAutoLoginInFlight: true })
    try {
      const password = await credsApi.getPassword()
      if (!password) return false
      // We do NOT pass rememberPassword/autoLogin here — saved
      // creds already exist, and re-saving on every auto-login
      // would also force-rewrite the meta blob for no reason. A
      // failed auto-login surfaces via flistSignInError; the
      // saved creds stay put so the user can correct from the
      // modal without losing the username they remembered.
      await get().flistSignIn(flistSavedCreds.account, password)
      return true
    } catch (err) {
      console.warn('[creds] auto-login failed:', err)
      return false
    } finally {
      set({ flistAutoLoginInFlight: false })
    }
  },

  async flistClearSavedCreds() {
    const credsApi = window.workbench?.creds
    if (!credsApi) return
    try {
      await credsApi.clear()
      const meta = await credsApi.getMeta()
      set({ flistSavedCreds: meta })
    } catch (err) {
      console.warn('[creds] clear failed:', err)
    }
  },

  async flistSetSavedAutoLogin(next) {
    const credsApi = window.workbench?.creds
    if (!credsApi) return
    try {
      await credsApi.setAutoLogin(next)
      const meta = await credsApi.getMeta()
      set({ flistSavedCreds: meta })
    } catch (err) {
      console.warn('[creds] set auto-login failed:', err)
    }
  },

  flistCloseSignIn() {
    set({ flistSignInOpen: false })
  },

  async flistSignIn(account, password, opts) {
    set({ flistSignInStatus: 'submitting', flistSignInError: null })
    try {
      const res = await api.flistSignIn({ account, password })
      try {
        localStorage.setItem(FLIST_ACCOUNT_KEY, account)
      } catch {
        // localStorage unavailable — account just won't pre-fill next session
      }
      // Persist (or clear) saved credentials based on the modal's
      // checkbox state. Auto-login implies remember-password — the
      // modal enforces that, but we also enforce it here so a
      // programmatic call can't end up with autoLogin=true + no
      // saved password. Failures here don't block sign-in (the
      // user has already authenticated); a save failure surfaces
      // via flistSavedCreds.encryptionAvailable on the next reload.
      //
      // `opts === undefined` means "this is a programmatic re-login"
      // (auto-login path) — don't touch the keychain at all. Without
      // this guard, every auto-login on launch ran the else-branch
      // below and cleared the saved password, so the second close →
      // relaunch always landed on the sign-in modal.
      if (opts !== undefined) {
        const remember = !!opts.rememberPassword || !!opts.autoLogin
        const autoLogin = !!opts.autoLogin
        const credsApi = window.workbench?.creds
        if (credsApi) {
          try {
            if (remember) {
              await credsApi.save({ account, password, autoLogin })
            } else {
              await credsApi.clear()
            }
            // Refresh in-memory mirror so Settings reflects reality
            // without a page reload.
            const meta = await credsApi.getMeta()
            set({ flistSavedCreds: meta })
          } catch (err) {
            console.warn('[creds] save failed:', err)
          }
        }
      }
      // Bump the session epoch so any in-flight mapping-list fetch from
      // a prior account is discarded on arrival (QA P2-4). Also reset
      // flistMapping to idle so KinksPane re-fires loadMapping — a
      // prior 401 (e.g. KinksPane mounting before sign-in completed)
      // would otherwise leave the picker permanently empty.
      _flistSessionEpoch++
      _mappingInflight = null
      set((s) => {
        // Reset flistMapping on ANY status except 'ready'. A picker
        // that already has a usable payload stays put; everything
        // else — 'idle' (never tried), 'loading' (in-flight against
        // the pre-sign-in epoch, which loadMapping's epoch guard
        // will silently drop), 'error' (a 401 from a pre-sign-in
        // mount) — gets blown back to idle so KinksPane's
        // useEffect fires a fresh load against the newly-active
        // session. Previously only 'error' was reset; a 'loading'
        // status that pre-dated sign-in would stay stuck forever
        // because the epoch-bumped in-flight call returns silently.
        const mappingNeedsReset = s.flistMapping.status !== 'ready'
        // Wipe stale "not signed in" pullErrors left by auto-pull
        // attempts that fired before the session was active — sign-in
        // just made them obsolete. Other pullError causes (network,
        // ticket-expired) will re-surface on the next pull attempt.
        const archive: typeof s.flistArchive = {}
        for (const [id, slot] of Object.entries(s.flistArchive)) {
          archive[id] = slot.pullError ? { ...slot, pullError: null } : slot
        }
        return {
          flistSignInStatus: 'idle',
          flistSignInOpen: false,
          flistAccountCharacters: res.characters,
          flistSession: {
            active: true,
            account: res.account,
            expires_in_sec: res.expires_in_sec
          },
          flistArchive: archive,
          ...(mappingNeedsReset
            ? {
                flistMapping: {
                  status: 'idle' as const,
                  payload: null,
                  etag: null,
                  fetchedAt: null,
                  error: null
                }
              }
            : {})
        }
      })
      await get().flistLoadRoster()
      // Auto-refresh: walk the roster and queue a background pull
      // for every account character whose local copy is older than
      // the user's configured threshold (Settings → F-list). 0
      // minutes = always re-pull. The picker's per-row badges show
      // progress; a character already being pulled (a manual ↻
      // Refresh) is skipped as busy. Fire-and-forget.
      void _flistAutoRefreshOnLogin(get)
    } catch (err) {
      // The modal shows "Invalid account name or password", not
      // "HTTP 401: Invalid account name or password".
      set({ flistSignInStatus: 'error', flistSignInError: errorDetail(err) })
    }
  },

  async flistSignOut() {
    // Flush any pending working-copy autosaves before tearing down — the
    // 500 ms debounce window can otherwise drop the user's last edits
    // (QA P1-1). Single-flight in flistFlushWorking keeps this safe
    // even when a flush is already in progress.
    const pendingIds = Array.from(_autosaveTimers.keys())
    for (const id of pendingIds) {
      try {
        await get().flistFlushWorking(id)
      } catch {
        // best-effort
      }
    }
    _cancelAllPendingTimers()
    // Cancel running Pulls and Back up all BEFORE clearing the ticket so
    // the sidecar doesn't keep writing live.json + image bytes against a
    // torn-down session. They are jobs: closing their streams would not
    // stop them, a cancel by id does.
    const jobIds = [
      ...Object.values(get().flistArchive).map((slot) => slot.pullJobId),
      get().flistBackupAllStatus.jobId
    ].filter((id): id is string => Boolean(id))
    await Promise.all(jobIds.map((id) => api.jobCancel(id).catch(() => undefined)))
    const ctrl = get().flistPullAbortController
    if (ctrl) {
      try { ctrl.abort() } catch { /* already aborted */ }
    }
    try {
      await api.flistSignOut()
    } catch {
      // Server-side clear is best-effort; clearing local state is the
      // user-visible signal that matters.
    }
    // Bump session epoch so any in-flight network call (mapping list,
    // archive load, etc.) that returns after this point is discarded
    // rather than reinstating the signed-out account's data (QA P2-4).
    _flistSessionEpoch++
    _mappingInflight = null
    _dropAllWorkbenches(set, () => ({
      flistSession: { active: false },
      flistAccountCharacters: [],
      flistActiveCharacterId: null,
      editorReadOnly: false,
      flistPullAbortController: null,
      // Purge mapping cache + working slots so a different account
      // logging in doesn't see another user's cached data (Tier 2 §2.x).
      flistMapping: {
        status: 'idle',
        payload: null,
        fetchedAt: null,
        etag: null,
        error: null
      },
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
    await get().flistLoadRoster()
  },

  async flistRefreshSession() {
    try {
      const status = await api.flistSession()
      set({ flistSession: status })
      if (!status.active && get().flistActiveCharacterId !== null) {
        // Session lapsed (e.g. sidecar restart). Drop active selection
        // so the UI doesn't render stale read-only docs.
        set({ flistActiveCharacterId: null, editorReadOnly: false })
      }
    } catch {
      // Sidecar unreachable — leave existing flag, /health card already
      // surfaces it.
    }
  },

  async flistLoadRoster() {
    set({ flistRosterStatus: 'loading' })
    try {
      const { characters } = await api.flistRoster()
      set((s) => {
        const archive = { ...s.flistArchive }
        for (const entry of characters) {
          if (entry.id === null || !entry.pull_status) continue
          const key = String(entry.id)
          const prev = archive[key] ?? {
            live: null,
            pullStatus: 'idle' as const,
          }
          archive[key] = {
            ...prev,
            integrity: {
              status: entry.pull_status.status,
              missing: entry.pull_status.missing_image_ids.length,
            },
          }
        }
        return {
          flistRoster: characters,
          flistRosterStatus: 'ready',
          flistArchive: archive,
        }
      })
      // Restore the previously-selected character so signing back in
      // lands the user on their default rather than the picker's
      // empty state. Only fires when nothing is currently selected
      // and the saved id still resolves against the fresh roster.
      // Route through selectCharacter(name) — going through the lower
      // flistSelectCharacter would only set flistActiveCharacterId and
      // leave activeCharacter (the picker chip's source) untouched,
      // so the chip and the working-sets zone end up on different
      // characters when loadCharacters() races in and defaults
      // activeCharacter to characters[0].
      if (get().flistActiveCharacterId === null) {
        let savedId: string | null = null
        try {
          savedId = localStorage.getItem(FLIST_LAST_CHAR_KEY)
        } catch {
          savedId = null
        }
        if (savedId) {
          const entry = characters.find((c) => String(c.id ?? '') === savedId)
          if (entry) {
            get().selectCharacter(entry.name)
          }
        }
      }
    } catch {
      set({ flistRosterStatus: 'error' })
    }
  },

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
    // surprise the user.
    if (get().flistBrowseBackup) {
      set({ flistBrowseBackup: null })
    }
    set({ flistActiveCharacterId: characterId })
    if (characterId === null) {
      set({ editorReadOnly: false })
      return
    }
    try {
      localStorage.setItem(FLIST_LAST_CHAR_KEY, characterId)
    } catch {
      // ignore
    }
    await get().flistLoadArchive(characterId)
  },

  async flistLoadArchive(characterId) {
    // Initialise the slot if missing so the UI has somewhere to render
    // the "no Live yet" empty state.
    set((s) => ({
      flistArchive: {
        ...s.flistArchive,
        [characterId]: s.flistArchive[characterId] ?? {
          live: null,
          pullStatus: 'idle'
        }
      }
    }))
    // Flip zip-backups to loading so the sidebar shows a spinner
    // instead of an empty list while we fetch.
    set((s) => ({
      flistArchive: {
        ...s.flistArchive,
        [characterId]: {
          ...(s.flistArchive[characterId] ?? {
            live: null,
            pullStatus: 'idle'
          }),
          zipBackupsStatus: 'loading',
          zipBackupsError: null
        }
      }
    }))
    const [live, zipBackupsResult] = await Promise.all([
      api.flistLive(characterId).catch(() => null),
      api
        .flistZipBackups(characterId)
        .then((r) => ({ ok: true as const, backups: r.backups }))
        .catch((err: unknown) =>
          // A character never pulled is not in the archive yet (404
          // `character_not_found`): it simply has no backups.
          err instanceof RefusalError && err.code === 'character_not_found'
            ? { ok: true as const, backups: [] }
            : {
                ok: false as const,
                error: err instanceof Error ? err.message : String(err)
              }
        )
    ])
    set((s) => ({
      flistArchive: {
        ...s.flistArchive,
        [characterId]: {
          ...(s.flistArchive[characterId] ?? { pullStatus: 'idle' }),
          live,
          zipBackups: zipBackupsResult.ok ? zipBackupsResult.backups : [],
          zipBackupsStatus: zipBackupsResult.ok ? 'ready' : 'error',
          zipBackupsError: zipBackupsResult.ok ? null : zipBackupsResult.error,
          lastPullAt:
            (live && typeof live.fetched_at === 'number'
              ? (live.fetched_at as number)
              : null) ?? null
        }
      }
    }))
  },

  async flistRefreshAllAccount() {
    await _flistAccountSweep(get, null)
  },

  async flistPullCharacter(name, characterId, opts) {
    await _followPull(
      get,
      set,
      characterId ?? null,
      (handlers, signal) => api.flistPull(name, handlers, { signal }),
      opts
    )
  },

  async flistCancelPull(characterId) {
    const jobId = get().flistArchive[characterId]?.pullJobId
    if (!jobId) return
    // The Pull stops at its next await and its stream ends with
    // `cancelled`, which sets the slot back to idle.
    await api.jobCancel(jobId)
  },

  async flistResumeJobs() {
    let jobs: Job[]
    try {
      jobs = (await api.jobsList()).jobs
    } catch {
      return
    }
    for (const job of jobs) {
      if (job.state !== 'pending' && job.state !== 'running') continue
      if (job.kind === 'backup-all') {
        if (get().flistBackupAllStatus.jobId === job.id) continue
        _startBackupAllStatus(set, job.id)
        void _followBackupAll(get, set, (handlers) =>
          api.flistBackupAllFollow(job.id, handlers)
        )
      } else if (job.kind === 'pull') {
        const cid = _pullTarget(get(), job)
        if (cid && get().flistArchive[cid]?.pullJobId === job.id) continue
        void _followPull(get, set, cid, (handlers, signal) =>
          api.flistPullFollow(job.id, handlers, { signal })
        )
      }
    }
  },

  flistOpenExportRestore(characterId) {
    set({ flistExportRestoreCharacterId: characterId })
  },

  flistCloseExportRestore() {
    set({ flistExportRestoreCharacterId: null })
  },

  async flistLoadCharacterImages(characterId) {
    set((s) => ({
      flistCharacterImages: {
        ...s.flistCharacterImages,
        [characterId]: {
          byId: s.flistCharacterImages[characterId]?.byId ?? {},
          status: 'loading'
        }
      }
    }))
    try {
      const res = await api.flistCharacterImages(characterId)
      const byId: Record<
        string,
        { extension: string; size: number; added_at?: number }
      > = {}
      for (const img of res.images) {
        byId[img.image_id] = {
          extension: img.extension,
          size: img.size,
          added_at: img.added_at
        }
      }
      set((s) => ({
        flistCharacterImages: {
          ...s.flistCharacterImages,
          [characterId]: { byId, status: 'ready' }
        }
      }))
    } catch {
      set((s) => ({
        flistCharacterImages: {
          ...s.flistCharacterImages,
          [characterId]: {
            byId: s.flistCharacterImages[characterId]?.byId ?? {},
            status: 'error'
          }
        }
      }))
    }
  },

  async flistUploadImage(characterId, file) {
    const entry = await api.flistImageUpload(characterId, file)
    set((s) => {
      const prev = s.flistCharacterImages[characterId]
      const nextById = { ...(prev?.byId ?? {}) }
      nextById[entry.image_id] = {
        extension: entry.extension,
        size: entry.size,
        added_at: entry.added_at
      }
      return {
        flistCharacterImages: {
          ...s.flistCharacterImages,
          [characterId]: { byId: nextById, status: prev?.status ?? 'ready' }
        }
      }
    })
    return entry
  },

  async flistTrashImages(characterId, imageIds) {
    if (imageIds.length === 0) return []
    // A gallery image comes off the Workbench's gallery on the sidecar,
    // which writes the Workbench. What was typed is saved first (after
    // any save in flight), or that save would be refused as stale.
    if (galleryOf(get().flistWorking[characterId]).some((e) => imageIds.includes(e.image_id))) {
      _cancelFlush(characterId)
      await get().flistFlushWorking(characterId).catch(() => {})
      if (get().flistWorking[characterId]?.unsavedDirty) {
        throw new Error('the Workbench has edits that could not be saved')
      }
    }
    const res = await api.flistImagesTrash(characterId, imageIds)
    const moved = res.trashed.map((t) => t.image_id)
    const offGallery = res.off_gallery ?? []
    const poolWithoutMoved = (s: State): Partial<State> => {
      const prev = s.flistCharacterImages[characterId]
      if (!prev) return {}
      const nextById = { ...prev.byId }
      for (const id of moved) delete nextById[id]
      return {
        flistCharacterImages: {
          ...s.flistCharacterImages,
          [characterId]: { byId: nextById, status: prev.status }
        }
      }
    }
    // Show what the sidecar wrote, and save the next edit over its
    // etag. Anything typed meanwhile stays unsaved and goes with it.
    const slot = get().flistWorking[characterId]
    if (slot && res.etag && offGallery.length > 0) {
      const off = (payload: WorkingPayload): WorkingPayload => ({
        ...payload,
        images: galleryOf({ ...slot, payload })
          .filter((e) => !offGallery.includes(e.image_id))
          .map((e, i) => ({ ...e, sort_order: i })),
        _overlay: Array.from(new Set([...(payload._overlay ?? []), 'images']))
      })
      _commit(
        get,
        set,
        characterId,
        {
          kind: 'written',
          label: 'edit',
          payload: off(slot.payload),
          etag: res.etag,
          keepPending: true,
          // On disk now: what was saved, less those images. Typing
          // since is not in it.
          saved: slot.saved ? off(slot.saved) : undefined
        },
        poolWithoutMoved
      )
    } else {
      set(poolWithoutMoved)
    }
    return moved
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
    const archive = get().flistArchive[characterId]
    if (!archive || archive.live === null) {
      const fetched = await api.flistLive(characterId).catch(() => null)
      if (fetched) {
        set((s) => ({
          flistArchive: {
            ...s.flistArchive,
            [characterId]: {
              ...(s.flistArchive[characterId] ?? {
                live: null,
                pullStatus: 'idle'
              }),
              live: fetched as Record<string, unknown>
            }
          }
        }))
      }
    }
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
    if (kept) void _refreshBackupList(characterId, set)
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

  flistLoadBackups(characterId) {
    return _refreshBackupList(characterId, set)
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

  async flistBackupAll() {
    if (get().flistBackupAllStatus.phase === 'running') return
    _startBackupAllStatus(set, null)
    await _followBackupAll(get, set, (handlers) => api.flistBackupAll(handlers))
  },

  async flistCancelBackupAll() {
    const jobId = get().flistBackupAllStatus.jobId
    if (!jobId) return
    await api.jobCancel(jobId)
  },

  async flistBackupCharacter(name, opts) {
    if (get().flistBackupAllStatus.phase === 'running') return
    set({
      flistBackupAllStatus: {
        phase: 'running',
        total: 1,
        done: 0,
        saved: 0,
        unchanged: 0,
        failed: 0,
        currentName: name,
        errorMessage: null
      }
    })

    const finalise = (
      patch: Partial<State['flistBackupAllStatus']>,
      autoClear: boolean
    ) => {
      set((s) => ({
        flistBackupAllStatus: {
          ...s.flistBackupAllStatus,
          ...patch,
          currentName: null
        }
      }))
      if (autoClear) {
        setTimeout(() => {
          const cur = get().flistBackupAllStatus
          if (cur.phase === 'done') {
            set({
              flistBackupAllStatus: {
                phase: 'idle',
                total: 0,
                done: 0,
                saved: 0,
                unchanged: 0,
                failed: 0,
                currentName: null,
                errorMessage: null
              }
            })
          }
        }, 6000)
      }
    }

    const pullFirst = opts?.pull !== false
    if (pullFirst) {
      try {
        // Full pull (JSON + images + avatar) so the ZIP that follows
        // can include every byte the userscript would need to restore
        // the profile. Reuses the existing per-character pull endpoint
        // — that flow already handles ticket refresh, dedup of cached
        // images, and snapshot side-effect.
        await get().flistPullCharacter(name)
      } catch (err) {
        finalise(
          {
            phase: 'error',
            done: 1,
            failed: 1,
            errorMessage:
              err instanceof Error ? err.message : 'pull failed'
          },
          false
        )
        return
      }
    }

    // Resolve the character id — `flistRoster` is keyed by name, and
    // `flistArchive` by id; a pull writes the id into the roster
    // (live.fetched_at), and without one the roster already holds it.
    const roster = get().flistRoster
    const match = roster.find(
      (r) => r.name.toLowerCase() === name.toLowerCase()
    )
    const cid = match?.id ? String(match.id) : null
    if (!cid) {
      finalise(
        {
          phase: 'error',
          done: 1,
          failed: 1,
          errorMessage: `Could not resolve ID for ${name}`
        },
        false
      )
      return
    }

    try {
      const res = await api.flistZipBackup(cid)
      if (res.saved) {
        finalise({ phase: 'done', done: 1, saved: 1 }, true)
      } else {
        // The endpoint defaults to `force=true`, so dedup shouldn't
        // fire from here — but be defensive.
        finalise({ phase: 'done', done: 1, unchanged: 1 }, true)
      }
      // Refresh the sidebar Backups list so the new ZIP appears
      // immediately instead of waiting for the next character switch.
      // Fire-and-forget; failure is harmless (list stays stale).
      void api
        .flistZipBackups(cid)
        .then((r) => {
          set((s) => ({
            flistArchive: {
              ...s.flistArchive,
              [cid]: {
                ...(s.flistArchive[cid] ?? {
                  live: null,
                  pullStatus: 'idle'
                }),
                zipBackups: r.backups,
                zipBackupsStatus: 'ready',
                zipBackupsError: null
              }
            }
          }))
        })
        .catch(() => {})
    } catch (err) {
      finalise(
        {
          phase: 'error',
          done: 1,
          failed: 1,
          errorMessage:
            err instanceof Error ? err.message : 'ZIP write failed'
        },
        false
      )
    }
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

  async flistOpenBrowseBackup(characterId, backupFilename) {
    const current = get().flistBrowseBackup
    if (
      current &&
      current.characterId === characterId &&
      current.filename === backupFilename &&
      current.status === 'ready'
    ) {
      return
    }
    // If a previous browse session is open, restore its state first so
    // the snapshot we stash below is "the user's real editor", not
    // "the previous backup we hijacked".
    if (current) {
      _restoreFromBrowse(get, set, current)
    }

    // Snapshot the user's current editor state so close-browse can put
    // it back exactly. Hijacking flistArchive[id].live is what lets us
    // route every existing Live-view tab + the preview pane through the
    // identical render path with zero per-tab refactors.
    const previousLive = get().flistArchive[characterId]?.live ?? null
    const previousViewingLive = get().flistViewingLive[characterId] === true

    set({
      flistBrowseBackup: {
        characterId,
        filename: backupFilename,
        status: 'loading',
        payload: null,
        error: null,
        previousLive,
        previousViewingLive
      }
    })

    let payload: Record<string, unknown>
    let kind: 'manual_single' | 'manual_bulk' | 'import' | 'scheduled' | 'unknown'
    let dateLabel: string
    try {
      const res = await api.flistZipBackupPayload(characterId, backupFilename)
      // The user may have switched away while we were loading. Don't
      // overwrite a different target.
      const inflight = get().flistBrowseBackup
      if (
        !inflight ||
        inflight.characterId !== characterId ||
        inflight.filename !== backupFilename
      ) {
        return
      }
      payload = res.payload
      kind = normaliseBackupKind(res.meta?.kind)
      dateLabel = formatBackupDateForBanner(backupFilename)
    } catch (err) {
      const inflight = get().flistBrowseBackup
      if (
        !inflight ||
        inflight.characterId !== characterId ||
        inflight.filename !== backupFilename
      ) {
        return
      }
      set({
        flistBrowseBackup: {
          characterId,
          filename: backupFilename,
          status: 'error',
          payload: null,
          error: err instanceof Error ? err.message : String(err),
          previousLive,
          previousViewingLive
        }
      })
      return
    }

    // The backup's working.json mostly matches live shape — both carry
    // the same {character, settings, infotags, kinks, custom_kinks,
    // images, inlines} container. seedWorkingFromLive() is defensive
    // about either shape, so reusing it on the backup payload Just
    // Works for the working-slot side. For the "fake live" entry in
    // the archive we feed the payload through verbatim so downstream
    // readers (ProfileFieldsPreview, KinksPane, PreviewPane inlines
    // resolution) see the same shape they always do.
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
      const patch: Partial<State> = {
        flistArchive: {
          ...s.flistArchive,
          [characterId]: {
            ...(s.flistArchive[characterId] ?? {
              pullStatus: 'idle'
            }),
            live: payload
          }
        },
        flistViewingLive: { ...s.flistViewingLive, [characterId]: true },
        editorReadOnly: true,
        flistBrowseBackup: {
          characterId,
          filename: backupFilename,
          status: 'ready',
          payload,
          error: null,
          kind,
          dateLabel,
          previousLive,
          previousViewingLive
        }
      }
      // The commit puts the Backup's description into the editor.
      if (s.flistActiveCharacterId === characterId) {
        patch.editorInlines = extractInlines(payload)
        patch.saveStatus = 'idle'
        patch.saveError = null
      }
      return patch
    })
  },

  flistCloseBrowseBackup() {
    const browse = get().flistBrowseBackup
    if (!browse) return
    _restoreFromBrowse(get, set, browse)
  },

  async flistDownloadZipBackup(characterId, backupFilename) {
    const dialog = window.workbench?.saveFileDialog
    const write = window.workbench?.writeFile
    if (!dialog || !write) return null
    let bytes: Uint8Array
    try {
      bytes = await api.flistZipBackupDownload(characterId, backupFilename)
    } catch (err) {
      console.error('[flist] backup download fetch failed:', err)
      return null
    }
    const path = await dialog({
      title: 'Download backup ZIP',
      defaultPath: backupFilename,
      filters: [
        { name: 'F-list backup', extensions: ['zip'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (!path) return null
    const ok = await write(path, bytes)
    if (!ok) return null
    return { path, bytes: bytes.length }
  },

  async flistRenameZipBackup(characterId, backupFilename, name) {
    let updated: FlistZipBackupEntry
    try {
      updated = await api.flistZipBackupRename(
        characterId,
        backupFilename,
        name
      )
    } catch (err) {
      console.error('[flist] backup rename failed:', err)
      return false
    }
    set((s) => {
      const slot = s.flistArchive[characterId]
      const list = slot?.zipBackups
      if (!list) return {}
      const nextList = list.map((b) =>
        b.filename === backupFilename ? updated : b
      )
      const patch: Partial<State> = {
        flistArchive: {
          ...s.flistArchive,
          [characterId]: { ...slot, zipBackups: nextList }
        }
      }
      // If the renamed backup is being browsed right now, refresh
      // the header banner copy in the same set call so the UI
      // doesn't flash through a stale label.
      if (
        s.flistBrowseBackup &&
        s.flistBrowseBackup.characterId === characterId &&
        s.flistBrowseBackup.filename === backupFilename
      ) {
        patch.flistBrowseBackup = {
          ...s.flistBrowseBackup,
          // dateLabel stays the same — only the user-facing name
          // changed. We don't store the name in flistBrowseBackup
          // (the banner pulls it lazily from the archive list via a
          // selector) so no further update is needed here.
        }
      }
      return patch
    })
    return true
  },

  async flistDeleteZipBackup(characterId, backupFilename) {
    try {
      await api.flistZipBackupDelete(characterId, backupFilename)
    } catch (err) {
      console.error('[flist] backup delete failed:', err)
      return false
    }
    // If we were browsing the now-deleted backup, exit browse mode
    // before the list refresh so the editor doesn't keep rendering
    // bytes that no longer exist on disk.
    const browse = get().flistBrowseBackup
    if (
      browse &&
      browse.characterId === characterId &&
      browse.filename === backupFilename
    ) {
      get().flistCloseBrowseBackup()
    }
    // Optimistic local update: drop the row immediately so the
    // sidebar feels snappy. Then reload archive to reconcile (handles
    // the rare race where another window restored the file).
    set((s) => {
      const slot = s.flistArchive[characterId]
      if (!slot?.zipBackups) return {}
      return {
        flistArchive: {
          ...s.flistArchive,
          [characterId]: {
            ...slot,
            zipBackups: slot.zipBackups.filter(
              (b) => b.filename !== backupFilename
            )
          }
        }
      }
    })
    void get().flistLoadArchive(characterId)
    return true
  },

  flistDismissDriftBanner(characterId) {
    set((s) => {
      if (!s.flistDriftBanners[characterId]) return {}
      const next = { ...s.flistDriftBanners }
      delete next[characterId]
      return { flistDriftBanners: next }
    })
  },

  // ---- mapping list -------------------------------------------------

  async flistLoadMapping(opts) {
    const status = get().flistMapping.status
    // Return the in-flight promise instead of resolving immediately
    // (QA P3-4) so callers can sequence reads of `flistMapping.payload`.
    if (status === 'loading' && !opts?.force && _mappingInflight) {
      return _mappingInflight
    }
    const epoch = _flistSessionEpoch
    set((s) => ({
      flistMapping: { ...s.flistMapping, status: 'loading', error: null }
    }))
    // Assigned once, after the closure that reads it is created.
    // eslint-disable-next-line prefer-const
    let resolvedPromise!: Promise<void>
    const work = (async () => {
      try {
        const payload = await api.flistMappingList({ force: opts?.force })
        if (epoch !== _flistSessionEpoch) return
        set({
          flistMapping: {
            status: 'ready',
            payload,
            etag: payload._etag ?? null,
            fetchedAt: payload._fetched_at ?? null,
            error: null
          }
        })
      } catch (err) {
        if (epoch !== _flistSessionEpoch) return
        const raw = err instanceof Error ? err.message : String(err)
        set((s) => ({
          flistMapping: { ...s.flistMapping, status: 'error', error: raw }
        }))
      } finally {
        if (_mappingInflight === resolvedPromise) {
          _mappingInflight = null
        }
      }
    })()
    resolvedPromise = work
    _mappingInflight = resolvedPromise
    return resolvedPromise
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

  async loadCharacters() {
    set({ charactersStatus: 'loading', charactersError: null })
    try {
      const { characters } = await api.characters()
      set({
        characters,
        charactersStatus: 'ready',
        activeCharacter: get().activeCharacter ?? characters[0]?.name ?? null
      })
    } catch (err) {
      set({
        charactersStatus: 'error',
        charactersError: err instanceof Error ? err.message : String(err)
      })
    }
  },

  selectCharacter(name) {
    // Picking a real character leaves the Foreign slot. What the slot
    // holds is kept, so going back to it shows the same profile again
    // without another F-list call.
    set({ activeCharacter: name, activePartner: null, foreignActive: false })
    // Close any open Browse-Backup view on a character pick — the
    // sidebar Backups list is now showing a different character's
    // archive, and the viewer body would otherwise still be on the
    // old character's backup (QA-S2 from the 2026-06-17 review).
    if (get().flistBrowseBackup) {
      set({ flistBrowseBackup: null })
    }
    if (!name) {
      set({ flistActiveCharacterId: null, editorReadOnly: false })
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
        try {
          localStorage.setItem(FLIST_LAST_CHAR_KEY, id)
        } catch {
          // ignore
        }
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
      set({ flistActiveCharacterId: null, editorReadOnly: false })
    }
  },

  markCharacterSeen(name) {
    const now = Date.now() / 1000
    set((s) => {
      const next = { ...s.charLastSeen, [name]: now }
      writeLastSeen(next)
      return { charLastSeen: next }
    })
  },

  setMode(mode) {
    set({ mode, crossSearchOpen: mode === 'logs' ? get().crossSearchOpen : false })
  },

  setCrossSearchOpen(open) {
    set({ crossSearchOpen: open })
  },

  // ---- foreign profile slot ----
  //
  // Read-only, in-memory, and pointedly not a character. None of these
  // actions touch flistActiveCharacterId, flistWorking or flistArchive,
  // which is what keeps every copy/backup/export path from having
  // anything to act on.

  foreignOpenSlot() {
    set({ foreignActive: true, mode: 'editor', crossSearchOpen: false })
  },

  foreignLeaveSlot() {
    set({ foreignActive: false })
  },

  foreignUnload() {
    // Emptying the slot is a newer pick too: a read still in flight
    // must not fill it again.
    _foreignLoadToken++
    set({
      foreignName: null,
      foreignProfile: null,
      foreignFromCache: false,
      foreignAgeSec: null,
      foreignStale: false,
      foreignRefreshError: null,
      foreignStatus: 'idle',
      foreignError: null
    })
  },

  async foreignLoad(name, refresh = false) {
    const clean = name.trim()
    if (!clean) return
    const token = ++_foreignLoadToken
    set({ foreignStatus: 'loading', foreignError: null, foreignActive: true })
    try {
      const res = await api.foreignProfile(clean, refresh)
      if (token !== _foreignLoadToken) return
      set({
        foreignName: res.name,
        foreignProfile: res.profile,
        foreignFromCache: res.from_cache,
        foreignAgeSec: res.age_sec,
        foreignStale: res.stale === true,
        foreignRefreshError: res.refresh_error ?? null,
        foreignStatus: 'ready',
        foreignError: null
      })
    } catch (err) {
      if (token !== _foreignLoadToken) return
      // The sidecar answers these with a code so the window can say
      // something useful instead of echoing an HTTP status at someone
      // who mistyped a name.
      // Any other code (flist_server_error, flist_unreachable, ...)
      // already comes with the sidecar's own words.
      const code = err instanceof RefusalError ? err.code : undefined
      const worded: Record<string, string> = {
        not_found:
          `F-list will not show "${clean}": there is no character by that name, ` +
          'or it was deleted, is private or blocks your account.',
        rate_limited: 'F-list is rate-limiting us. Give it a minute and try again.',
        not_signed_in: 'Your F-list session expired. Sign in again to look up profiles.'
      }
      const message = (code && worded[code]) || errorDetail(err)
      set({ foreignStatus: 'error', foreignError: message })
    }
  },

  async loadPartners(char) {
    set((s) => ({ partnersStatus: { ...s.partnersStatus, [char]: 'loading' } }))
    try {
      const { partners } = await api.partners(char)
      set((s) => ({
        partners: { ...s.partners, [char]: partners },
        partnersStatus: { ...s.partnersStatus, [char]: 'ready' }
      }))
    } catch {
      set((s) => ({
        partnersStatus: { ...s.partnersStatus, [char]: 'error' }
      }))
    }
  },

  selectPartner(name) {
    set({ activePartner: name, crossSearchOpen: false })
  },

  async loadMessages(char, partner, opts) {
    const key = partnerKey(char, partner)
    if (get().messagesStatus[key] === 'ready' && !opts?.force) return
    set((s) => ({
      messagesStatus: { ...s.messagesStatus, [key]: 'loading' },
      messagesError: { ...s.messagesError, [key]: null }
    }))
    try {
      const { messages } = await api.messages(char, partner)
      set((s) => ({
        messagesByPartner: { ...s.messagesByPartner, [key]: messages },
        messagesStatus: { ...s.messagesStatus, [key]: 'ready' }
      }))
    } catch (err) {
      set((s) => ({
        messagesStatus: { ...s.messagesStatus, [key]: 'error' },
        messagesError: {
          ...s.messagesError,
          [key]: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  // Drop the cached entry so the next loadMessages refetches. Used
  // after a multi-scope classify so the currently open conversation
  // doesn't show stale labels.
  invalidateMessages(char, partner) {
    const key = partnerKey(char, partner)
    set((s) => {
      const { [key]: _, ...byPartner } = s.messagesByPartner
      const { [key]: __, ...status } = s.messagesStatus
      void _
      void __
      return { messagesByPartner: byPartner, messagesStatus: status }
    })
  },

  noteSettingsChanged(fields) {
    set((s) => ({ settingsRevision: s.settingsRevision + 1 }))
    // The OOC threshold is applied when a Log is read, so the open
    // Log's Labels are only current after a re-read.
    const { activeCharacter: char, activePartner: partner } = get()
    if (fields.includes('labels.threshold_chars') && char && partner) {
      get().invalidateMessages(char, partner)
      void get().loadMessages(char, partner, { force: true })
    }
  },

  openIngest(scope, label, opts) {
    set({
      ingestTarget: { scope, label, forceRewipe: opts?.forceRewipe ?? false }
    })
  },

  closeIngest() {
    set({ ingestTarget: null })
  },

  noteIndexChanged() {
    set((s) => ({ indexRevision: s.indexRevision + 1 }))
  },

  noteLabelsChanged() {
    set((s) => ({ labelsRevision: s.labelsRevision + 1 }))
  },

  // Patches one message's label fields in place, or those of every
  // message in a set of hashes (the log view's multi-select) in the same
  // single pass over the conversation. `patch === null`
  // clears label fields back to rule/Unlabeled resolution — but since
  // the resolver runs server-side, we approximate locally by removing
  // label_source and falling back to the rule the renderer can compute
  // (or 'Unlabeled' if unknown). The next loadMessages refresh
  // re-resolves from the sidecar authoritatively.
  applyLabelOverride(char, partner, hash, patch) {
    const key = partnerKey(char, partner)
    const hit =
      typeof hash === 'string' ? (h: string) => h === hash : (h: string) => hash.has(h)
    set((s) => {
      const list = s.messagesByPartner[key]
      if (!list) return s
      const next = list.map((m) => {
        if (!hit(m.hash)) return m
        if (patch === null) {
          const { label_source, ...rest } = m
          void label_source
          // Drop the explicit label so the UI treats it as needing
          // rule recomputation; the resolver re-runs on next fetch.
          return { ...rest, label: undefined }
        }
        return {
          ...m,
          label: patch.label ?? m.label,
          label_source: patch.label_source ?? m.label_source
        }
      })
      return { messagesByPartner: { ...s.messagesByPartner, [key]: next } }
    })
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

  setEditorActiveTab(tab) {
    if (get().editorActiveTab === tab) return
    set({ editorActiveTab: tab })
  },

  setEditorViewMode(mode) {
    if (get().editorViewMode === mode) return
    set({ editorViewMode: mode })
    try {
      localStorage.setItem('flist-workbench:editor-view-mode', mode)
    } catch {
      // ignore
    }
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
  },

}))

function humanizeFetchError(err: unknown, name: string): string {
  const raw = err instanceof Error ? err.message : String(err)
  // 401 — JSON API path now requires sign-in. Surface a clear CTA.
  if (/HTTP 401/.test(raw)) {
    return 'Sign in to F-list to fetch profiles. Click the chip in the sidebar.'
  }
  // 404 from the sidecar — F-list said "no such character".
  if (/HTTP 404/.test(raw)) return `No character named "${name}" on F-list.`
  // Network reach failures: fetch throws "Failed to fetch" / "TypeError"
  // on the renderer side when the sidecar is down.
  if (/Failed to fetch|NetworkError|ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(raw)) {
    return "Can't reach the app's sidecar. Restart the app and try again."
  }
  if (/HTTP 5\d\d/.test(raw)) return 'F-list is having trouble right now. Try again in a moment.'
  if (/HTTP 4\d\d/.test(raw)) return `F-list refused that name (${errorDetail(err)}).`
  return raw
}
