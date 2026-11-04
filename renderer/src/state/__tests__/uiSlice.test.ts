// The UI slice: the window's layout and view choices, the dialogs it
// opens, and the preferences it keeps in browser storage. Seam: the
// one store, against the fake sidecar, and localStorage as the window
// leaves it for its next start.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { uiInitialState } from '../slices/ui'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'

let fake: FakeApi

beforeEach(() => {
  localStorage.clear()
  fake = installFakeApi()
  useStore.setState(uiInitialState())
})

afterEach(() => {
  fake.restore()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('preferences kept in browser storage', () => {
  it('starts with the defaults when nothing is stored', () => {
    const s = useStore.getState()
    expect(s.mode).toBe('editor')
    expect(s.editorActiveTab).toBe('description')
    expect(s.editorViewMode).toBe('split')
    expect(s.previewTheme).toBe('default')
    expect(s.charLastSeen).toEqual({})
    expect(s.flistExportRestoreCharacterId).toBeNull()
  })

  it('starts with what the window stored last time', () => {
    localStorage.setItem('flist-workbench:editor-view-mode', 'code')
    localStorage.setItem('workbench.previewTheme', 'light')
    localStorage.setItem('flist-workbench:char-last-seen', JSON.stringify({ Quill: 1700000000 }))

    useStore.setState(uiInitialState())

    const s = useStore.getState()
    expect(s.editorViewMode).toBe('code')
    expect(s.previewTheme).toBe('light')
    expect(s.charLastSeen).toEqual({ Quill: 1700000000 })
  })

  it('ignores stored values it does not know', () => {
    localStorage.setItem('flist-workbench:editor-view-mode', 'sideways')
    localStorage.setItem('workbench.previewTheme', 'neon')
    localStorage.setItem('flist-workbench:char-last-seen', '{not json')

    useStore.setState(uiInitialState())

    const s = useStore.getState()
    expect(s.editorViewMode).toBe('split')
    expect(s.previewTheme).toBe('default')
    expect(s.charLastSeen).toEqual({})
  })
})

/** The store as the window's next start finds it in browser storage. */
const restart = () => useStore.setState(uiInitialState())

describe('view choices', () => {
  it('keeps the Description view mode for the next start', () => {
    useStore.getState().setEditorViewMode('preview')
    expect(useStore.getState().editorViewMode).toBe('preview')

    useStore.setState({ editorViewMode: 'split' })
    restart()
    expect(useStore.getState().editorViewMode).toBe('preview')
  })

  it('keeps the preview theme for the next start', () => {
    useStore.getState().setPreviewTheme('dark')
    expect(useStore.getState().previewTheme).toBe('dark')

    useStore.setState({ previewTheme: 'default' })
    restart()
    expect(useStore.getState().previewTheme).toBe('dark')
  })

  it('switches the editor tab without storing it', () => {
    useStore.getState().setEditorActiveTab('kinks')
    expect(useStore.getState().editorActiveTab).toBe('kinks')

    restart()
    expect(useStore.getState().editorActiveTab).toBe('description')
  })

  it('keeps the editor tab per character, for when it is opened again', () => {
    useStore.setState({ flistActiveCharacterId: '7' })
    useStore.getState().setEditorActiveTab('kinks')

    useStore.setState({ flistActiveCharacterId: '8' })
    useStore.getState().editorRestoreTab('8')
    expect(useStore.getState().editorActiveTab).toBe('description')

    restart()
    useStore.getState().editorRestoreTab('7')
    expect(useStore.getState().editorActiveTab).toBe('kinks')
  })

  it('keeps the sign-in auto-refresh for the next start, at least every 24 hours', () => {
    expect(useStore.getState().flistAutoRefreshEnabled).toBe(false)
    expect(useStore.getState().flistAutoRefreshHours).toBe(24)

    useStore.getState().setFlistAutoRefreshEnabled(true)
    useStore.getState().setFlistAutoRefreshHours(6)
    expect(useStore.getState().flistAutoRefreshHours).toBe(24)
    useStore.getState().setFlistAutoRefreshHours(48.7)

    restart()
    expect(useStore.getState().flistAutoRefreshEnabled).toBe(true)
    expect(useStore.getState().flistAutoRefreshHours).toBe(48)
  })

  it('closes cross search when the window leaves the Logs pane, and only then', () => {
    useStore.getState().setMode('logs')
    useStore.getState().setCrossSearchOpen(true)

    useStore.getState().setMode('logs')
    expect(useStore.getState().crossSearchOpen).toBe(true)

    useStore.getState().setMode('editor')
    expect(useStore.getState().mode).toBe('editor')
    expect(useStore.getState().crossSearchOpen).toBe(false)
  })

  it('opens and closes the export preview for one character', () => {
    useStore.getState().flistOpenExportRestore('99')
    expect(useStore.getState().flistExportRestoreCharacterId).toBe('99')

    useStore.getState().flistCloseExportRestore()
    expect(useStore.getState().flistExportRestoreCharacterId).toBeNull()
  })
})

describe('remembered across starts', () => {
  it('keeps when the Log tab of each character was last opened', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_500_000)

    useStore.getState().markCharacterSeen('Quill')

    expect(useStore.getState().charLastSeen).toEqual({ Quill: 1_700_000_500 })
    useStore.setState({ charLastSeen: {} })
    restart()
    expect(useStore.getState().charLastSeen).toEqual({ Quill: 1_700_000_500 })
  })

  it('pre-fills the sign-in with the last account signed in with', async () => {
    useStore.setState({
      flistSignInOpen: true,
      flistSignInAttempt: { status: 'idle' },
      flistSavedCreds: { account: null, autoLogin: false, encryptionAvailable: false, hasPassword: false }
    })
    fake
      .on('POST /flist/session', json({ characters: [], expires_in_sec: 1800, account: 'Quill Account' }))
      .on('GET /flist/characters', json({ characters: [] }))
      .on('GET /settings', json({ fchat_data_dir: null, image_import_roots: [] }))

    expect(useStore.getState().flistGetLastAccount()).toBe('')
    await useStore.getState().flistSignIn('Quill Account', 'pw')

    restart()
    expect(useStore.getState().flistGetLastAccount()).toBe('Quill Account')
  })

  it('pre-fills the sign-in with the saved login over the last account', () => {
    localStorage.setItem('flist-workbench:last-account', 'Old Account')
    useStore.setState({
      flistSavedCreds: { account: 'Saved Account', autoLogin: true, encryptionAvailable: true, hasPassword: true }
    })

    expect(useStore.getState().flistGetLastAccount()).toBe('Saved Account')
  })

  it('opens the character opened last once the roster is read', async () => {
    fake
      .on('GET /flist/character/99/live', json({ fetched_at: 1700000000 }))
      .on('GET /flist/character/99/zip-backups', json({ backups: [] }))
    useStore.setState({ flistActiveCharacterId: null, flistBrowseBackup: null })
    await useStore.getState().flistSelectCharacter('99')

    // Next start: nothing open, the roster names the character again.
    useStore.setState({ flistActiveCharacterId: null, activeCharacter: null })
    restart()
    const quill = {
      name: 'Quill',
      id: 99,
      on_account: true,
      has_archive: true,
      has_logs: false,
      last_pulled_at: null,
      backup_count: 0
    }
    fake
      .on('GET /flist/characters', json({ characters: [quill] }))
      .fallback(json({}))
    await useStore.getState().flistLoadRoster()

    expect(useStore.getState().activeCharacter).toBe('Quill')
    expect(useStore.getState().flistActiveCharacterId).toBe('99')
  })
})
