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
}

export type UiSlice = UiState & {
  /** Leaving the Logs pane closes its cross search. */
  setMode: (mode: Mode) => void
  setEditorActiveTab: (tab: string) => void
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
    charLastSeen: readLastSeen()
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
  }
})
