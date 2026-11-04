// Every call the window makes to the sidecar goes through one request
// function: a refusal is recognised by its code, not by its words, and
// a lost F-list session is recovered (or signalled) on every route.
// Driven through the store's actions against the fake sidecar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { bytes, installFakeApi, json, type FakeApi } from '../../test/fakeApi'
import { workbenchPayload, workingSlot } from '../../test/payloads'

const CID = '99'
const BENCH = `/flist/character/${CID}/workbench/payload`
const SAVE = `PUT ${BENCH}`
const READ = `GET ${BENCH}`
const AUTOSAVE_MS = 500

let fake: FakeApi
const store = () => useStore.getState()
const slotOf = () => store().flistWorking[CID]

beforeEach(() => {
  fake = installFakeApi()
  useStore.setState({
    flistWorking: {},
    flistExternalChange: {},
    flistMergeQuestion: {},
    flistArchive: {},
    flistActiveCharacterId: null,
    editorReadOnly: false
  })
})

afterEach(() => {
  fake.restore()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a Workbench save the sidecar refuses', () => {
  async function typeAndSave() {
    vi.useFakeTimers()
    useStore.setState({
      flistWorking: { [CID]: workingSlot(workbenchPayload({ character: { description: 'mine' } })) },
      flistActiveCharacterId: CID
    })
    // The merge reads the version on disk; hold it so the slot stays
    // where the refusal left it.
    fake.hold(READ)
    store().flistSetWorkingField(CID, 'character.description', 'mine, typed on')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
  }

  it.each(['etag_mismatch', 'etag_required'])(
    'opens the merge for %s, however the sidecar words it',
    async (code) => {
      fake.on(
        SAVE,
        json({ code, message: 'Somebody else got here first.', details: { current_etag: 'theirs' } }, 409)
      )

      await typeAndSave()

      expect(fake.requestsTo(READ)).toHaveLength(1)
      expect(store().flistExternalChange[CID]).toMatchObject({ etag: 'theirs' })
      expect(slotOf()).toMatchObject({ unsavedDirty: true, etag: 'seed-etag' })
      expect(slotOf().saveError).toMatch(/merging their version/i)
    }
  )

  it('shows any other refusal in the sidecar’s own words and merges nothing', async () => {
    fake.on(
      SAVE,
      json(
        { code: 'invalid_workbench_payload', message: 'payload has no profile content', details: {} },
        422
      )
    )

    await typeAndSave()

    expect(fake.requestsTo(READ)).toHaveLength(0)
    expect(store().flistExternalChange[CID]).toBeUndefined()
    expect(slotOf()).toMatchObject({
      saveStatus: 'error',
      saveError: 'payload has no profile content',
      unsavedDirty: true
    })
  })
})

// ---- a lost F-list session ---------------------------------------------

const SIGN_IN = 'POST /flist/session'
const BACKUP = `/flist/character/${CID}/zip-backups/kept.zip`
const sessionLost = (message = 'not signed in to F-list') =>
  json({ code: 'not_signed_in', message, details: {} }, 401)

type Workbench = Record<string, unknown>
const win = window as unknown as { workbench?: Workbench }

/** The window's keychain: a saved password with auto sign-in on, or
 *  (`autoLogin: false`) one only meant to pre-fill the sign-in modal. */
function keychain(autoLogin = true, extra: Workbench = {}) {
  win.workbench = {
    ...extra,
    creds: {
      getMeta: async () => ({
        account: 'Quill Account',
        autoLogin,
        encryptionAvailable: true,
        hasPassword: true
      }),
      getPassword: async () => 'pw'
    }
  }
}

function heard(name: string): () => number {
  let count = 0
  const listener = () => {
    count += 1
  }
  window.addEventListener(name, listener)
  listeners.push([name, listener])
  return () => count
}
const listeners: [string, () => void][] = []

afterEach(() => {
  for (const [name, listener] of listeners.splice(0)) window.removeEventListener(name, listener)
  delete win.workbench
})

const backupEntry = (name: string) => ({
  filename: 'kept.zip',
  created_at: 1,
  size: 10,
  kind: 'manual_single',
  source: 'workbench',
  occasion: 'manual',
  holds_profile: true,
  name
})

