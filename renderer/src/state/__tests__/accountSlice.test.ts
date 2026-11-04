// The Account slice: the F-list session, signing in and out, the saved
// login and auto-login, the roster and the account-wide Refresh all.
// Seam: the one store against the fake sidecar; the saved login sits
// behind the window's keychain bridge (`window.workbench.creds`), which
// a test stubs where it needs one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { accountInitialState } from '../slices/account'
import { installFakeApi, json, sse, type FakeApi } from '../../test/fakeApi'
import { archiveEntry, workbenchPayload, workingSlot } from '../../test/payloads'

const SIGN_IN = 'POST /flist/session'
const SIGN_OUT = 'DELETE /flist/session'
const SESSION = 'GET /flist/session'
const ROSTER = 'GET /flist/characters'
const MAPPING = 'GET /flist/mapping-list'

let fake: FakeApi

const signedIn = (account = 'Quill Account') =>
  json({
    characters: [{ id: 7, name: 'Quill' }],
    expires_in_sec: 1800,
    account
  })

function rosterEntry(id: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    on_account: true,
    has_archive: true,
    has_logs: false,
    last_pulled_at: null,
    backup_count: 0,
    ...extra
  }
}

const mappingList = (etag: string) => json({ kinks: {}, _etag: etag, _fetched_at: 1_700_000_000 })

type Creds = {
  getMeta: ReturnType<typeof vi.fn>
  getPassword: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  setAutoLogin: ReturnType<typeof vi.fn>
  clear: ReturnType<typeof vi.fn>
}

/** The window's keychain bridge, holding `saved` as its login. */
function stubKeychain(saved: { account: string | null; autoLogin: boolean; password: string | null }): Creds {
  const meta = () => ({
    account: saved.account,
    autoLogin: saved.autoLogin,
    encryptionAvailable: true,
    hasPassword: saved.password !== null
  })
  const creds: Creds = {
    getMeta: vi.fn(async () => meta()),
    getPassword: vi.fn(async () => saved.password),
    save: vi.fn(async (p: { account: string; password: string; autoLogin: boolean }) => {
      saved = { account: p.account, autoLogin: p.autoLogin, password: p.password }
      return true
    }),
    setAutoLogin: vi.fn(async (next: boolean) => {
      saved = { ...saved, autoLogin: next }
      return true
    }),
    clear: vi.fn(async () => {
      saved = { account: null, autoLogin: false, password: null }
      return true
    })
  }
  ;(window as unknown as { workbench?: unknown }).workbench = { creds }
  return creds
}

const requestIndex = (route: string) =>
  fake.requests.findIndex((r) => `${r.method} ${r.path.split('?')[0]}` === route)

beforeEach(() => {
  localStorage.clear()
  fake = installFakeApi()
  useStore.setState({
    ...accountInitialState(),
    flistArchive: {},
    flistWorking: {},
    flistActiveCharacterId: null,
    editorReadOnly: false
  })
})

