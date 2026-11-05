// The UI slice: which pane the window shows and how, the dialogs only
// the window opens, and every preference the store keeps in browser
// storage (localStorage). Other slices read and write those preferences
// through the actions here, never through localStorage themselves.

import type { SliceCreator } from './slice'

export type Mode = 'editor' | 'logs'
export type EditorViewMode = 'split' | 'preview' | 'code'
export type PreviewTheme = 'dark' | 'default' | 'light'

const LAST_SEEN_KEY = 'flist-workbench:char-last-seen'
const LAST_ACCOUNT_KEY = 'flist-workbench:last-account'
const LAST_CHARACTER_KEY = 'flist-workbench:last-flist-char-id'
const EDITOR_VIEW_MODE_KEY = 'flist-workbench:editor-view-mode'
const PREVIEW_THEME_KEY = 'workbench.previewTheme'
const AUTO_REFRESH_ENABLED_KEY = 'workbench.flistAutoRefreshEnabled'
const AUTO_REFRESH_HOURS_KEY = 'workbench.flistAutoRefreshHours'

/** The editor tab last used with a character (or with none). */
function editorTabKey(characterId: string | null): string {
  return characterId
    ? `flist-workbench:active-editor-tab:${characterId}`
    : 'flist-workbench:active-editor-tab'
}

/** The sign-in auto-refresh runs at most this often, to be kind to the
 *  F-list API; anything faster is what the manual button is for. */
export const FLIST_AUTO_REFRESH_MIN_HOURS = 24
export const FLIST_AUTO_REFRESH_DEFAULT_HOURS = 24

function autoRefreshHours(raw: string | null): number {
  if (raw === null) return FLIST_AUTO_REFRESH_DEFAULT_HOURS
  const n = Number(raw)
  if (!Number.isFinite(n)) return FLIST_AUTO_REFRESH_DEFAULT_HOURS
  return Math.max(FLIST_AUTO_REFRESH_MIN_HOURS, Math.floor(n))
}

// Storage can be missing (tests outside jsdom) or refuse (private mode,
// storage full); a preference then just does not survive a restart.
function readStored(key: string): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(key, value)
  } catch {
    // best-effort persistence
  }
}

function readLastSeen(): Record<string, number> {
  const raw = readStored(LAST_SEEN_KEY)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, number>
  } catch {
    return {}
  }
}

export type UiState = {
  mode: Mode
  /** Which editor tab is active. Mirrored from EditorTabsHost so the
   *  preview pane can swap content per tab (e.g. show a website-style
   *  Info-pane view when the user is on Profile fields). */
  editorActiveTab: string
  /** Description-tab view mode. Only applied while the active tab is
   *  Description (other tabs always render side-by-side). Persisted
   *  in localStorage. */
  editorViewMode: EditorViewMode
  /** Which F-list theme palette the preview pane mimics. Values match
   *  F-list's own theme picker (Settings → Display). Persisted in
   *  localStorage so it sticks across launches. */
  previewTheme: PreviewTheme
  /** Open-restore-preview-modal target. When non-null, the export
   *  preview modal is open for this character; clicking "Download" in
   *  the modal navigates to the export.zip route. Lives in the store so
   *  the menu / sidebar / Images tab can all open it from anywhere. */
  flistExportRestoreCharacterId: string | null
  /** Last time the user opened the log tab for each character (epoch seconds). */
  charLastSeen: Record<string, number>
  /** Whether signing in pulls every character whose Live is older than
   *  `flistAutoRefreshHours`. Off by default: pulling a whole roster at
   *  every sign-in is rude when the user only wanted to edit one. */
  flistAutoRefreshEnabled: boolean
  /** How old a Live may be before the sign-in auto-refresh pulls it,
   *  in hours; at least `FLIST_AUTO_REFRESH_MIN_HOURS`. */
  flistAutoRefreshHours: number
}