describe('a route refused because the F-list session is gone', () => {
  it('renaming a Backup signs back in once and renames it', async () => {
    keychain()
    const recovered = heard('flist-session-recovered')
    fake
      .once(`PATCH ${BACKUP}`, sessionLost())
      .on(`PATCH ${BACKUP}`, json(backupEntry('the good one')))
      .on(SIGN_IN, json({ characters: [], expires_in_sec: 1800, account: 'Quill Account' }))

    expect(await store().flistRenameZipBackup(CID, 'kept.zip', 'the good one')).toBe(true)

    expect(fake.requestsTo(SIGN_IN).map((r) => r.body)).toEqual([
      { account: 'Quill Account', password: 'pw' }
    ])
    expect(fake.requestsTo(`PATCH ${BACKUP}`).map((r) => r.body)).toEqual([
      { name: 'the good one' },
      { name: 'the good one' }
    ])
    expect(recovered()).toBe(1)
  })

  it('an image upload to the Pool signs back in and sends the same file again', async () => {
    keychain()
    const UPLOAD = `POST /flist/character/${CID}/images`
    const file = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
    fake
      .once(UPLOAD, sessionLost())
      .on(UPLOAD, json({ image_id: 'local-ab12', extension: 'png', size: 4 }))
      .on(SIGN_IN, json({ characters: [], expires_in_sec: 1800, account: 'Quill Account' }))

    const entry = await store().flistUploadImage(CID, file)

    expect(entry.image_id).toBe('local-ab12')
    const uploads = fake.requestsTo(UPLOAD)
    expect(uploads).toHaveLength(2)
    expect(uploads[1].body).toBe(file)
    expect(uploads[1].headers['Content-Type']).toBeUndefined()
    expect(store().flistCharacterImages[CID].byId['local-ab12']).toBeTruthy()
  })

  it('reading the Backup list signs back in once and lists them', async () => {
    keychain()
    const LIST = `GET /flist/character/${CID}/zip-backups`
    fake
      .once(LIST, sessionLost())
      .on(LIST, json({ character_id: CID, backups: [backupEntry('the good one')] }))
      .on(SIGN_IN, json({ characters: [], expires_in_sec: 1800, account: 'Quill Account' }))
    useStore.setState({ flistArchive: { [CID]: { live: null, pullStatus: 'idle' } } })

    await store().flistLoadBackups(CID)

    expect(fake.requestsTo(LIST)).toHaveLength(2)
    expect(fake.requestsTo(SIGN_IN)).toHaveLength(1)
    expect(store().flistArchive[CID].zipBackups?.map((b) => b.name)).toEqual(['the good one'])
  })

  it('without auto sign-in, a Backup download hears the session expired and signs nobody in', async () => {
    keychain(false, { saveFileDialog: async () => 'C:/out.zip', writeFile: async () => true })
    const expired = heard('flist-session-expired')
    fake.on(`GET ${BACKUP}/download`, sessionLost())

    expect(await store().flistDownloadZipBackup(CID, 'kept.zip')).toBeNull()

    expect(fake.requestsTo(SIGN_IN)).toHaveLength(0)
    expect(expired()).toBe(1)
  })

  it('a Workbench save whose sign-in did not take hears the session expired', async () => {
    vi.useFakeTimers()
    keychain()
    const expired = heard('flist-session-expired')
    fake
      .on(SAVE, sessionLost())
      .on(SIGN_IN, json({ characters: [], expires_in_sec: 1800, account: 'Quill Account' }))
    useStore.setState({
      flistWorking: { [CID]: workingSlot(workbenchPayload({ character: { description: 'mine' } })) }
    })
    store().flistSetWorkingField(CID, 'character.description', 'mine, typed on')

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)

    expect(fake.requestsTo(SAVE)).toHaveLength(2)
    expect(fake.requestsTo(SIGN_IN)).toHaveLength(1)
    expect(expired()).toBe(1)
    expect(slotOf()).toMatchObject({ saveStatus: 'error', unsavedDirty: true })
  })

  it('a 401 that is not about the F-list session neither signs in nor says the session expired', async () => {
    keychain()
    const expired = heard('flist-session-expired')
    fake.on(
      `PATCH ${BACKUP}`,
      json({ code: 'unauthorized', message: 'only the app window', details: {} }, 401)
    )

    expect(await store().flistRenameZipBackup(CID, 'kept.zip', 'x')).toBe(false)

    expect(fake.requestsTo(SIGN_IN)).toHaveLength(0)
    expect(expired()).toBe(0)
  })
})

describe('binary answers', () => {
  it('a Backup download writes the zip’s bytes where the user chose', async () => {
    const written: { path: string; data: Uint8Array }[] = []
    win.workbench = {
      saveFileDialog: async () => 'C:/out.zip',
      writeFile: async (path: string, data: Uint8Array) => {
        written.push({ path, data })
        return true
      }
    }
    fake.on(`GET ${BACKUP}/download`, bytes(new Uint8Array([80, 75, 3, 4, 9])))

    expect(await store().flistDownloadZipBackup(CID, 'kept.zip')).toEqual({
      path: 'C:/out.zip',
      bytes: 5
    })
    expect(written).toEqual([{ path: 'C:/out.zip', data: new Uint8Array([80, 75, 3, 4, 9]) }])
  })
})
