import { create } from 'zustand'
import {
  api,
  type AiDraft,
  type AiDraftEdit,
  type AssistantChatMessage,
  type AssistantToolEvent,
  type PromptPreset,
  type CharacterEntry,
  type FlistAccountCharacter,
  type FlistSnapshotEntry,
  type FlistZipBackupEntry,
  type FlistCharacterImage,
  type FlistRosterEntry,
  type FlistSessionStatus,
  type InlineImage,
  type LogMessage,
  type PartnerEntry,
  type SetMetaWire
} from './lib/api'
import {
  DESCRIPTION_PATH,
  applyEdit as flistApplyEdit,
  applyReset as flistApplyReset,
  descriptionOf,
  detectLiveDrift,
  emptyWorkingSlot,
  extractInlines as flistExtractInlines,
  isInfotagPath,
  normaliseNewlines as flistNormaliseNewlines,
  pathLookup,
  seedWorkingFromLive,
  selectWorkingSlot as flistSelectWorkingSlot,
  WORKING_SCHEMA_VERSION,
  type FlistImportOutcome,
  type FlistSaveStatus,
  type FlistWorkingSlot,
  type SetMeta,
  type WorkingPayload
} from './state/flist'

export type {
  FlistImportOutcome,
  FlistSaveStatus,
  FlistWorkingSlot,
  SetMeta,
  WorkingPayload
} from './state/flist'

export { selectWorkingSlot } from './state/flist'

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

  partners: Record<string, PartnerEntry[]>
  partnersStatus: Record<string, 'loading' | 'ready' | 'error'>

  activePartner: string | null

  /** When set, a Classify-labels progress dialog is open over the app. */
  classifyTarget: { scope: { character?: string | null; partner?: string | null }; label: string } | null

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

  /** Visibility of the RAG chat panel beside the Log Viewer. */
  chatPanelOpen: boolean
  /** Bumped any time something wants the chat input focused — e.g. the
   *  "Chat with this log" context-menu action. ChatPanel watches it. */
  chatFocusNonce: number

  // ---- AI Assistant (Phase 9) -----------------------------------
  /** Mirror of sidecar `settings.ai_assistant.enabled`. Default false
   *  so the feature is opt-in and the Tools menu hides the entry
   *  until the user flips the master toggle in Settings. Loaded from
   *  /settings on app start and after every PUT. */
  aiAssistantEnabled: boolean
  /** Session toggle for the bottom-dock chat row. Gated on
   *  `aiAssistantEnabled` — flipping the master toggle off closes
   *  the pane in the same reducer step. */
  aiAssistantPaneOpen: boolean
  /** Local-only transcript driving the chat history sent to /assistant/chat.
   *  Sidecar is stateless on history — the renderer sends the whole
   *  list each turn. Cleared on character switch + on pane close. */
  aiAssistantTranscript: AssistantChatMessage[]
  /** Per-character pending draft. Loaded lazily when the pane opens
   *  or when the chat endpoint emits a draft_update event. */
  aiAssistantDrafts: Record<string, AiDraft | null>
  /** True while a /assistant/chat stream is in flight. UI uses it to
   *  show a typing indicator + disable the send button. */
  aiAssistantStreaming: boolean
  /** Last error string surfaced from the chat stream (transport or
   *  loop-cap). Cleared on next successful turn. */
  aiAssistantLastError: string | null
  /** Abort handle on the currently-streaming /assistant/chat turn.
   *  A new send or pane-close aborts the prior request so its late
   *  draft_update events can't mutate state under the next turn. */
  aiAssistantInflight: AbortController | null
  /** Per-turn tool activity, keyed by transcript index of the
   *  assistant message that the events belong to. Lets the
   *  TranscriptRow render visible chips for every tool the model
   *  called + its outcome — silent rejections were the #1 reason
   *  users couldn't tell why edits "weren't landing" in early
   *  smoke-testing (2026-06-20). */
  aiAssistantToolEvents: Record<number, AssistantToolEvent[]>
  /** Shipped prompt presets from /settings — used by the in-chat
   *  preset switcher above the input bar. Loaded once at app start
   *  and refreshed after every Save in Settings. */
  aiAssistantPromptPresets: PromptPreset[]
  /** Live system prompt body (mirror of `ai_assistant.system_prompt`
   *  from /settings). Used by the in-chat preset switcher to highlight
   *  which preset is active. */
  aiAssistantSystemPrompt: string
  /** Pending "scroll the log viewer to this timestamp range" intent
   *  raised by a clicked citation. LogViewer consumes & clears it. */
  logJump:
    | { character: string; partner: string; ts_start: number; ts_end: number; nonce: number }
    | null

  messagesByPartner: Record<string, LogMessage[]>
  messagesStatus: Record<string, 'loading' | 'ready' | 'error'>
  messagesError: Record<string, string | null>

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
      /** JSON-snapshot history (the auto-on-pull forever-history). */
      snapshots: FlistSnapshotEntry[]
      /** ZIP-backup files in `characters/<id>/backups/`, newest first.
       *  Distinct from snapshots: backups are explicit user-driven
       *  archives (Tools → Back up all sweep + per-character right-
       *  click → Back up now); snapshots are auto-on-pull JSON. The
       *  Backups sidebar list reads from this slot. `undefined` means
       *  "not yet loaded for this character"; an empty array means
       *  "loaded, none exist". */
      zipBackups?: FlistZipBackupEntry[]
      zipBackupsStatus?: 'idle' | 'loading' | 'ready' | 'error'
      zipBackupsError?: string | null
      pullStatus: 'idle' | 'queued' | 'running' | 'done' | 'error'
      pullStage?: string
      pullProgress?: { done: number; total: number }
      pullError?: string | null
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
     *              common error is HTTP 410 — backup predates the
     *              Browse-support write that bundles working.json
     *              into the ZIP. */
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
    previousActiveSetId: string | null
    previousReadOnly: boolean
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
   *  TODO(working-sets v2): remove after consumer sweep — the editable
   *  slot now lives at `flistSetWorking[activeSetId]`, surfaced through
   *  `selectWorkingSlot`. This field stays as the back-compat mirror so
   *  the legacy Tier 2/3/4 actions still typecheck until that round. */
  flistWorking: Record<string, FlistWorkingSlot>
  flistWorkingLoadStatus: Record<string, 'idle' | 'loading' | 'ready' | 'error'>
  // ---- Working sets v2 ----
  /** Per-character ordered list of working-set metadata, sorted most-
   *  recently-updated first. Populated by `flistLoadSets`. */
  flistSets: Record<string, SetMeta[]>
  flistSetsStatus: Record<string, 'idle' | 'loading' | 'ready' | 'error'>
  /** Active working set per character. `null` = user is viewing the
   *  read-only F-list row (no editable slot). Mirrors the sidecar's
   *  `active_set.json`. */
  flistActiveSetId: Record<string, string | null>
  /** Per-set working slot, keyed by set id. The editor's edits land here
   *  via `flistSetWorkingMaterialise` + the autosave path. */
  flistSetWorking: Record<string, FlistWorkingSlot>
  flistSetWorkingLoadStatus: Record<string, 'idle' | 'loading' | 'ready' | 'error'>
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
    phase: 'idle' | 'running' | 'done' | 'error'
    total: number
    done: number
    saved: number
    unchanged: number
    failed: number
    currentName: string | null
    errorMessage: string | null
    /** Drives the banner's copy: 'manual_bulk' → "Backing up all
     *  characters…"; 'scheduled' → "Scheduled backup running…" so the
     *  user knows the post-sign-in nudge isn't a manual action. */
    kind: 'manual_bulk' | 'scheduled'
  }
  /** "F-list-side change in N fields since you started editing — review."
   *  Set after a Live re-pull when the new Live differs from what the
   *  working copy is showing on a path the user has NOT edited. Keyed
   *  by character id so per-character switches keep their own banner. */
  flistDriftBanners: Record<string, { paths: string[]; dismissedAt: number | null }>
  /** 5-second undo banner shown after "Reset to Live" or per-row reset.
   *  Stores the pre-delete snapshot for the Undo affordance. */
  flistResetUndo: {
    characterId: string
    snapshot: FlistWorkingSlot
    expiresAt: number
  } | null
  /** 5-second undo banner shown after a custom-kink tombstone. Single
   *  banner across both surfaces (single + bulk tombstone). Tier 3 §Step 8. */
  flistTombstoneUndo: {
    characterId: string
    snapshot: FlistWorkingSlot
    kinkIds: string[]
    expiresAt: number
  } | null
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
  loadPartners: (char: string) => Promise<void>
  selectPartner: (name: string | null) => void
  loadMessages: (char: string, partner: string, opts?: { force?: boolean }) => Promise<void>
  invalidateMessages: (char: string, partner: string) => void
  aiSetupOpen: boolean
  openAiSetup: () => void
  closeAiSetup: () => void
  openClassify: (
    scope: { character?: string | null; partner?: string | null },
    label: string
  ) => void
  closeClassify: () => void
  openIngest: (
    scope: { character?: string | null; partner?: string | null },
    label: string,
    opts?: { forceRewipe?: boolean }
  ) => void
  closeIngest: () => void
  toggleChatPanel: (force?: boolean) => void
  requestChatFocus: () => void

  // ---- AI Assistant (Phase 9) -----------------------------------
  setAiAssistantEnabled: (enabled: boolean) => void
  /** Mirror /settings.ai_assistant.prompt_presets + system_prompt
   *  into the store so the in-chat preset switcher has data to drive
   *  without a per-render API call. */
  setAiAssistantPromptConfig: (
    presets: PromptPreset[],
    systemPrompt: string
  ) => void
  /** Picks one of the shipped presets as the active system prompt.
   *  Persists via api.settingsUpdate so the next chat turn uses the
   *  new prompt. */
  setAiAssistantPromptBody: (body: string) => Promise<void>
  toggleAiAssistantPane: (force?: boolean) => void
  resetAiAssistantTranscript: () => void
  /** Drives one user turn through /assistant/chat.
   *  Appends the user message + assistant reply to the transcript;
   *  updates the draft slot as tool calls land. */
  sendAiAssistantTurn: (userMessage: string) => Promise<void>
  /** Pull the on-disk draft for `characterId` into state. Called on
   *  pane open + after every accept/reject round-trip. */
  loadAiAssistantDraft: (characterId: string) => Promise<void>
  acceptAiAssistantEdits: (
    characterId: string,
    editIds: string[]
  ) => Promise<void>
  rejectAiAssistantEdits: (
    characterId: string,
    editIds: string[]
  ) => Promise<void>
  discardAiAssistantDraft: (characterId: string) => Promise<void>
  requestLogJump: (
    character: string,
    partner: string,
    ts_start: number,
    ts_end: number
  ) => void
  clearLogJump: () => void
  applyLabelOverride: (
    char: string,
    partner: string,
    hash: string,
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
  flistPullCharacter: (name: string, characterId?: string | null) => Promise<void>
  /** Manual "Refresh all" — unconditionally pulls every account
   *  character on the current roster. Single-flight: triggering while
   *  a sweep is running (either this or the sign-in sweep) is a no-op. */
  flistRefreshAllAccount: () => Promise<void>
  flistSaveSnapshot: (characterId: string) => Promise<void>
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
  /** Permanently remove `images/<image_id>.<ext>` from disk. The only
   *  destructive action under v5; the renderer must wrap this in an
   *  explicit confirm dialog (the pool-delete affordance). Also drops
   *  the gallery row if the image happened to still be on-profile, so
   *  callers don't have to coordinate. */
  flistDeleteImage: (
    characterId: string,
    imageId: string
  ) => Promise<void>
  /** Append `imageId` to working.json's gallery (move pool→profile).
   *  No-op if the id is already in the gallery. */
  flistMoveImageToProfile: (
    characterId: string,
    imageId: string
  ) => void
  /** Drop `imageId` from working.json's gallery (move profile→pool).
   *  The file on disk stays — only flistDeleteImage removes bytes. */
  flistMoveImageToPool: (
    characterId: string,
    imageId: string
  ) => void
  flistSetGalleryImages: (
    characterId: string,
    images: { image_id: string; description: string; sort_order: number }[]
  ) => void
  flistOpenLive: (characterId: string) => Promise<void>
  flistOpenBackup: (characterId: string, filename: string) => Promise<void>
  /** Load the editor with this character's working copy.
   *  Falls back to the Live description when no working copy exists
   *  yet (materialise-on-first-edit, §1.6). The previous character's
   *  edits stay in `flistWorking` so a later switch-back restores them
   *  verbatim. */
  flistOpenWorking: (characterId: string) => Promise<void>
  flistGetLastAccount: () => string
  // ---- Working-sets v2 actions ----
  flistLoadSets: (characterId: string) => Promise<void>
  flistCreateSet: (characterId: string, name: string) => Promise<SetMeta | null>
  flistRenameSet: (
    characterId: string,
    setId: string,
    name: string
  ) => Promise<void>
  flistDuplicateSet: (
    characterId: string,
    setId: string,
    name: string
  ) => Promise<SetMeta | null>
  flistDeleteSet: (characterId: string, setId: string) => Promise<void>
  flistActivateSet: (characterId: string, setId: string) => Promise<void>
  flistActivateFromFlist: (characterId: string) => Promise<void>
  /** Export a working set as a Workbench-native bundle ZIP. Opens the
   *  native save dialog. Returns the bytes written and the chosen path
   *  on success; null when the user cancels or the IPC plumbing is
   *  unavailable (e.g. unit tests without an Electron host). */
  flistExportSet: (
    characterId: string,
    setId: string
  ) => Promise<{ path: string; bytes: number } | null>
  /** Pick a bundle ZIP from disk and create a new working set from it.
   *  Returns metadata about the imported set, or a discriminated result
   *  signalling cross-character-confirmation-needed so the caller can
   *  show the warning modal and call `flistConfirmCrossCharacterImport`
   *  to finish the import. */
  flistImportSet: (targetCharacterId: string) => Promise<FlistImportOutcome>
  /** Second leg of the cross-character handshake. Sends the same bytes
   *  back with `confirmCrossCharacter: true`. The bytes + auto-name are
   *  remembered in module-local state between the two calls so the
   *  modal doesn't need to thread them through. */
  flistConfirmCrossCharacterImport: () => Promise<FlistImportOutcome>
  /** Drop the cross-character handshake's pending bytes. Called when
   *  the user dismisses the warning modal — without it the bytes
   *  linger in module scope until the next import overwrites them,
   *  which is safe today but a footgun if any code path could fire
   *  `flistConfirmCrossCharacterImport` after the modal is closed. */
  flistCancelPendingImport: () => void
  /** Tools → "Back up all characters". Walks the signed-in account
   *  roster, pulls each character (JSON + images + avatar), and
   *  writes a userscript-restoreable ZIP per character. Single-flight:
   *  a second call while one is running is a no-op. */
  flistBackupAll: (opts?: {
    kind?: 'manual_bulk' | 'scheduled'
    source?: 'manual' | 'post_login'
  }) => Promise<void>
  /** After a successful F-list sign-in, check whether the
   *  scheduled-sweep clock has expired and (if so) kick off the
   *  pull-then-backup pipeline as a kind='scheduled' run. Pre-sign-in
   *  there's no F-list session to pull with, so we can't responsibly
   *  snapshot — the user wants backups to reflect *current* data,
   *  not whatever stale cache was on disk. Idempotent: safe to call
   *  on every sign-in; if not due, returns without doing anything. */
  flistMaybeRunScheduledSweep: () => Promise<boolean>
  /** Right-click → "Back up now" on a single character row. Pulls
   *  the character (full, with images), then forces a ZIP backup write
   *  to `characters/<id>/backups/<ISO>.zip`. Uses the same Backup-all
   *  banner UI so the user sees progress, with `total: 1`. */
  flistBackupCharacter: (name: string) => Promise<void>
  flistSetWorkingMaterialise: (
    characterId: string,
    setId: string
  ) => Promise<void>
  flistSetWorkingFlushPending: (
    characterId: string,
    setId: string
  ) => Promise<void>

  // ---- Tier 2 working-copy actions ----
  flistLoadWorking: (characterId: string) => Promise<void>
  flistSetWorkingField: (characterId: string, path: string, value: unknown) => void
  flistResetWorkingField: (characterId: string, path: string) => void
  /** Restore a single image row in working.json's gallery to match Live —
   *  add/remove/update the entry for `imageId` so working aligns with
   *  Live for that one image, leaving other gallery edits intact. */
  flistResetImageRow: (characterId: string, imageId: string) => void
  flistFlushWorking: (characterId: string) => Promise<void>
  flistResetWorkingToLive: (characterId: string) => Promise<void>
  flistUndoResetWorking: () => Promise<void>
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
  flistUndoTombstone: () => void
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
  /** Tier 4 — reset working copy to a chosen backup payload.
   *  Re-uses Tier 2's reset-undo banner so the 5-second undo flow is
   *  consistent across reset sources. */
  flistResetWorkingToBackup: (
    characterId: string,
    backupFilename: string
  ) => Promise<void>

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
  /** Right-click → Delete backup on a Backups row. Callers should
   *  funnel through a confirm modal — there's no undo in the sidecar
   *  (the bytes are gone). Refreshes the sidebar list on success.
   *  If the deleted backup is currently being browsed, also closes
   *  browse mode so the editor doesn't display data that no longer
   *  exists on disk. */
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
  /** Right-click → Create working set from backup. Pulls the
   *  backup ZIP from the sidecar, then pipes the bytes through the
   *  same import path the user-facing "Import working set" flow
   *  uses. Result: a new working set named after the backup's
   *  timestamp, ready to edit. Cross-character handshake is bypassed
   *  by design — the backup belongs to the same character whose
   *  archive we're listing. */
  flistCreateSetFromBackup: (
    characterId: string,
    backupFilename: string
  ) => Promise<{ setId: string; setName: string } | null>

}