export type UiSlice = UiState & {
  /** Leaving the Logs pane closes its cross search. */
  setMode: (mode: Mode) => void
  /** Switch the editor tab; it is kept for the active character. */
  setEditorActiveTab: (tab: string) => void
  /** Show the editor tab last used with `characterId` (Description when
   *  none was kept), as the window does when it switches character. */
  editorRestoreTab: (characterId: string | null) => void
  setEditorViewMode: (mode: EditorViewMode) => void
  setPreviewTheme: (next: PreviewTheme) => void
  flistOpenExportRestore: (characterId: string) => void
  flistCloseExportRestore: () => void
  markCharacterSeen: (name: string) => void
  /** The account the sign-in dialog pre-fills: the saved login's when
   *  there is one, otherwise the last account signed in with. */
  flistGetLastAccount: () => string
  /** Remember the account signed in with, for the next sign-in. */
  flistRememberAccount: (account: string) => void
  /** The F-list character last opened, as stored; null when none is. */
  flistLastCharacterId: () => string | null
  /** Remember the F-list character opened, to open it again next start. */
  flistRememberCharacter: (characterId: string) => void
  setFlistAutoRefreshEnabled: (on: boolean) => void
  /** Kept floored to whole hours, and to the minimum. */
  setFlistAutoRefreshHours: (hours: number) => void
}

/** The UI state as the window starts: defaults, overlaid with the
 *  preferences browser storage kept. Tests reset the slice with
 *  `useStore.setState(uiInitialState())`. */
export function uiInitialState(): UiState {
  const viewMode = readStored(EDITOR_VIEW_MODE_KEY)
  const theme = readStored(PREVIEW_THEME_KEY)
  return {
    mode: 'editor',
    editorActiveTab: 'description',
    editorViewMode:
      viewMode === 'split' || viewMode === 'preview' || viewMode === 'code' ? viewMode : 'split',
    previewTheme: theme === 'dark' || theme === 'default' || theme === 'light' ? theme : 'default',
    flistExportRestoreCharacterId: null,
    charLastSeen: readLastSeen(),
    flistAutoRefreshEnabled: readStored(AUTO_REFRESH_ENABLED_KEY) === 'true',
    flistAutoRefreshHours: autoRefreshHours(readStored(AUTO_REFRESH_HOURS_KEY))
  }
}

export const createUiSlice: SliceCreator<UiSlice> = (set, get) => ({
  ...uiInitialState(),

  setMode(mode) {
    set({ mode })
    if (mode !== 'logs') get().setCrossSearchOpen(false)
  },

  setEditorActiveTab(tab) {
    if (get().editorActiveTab === tab) return
    set({ editorActiveTab: tab })
    // Per character, so a Kinks-tab pin does not follow the user
    // between profiles (UX P3-11).
    writeStored(editorTabKey(get().flistActiveCharacterId), tab)
  },

  editorRestoreTab(characterId) {
    set({ editorActiveTab: readStored(editorTabKey(characterId)) || 'description' })
  },

  setEditorViewMode(mode) {
    if (get().editorViewMode === mode) return
    set({ editorViewMode: mode })
    writeStored(EDITOR_VIEW_MODE_KEY, mode)
  },

  setPreviewTheme(next) {
    writeStored(PREVIEW_THEME_KEY, next)
    set({ previewTheme: next })
  },

  flistOpenExportRestore(characterId) {
    set({ flistExportRestoreCharacterId: characterId })
  },

  flistCloseExportRestore() {
    set({ flistExportRestoreCharacterId: null })
  },

  markCharacterSeen(name) {
    const now = Date.now() / 1000
    set((s) => {
      const next = { ...s.charLastSeen, [name]: now }
      writeStored(LAST_SEEN_KEY, JSON.stringify(next))
      return { charLastSeen: next }
    })
  },

  flistGetLastAccount() {
    // Saved-creds account wins when present so the sign-in modal
    // pre-fills the username the user explicitly chose to remember.
    return get().flistSavedCreds.account || (readStored(LAST_ACCOUNT_KEY) ?? '')
  },

  flistRememberAccount(account) {
    writeStored(LAST_ACCOUNT_KEY, account)
  },

  flistLastCharacterId() {
    return readStored(LAST_CHARACTER_KEY)
  },

  flistRememberCharacter(characterId) {
    writeStored(LAST_CHARACTER_KEY, characterId)
  },

  setFlistAutoRefreshEnabled(on) {
    set({ flistAutoRefreshEnabled: on })
    writeStored(AUTO_REFRESH_ENABLED_KEY, on ? 'true' : 'false')
  },

  setFlistAutoRefreshHours(hours) {
    const kept = autoRefreshHours(String(hours))
    set({ flistAutoRefreshHours: kept })
    writeStored(AUTO_REFRESH_HOURS_KEY, String(kept))
  }
})