afterEach(() => {
  fake.restore()
  ;(window as unknown as { workbench?: unknown }).workbench = undefined
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('signing in', () => {
  it('opens the session, lists the account characters and reads the roster', async () => {
    fake.on(SIGN_IN, signedIn()).on(ROSTER, json({ characters: [rosterEntry(7, 'Quill')] }))
    useStore.getState().flistOpenSignIn()

    await useStore.getState().flistSignIn('Quill Account', 'pw')

    const s = useStore.getState()
    expect(fake.requestsTo(SIGN_IN)[0].body).toEqual({ account: 'Quill Account', password: 'pw' })
    expect(s.flistSession).toEqual({ active: true, account: 'Quill Account', expires_in_sec: 1800 })
    expect(s.flistAccountCharacters).toEqual([{ id: 7, name: 'Quill' }])
    expect(s.flistRoster.map((r) => r.name)).toEqual(['Quill'])
    expect(s.flistRosterStatus).toBe('ready')
    expect(s.flistSignInOpen).toBe(false)
    expect(s.flistSignInStatus).toBe('idle')
  })

  it('a refused sign-in keeps the dialog open with the sidecar’s words', async () => {
    fake.on(
      SIGN_IN,
      json({ code: 'sign_in_failed', message: 'Invalid account name or password', details: {} }, 401)
    )
    useStore.getState().flistOpenSignIn()

    await useStore.getState().flistSignIn('Quill Account', 'wrong')

    const s = useStore.getState()
    expect(s.flistSignInStatus).toBe('error')
    expect(s.flistSignInError).toBe('Invalid account name or password')
    expect(s.flistSignInErrorCode).toBe('sign_in_failed')
    expect(s.flistSignInOpen).toBe(true)
    expect(s.flistSession.active).toBe(false)
    expect(fake.requestsTo(ROSTER)).toEqual([])
  })

  it('clears the Pull errors left from before the session', async () => {
    fake.on(SIGN_IN, signedIn()).on(ROSTER, json({ characters: [] }))
    useStore.setState({
      flistArchive: { '7': archiveEntry(null, { pullStatus: 'error', pullError: 'Not signed in.' }) }
    })

    await useStore.getState().flistSignIn('Quill Account', 'pw')

    expect(useStore.getState().flistArchive['7'].pullError).toBeNull()
  })

  it('reads the mapping list again unless it already has one', async () => {
    fake.on(SIGN_IN, signedIn()).on(ROSTER, json({ characters: [] })).on(MAPPING, mappingList('m1'))
    useStore.setState({
      flistMapping: { status: 'error', payload: null, fetchedAt: null, etag: null, error: 'HTTP 401' }
    })
    await useStore.getState().flistSignIn('Quill Account', 'pw')
    expect(useStore.getState().flistMapping.status).toBe('idle')

    await useStore.getState().flistLoadMapping()
    await useStore.getState().flistSignIn('Quill Account', 'pw')
    expect(useStore.getState().flistMapping).toMatchObject({ status: 'ready', etag: 'm1' })
  })
})

describe('signing out', () => {
  function signInState() {
    useStore.setState({
      flistSession: { active: true, account: 'Quill Account', expires_in_sec: 1800 },
      flistAccountCharacters: [{ id: 7, name: 'Quill' } as never],
      flistMapping: { status: 'ready', payload: { _etag: 'm1', _fetched_at: 1 }, fetchedAt: 1, etag: 'm1', error: null },
      flistWorking: { '7': workingSlot(workbenchPayload({ character: { description: 'saved' } })) },
      flistActiveCharacterId: '7'
    })
  }

  it('ends the session and forgets what the account had open', async () => {
    signInState()
    fake.on(SIGN_OUT, json({ signed_out: true })).on(ROSTER, json({ characters: [] }))

    await useStore.getState().flistSignOut()

    const s = useStore.getState()
    expect(fake.requestsTo(SIGN_OUT)).toHaveLength(1)
    expect(s.flistSession).toEqual({ active: false })
    expect(s.flistAccountCharacters).toEqual([])
    expect(s.flistMapping).toEqual({ status: 'idle', payload: null, fetchedAt: null, etag: null, error: null })
    expect(s.flistWorking).toEqual({})
    expect(s.flistActiveCharacterId).toBeNull()
    expect(fake.requestsTo(ROSTER)).toHaveLength(1)
  })

  it('saves a pending Workbench edit before the session ends', async () => {
    signInState()
    fake
      .on('PUT /flist/character/7/workbench/payload', json({ etag: 'flushed' }))
      .on(SIGN_OUT, json({ signed_out: true }))
      .on(ROSTER, json({ characters: [] }))
    useStore.getState().flistSetWorkingField('7', 'character.description', 'typed')

    await useStore.getState().flistSignOut()

    const save = requestIndex('PUT /flist/character/7/workbench/payload')
    expect(save).toBeGreaterThanOrEqual(0)
    expect(save).toBeLessThan(requestIndex(SIGN_OUT))
  })

  it('cancels a running Pull and Back up all before the session ends', async () => {
    signInState()
    useStore.setState({
      flistArchive: { '7': archiveEntry(null, { pullStatus: 'running', pullJobId: 'j1' }) },
      flistBackupAllStatus: {
        phase: 'running',
        total: 2,
        done: 0,
        saved: 0,
        unchanged: 0,
        failed: 0,
        currentName: 'Quill',
        errorMessage: null,
        jobId: 'j2'
      }
    })
    fake
      .on('DELETE /jobs/j1', json({}))
      .on('DELETE /jobs/j2', json({}))
      .on(SIGN_OUT, json({ signed_out: true }))
      .on(ROSTER, json({ characters: [] }))

    await useStore.getState().flistSignOut()

    expect(requestIndex('DELETE /jobs/j1')).toBeLessThan(requestIndex(SIGN_OUT))
    expect(requestIndex('DELETE /jobs/j2')).toBeLessThan(requestIndex(SIGN_OUT))
  })

  it('drops a mapping list that answers after the session ended', async () => {
    signInState()
    useStore.setState({ flistMapping: accountInitialState().flistMapping })
    fake.hold(MAPPING).on(SIGN_OUT, json({ signed_out: true })).on(ROSTER, json({ characters: [] }))

    const load = useStore.getState().flistLoadMapping()
    await useStore.getState().flistSignOut()
    fake.pending(MAPPING)[0].resolve(mappingList('old-account'))
    await load

    expect(useStore.getState().flistMapping).toMatchObject({ status: 'idle', payload: null })
  })
})

describe('the mapping list', () => {
  it('two loads at once share one read', async () => {
    fake.hold(MAPPING)

    const first = useStore.getState().flistLoadMapping()
    const second = useStore.getState().flistLoadMapping()
    expect(fake.requestsTo(MAPPING)).toHaveLength(1)
    expect(useStore.getState().flistMapping.status).toBe('loading')

    fake.pending(MAPPING)[0].resolve(mappingList('m1'))
    await Promise.all([first, second])
    expect(useStore.getState().flistMapping).toMatchObject({ status: 'ready', etag: 'm1', fetchedAt: 1_700_000_000 })
  })

  it('a forced load reads again, and says so', async () => {
    fake.on(MAPPING, mappingList('m1'))
    await useStore.getState().flistLoadMapping()
    fake.on('GET /flist/mapping-list?force=true', mappingList('m2'))

    await useStore.getState().flistLoadMapping({ force: true })

    expect(fake.requestsTo('GET /flist/mapping-list?force=true')).toHaveLength(1)
    expect(useStore.getState().flistMapping.etag).toBe('m2')
  })
})

describe('the session and the roster', () => {
  it('a lapsed session closes the character open in the window', async () => {
    useStore.setState({
      flistSession: { active: true, account: 'Quill Account', expires_in_sec: 1800 },
      flistActiveCharacterId: '7',
      editorReadOnly: true
    })
    fake.on(SESSION, json({ active: false }))

    await useStore.getState().flistRefreshSession()

    const s = useStore.getState()
    expect(s.flistSession).toEqual({ active: false })
    expect(s.flistActiveCharacterId).toBeNull()
    expect(s.editorReadOnly).toBe(false)
  })

  it('an unreachable sidecar leaves the session as it was', async () => {
    useStore.setState({ flistSession: { active: true, account: 'Quill Account', expires_in_sec: 1800 } })
    fake.on(SESSION, json({ detail: 'boom' }, 500))

    await useStore.getState().flistRefreshSession()

    expect(useStore.getState().flistSession.active).toBe(true)
  })

  it('the roster carries each character’s Pull integrity into its archive entry', async () => {
    fake.on(
      ROSTER,
      json({
        characters: [
          rosterEntry(7, 'Quill', { pull_status: { status: 'partial', missing_image_ids: ['a', 'b'] } })
        ]
      })
    )

    await useStore.getState().flistLoadRoster()

    expect(useStore.getState().flistArchive['7'].integrity).toEqual({ status: 'partial', missing: 2 })
  })

  it('a roster read that fails says so', async () => {
    fake.on(ROSTER, json({ detail: 'boom' }, 500))

    await useStore.getState().flistLoadRoster()

    expect(useStore.getState().flistRosterStatus).toBe('error')
  })
})

describe('the saved login', () => {
  it('auto-login signs in with the saved account and leaves the keychain alone', async () => {
    const creds = stubKeychain({ account: 'Quill Account', autoLogin: true, password: 'pw' })
    fake.on(SIGN_IN, signedIn()).on(ROSTER, json({ characters: [] }))

    await useStore.getState().flistLoadSavedCreds()
    const attempted = await useStore.getState().flistAttemptAutoLogin()

    expect(attempted).toBe(true)
    expect(fake.requestsTo(SIGN_IN)[0].body).toEqual({ account: 'Quill Account', password: 'pw' })
    expect(useStore.getState().flistSession.active).toBe(true)
    expect(useStore.getState().flistAutoLoginInFlight).toBe(false)
    expect(creds.save).not.toHaveBeenCalled()
    expect(creds.clear).not.toHaveBeenCalled()
  })

  it('makes no attempt when auto-login is off', async () => {
    stubKeychain({ account: 'Quill Account', autoLogin: false, password: 'pw' })

    await useStore.getState().flistLoadSavedCreds()
    const attempted = await useStore.getState().flistAttemptAutoLogin()

    expect(attempted).toBe(false)
    expect(fake.requestsTo(SIGN_IN)).toEqual([])
  })

  it('signing in with Remember password saves the login, and without it removes one', async () => {
    const creds = stubKeychain({ account: null, autoLogin: false, password: null })
    fake.on(SIGN_IN, signedIn()).on(ROSTER, json({ characters: [] }))

    await useStore.getState().flistSignIn('Quill Account', 'pw', { rememberPassword: true })
    expect(creds.save).toHaveBeenCalledWith({ account: 'Quill Account', password: 'pw', autoLogin: false })
    expect(useStore.getState().flistSavedCreds).toMatchObject({ account: 'Quill Account', hasPassword: true })

    await useStore.getState().flistSignIn('Quill Account', 'pw', { rememberPassword: false })
    expect(creds.clear).toHaveBeenCalled()
    expect(useStore.getState().flistSavedCreds).toMatchObject({ account: null, hasPassword: false })
  })

  it('turns auto-login on and off, and removes the saved login', async () => {
    stubKeychain({ account: 'Quill Account', autoLogin: false, password: 'pw' })

    await useStore.getState().flistSetSavedAutoLogin(true)
    expect(useStore.getState().flistSavedCreds.autoLogin).toBe(true)

    await useStore.getState().flistClearSavedCreds()
    expect(useStore.getState().flistSavedCreds).toMatchObject({ account: null, autoLogin: false, hasPassword: false })
  })
})

describe('Refresh all', () => {
  const pullOf = (name: string) => `POST /flist/character/${encodeURIComponent(name)}/pull`

  it('pulls every character on the account, and only those', async () => {
    useStore.setState({
      flistSession: { active: true, account: 'Quill Account', expires_in_sec: 1800 },
      flistRoster: [
        rosterEntry(7, 'Quill'),
        rosterEntry(8, 'Wren', { last_pulled_at: Date.now() / 1000 }),
        rosterEntry(9, 'Fennick', { on_account: false })
      ] as never
    })
    fake.on(/^POST \/flist\/character\/[^/]+\/pull/, sse())

    await useStore.getState().flistRefreshAllAccount()

    expect(fake.requestsTo(pullOf('Quill'))).toHaveLength(1)
    expect(fake.requestsTo(pullOf('Wren'))).toHaveLength(1)
    expect(fake.requestsTo(pullOf('Fennick'))).toEqual([])
    expect(useStore.getState().flistAccountSweepStatus).toBe('idle')
  })

  it('a second Refresh all while one runs does nothing', async () => {
    useStore.setState({
      flistSession: { active: true, account: 'Quill Account', expires_in_sec: 1800 },
      flistRoster: [rosterEntry(7, 'Quill')] as never
    })
    fake.hold(pullOf('Quill'))

    const first = useStore.getState().flistRefreshAllAccount()
    await vi.waitFor(() => expect(fake.pending(pullOf('Quill'))).toHaveLength(1))
    expect(useStore.getState().flistAccountSweepStatus).toBe('running')
    await useStore.getState().flistRefreshAllAccount()
    expect(fake.requestsTo(pullOf('Quill'))).toHaveLength(1)

    fake.pending(pullOf('Quill'))[0].resolve(sse())
    await first
    expect(useStore.getState().flistAccountSweepStatus).toBe('idle')
  })

  it('pulls nothing while signed out', async () => {
    useStore.setState({ flistRoster: [rosterEntry(7, 'Quill')] as never })

    await useStore.getState().flistRefreshAllAccount()

    expect(fake.requests).toEqual([])
  })
})