function partnerKey(char: string, partner: string): string {
  return `${char}::${partner}`
}

// Reset-undo banner lives 5 seconds. Stored in module scope so the
// timer can be cleared on user dismiss or character switch without
// growing the store with timer ids.
const _resetUndoTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Tombstone-undo timer is single-banner (vs per-character) since the
// UI surfaces one toast at a time across both surfaces.
let _tombstoneUndoTimer: ReturnType<typeof setTimeout> | null = null
const RESET_UNDO_MS = 5_000

// Per-character autosave debouncers (Tier 2 §1.5 — 500 ms quiet time).
// Keyed by character id so per-character switches don't race.
const _autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Per-character in-flight flush promise. Ensures overlapping calls to
// flistFlushWorking serialise per character so a later flush can't
// race a still-running PUT and "succeed" on a stale payload (QA P1-4).
const _flushInflight = new Map<string, Promise<void>>()
const AUTOSAVE_DEBOUNCE_MS = 500

// Working-sets v2: autosave debouncer + single-flight, keyed by **set id**
// rather than character id. Multiple sets can be open simultaneously in
// memory; their writes are independent so the debounce + serialisation
// guarantees apply per-set.
const _setAutosaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const _setFlushInflight = new Map<string, Promise<void>>()

function _scheduleFlush(characterId: string, fn: () => void): void {
  const prev = _autosaveTimers.get(characterId)
  if (prev) clearTimeout(prev)
  const t = setTimeout(() => {
    _autosaveTimers.delete(characterId)
    fn()
  }, AUTOSAVE_DEBOUNCE_MS)
  _autosaveTimers.set(characterId, t)
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
  for (const [, t] of _setAutosaveTimers) clearTimeout(t)
  _setAutosaveTimers.clear()
  for (const [, t] of _resetUndoTimers) clearTimeout(t)
  _resetUndoTimers.clear()
  if (_tombstoneUndoTimer) {
    clearTimeout(_tombstoneUndoTimer)
    _tombstoneUndoTimer = null
  }
}

function _scheduleSetFlush(setId: string, fn: () => void): void {
  const prev = _setAutosaveTimers.get(setId)
  if (prev) clearTimeout(prev)
  const t = setTimeout(() => {
    _setAutosaveTimers.delete(setId)
    fn()
  }, AUTOSAVE_DEBOUNCE_MS)
  _setAutosaveTimers.set(setId, t)
}

function _cancelSetFlush(setId: string): void {
  const prev = _setAutosaveTimers.get(setId)
  if (prev) {
    clearTimeout(prev)
    _setAutosaveTimers.delete(setId)
  }
}

// Tracks whether an account-wide sweep is in flight. Shared between
// the sign-in auto-refresh and the picker's manual "↻ Refresh all",
// so a second trigger while one is running is a no-op rather than
// stacking two passes onto pull_lock.
let _flistAccountSweepInFlight = false

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
      if (thresholdSec !== null) {
        const age =
          t.lastPulledAt === null
            ? Number.POSITIVE_INFINITY
            : now - t.lastPulledAt
        if (age < thresholdSec) continue
      }
      // selectCharacter would change the active character; we want
      // a silent background refresh, so go straight to the pull.
      // The pull endpoint's pull_lock serialises us behind any
      // manual single-character ↻ Refresh the user kicked off.
      try {
        await get().flistPullCharacter(t.name, t.id)
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

/** Convert a wire-format SetMeta to in-memory camelCase. Single converter
 *  so the wire-vs-memory boundary lives in one place. */
function _setMetaFromWire(wire: SetMetaWire): SetMeta {
  return {
    id: wire.id,
    name: wire.name,
    createdAt: wire.created_at,
    updatedAt: wire.updated_at
  }
}

// In-flight mapping-list promise (QA P3-4): callers awaiting an
// already-running flistLoadMapping get the same promise back so they
// can sequence their work after `payload` is populated.
let _mappingInflight: Promise<void> | null = null

// Monotonic session counter bumped on sign-in / sign-out (QA P2-4).
// Mapping-list responses that arrive after a session change are
// discarded so a prior account's data can't be reinstated.
let _flistSessionEpoch = 0

// Cross-character import handshake state. The first POST sees the
// 422-with-source response and stashes the bytes + name + target here;
// the second leg (`flistConfirmCrossCharacterImport`) sends the same
// payload back with `confirmCrossCharacter: true`. Kept in module
// scope so the renderer's modal can fire the confirm action without
// re-prompting the file dialog. Cleared on success/cancel/error.
let _pendingCrossCharImport: {
  targetCharacterId: string
  zipBytes: Uint8Array
  name: string
} | null = null

function _defaultImportedSetName(existing: SetMeta[]): string {
  const used = new Set(existing.map((s) => s.name))
  let n = 1
  while (used.has(`Imported set ${n}`)) n++
  return `Imported set ${n}`
}

/** Apply N tombstones in a single reducer pass — keeps the bulk action
 *  cheap even for large selections and ensures one slot mutation lands
 *  per click rather than N (QA P1-2 / P2-6). */
function _applyTombstones(
  characterId: string,
  kinkIds: string[],
  setFn: (
    update:
      | Partial<State>
      | ((s: State) => Partial<State> | State)
  ) => void
): void {
  setFn((s) => {
    const slot = s.flistWorking[characterId]
    if (!slot) return {}
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
    return {
      flistWorking: {
        ...s.flistWorking,
        [characterId]: {
          ...slot,
          payload,
          overlay,
          unsavedDirty: true,
          saveStatus: 'idle',
          saveError: slot.saveError
        }
      }
    }
  })
}

/** Arm the 5-second tombstone undo banner. Captures `prevSlot` so undo
 *  restores the pre-delete payload + overlay exactly (Tier 3 §Step 8). */
function _armTombstoneUndo(
  characterId: string,
  prevSlot: FlistWorkingSlot,
  kinkIds: string[],
  setFn: (
    update:
      | Partial<State>
      | ((s: State) => Partial<State> | State)
  ) => void,
  getFn: () => State
): void {
  if (_tombstoneUndoTimer) {
    clearTimeout(_tombstoneUndoTimer)
    _tombstoneUndoTimer = null
  }
  const expiresAt = Date.now() + RESET_UNDO_MS
  setFn({
    flistTombstoneUndo: {
      characterId,
      snapshot: prevSlot,
      kinkIds: [...kinkIds],
      expiresAt
    }
  })
  _tombstoneUndoTimer = setTimeout(() => {
    _tombstoneUndoTimer = null
    const undo = getFn().flistTombstoneUndo
    if (undo && undo.expiresAt <= Date.now()) {
      setFn({ flistTombstoneUndo: null })
    }
  }, RESET_UNDO_MS + 50)
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

/** Restore the editor state stashed when the user entered Browse mode.
 *  Three exit paths depending on what they were doing before:
 *    - had a working set active     → re-activate it
 *    - was viewing From-F-list      → re-activate From-F-list
 *    - was editing (no set, !RO)    → put working-copy mode back
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
  const { characterId, previousLive, previousActiveSetId, previousReadOnly } = browse
  setter((s) => ({
    flistArchive: {
      ...s.flistArchive,
      [characterId]: {
        ...(s.flistArchive[characterId] ?? {
          snapshots: [],
          pullStatus: 'idle'
        }),
        live: previousLive
      }
    },
    flistBrowseBackup: null
  }))
  // Re-activate the user's previous mode. These three actions all
  // overwrite editorReadOnly + editorContent + editorInlines + the
  // working slot, so we don't need to undo any of that ourselves.
  if (previousActiveSetId !== null) {
    void getter().flistActivateSet(characterId, previousActiveSetId)
  } else if (previousReadOnly) {
    void getter().flistActivateFromFlist(characterId)
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

  partners: {},
  partnersStatus: {},
  activePartner: null,

  classifyTarget: null,
  aiSetupOpen: false,
  ingestTarget: null,
  chatPanelOpen: false,
  chatFocusNonce: 0,

  aiAssistantEnabled: false,
  aiAssistantPaneOpen: false,
  aiAssistantTranscript: [],
  aiAssistantDrafts: {},
  aiAssistantStreaming: false,
  aiAssistantLastError: null,
  aiAssistantInflight: null,
  aiAssistantToolEvents: {},
  aiAssistantPromptPresets: [],
  aiAssistantSystemPrompt: '',

  logJump: null,

  messagesByPartner: {},
  messagesStatus: {},
  messagesError: {},

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
  flistSets: {},
  flistSetsStatus: {},
  flistActiveSetId: {},
  flistSetWorking: {},
  flistSetWorkingLoadStatus: {},
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
    errorMessage: null,
    kind: 'manual_bulk'
  },
  flistDriftBanners: {},
  flistResetUndo: null,
  flistTombstoneUndo: null,
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

  flistGetLastAccount() {
    // Saved-creds account wins when present so the sign-in modal
    // pre-fills the username the user explicitly chose to remember.
    // Falls back to the localStorage last-used account otherwise.
    const saved = useStore.getState().flistSavedCreds.account
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
      const remember = !!opts?.rememberPassword || !!opts?.autoLogin
      const autoLogin = !!opts?.autoLogin
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
      // Post-login scheduled-backup sweep first — its backup-all
      // pulls every character (with images) and is a superset of
      // what _flistAutoRefreshOnLogin does, so when the sweep is
      // going to fire there's no point queueing a separate
      // partial-refresh pass. Snapshots reflect *current* F-list
      // data because backup-all does the pull before snapshotting.
      const sweepStarted = await get().flistMaybeRunScheduledSweep()
      if (!sweepStarted) {
        // Auto-refresh: walk the roster and queue a background pull
        // for every account character whose local copy is older than
        // the user's configured threshold (Settings → F-list). 0
        // minutes = always re-pull. The picker's per-row badges show
        // progress; pull_lock serialises so a manual ↻ Refresh
        // interleaves cleanly. Fire-and-forget.
        void _flistAutoRefreshOnLogin(get)
      }
    } catch (err) {
      // F-list returns the human-readable error in `detail`; the
      // request() helper folds it into `HTTP 401: <detail>`. Strip the
      // prefix so the modal shows "Invalid account name or password"
      // instead of "HTTP 401: Invalid account name or password".
      const raw = err instanceof Error ? err.message : String(err)
      const stripped = raw.replace(/^HTTP \d+:\s*/, '')
      set({ flistSignInStatus: 'error', flistSignInError: stripped })
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
    // Abort any in-flight pull BEFORE clearing the ticket so the
    // sidecar's producer task doesn't keep writing live.json + image
    // bytes against a torn-down session. The pull-lock and httpx
    // client clean up via the producer's try/finally on disconnect.
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
    set({
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
      flistWorking: {},
      flistWorkingLoadStatus: {},
      flistSets: {},
      flistSetsStatus: {},
      flistActiveSetId: {},
      flistSetWorking: {},
      flistSetWorkingLoadStatus: {},
      flistDriftBanners: {},
      flistResetUndo: null,
      flistDiffRightSource: {},
      flistDiffBackupCache: {},
      flistDiffBackupStatus: {},
      flistCustomKinksUI: {}
    })
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
            snapshots: [],
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
          snapshots: [],
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
            snapshots: [],
            pullStatus: 'idle'
          }),
          zipBackupsStatus: 'loading',
          zipBackupsError: null
        }
      }
    }))
    const [live, snapshots, zipBackupsResult] = await Promise.all([
      api.flistLive(characterId).catch(() => null),
      api
        .flistSnapshots(characterId)
        .then((r) => r.snapshots)
        .catch(() => []),
      api
        .flistZipBackups(characterId)
        .then((r) => ({ ok: true as const, backups: r.backups }))
        .catch((err: unknown) => ({
          ok: false as const,
          error: err instanceof Error ? err.message : String(err)
        }))
    ])
    set((s) => ({
      flistArchive: {
        ...s.flistArchive,
        [characterId]: {
          ...(s.flistArchive[characterId] ?? { pullStatus: 'idle' }),
          live,
          snapshots,
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

  async flistPullCharacter(name, characterId) {
    const targetId = characterId ?? null
    const setStatus = (
      patch: Partial<{
        pullStatus: 'idle' | 'queued' | 'running' | 'done' | 'error'
        pullStage: string
        pullProgress: { done: number; total: number }
        pullError: string | null
      }>
    ) => {
      if (!targetId) return
      set((s) => ({
        flistArchive: {
          ...s.flistArchive,
          [targetId]: {
            ...(s.flistArchive[targetId] ?? {
              live: null,
              snapshots: [],
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
      await api.flistPull(name, {
        onQueued: () => setStatus({ pullStatus: 'queued', pullStage: 'queued' }),
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
                  snapshots: [],
                  pullStatus: 'idle'
                }),
                pullStatus: 'done',
                pullStage: 'done'
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
              set((s) => {
                const next = { ...s.flistWorking }
                delete next[info.character_id]
                return { flistWorking: next }
              })
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
          }
        },
        onError: ({ message }) => {
          setStatus({ pullStatus: 'error', pullError: message })
        }
      }, { signal: ctrl.signal })
    } catch (err) {
      // AbortError = user-initiated (sign-out / explicit cancel).
      // Don't surface as a scary error to the user.
      const raw = err instanceof Error ? err.message : String(err)
      if (err instanceof Error && err.name === 'AbortError') {
        setStatus({ pullStatus: 'idle', pullError: null })
      } else {
        setStatus({ pullStatus: 'error', pullError: raw })
      }
    } finally {
      if (get().flistPullAbortController === ctrl) {
        set({ flistPullAbortController: null })
      }
    }
  },

  async flistSaveSnapshot(characterId) {
    try {
      await api.flistSaveSnapshot(characterId)
      await get().flistLoadArchive(characterId)
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      set((s) => ({
        flistArchive: {
          ...s.flistArchive,
          [characterId]: {
            ...(s.flistArchive[characterId] ?? {
              live: null,
              snapshots: [],
              pullStatus: 'idle'
            }),
            pullError: raw
          }
        }
      }))
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

  async flistDeleteImage(characterId, imageId) {
    await api.flistImageRemove(characterId, imageId).catch(() => null)
    set((s) => {
      const prev = s.flistCharacterImages[characterId]
      if (!prev) return {}
      const nextById = { ...prev.byId }
      delete nextById[imageId]
      return {
        flistCharacterImages: {
          ...s.flistCharacterImages,
          [characterId]: { byId: nextById, status: prev.status }
        }
      }
    })
    const slot = get().flistWorking[characterId]
    if (!slot) return
    const images = Array.isArray((slot.payload as { images?: unknown }).images)
      ? ((slot.payload as { images: { image_id: string; description: string; sort_order: number }[] }).images)
      : []
    if (!images.some((e) => e.image_id === imageId)) return
    get().flistSetGalleryImages(
      characterId,
      images.filter((e) => e.image_id !== imageId)
    )
  },

  flistMoveImageToProfile(characterId, imageId) {
    const slot = get().flistWorking[characterId]
    if (!slot) return
    const images = Array.isArray((slot.payload as { images?: unknown }).images)
      ? ((slot.payload as { images: { image_id: string; description: string; sort_order: number }[] }).images)
      : []
    if (images.some((e) => e.image_id === imageId)) return
    const nextOrder =
      images.length === 0
        ? 0
        : Math.max(...images.map((e) => e.sort_order)) + 1
    get().flistSetGalleryImages(characterId, [
      ...images,
      { image_id: imageId, description: '', sort_order: nextOrder }
    ])
  },

  flistMoveImageToPool(characterId, imageId) {
    const slot = get().flistWorking[characterId]
    if (!slot) return
    const images = Array.isArray((slot.payload as { images?: unknown }).images)
      ? ((slot.payload as { images: { image_id: string; description: string; sort_order: number }[] }).images)
      : []
    if (!images.some((e) => e.image_id === imageId)) return
    get().flistSetGalleryImages(
      characterId,
      images.filter((e) => e.image_id !== imageId)
    )
  },

  flistSetGalleryImages(characterId, images) {
    set((s) => {
      const slot = s.flistWorking[characterId]
      if (!slot) return {}
      const payload = { ...slot.payload, images }
      const overlay = slot.overlay.includes('images')
        ? slot.overlay
        : [...slot.overlay, 'images']
      payload._overlay = [...overlay]
      return {
        flistWorking: {
          ...s.flistWorking,
          [characterId]: {
            ...slot,
            payload,
            overlay,
            unsavedDirty: true,
            saveStatus: 'idle',
            saveError: slot.saveError
          }
        }
      }
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

  async flistOpenBackup(characterId, filename) {
    const payload = await api.flistSnapshotRead(characterId, filename).catch(() => null)
    if (!payload) return
    const character = (payload.character ?? payload) as Record<string, unknown>
    const name =
      (typeof character.name === 'string' && character.name) || 'Backup'
    const rawBbcode =
      (typeof character.description === 'string' && (character.description as string)) ||
      ''
    set({
      editorContent: normaliseNewlines(rawBbcode),
      editorTitle: `${name} — ${filename}`,
      editorInlines: extractInlines(payload),
      editorReadOnly: true,
      editorDirty: false,
      saveStatus: 'idle',
      saveError: null,
      draftStatus: 'idle'
    })
  },

  async flistOpenWorking(characterId) {
    // Ensure Live is loaded into flistArchive BEFORE we ask
    // flistLoadWorking to handle a 404 — its seed-from-Live branch
    // reads from flistArchive, so a race against the loader produces
    // an empty `character` block and the first edit ships a bare
    // payload (QA P1-3).
    let archive = get().flistArchive[characterId]
    if (!archive || archive.live === null) {
      const fetched = await api.flistLive(characterId).catch(() => null)
      if (fetched) {
        set((s) => ({
          flistArchive: {
            ...s.flistArchive,
            [characterId]: {
              ...(s.flistArchive[characterId] ?? {
                live: null,
                snapshots: [],
                pullStatus: 'idle'
              }),
              live: fetched as Record<string, unknown>
            }
          }
        }))
        archive = get().flistArchive[characterId]
      }
    }
    // Load the persisted working copy. On 404 the slot is seeded from
    // Live in memory but not flushed to disk — first edit then PUTs
    // (Tier 2 §1.6 materialise-on-first-edit).
    await get().flistLoadWorking(characterId)
    const slot = get().flistWorking[characterId]
    const live = archive?.live ?? null
    const inlines: Record<string, InlineImage> = live ? flistExtractInlines(live) : {}
    const content = slot ? descriptionOf(slot.payload) : ''
    const entry = get().flistRoster.find((r) => String(r.id ?? '') === characterId)
    const name = entry?.name ?? 'My edits'
    const titleSuffix = slot?.unsavedDirty ? ' (unsaved)' : ''
    set({
      editorContent: content,
      editorTitle: `${name} — My edits${titleSuffix}`,
      editorInlines: inlines,
      editorReadOnly: false,
      editorDirty: !!slot?.unsavedDirty,
      saveStatus: 'idle',
      saveError: null,
      draftStatus: 'idle'
    })
  },

  // ---- Tier 2 working-copy persistence ------------------------------

  async flistLoadWorking(characterId) {
    set((s) => ({
      flistWorkingLoadStatus: { ...s.flistWorkingLoadStatus, [characterId]: 'loading' }
    }))
    try {
      const { payload, etag } = await api.flistWorkingRead(characterId)
      const overlay = Array.isArray((payload as WorkingPayload)._overlay)
        ? ((payload as WorkingPayload)._overlay as string[])
        : []
      // A v3 file migrated to v4 has its sha-keyed `images` stripped
      // (sidecar can't translate without re-querying F-list). Backfill
      // the gallery from live.json so the user doesn't see an empty
      // pane after upgrading.
      const workingPayload = payload as WorkingPayload
      const images = (workingPayload as { images?: unknown }).images
      if (!Array.isArray(images) || images.length === 0) {
        const live = get().flistArchive[characterId]?.live ?? null
        if (live) {
          const seeded = seedWorkingFromLive(live)
          if (Array.isArray(seeded.images) && seeded.images.length > 0) {
            workingPayload.images = seeded.images
          }
        }
      }
      const slot: FlistWorkingSlot = {
        payload: workingPayload,
        overlay,
        etag,
        unsavedDirty: false,
        saveStatus: 'idle',
        saveError: null,
        lastSavedAt: null,
        materialised: true
      }
      set((s) => ({
        flistWorking: { ...s.flistWorking, [characterId]: slot },
        flistWorkingLoadStatus: {
          ...s.flistWorkingLoadStatus,
          [characterId]: 'ready'
        }
      }))
    } catch (err) {
      const isHttp404 =
        err instanceof Error && /HTTP 404/.test(err.message)
      if (isHttp404) {
        // First-open: seed from Live (materialise-on-first-edit). Live
        // may itself be missing — caller (flistOpenWorking) tolerates.
        const live = get().flistArchive[characterId]?.live ?? null
        const seeded = live ? seedWorkingFromLive(live) : { ...emptyWorkingSlot().payload }
        const slot: FlistWorkingSlot = {
          ...emptyWorkingSlot(),
          payload: seeded,
          materialised: false
        }
        set((s) => ({
          flistWorking: { ...s.flistWorking, [characterId]: slot },
          flistWorkingLoadStatus: {
            ...s.flistWorkingLoadStatus,
            [characterId]: 'ready'
          }
        }))
        return
      }
      set((s) => ({
        flistWorkingLoadStatus: {
          ...s.flistWorkingLoadStatus,
          [characterId]: 'error'
        }
      }))
    }
  },

  flistSetWorkingField(characterId, path, value) {
    set((s) => {
      const slot = s.flistWorking[characterId]
      if (!slot) return {}
      const next = flistApplyEdit(slot, path, value)
      return {
        flistWorking: { ...s.flistWorking, [characterId]: next }
      }
    })
    _scheduleFlush(characterId, () => {
      void get().flistFlushWorking(characterId)
    })
  },

  flistResetImageRow(characterId, imageId) {
    set((s) => {
      const slot = s.flistWorking[characterId]
      if (!slot) return {}
      const live = s.flistArchive[characterId]?.live ?? null
      type GalleryRow = { image_id: string; description: string; sort_order: number }
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
      const payload = { ...slot.payload, images: renumbered }
      const overlay = slot.overlay.includes('images')
        ? slot.overlay
        : [...slot.overlay, 'images']
      payload._overlay = [...overlay]
      return {
        flistWorking: {
          ...s.flistWorking,
          [characterId]: {
            ...slot,
            payload,
            overlay,
            unsavedDirty: true,
            saveStatus: 'idle',
            saveError: slot.saveError
          }
        }
      }
    })
    _scheduleFlush(characterId, () => {
      void get().flistFlushWorking(characterId)
    })
  },

  flistResetWorkingField(characterId, path) {
    set((s) => {
      const slot = s.flistWorking[characterId]
      if (!slot) return {}
      const live = s.flistArchive[characterId]?.live ?? null
      const next = flistApplyReset(slot, live, path)
      // If the reset path is the description, mirror back into the
      // editor surface so the open BBCode editor reflects the revert
      // without a re-render hop.
      const patch: Partial<State> = {
        flistWorking: { ...s.flistWorking, [characterId]: next }
      }
      const workingCopyMode =
        s.flistActiveCharacterId === characterId &&
        !s.editorReadOnly
      if (path === DESCRIPTION_PATH && workingCopyMode) {
        patch.editorContent = descriptionOf(next.payload)
        patch.editorDirty = next.unsavedDirty
      }
      return patch
    })
    _scheduleFlush(characterId, () => {
      void get().flistFlushWorking(characterId)
    })
  },

  async flistFlushWorking(characterId) {
    _cancelFlush(characterId)
    // Per-character single-flight: if a flush is already in progress,
    // chain after it. Otherwise the in-flight PUT could race a fresh
    // one carrying a newer payload — the older PUT could win, leaving
    // the user's later keystrokes unsaved while saveStatus shows 'saved'
    // (QA P1-4).
    const prior = _flushInflight.get(characterId)
    if (prior) {
      await prior.catch(() => {})
      // Re-cancel any debounce that may have re-armed during the wait
      // so we don't double-fire.
      _cancelFlush(characterId)
    }
    const slot = get().flistWorking[characterId]
    if (!slot || !slot.unsavedDirty) {
      // Second cancel post-early-return — a scheduleFlush may have armed
      // during the await above; we'd otherwise leave a stranded timer
      // (QA P3-3).
      _cancelFlush(characterId)
      return
    }
    // Working-sets v2: every PUT routes through the active set's payload
    // endpoint. When no set is active, the editor is in F-list read-only
    // mode; nothing to flush, so silently drop the schedule.
    const activeSetId = get().flistActiveSetId[characterId]
    if (!activeSetId) {
      _cancelFlush(characterId)
      return
    }
    const inflight = (async () => {
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
        const { etag } = await api.flistSetPayloadPut(
          characterId,
          activeSetId,
          sentPayload,
          slot.materialised ? slot.etag : null
        )
        set((s) => {
          const existing = s.flistWorking[characterId]
          if (!existing) return {}
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
            materialised: true
          }
          // Mirror into the per-set cache so any consumer reading
          // flistSetWorking[setId] sees the freshest payload, and bump
          // the set's updatedAt so the "last changed Xm ago" suffix refreshes.
          const setsList = s.flistSets[characterId] ?? []
          return {
            flistWorking: { ...s.flistWorking, [characterId]: nextSlot },
            flistSetWorking: {
              ...s.flistSetWorking,
              [activeSetId]: nextSlot
            },
            flistSets: {
              ...s.flistSets,
              [characterId]: setsList.map((m) =>
                m.id === activeSetId
                  ? { ...m, updatedAt: Math.floor(Date.now() / 1000) }
                  : m
              )
            }
          }
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
        const raw = err instanceof Error ? err.message : String(err)
        const conflict = err instanceof Error && err.message === 'etag_mismatch'
        const errWith = err as Error & { currentEtag?: string | null }
        set((s) => {
          const existing = s.flistWorking[characterId]
          if (!existing) return {}
          return {
            flistWorking: {
              ...s.flistWorking,
              [characterId]: {
                ...existing,
                saveStatus: 'error',
                saveError: conflict
                  ? 'Another window saved a different version. Reload to merge.'
                  : raw,
                etag: conflict
                  ? errWith.currentEtag ?? existing.etag
                  : existing.etag,
                unsavedDirty: true
              }
            }
          }
        })
      }
    })()
    _flushInflight.set(characterId, inflight)
    try {
      await inflight
    } finally {
      if (_flushInflight.get(characterId) === inflight) {
        _flushInflight.delete(characterId)
      }
    }
  },

  async flistResetWorkingToLive(characterId) {
    const slot = get().flistWorking[characterId]
    if (!slot) return
    _cancelFlush(characterId)
    // Drain any in-flight save before issuing the DELETE — otherwise a
    // mid-flight PUT (saveStatus === 'saving') could resurrect the
    // pre-reset payload after we've already cleared local state
    // (QA P2-3). Single-flight already chains here.
    const inflight = _flushInflight.get(characterId)
    if (inflight) {
      await inflight.catch(() => {})
    }
    // A still-newer-payload follow-up flush may have armed itself via
    // _scheduleFlush in the success branch of the drained PUT; cancel
    // that too or it would race ahead of our DELETE (Round 1 verifier).
    _cancelFlush(characterId)
    try {
      await api.flistWorkingDelete(characterId)
    } catch {
      // Best-effort — even if delete failed (race with another window),
      // dropping the in-memory slot still gives the user a recovery
      // path. Next flush will reconcile via If-Match.
    }
    // Stash the pre-delete snapshot for the 5s undo banner.
    const expiresAt = Date.now() + RESET_UNDO_MS
    set((s) => {
      const live = s.flistArchive[characterId]?.live ?? null
      const seeded = live ? seedWorkingFromLive(live) : emptyWorkingSlot().payload
      const fresh: FlistWorkingSlot = {
        ...emptyWorkingSlot(),
        payload: seeded,
        materialised: false
      }
      return {
        flistWorking: { ...s.flistWorking, [characterId]: fresh },
        flistResetUndo: { characterId, snapshot: slot, expiresAt }
      }
    })
    // Mirror the seeded description into the editor so the panel
    // immediately reflects the revert.
    const reloaded = get().flistWorking[characterId]
    if (
      reloaded &&
      get().flistActiveCharacterId === characterId &&
      !get().editorReadOnly
    ) {
      set({
        editorContent: descriptionOf(reloaded.payload),
        editorDirty: false
      })
    }
    const prev = _resetUndoTimers.get(characterId)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      _resetUndoTimers.delete(characterId)
      const undo = get().flistResetUndo
      if (undo && undo.characterId === characterId && undo.expiresAt <= Date.now()) {
        set({ flistResetUndo: null })
      }
    }, RESET_UNDO_MS + 50)
    _resetUndoTimers.set(characterId, t)
  },

  // ---- Working sets v2 ----------------------------------------------

  async flistLoadSets(characterId) {
    set((s) => ({
      flistSetsStatus: { ...s.flistSetsStatus, [characterId]: 'loading' }
    }))
    try {
      const wire = await api.flistSetsList(characterId)
      const sets = wire.sets.map(_setMetaFromWire)
      sets.sort((a, b) => b.updatedAt - a.updatedAt)
      set((s) => ({
        flistSets: { ...s.flistSets, [characterId]: sets },
        flistSetsStatus: { ...s.flistSetsStatus, [characterId]: 'ready' }
      }))
      // Drive the activate flow so the editor's view slot
      // (flistWorking[characterId]) lands in sync with the server-side
      // active_set.json — either an editable set or read-only live.
      if (wire.active_set_id) {
        // Clear the local pointer so flistActivateSet doesn't short-
        // circuit when char-switching and the prior session had this
        // same setId active.
        set((s) => ({
          flistActiveSetId: { ...s.flistActiveSetId, [characterId]: null }
        }))
        await get().flistActivateSet(characterId, wire.active_set_id)
      } else {
        await get().flistActivateFromFlist(characterId)
      }
    } catch {
      set((s) => ({
        flistSetsStatus: { ...s.flistSetsStatus, [characterId]: 'error' }
      }))
    }
  },

  async flistCreateSet(characterId, name) {
    try {
      const wire = await api.flistSetCreate(characterId, { name })
      const meta = _setMetaFromWire(wire.set)
      // Insert the new meta into the list first; flistActivateSet will
      // do the flush-outgoing + load-incoming + editorContent dance and
      // set this set as active.
      set((s) => {
        const list = s.flistSets[characterId] ?? []
        return {
          flistSets: {
            ...s.flistSets,
            [characterId]: [meta, ...list.filter((m) => m.id !== meta.id)]
          }
        }
      })
      await get().flistActivateSet(characterId, meta.id)
      return meta
    } catch {
      return null
    }
  },

  async flistRenameSet(characterId, setId, name) {
    try {
      const wire = await api.flistSetRename(characterId, setId, { name })
      const meta = _setMetaFromWire(wire.set)
      set((s) => {
        const list = s.flistSets[characterId] ?? []
        return {
          flistSets: {
            ...s.flistSets,
            [characterId]: list.map((m) => (m.id === meta.id ? meta : m))
          }
        }
      })
    } catch {
      // Rename is a meta-only op; surface error via the next list reload
      // rather than a dedicated error field this round.
    }
  },

  async flistDuplicateSet(characterId, setId, name) {
    try {
      const wire = await api.flistSetDuplicate(characterId, setId, { name })
      const meta = _setMetaFromWire(wire.set)
      // Photoshop "Duplicate layer" semantics: append at top of list,
      // **do not** activate. The orchestrator's UI handles the selection
      // flow if the user wants to switch.
      set((s) => {
        const list = s.flistSets[characterId] ?? []
        return {
          flistSets: {
            ...s.flistSets,
            [characterId]: [meta, ...list.filter((m) => m.id !== meta.id)]
          }
        }
      })
      return meta
    } catch {
      return null
    }
  },

  async flistDeleteSet(characterId, setId) {
    // Cancel any pending autosave for the doomed set so a stranded timer
    // can't fire a PUT against a now-deleted folder. Also clear the
    // legacy view slot if it was the active one.
    _cancelSetFlush(setId)
    const wasActive = get().flistActiveSetId[characterId] === setId
    if (wasActive) _cancelFlush(characterId)
    try {
      const res = await api.flistSetDelete(characterId, setId)
      set((s) => {
        const list = (s.flistSets[characterId] ?? []).filter((m) => m.id !== setId)
        const nextSetWorking = { ...s.flistSetWorking }
        delete nextSetWorking[setId]
        const nextLoadStatus = { ...s.flistSetWorkingLoadStatus }
        delete nextLoadStatus[setId]
        const patch: Partial<State> = {
          flistSets: { ...s.flistSets, [characterId]: list },
          flistSetWorking: nextSetWorking,
          flistSetWorkingLoadStatus: nextLoadStatus
        }
        if (wasActive) {
          patch.flistActiveSetId = {
            ...s.flistActiveSetId,
            [characterId]: res.active_set_id
          }
        }
        return patch
      })
      if (wasActive) {
        // Re-route the editor to whichever set the server picked as the
        // new active one — or to F-list read-only when there are none.
        const nextActive = get().flistActiveSetId[characterId]
        if (nextActive) {
          // flistActivateSet flushes outgoing + loads incoming; activeSetId
          // was set to nextActive above, so prevent the early-return path
          // by clearing it first then re-activating.
          set((s) => ({
            flistActiveSetId: { ...s.flistActiveSetId, [characterId]: null }
          }))
          await get().flistActivateSet(characterId, nextActive)
        } else {
          await get().flistActivateFromFlist(characterId)
        }
      }
    } catch {
      // Failure leaves local state untouched; user can retry from the
      // confirm dialog the next round adds.
    }
  },

  async flistActivateSet(characterId, setId) {
    const prevSetId = get().flistActiveSetId[characterId]
    if (prevSetId === setId) return
    // Flush the outgoing slot synchronously so its edits land under the
    // PREVIOUS set's id (flistFlushWorking reads activeSetId at PUT time
    // — we cancel any debounce, drain the in-flight save, then flush
    // explicitly before flipping the pointer).
    if (prevSetId && get().flistWorking[characterId]?.unsavedDirty) {
      _cancelFlush(characterId)
      try {
        await get().flistFlushWorking(characterId)
      } catch {
        // best-effort; saveError on the slot is the user signal
      }
    }
    try {
      await api.flistSetActivate(characterId, setId)
    } catch {
      // Server rejected (404 / 409). Leave the prior active id in place.
      return
    }
    // Fetch the new set's payload fresh from disk every time — each
    // set has its own payload.json so this is what gives them
    // byte-isolated identity.
    let payload: WorkingPayload
    let etag: string | null = null
    try {
      const res = await api.flistSetPayloadRead(characterId, setId)
      payload = res.payload as WorkingPayload
      etag = res.etag
    } catch {
      payload = { ...emptyWorkingSlot().payload }
    }
    const overlay = Array.isArray(payload._overlay) ? payload._overlay : []
    const slot: FlistWorkingSlot = {
      payload,
      overlay,
      etag,
      unsavedDirty: false,
      saveStatus: 'idle',
      saveError: null,
      lastSavedAt: null,
      materialised: true
    }
    set((s) => {
      const patch: Partial<State> = {
        flistActiveSetId: { ...s.flistActiveSetId, [characterId]: setId },
        editorReadOnly: false,
        flistWorking: { ...s.flistWorking, [characterId]: slot },
        flistSetWorking: { ...s.flistSetWorking, [setId]: slot }
      }
      // Mirror the new set's description into the editor so the panel
      // immediately reflects the switch.
      if (s.flistActiveCharacterId === characterId) {
        patch.editorContent = descriptionOf(payload)
        patch.editorDirty = false
      }
      return patch
    })
  },

  async flistActivateFromFlist(characterId) {
    const prevSetId = get().flistActiveSetId[characterId]
    if (prevSetId && get().flistWorking[characterId]?.unsavedDirty) {
      _cancelFlush(characterId)
      try {
        await get().flistFlushWorking(characterId)
      } catch {
        // best-effort
      }
    }
    try {
      await api.flistFromFlistActivate(characterId)
    } catch {
      // Leave previous selection intact on failure.
      return
    }
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
      materialised: true
    }
    set((s) => {
      const patch: Partial<State> = {
        flistActiveSetId: { ...s.flistActiveSetId, [characterId]: null },
        editorReadOnly: true,
        flistWorking: { ...s.flistWorking, [characterId]: slot }
      }
      if (s.flistActiveCharacterId === characterId) {
        patch.editorContent = descriptionOf(payload)
        patch.editorDirty = false
      }
      return patch
    })
  },

  async flistExportSet(characterId, setId) {
    const dialog = window.workbench?.saveFileDialog
    const write = window.workbench?.writeFile
    if (!dialog || !write) return null
    let bundle: { bytes: Uint8Array; suggestedFilename: string }
    try {
      bundle = await api.flistSetExport(characterId, setId)
    } catch (err) {
      console.error('[flist] export bundle fetch failed:', err)
      return null
    }
    const path = await dialog({
      title: 'Export working set',
      defaultPath: bundle.suggestedFilename,
      filters: [
        { name: 'Workbench set bundle', extensions: ['zip'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (!path) return null
    const ok = await write(path, bundle.bytes)
    if (!ok) return null
    return { path, bytes: bundle.bytes.length }
  },

  flistCancelPendingImport() {
    _pendingCrossCharImport = null
  },

  async flistMaybeRunScheduledSweep() {
    // Three preconditions must hold before we run the sweep:
    //   1. F-list session is active (we need a ticket to pull).
    //   2. A backup-all isn't already in flight.
    //   3. settings.backups.next_due_at is in the past (or null —
    //      "never run" should kick off the first sweep).
    // Returns true if the sweep was kicked off so the caller (the
    // sign-in flow) can skip the redundant _flistAutoRefreshOnLogin —
    // backup-all pulls every character including images, which is a
    // superset of what auto-refresh does.
    if (!get().flistSession.active) return false
    if (get().flistBackupAllStatus.phase === 'running') return false
    let settings:
      | Awaited<ReturnType<typeof api.settingsGet>>
      | null = null
    try {
      settings = await api.settingsGet()
    } catch {
      return false
    }
    if (!settings) return false
    const intervalDays = settings.backups.scheduled_interval_days
    if (intervalDays <= 0) return false // Auto-sweep disabled.
    const nextDueAt = settings.backups.next_due_at
    const now = Math.floor(Date.now() / 1000)
    // null next_due_at means "never run" — kick off the first sweep.
    if (nextDueAt !== null && nextDueAt > now) return false
    void get().flistBackupAll({ kind: 'scheduled', source: 'post_login' })
    return true
  },

  async flistBackupAll(opts) {
    if (get().flistBackupAllStatus.phase === 'running') return
    const kind = opts?.kind ?? 'manual_bulk'
    const source = opts?.source ?? 'manual'
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
        kind
      }
    })
    try {
      await api.flistBackupAll({
        onStart: ({ total }) => {
          set((s) => ({
            flistBackupAllStatus: { ...s.flistBackupAllStatus, total }
          }))
        },
        onQueued: () => {
          set((s) => ({
            flistBackupAllStatus: {
              ...s.flistBackupAllStatus,
              currentName: 'waiting for another pull to finish…'
            }
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
          // every character even though the scheduled sweep just
          // updated all of them — wasted disk + network on subsequent
          // manual REFRESH ALL clicks. flistLoadArchive reads from
          // local /flist/character/{id}/live (no F-list network),
          // updates the live payload + snapshots + zipBackups +
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
                  errorMessage: null,
                  kind: 'manual_bulk'
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
      }, { kind, source })
    } catch (err) {
      const message = (err as Error).message ?? 'backup-all failed'
      set((s) => ({
        flistBackupAllStatus: {
          ...s.flistBackupAllStatus,
          phase: 'error',
          errorMessage: message,
          currentName: null
        }
      }))
    }
  },

  async flistBackupCharacter(name) {
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
        errorMessage: null,
        kind: 'manual_bulk'
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
                errorMessage: null,
                kind: 'manual_bulk'
              }
            })
          }
        }, 6000)
      }
    }

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

    // Resolve the character id post-pull — `flistRoster` is keyed by
    // name, and `flistArchive` by id; the pull writes the id into the
    // roster (live.fetched_at) so this lookup is safe right after it.
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
                  snapshots: [],
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

  async flistImportSet(targetCharacterId) {
    // Belt-and-braces: drop any leftover handshake state from a prior
    // import the user abandoned without dismissing the modal.
    _pendingCrossCharImport = null
    const openDialog = window.workbench?.openFileDialog
    const read = window.workbench?.readFile
    if (!openDialog || !read) return { status: 'unavailable' }
    const path = await openDialog({
      title: 'Import working set',
      filters: [
        { name: 'Workbench set bundle', extensions: ['zip'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (!path) return { status: 'cancelled' }
    const bytes = await read(path)
    if (!bytes) return { status: 'error', message: 'could not read file' }
    const existing = get().flistSets[targetCharacterId] ?? []
    const name = _defaultImportedSetName(existing)
    try {
      const result = await api.flistSetImport(targetCharacterId, bytes, {
        name,
        confirmCrossCharacter: false
      })
      const newMeta = _setMetaFromWire(result.set)
      set((s) => {
        const list = s.flistSets[targetCharacterId] ?? []
        return {
          flistSets: {
            ...s.flistSets,
            [targetCharacterId]: [newMeta, ...list.filter((m) => m.id !== newMeta.id)]
          }
        }
      })
      await get().flistActivateSet(targetCharacterId, newMeta.id)
      return {
        status: 'imported',
        set: _setMetaFromWire(result.set),
        imageStats: {
          added: result.image_stats.added,
          skipped: result.image_stats.skipped
        },
        crossCharacter: result.cross_character
      }
    } catch (err) {
      const e = err as Error & {
        code?: string
        source?: { characterId: string; characterName: string; setName: string }
      }
      if (
        e.code === 'requires_cross_character_confirmation' &&
        e.source
      ) {
        _pendingCrossCharImport = {
          targetCharacterId,
          zipBytes: bytes,
          name
        }
        return { status: 'requires_confirmation', source: e.source }
      }
      _pendingCrossCharImport = null
      return { status: 'error', message: e.message || 'import failed' }
    }
  },

  async flistConfirmCrossCharacterImport() {
    const pending = _pendingCrossCharImport
    if (!pending) {
      return { status: 'error', message: 'no pending import' }
    }
    try {
      const result = await api.flistSetImport(
        pending.targetCharacterId,
        pending.zipBytes,
        { name: pending.name, confirmCrossCharacter: true }
      )
      const newMeta = _setMetaFromWire(result.set)
      const targetId = pending.targetCharacterId
      set((s) => {
        const list = s.flistSets[targetId] ?? []
        return {
          flistSets: {
            ...s.flistSets,
            [targetId]: [newMeta, ...list.filter((m) => m.id !== newMeta.id)]
          }
        }
      })
      await get().flistActivateSet(targetId, newMeta.id)
      return {
        status: 'imported',
        set: _setMetaFromWire(result.set),
        imageStats: {
          added: result.image_stats.added,
          skipped: result.image_stats.skipped
        },
        crossCharacter: result.cross_character
      }
    } catch (err) {
      const message = (err as Error).message || 'import failed'
      return { status: 'error', message }
    } finally {
      _pendingCrossCharImport = null
    }
  },

  async flistSetWorkingMaterialise(characterId, setId) {
    set((s) => ({
      flistSetWorkingLoadStatus: {
        ...s.flistSetWorkingLoadStatus,
        [setId]: 'loading'
      }
    }))
    try {
      const { payload, etag } = await api.flistSetPayloadRead(characterId, setId)
      const overlay = Array.isArray((payload as WorkingPayload)._overlay)
        ? ((payload as WorkingPayload)._overlay as string[])
        : []
      const slot: FlistWorkingSlot = {
        payload: payload as WorkingPayload,
        overlay,
        etag,
        unsavedDirty: false,
        saveStatus: 'idle',
        saveError: null,
        lastSavedAt: null,
        // Per-set payloads are seeded server-side on create — they're on
        // disk by the time we read them, so the slot is materialised.
        materialised: true
      }
      set((s) => ({
        flistSetWorking: { ...s.flistSetWorking, [setId]: slot },
        flistSetWorkingLoadStatus: {
          ...s.flistSetWorkingLoadStatus,
          [setId]: 'ready'
        }
      }))
    } catch {
      set((s) => ({
        flistSetWorkingLoadStatus: {
          ...s.flistSetWorkingLoadStatus,
          [setId]: 'error'
        }
      }))
    }
  },

  async flistSetWorkingFlushPending(characterId, setId) {
    _cancelSetFlush(setId)
    // Chain after any in-flight PUT so we don't race ahead and ship a
    // stale payload (mirrors the per-character single-flight pattern).
    const prior = _setFlushInflight.get(setId)
    if (prior) {
      await prior.catch(() => {})
      _cancelSetFlush(setId)
    }
    const slot = get().flistSetWorking[setId]
    if (!slot || !slot.unsavedDirty) {
      _cancelSetFlush(setId)
      return
    }
    const inflight = (async () => {
      const sentPayload = slot.payload
      set((s) => {
        const existing = s.flistSetWorking[setId]
        if (!existing) return {}
        return {
          flistSetWorking: {
            ...s.flistSetWorking,
            [setId]: { ...existing, saveStatus: 'saving', saveError: null }
          }
        }
      })
      try {
        const { etag } = await api.flistSetPayloadPut(
          characterId,
          setId,
          sentPayload,
          slot.etag
        )
        set((s) => {
          const existing = s.flistSetWorking[setId]
          if (!existing) return {}
          const isFresh = existing.payload === sentPayload
          return {
            flistSetWorking: {
              ...s.flistSetWorking,
              [setId]: {
                ...existing,
                etag,
                unsavedDirty: isFresh ? false : existing.unsavedDirty,
                saveStatus: isFresh ? 'saved' : existing.saveStatus,
                saveError: null,
                lastSavedAt: Date.now(),
                materialised: true
              }
            }
          }
        })
        const next = get().flistSetWorking[setId]
        if (next?.unsavedDirty) {
          _scheduleSetFlush(setId, () => {
            void get().flistSetWorkingFlushPending(characterId, setId)
          })
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err)
        const conflict = err instanceof Error && err.message === 'etag_mismatch'
        const errWith = err as Error & { currentEtag?: string | null }
        set((s) => {
          const existing = s.flistSetWorking[setId]
          if (!existing) return {}
          return {
            flistSetWorking: {
              ...s.flistSetWorking,
              [setId]: {
                ...existing,
                saveStatus: 'error',
                saveError: conflict
                  ? 'Another window saved a different version. Reload to merge.'
                  : raw,
                etag: conflict
                  ? errWith.currentEtag ?? existing.etag
                  : existing.etag,
                unsavedDirty: true
              }
            }
          }
        })
      }
    })()
    _setFlushInflight.set(setId, inflight)
    try {
      await inflight
    } finally {
      if (_setFlushInflight.get(setId) === inflight) {
        _setFlushInflight.delete(setId)
      }
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
      const payload = await api.flistSnapshotRead(characterId, filename)
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

  async flistResetWorkingToBackup(characterId, backupFilename) {
    const slot = get().flistWorking[characterId]
    if (!slot) return
    _cancelFlush(characterId)
    // Drain any in-flight save before DELETE/PUT so a mid-flight save
    // can't resurrect the pre-reset payload (mirrors Tier 2 §P2-3).
    const inflight = _flushInflight.get(characterId)
    if (inflight) await inflight.catch(() => {})
    _cancelFlush(characterId)
    let backupPayload: Record<string, unknown> | null = null
    const cacheKey = `${characterId}:${backupFilename}`
    backupPayload = get().flistDiffBackupCache[cacheKey] ?? null
    if (!backupPayload) {
      try {
        backupPayload = await api.flistSnapshotRead(characterId, backupFilename)
      } catch {
        // Bail without mutating — surface the failure via saveError on
        // the next flush attempt.
        return
      }
    }
    // A user keystroke during the backup-read await may have armed a
    // fresh flush against the still-pre-reset slot — re-drain so the
    // DELETE we're about to issue isn't racing one (QA P2-1).
    _cancelFlush(characterId)
    const secondInflight = _flushInflight.get(characterId)
    if (secondInflight) await secondInflight.catch(() => {})
    _cancelFlush(characterId)
    // Capture the pre-reset etag so the eager-PUT after seeding can
    // explicitly overwrite whatever's on disk. Without this, a DELETE
    // failure followed by the eager-PUT would ship etag=null and 409
    // against the still-present file (QA P1-1).
    const priorEtag = slot.etag
    try {
      await api.flistWorkingDelete(characterId)
    } catch {
      // Non-404 failures will be caught by the eager PUT's If-Match;
      // 404 (nothing to delete) is the expected path on a clean reset.
    }
    // Build a fresh working payload from the backup. Backup data uses
    // the same JSON-API shape as Live; pass through seedWorkingFromLive
    // so CRLF normalisation + kinks-list-to-dict coercion apply.
    const seeded = seedWorkingFromLive(backupPayload)
    const expiresAt = Date.now() + RESET_UNDO_MS
    set((s) => {
      const fresh: FlistWorkingSlot = {
        ...emptyWorkingSlot(),
        payload: seeded,
        // Inherit the pre-reset etag and treat the slot as materialised
        // so the eager PUT below ships If-Match against whatever was
        // on disk before. If DELETE succeeded the etag is stale and the
        // server returns 409 → flistFlushWorking's conflict branch
        // updates to the new etag and re-tries; if DELETE failed the
        // etag still matches and the PUT overwrites cleanly (QA P1-1).
        etag: priorEtag,
        materialised: true,
        unsavedDirty: true
      }
      return {
        flistWorking: { ...s.flistWorking, [characterId]: fresh },
        flistResetUndo: { characterId, snapshot: slot, expiresAt }
      }
    })
    const reloaded = get().flistWorking[characterId]
    if (
      reloaded &&
      get().flistActiveCharacterId === characterId &&
      !get().editorReadOnly
    ) {
      set({
        editorContent: descriptionOf(reloaded.payload),
        editorDirty: false
      })
    }
    const prev = _resetUndoTimers.get(characterId)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      _resetUndoTimers.delete(characterId)
      const undo = get().flistResetUndo
      if (undo && undo.characterId === characterId && undo.expiresAt <= Date.now()) {
        set({ flistResetUndo: null })
      }
    }, RESET_UNDO_MS + 50)
    _resetUndoTimers.set(characterId, t)
    // Eager-flush the seeded payload to disk so a crash before next
    // edit doesn't lose the reset (parity with Tier 2 reset-to-Live
    // which uses DELETE only; seed-from-backup needs a PUT because
    // the source isn't recoverable from Live). Slot is already dirty
    // + carries the prior etag, so flistFlushWorking handles a 409
    // and retries through its conflict branch.
    _scheduleFlush(characterId, () => {
      void get().flistFlushWorking(characterId)
    })
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
    const previousActiveSetId = get().flistActiveSetId[characterId] ?? null
    const previousReadOnly = get().editorReadOnly

    set({
      flistBrowseBackup: {
        characterId,
        filename: backupFilename,
        status: 'loading',
        payload: null,
        error: null,
        previousLive,
        previousActiveSetId,
        previousReadOnly
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
          previousActiveSetId,
          previousReadOnly
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
      materialised: true
    }

    set((s) => {
      const patch: Partial<State> = {
        flistArchive: {
          ...s.flistArchive,
          [characterId]: {
            ...(s.flistArchive[characterId] ?? {
              snapshots: [],
              pullStatus: 'idle'
            }),
            live: payload
          }
        },
        flistActiveSetId: { ...s.flistActiveSetId, [characterId]: null },
        editorReadOnly: true,
        flistWorking: { ...s.flistWorking, [characterId]: slot },
        flistBrowseBackup: {
          characterId,
          filename: backupFilename,
          status: 'ready',
          payload,
          error: null,
          kind,
          dateLabel,
          previousLive,
          previousActiveSetId,
          previousReadOnly
        }
      }
      if (s.flistActiveCharacterId === characterId) {
        patch.editorContent = descriptionOf(slot.payload)
        patch.editorInlines = extractInlines(payload)
        patch.editorDirty = false
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

  async flistCreateSetFromBackup(characterId, backupFilename) {
    // Backup ZIPs carry character.json + working.json + backup-meta
    // — *not* the manifest.json shape the userscript-import path
    // expects (that's the working-set-bundle format). Going through
    // flistSetImport would 422 with "bundle is missing manifest.json".
    // We hit a dedicated sidecar endpoint that reads working.json
    // directly out of the backup ZIP and materialises a new set
    // from it, no on-disk round-trip needed.
    const existingNames = (get().flistSets[characterId] ?? []).map((s) => s.name)
    const baseName = (() => {
      // Default name: "Backup YYYY-MM-DD HH:MM" from the filename's
      // UTC timestamp. Older entries get "(2)" / "(3)" suffixes if
      // a same-named set already exists.
      const m = backupFilename.match(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z/
      )
      if (!m) return `From backup ${backupFilename.replace(/\.zip$/, '')}`
      const [, y, mo, d, h, mi] = m
      return `Backup ${y}-${mo}-${d} ${h}:${mi}`
    })()
    let candidate = baseName
    let i = 2
    while (existingNames.includes(candidate)) {
      candidate = `${baseName} (${i})`
      i += 1
    }
    try {
      const result = await api.flistSetCreateFromBackup(
        characterId,
        backupFilename,
        { name: candidate }
      )
      const meta = _setMetaFromWire(result.set)
      set((s) => {
        const list = s.flistSets[characterId] ?? []
        return {
          flistSets: {
            ...s.flistSets,
            [characterId]: [
              meta,
              ...list.filter((m) => m.id !== meta.id)
            ]
          }
        }
      })
      await get().flistActivateSet(characterId, meta.id)
      return { setId: meta.id, setName: meta.name }
    } catch (err) {
      console.error('[flist] create set from backup failed:', err)
      return null
    }
  },

  async flistUndoResetWorking() {
    const undo = get().flistResetUndo
    if (!undo) return
    const { characterId, snapshot } = undo
    set({ flistResetUndo: null })
    const timer = _resetUndoTimers.get(characterId)
    if (timer) {
      clearTimeout(timer)
      _resetUndoTimers.delete(characterId)
    }
    // Re-PUT the pre-delete snapshot. Try `If-Match: null` first (delete
    // left disk empty); on 409 the file was touched by another window
    // during the 5s undo window — read the current etag and retry with
    // it so we explicitly overwrite rather than silently clobbering
    // unknown bytes (QA P2-5).
    const writeWith = async (etag: string | null) =>
      api.flistWorkingWrite(characterId, snapshot.payload, { etag })
    try {
      let result
      try {
        result = await writeWith(null)
      } catch (err) {
        if (err instanceof Error && err.message === 'etag_mismatch') {
          const errWith = err as Error & { currentEtag?: string | null }
          const currentEtag = errWith.currentEtag ?? null
          result = await writeWith(currentEtag)
        } else {
          throw err
        }
      }
      const { etag } = result
      set((s) => ({
        flistWorking: {
          ...s.flistWorking,
          [characterId]: {
            ...snapshot,
            etag,
            unsavedDirty: false,
            saveStatus: 'saved',
            saveError: null,
            lastSavedAt: Date.now(),
            materialised: true
          }
        }
      }))
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      set((s) => ({
        flistWorking: {
          ...s.flistWorking,
          [characterId]: { ...snapshot, saveStatus: 'error', saveError: raw }
        }
      }))
    }
    // Refresh the editor surface against the restored slot.
    const slot = get().flistWorking[characterId]
    if (
      slot &&
      get().flistActiveCharacterId === characterId &&
      !get().editorReadOnly
    ) {
      set({
        editorContent: descriptionOf(slot.payload),
        editorDirty: slot.unsavedDirty
      })
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
    _applyTombstones(characterId, kinkIds, set)
    _armTombstoneUndo(characterId, prevSlot, kinkIds, set, get)
    get().flistCustomKinksClearMulti(characterId)
    _scheduleFlush(characterId, () => {
      void get().flistFlushWorking(characterId)
    })
  },

  flistUndoTombstone() {
    const undo = get().flistTombstoneUndo
    if (!undo) return
    if (_tombstoneUndoTimer) {
      clearTimeout(_tombstoneUndoTimer)
      _tombstoneUndoTimer = null
    }
    set((s) => ({
      flistWorking: {
        ...s.flistWorking,
        [undo.characterId]: undo.snapshot
      },
      flistTombstoneUndo: null
    }))
    _scheduleFlush(undo.characterId, () => {
      void get().flistFlushWorking(undo.characterId)
    })
  },

  flistStandardKinksBulkSetChoice(characterId, kinkIds, choice) {
    set((s) => {
      const slot = s.flistWorking[characterId]
      if (!slot) return {}
      const payload = JSON.parse(JSON.stringify(slot.payload)) as WorkingPayload
      const existing =
        (payload.kinks && typeof payload.kinks === 'object' && !Array.isArray(payload.kinks)
          ? (payload.kinks as Record<string, unknown>)
          : {}) as Record<string, unknown>
      for (const id of kinkIds) {
        existing[id] = choice
      }
      payload.kinks = existing
      const overlay = Array.from(
        new Set([...slot.overlay, ...kinkIds.map((id) => `kinks.${id}`)])
      )
      payload._overlay = overlay
      return {
        flistWorking: {
          ...s.flistWorking,
          [characterId]: {
            ...slot,
            payload,
            overlay,
            unsavedDirty: true,
            saveStatus: 'idle',
            saveError: slot.saveError
          }
        }
      }
    })
    _scheduleFlush(characterId, () => {
      void get().flistFlushWorking(characterId)
    })
  },

  flistCustomKinksAdd(characterId) {
    const localId = `local:${
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36)
    }`
    set((s) => {
      const slot = s.flistWorking[characterId]
      if (!slot) return {}
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
      const overlayAdds = ['custom_kinks._order']
      const overlay = Array.from(new Set([...slot.overlay, ...overlayAdds]))
      payload._overlay = overlay
      const next: FlistWorkingSlot = {
        ...slot,
        payload,
        overlay,
        unsavedDirty: true,
        saveStatus: 'idle',
        saveError: null
      }
      return {
        flistWorking: { ...s.flistWorking, [characterId]: next },
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
      }
    })
    _scheduleFlush(characterId, () => {
      void get().flistFlushWorking(characterId)
    })
    return localId
  },

  flistCustomKinksEdit(characterId, kinkId, field, value) {
    const path = `custom_kinks.${kinkId}.${field}`
    get().flistSetWorkingField(characterId, path, value)
  },

  flistCustomKinksTombstone(characterId, kinkId) {
    const prevSlot = get().flistWorking[characterId]
    if (!prevSlot) return
    _applyTombstones(characterId, [kinkId], set)
    _armTombstoneUndo(characterId, prevSlot, [kinkId], set, get)
    _scheduleFlush(characterId, () => {
      void get().flistFlushWorking(characterId)
    })
  },

  flistCustomKinksUndelete(characterId, kinkId) {
    set((s) => {
      const slot = s.flistWorking[characterId]
      if (!slot) return {}
      const payload = JSON.parse(JSON.stringify(slot.payload)) as WorkingPayload
      const ck = (payload.custom_kinks ?? {}) as Record<string, Record<string, unknown>>
      if (ck[kinkId]) {
        delete ck[kinkId]._deleted
        payload.custom_kinks = ck
      }
      const overlay = slot.overlay.filter(
        (p) => p !== `custom_kinks.${kinkId}._deleted`
      )
      payload._overlay = overlay
      return {
        flistWorking: {
          ...s.flistWorking,
          [characterId]: {
            ...slot,
            payload,
            overlay,
            unsavedDirty: true,
            saveStatus: 'idle',
            saveError: null
          }
        }
      }
    })
    _scheduleFlush(characterId, () => {
      void get().flistFlushWorking(characterId)
    })
  },

  flistCustomKinksReorder(characterId, nextOrder) {
    set((s) => {
      const slot = s.flistWorking[characterId]
      if (!slot) return {}
      const payload = JSON.parse(JSON.stringify(slot.payload)) as WorkingPayload
      payload._custom_kinks_order = [...nextOrder]
      const overlay = Array.from(new Set([...slot.overlay, 'custom_kinks._order']))
      payload._overlay = overlay
      return {
        flistWorking: {
          ...s.flistWorking,
          [characterId]: {
            ...slot,
            payload,
            overlay,
            unsavedDirty: true,
            saveStatus: 'idle',
            saveError: null
          }
        }
      }
    })
    _scheduleFlush(characterId, () => {
      void get().flistFlushWorking(characterId)
    })
  },

  flistCustomKinksResetField(characterId, kinkId, field) {
    const path = `custom_kinks.${kinkId}.${field}`
    get().flistResetWorkingField(characterId, path)
  },

  flistCustomKinksBulkSetChoice(characterId, kinkIds, choice) {
    set((s) => {
      const slot = s.flistWorking[characterId]
      if (!slot) return {}
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
      if (additions.length === 0) return {}
      payload.custom_kinks = ck
      const overlay = Array.from(new Set([...slot.overlay, ...additions]))
      payload._overlay = overlay
      return {
        flistWorking: {
          ...s.flistWorking,
          [characterId]: {
            ...slot,
            payload,
            overlay,
            unsavedDirty: true,
            saveStatus: 'idle',
            saveError: slot.saveError
          }
        }
      }
    })
    _scheduleFlush(characterId, () => {
      void get().flistFlushWorking(characterId)
    })
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
    // routing through the regular field setter.
    const slot = get().flistWorking[characterId]
    if (slot && Array.isArray(slot.payload.kinks)) {
      set((s) => {
        const existing = s.flistWorking[characterId]
        if (!existing) return {}
        const payload = { ...existing.payload, kinks: {} }
        return {
          flistWorking: {
            ...s.flistWorking,
            [characterId]: { ...existing, payload }
          }
        }
      })
    }
    const path = `kinks.${kinkId}`
    get().flistSetWorkingField(characterId, path, choice)
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
    set({ activeCharacter: name, activePartner: null })
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
      if (switched) {
        try {
          localStorage.setItem(FLIST_LAST_CHAR_KEY, id)
        } catch {
          // ignore
        }
        set({ flistActiveCharacterId: id })
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

  openAiSetup() {
    set({ aiSetupOpen: true })
  },
  closeAiSetup() {
    set({ aiSetupOpen: false })
  },
  openClassify(scope, label) {
    set({ classifyTarget: { scope, label } })
  },

  closeClassify() {
    set({ classifyTarget: null })
  },

  openIngest(scope, label, opts) {
    set({
      ingestTarget: { scope, label, forceRewipe: opts?.forceRewipe ?? false }
    })
  },

  closeIngest() {
    set({ ingestTarget: null })
  },

  toggleChatPanel(force) {
    set((s) => ({
      chatPanelOpen: typeof force === 'boolean' ? force : !s.chatPanelOpen
    }))
  },

  requestChatFocus() {
    set((s) => ({ chatFocusNonce: s.chatFocusNonce + 1 }))
  },

  // ---- AI Assistant (Phase 9) -----------------------------------

  setAiAssistantEnabled(enabled) {
    set((s) => ({
      aiAssistantEnabled: enabled,
      // Disabling the feature also closes the pane — keeps the
      // master toggle and the session toggle in sync.
      aiAssistantPaneOpen: enabled ? s.aiAssistantPaneOpen : false
    }))
  },

  setAiAssistantPromptConfig(presets, systemPrompt) {
    set({
      aiAssistantPromptPresets: presets,
      aiAssistantSystemPrompt: systemPrompt
    })
  },

  async setAiAssistantPromptBody(body) {
    // Optimistic local update so the in-chat dropdown reflects
    // immediately; on PUT failure, surface as an error chip.
    const prev = get().aiAssistantSystemPrompt
    set({ aiAssistantSystemPrompt: body })
    try {
      await api.settingsUpdate({ ai_assistant: { system_prompt: body } })
    } catch (err) {
      // Roll back + report.
      set({
        aiAssistantSystemPrompt: prev,
        aiAssistantLastError:
          err instanceof Error
            ? `Couldn't save prompt: ${err.message}`
            : 'Couldn’t save prompt.'
      })
    }
  },

  toggleAiAssistantPane(force) {
    const s = get()
    if (!s.aiAssistantEnabled) {
      set({ aiAssistantPaneOpen: false })
      return
    }
    const next = typeof force === 'boolean' ? force : !s.aiAssistantPaneOpen
    if (!next && s.aiAssistantInflight) {
      // Closing the pane cancels any in-flight stream so we don't
      // continue downloading tokens the user can't see.
      s.aiAssistantInflight.abort()
    }
    set({ aiAssistantPaneOpen: next })
  },

  resetAiAssistantTranscript() {
    set({
      aiAssistantTranscript: [],
      aiAssistantLastError: null,
      aiAssistantToolEvents: {}
    })
  },

  async sendAiAssistantTurn(userMessage) {
    const s = get()
    if (!s.aiAssistantEnabled) return
    const activeId = s.flistActiveCharacterId
    if (!activeId) {
      set({
        aiAssistantLastError:
          'Select an active character before sending a message.'
      })
      return
    }
    const trimmed = userMessage.trim()
    if (!trimmed) return

    // Cancel any in-flight stream so a stale onDraftUpdate from the
    // previous turn can't land after we've moved on. Without this, a
    // late-arriving tool_result mutates aiAssistantDrafts under the
    // new turn and the user sees draft cards appear belonging to the
    // prior conversation.
    s.aiAssistantInflight?.abort()

    const controller = new AbortController()
    const transcript: AssistantChatMessage[] = [
      ...s.aiAssistantTranscript,
      { role: 'user', content: trimmed }
    ]
    set({
      aiAssistantTranscript: transcript,
      aiAssistantStreaming: true,
      aiAssistantLastError: null,
      aiAssistantInflight: controller
    })

    // Accumulate text chunks across rounds — model can emit multiple
    // text events between tool calls; we coalesce into one assistant
    // turn so the transcript stays clean.
    let assistantText = ''
    let fromReasoning = false
    // Capture every tool_call/tool_result pair the sidecar emits so
    // the user can see exactly what the model did — silent rejections
    // (anchor_mismatch etc.) were invisible in early smoke testing
    // and led the user to assume edits should be landing when they
    // weren't.
    const toolEvents: AssistantToolEvent[] = []
    const pendingCalls: Record<string, { tool: string; args: Record<string, unknown> }> = {}

    try {
      await api.assistantChat(
        { messages: transcript, active_character_id: activeId },
        {
          onText: (data) => {
            assistantText += (assistantText ? '\n\n' : '') + data.content
            // Capture the reasoning-fallback flag so we can mark the
            // appended assistant message and let the renderer style
            // it differently from a normal reply.
            if (data.from_reasoning) {
              fromReasoning = true
            }
          },
          onToolCall: (data) => {
            pendingCalls[data.call_id] = { tool: data.tool, args: data.args }
          },
          onToolResult: (data) => {
            const pending = pendingCalls[data.call_id]
            const tool = pending?.tool ?? 'unknown'
            const args = pending?.args ?? {}
            delete pendingCalls[data.call_id]
            // Build a short result summary for the chip. For writes
            // we surface accepted/rejected counts; for reads we just
            // mark ok.
            let resultSummary: string | undefined
            const r = data.result as
              | { accepted_edit_ids?: string[]; rejected?: unknown[] }
              | undefined
            if (data.ok && r) {
              const accepted = r.accepted_edit_ids?.length ?? 0
              const rejected = r.rejected?.length ?? 0
              if (accepted > 0 || rejected > 0) {
                resultSummary = `${accepted} accepted${rejected > 0 ? `, ${rejected} rejected` : ''}`
              }
            }
            toolEvents.push({
              callId: data.call_id,
              tool,
              args,
              ok: data.ok,
              error: data.error,
              resultSummary
            })
          },
          onDraftUpdate: (data) => {
            if (controller.signal.aborted) return
            set((curr) => ({
              aiAssistantDrafts: {
                ...curr.aiAssistantDrafts,
                [activeId]: data.draft
              }
            }))
          },
          onError: (data) => {
            set({ aiAssistantLastError: data.message })
          }
        },
        { signal: controller.signal }
      )
    } catch (err) {
      // Aborts surface as DOMException("AbortError"); treat as a
      // clean cancellation rather than an error to surface.
      if (
        err instanceof DOMException &&
        err.name === 'AbortError'
      ) {
        // no-op
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        set({ aiAssistantLastError: msg })
      }
    } finally {
      // Always land an assistant row when the stream completes
      // cleanly, even if the model only emitted tool calls and no
      // text. The transcript stub at AssistantPane.tsx renders
      // "Proposed edits — see the review column" for empty content
      // so the user doesn't watch a dead transcript while diff
      // cards fill in on the right. Tool events live alongside,
      // keyed by the assistant message's index so the renderer
      // can show them as chips on the same row.
      if (!controller.signal.aborted) {
        set((curr) => {
          const nextIndex = curr.aiAssistantTranscript.length
          return {
            aiAssistantTranscript: [
              ...curr.aiAssistantTranscript,
              {
                role: 'assistant',
                content: assistantText,
                ...(fromReasoning ? { _from_reasoning: true } : {})
              }
            ],
            aiAssistantToolEvents:
              toolEvents.length > 0
                ? {
                    ...curr.aiAssistantToolEvents,
                    [nextIndex]: toolEvents
                  }
                : curr.aiAssistantToolEvents
          }
        })
      }
      // Only clear streaming/inflight if WE are still the active
      // turn — a follow-up sendAiAssistantTurn would have already
      // swapped to a fresh controller and we shouldn't clobber it.
      const curr = get()
      if (curr.aiAssistantInflight === controller) {
        set({ aiAssistantStreaming: false, aiAssistantInflight: null })
      }
      // Always re-sync the draft from disk — a tool_call may have
      // landed an edit even if the stream errored mid-flight.
      try {
        await get().loadAiAssistantDraft(activeId)
      } catch {
        // Best-effort; failures here aren't user-actionable.
      }
    }
  },

  async loadAiAssistantDraft(characterId) {
    try {
      const { draft } = await api.aiDraftGet(characterId)
      set((s) => ({
        aiAssistantDrafts: { ...s.aiAssistantDrafts, [characterId]: draft }
      }))
    } catch (err) {
      // 404 means no draft — that's the common case, not an error.
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('HTTP 404')) {
        set((s) => ({
          aiAssistantDrafts: { ...s.aiAssistantDrafts, [characterId]: null }
        }))
        return
      }
      set({ aiAssistantLastError: msg })
    }
  },

  async acceptAiAssistantEdits(characterId, editIds) {
    if (editIds.length === 0) return
    const slot = flistSelectWorkingSlot(get(), characterId)
    const etag = slot?.etag ?? null
    try {
      const res = await api.aiDraftAccept(characterId, { edit_ids: editIds }, etag)
      set((s) => ({
        aiAssistantDrafts: {
          ...s.aiAssistantDrafts,
          [characterId]: res.draft
        }
      }))
      // Tell the user when some of the cards they tried to Accept
      // were skipped because they'd been marked stale (working copy
      // moved under the draft). Without this they'd silently sit in
      // the draft and the user would wonder why Accept-all "didn't
      // work" on them. Treat this as informational, not an error.
      const skipped = res.skipped_stale ?? []
      if (skipped.length > 0) {
        set({
          aiAssistantLastError:
            `${skipped.length} edit${skipped.length === 1 ? '' : 's'} ` +
            `skipped — working copy changed since the draft was built. ` +
            `Discard the draft and re-prompt, or ask the assistant to retry.`
        })
      }
      // The accepted edits already mutated working.json; reload the
      // working copy so the editor surfaces them without a manual
      // refresh.
      await get().flistLoadWorking(characterId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ aiAssistantLastError: msg })
    }
  },

  async rejectAiAssistantEdits(characterId, editIds) {
    if (editIds.length === 0) return
    try {
      const res = await api.aiDraftReject(characterId, { edit_ids: editIds })
      set((s) => ({
        aiAssistantDrafts: { ...s.aiAssistantDrafts, [characterId]: res.draft }
      }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ aiAssistantLastError: msg })
    }
  },

  async discardAiAssistantDraft(characterId) {
    try {
      await api.aiDraftDelete(characterId)
    } catch {
      // Idempotent server-side; ignore failures.
    }
    set((s) => ({
      aiAssistantDrafts: { ...s.aiAssistantDrafts, [characterId]: null }
    }))
  },

  requestLogJump(character, partner, ts_start, ts_end) {
    // nonce guarantees a fresh value even if the user clicks the same
    // citation twice — useEffect dependencies see a new reference.
    set({
      logJump: { character, partner, ts_start, ts_end, nonce: Date.now() }
    })
  },

  clearLogJump() {
    set({ logJump: null })
  },

  // Patches a single message's label fields in place. `patch === null`
  // clears label fields back to rule/Unlabeled resolution — but since
  // the resolver runs server-side, we approximate locally by removing
  // label_source and falling back to the rule the renderer can compute
  // (or 'Unlabeled' if unknown). The next loadMessages refresh
  // re-resolves from the sidecar authoritatively.
  applyLabelOverride(char, partner, hash, patch) {
    const key = partnerKey(char, partner)
    set((s) => {
      const list = s.messagesByPartner[key]
      if (!list) return s
      const next = list.map((m) => {
        if (m.hash !== hash) return m
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
    const before = get().editorContent
    set((s) => ({
      editorContent: value,
      editorDirty: s.editorDirty || value !== before,
      // Mark draft stale as soon as the user types — the autosave
      // effect will pick this up and flush after the idle window.
      draftStatus: 'idle'
    }))
    // Working-copy mode: editor is showing an F-list character's
    // editable copy (no local doc active, not in read-only Live /
    // Backup view). Route description edits through the persisted
    // working-copy slice so the 500 ms debounce + If-Match flush apply
    // uniformly with the other infotag / kink edits.
    const s = get()
    const isWorkingCopyMode =
      s.flistActiveCharacterId !== null && !s.editorReadOnly
    if (isWorkingCopyMode && value !== before) {
      get().flistSetWorkingField(s.flistActiveCharacterId!, DESCRIPTION_PATH, value)
    }
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
    return "Can't reach the sidecar. Is it running on port 27384?"
  }
  if (/HTTP 5\d\d/.test(raw)) return 'F-list is having trouble right now. Try again in a moment.'
  if (/HTTP 4\d\d/.test(raw)) return `F-list refused that name (${raw.replace(/^HTTP \d+:\s*/, '')}).`
  return raw
}
