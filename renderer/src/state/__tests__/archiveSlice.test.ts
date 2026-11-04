// The Archive slice: a character's Live, its Pulls, its Backups and
// Back up all, its Pool and its Trash. Seam: the one store, against the
// fake sidecar, asserting what the store holds and what it asked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { archiveInitialState } from '../slices/archive'
import type { FlistZipBackupEntry } from '../../lib/api'
import { installFakeApi, json, sse, type FakeApi } from '../../test/fakeApi'
import { archiveEntry, livePayload, workbenchPayload, workingSlot } from '../../test/payloads'

const CID = '42'
const NAME = 'Quill Marrow'
const BASE = `/flist/character/${CID}`
const OLD = '2026-09-01T080000Z.zip'
const NEW = '2026-10-01T120000Z.zip'

let fake: FakeApi

function backup(filename: string, name: string | null = null): FlistZipBackupEntry {
  return {
    filename,
    created_at: 1,
    size: 100,
    kind: 'manual_single',
    source: 'workbench',
    occasion: null,
    holds_profile: true,
    name
  }
}

/** The sidecar turning a request down, in its own words. */
function refused(message: string, status: number) {
  return json({ code: 'refused', message, details: {} }, status)
}

function poolOf(...ids: string[]) {
  return {
    [CID]: {
      byId: Object.fromEntries(ids.map((id) => [id, { extension: 'png', size: 1 }])),
      status: 'ready' as const
    }
  }
}

const archive = () => useStore.getState().flistArchive[CID]
const pool = () => Object.keys(useStore.getState().flistCharacterImages[CID]?.byId ?? {})
const asked = () => fake.requests.map((r) => `${r.method} ${r.path}`)

beforeEach(() => {
  fake = installFakeApi()
  useStore.setState({
    ...archiveInitialState(),
    flistWorking: {},
    flistViewingLive: {},
    flistActiveCharacterId: null,
    flistRoster: []
  })
})

afterEach(() => {
  fake.restore()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Live', () => {
  it('a character never pulled has no Backups, which is no error', async () => {
    fake.on(`GET ${BASE}/live`, refused('not found', 404))
    fake.on(
      `GET ${BASE}/zip-backups`,
      json({ code: 'character_not_found', message: 'no such character', details: {} }, 404)
    )

    await useStore.getState().flistLoadArchive(CID)

    expect(archive()).toMatchObject({ live: null, zipBackups: [], zipBackupsStatus: 'ready' })
  })

  it('a Backup list that cannot be read says so, beside the Live it read', async () => {
    fake.on(`GET ${BASE}/live`, json(livePayload({ fetched_at: 1700000000 })))
    fake.on(`GET ${BASE}/zip-backups`, refused('disk error', 500))

    await useStore.getState().flistLoadArchive(CID)

    expect(archive()?.live).not.toBeNull()
    expect(archive()?.lastPullAt).toBe(1700000000)
    expect(archive()?.zipBackupsStatus).toBe('error')
    expect(archive()?.zipBackupsError).toMatch(/disk error/)
  })
})

describe('the Pool', () => {
  it('lists the image files the sidecar keeps for the character', async () => {
    fake.on(
      `GET ${BASE}/images`,
      json({
        character_id: CID,
        images: [
          { image_id: '1001', extension: 'png', size: 10, added_at: 5 },
          { image_id: 'local-ab12cd34', extension: 'jpg', size: 20 }
        ]
      })
    )

    await useStore.getState().flistLoadCharacterImages(CID)

    expect(useStore.getState().flistCharacterImages[CID]).toEqual({
      byId: {
        '1001': { extension: 'png', size: 10, added_at: 5 },
        'local-ab12cd34': { extension: 'jpg', size: 20, added_at: undefined }
      },
      status: 'ready'
    })
  })

  it('keeps what it listed when the sidecar cannot be read', async () => {
    useStore.setState({ flistCharacterImages: poolOf('1001') })
    fake.on(`GET ${BASE}/images`, refused('down', 500))

    await useStore.getState().flistLoadCharacterImages(CID)

    expect(pool()).toEqual(['1001'])
    expect(useStore.getState().flistCharacterImages[CID].status).toBe('error')
  })

  it('an uploaded image joins the Pool', async () => {
    useStore.setState({ flistCharacterImages: poolOf('1001') })
    fake.on(
      `POST ${BASE}/images`,
      json({ image_id: 'local-ab12cd34', extension: 'png', size: 3, added_at: 9 })
    )

    const entry = await useStore.getState().flistUploadImage(CID, new Blob(['png']))

    expect(entry.image_id).toBe('local-ab12cd34')
    expect(pool().sort()).toEqual(['1001', 'local-ab12cd34'])
  })

  it('images only in the Pool go to the Trash without saving the Workbench', async () => {
    useStore.setState({
      flistCharacterImages: poolOf('1001', '1002', '1003'),
      flistWorking: { [CID]: workingSlot(workbenchPayload({ images: [] })) }
    })
    fake.on(
      `POST ${BASE}/images/trash`,
      json({
        trashed: [{ image_id: '1001', trash_id: 't1' }],
        not_found: ['1002'],
        off_gallery: [],
        etag: null
      })
    )

    const moved = await useStore.getState().flistTrashImages(CID, ['1001', '1002'])

    expect(moved).toEqual(['1001'])
    // Only what the sidecar moved leaves the Pool.
    expect(pool().sort()).toEqual(['1002', '1003'])
    expect(asked()).toEqual([`POST ${BASE}/images/trash`])
    expect(fake.requests[0].body).toEqual({ image_ids: ['1001', '1002'] })
    expect(useStore.getState().flistWorking[CID].etag).toBe('seed-etag')
  })

  it('a gallery image goes to the Trash and off the gallery the sidecar wrote', async () => {
    const images = [
      { image_id: '1001', description: '', sort_order: 0 },
      { image_id: '1002', description: '', sort_order: 1 }
    ]
    useStore.setState({
      flistCharacterImages: poolOf('1001', '1002'),
      flistWorking: { [CID]: workingSlot(workbenchPayload({ images })) }
    })
    fake.on(
      `POST ${BASE}/images/trash`,
      json({
        trashed: [{ image_id: '1001', trash_id: 't1' }],
        not_found: [],
        off_gallery: ['1001'],
        etag: 'after-trash'
      })
    )

    await useStore.getState().flistTrashImages(CID, ['1001'])

    const slot = useStore.getState().flistWorking[CID]
    expect(slot.etag).toBe('after-trash')
    expect(slot.payload.images).toEqual([{ image_id: '1002', description: '', sort_order: 0 }])
    expect(pool()).toEqual(['1002'])
  })

  it('a failed Trash request leaves the Pool as it was and says so', async () => {
    useStore.setState({ flistCharacterImages: poolOf('1001') })
    fake.on(`POST ${BASE}/images/trash`, refused('locked', 500))

    await expect(useStore.getState().flistTrashImages(CID, ['1001'])).rejects.toThrow(/locked/)

    expect(pool()).toEqual(['1001'])
  })

  it('trashing nothing asks the sidecar nothing', async () => {
    expect(await useStore.getState().flistTrashImages(CID, [])).toEqual([])
    expect(fake.requests).toEqual([])
  })
})

describe('the Backup list', () => {
  beforeEach(() => {
    useStore.setState({
      flistArchive: { [CID]: archiveEntry(livePayload(), { zipBackups: [backup(NEW), backup(OLD)] }) }
    })
  })

  it('a renamed Backup keeps its place in the list under its new name', async () => {
    fake.on(`PATCH ${BASE}/zip-backups/${NEW}`, json(backup(NEW, 'before the rewrite')))

    expect(await useStore.getState().flistRenameZipBackup(CID, NEW, 'before the rewrite')).toBe(true)

    expect(fake.requests[0].body).toEqual({ name: 'before the rewrite' })
    expect(archive()?.zipBackups?.map((b) => b.name)).toEqual(['before the rewrite', null])
  })

  it('a rename the sidecar refuses changes nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fake.on(`PATCH ${BASE}/zip-backups/${NEW}`, refused('no', 500))

    expect(await useStore.getState().flistRenameZipBackup(CID, NEW, 'x')).toBe(false)

    expect(archive()?.zipBackups?.map((b) => b.name)).toEqual([null, null])
  })

  it('a deleted Backup goes to the Trash and leaves the list', async () => {
    fake.on(`DELETE ${BASE}/zip-backups/${NEW}`, json(null, 204))
    fake.on(`GET ${BASE}/live`, json(livePayload()))
    const reread = new Promise<void>((resolve) => {
      fake.on(`GET ${BASE}/zip-backups`, () => {
        resolve()
        return json({ character_id: CID, backups: [backup(OLD)] })
      })
    })

    expect(await useStore.getState().flistDeleteZipBackup(CID, NEW)).toBe(true)

    expect(archive()?.zipBackups?.map((b) => b.filename)).toEqual([OLD])
    // The list is read again, in case another writer changed it too.
    await reread
    expect(asked()).toContain(`GET ${BASE}/zip-backups`)
  })

  it('downloads a Backup to the file the user picks', async () => {
    const written: { path: string; bytes: Uint8Array }[] = []
    const win = window as unknown as { workbench?: unknown }
    win.workbench = {
      saveFileDialog: async (opts: { defaultPath: string }) => `C:/out/${opts.defaultPath}`,
      writeFile: async (path: string, bytes: Uint8Array) => {
        written.push({ path, bytes })
        return true
      }
    }
    try {
      fake.on(`GET ${BASE}/zip-backups/${NEW}/download`, json('PK'))

      const saved = await useStore.getState().flistDownloadZipBackup(CID, NEW)

      expect(saved).toEqual({ path: `C:/out/${NEW}`, bytes: 4 })
      expect(written.map((w) => w.path)).toEqual([`C:/out/${NEW}`])
    } finally {
      delete win.workbench
    }
  })
})

describe('backing up one character', () => {
  beforeEach(() => {
    useStore.setState({
      flistRoster: [
        { id: Number(CID), name: NAME, on_account: true, has_archive: true, last_pulled_at: 1 } as never
      ],
      flistArchive: { [CID]: archiveEntry(livePayload(), { zipBackups: [backup(OLD)] }) }
    })
  })

  it('from the Workbench row writes a Backup without a Pull, and lists it', async () => {
    vi.useFakeTimers()
    fake.on(`POST ${BASE}/zip-backup`, json({ saved: true, filename: NEW }))
    fake.on(`GET ${BASE}/zip-backups`, json({ character_id: CID, backups: [backup(NEW), backup(OLD)] }))

    await useStore.getState().flistBackupCharacter(NAME, { pull: false })
    await vi.advanceTimersByTimeAsync(0)

    expect(asked()).toEqual([`POST ${BASE}/zip-backup`, `GET ${BASE}/zip-backups`])
    expect(useStore.getState().flistBackupAllStatus).toMatchObject({
      phase: 'done',
      total: 1,
      done: 1,
      saved: 1
    })
    expect(archive()?.zipBackups?.map((b) => b.filename)).toEqual([NEW, OLD])

    // The banner clears itself after a while.
    await vi.advanceTimersByTimeAsync(6000)
    expect(useStore.getState().flistBackupAllStatus.phase).toBe('idle')
  })

  it('a character the roster does not know is not backed up', async () => {
    await useStore.getState().flistBackupCharacter('Nobody Known', { pull: false })

    expect(fake.requests).toEqual([])
    expect(useStore.getState().flistBackupAllStatus).toMatchObject({
      phase: 'error',
      failed: 1,
      errorMessage: 'Could not resolve ID for Nobody Known'
    })
  })
})

describe('Back up all', () => {
  it('counts each character as it is saved, unchanged or failed', async () => {
    vi.useFakeTimers()
    fake.on(`GET ${BASE}/live`, json(livePayload()))
    fake.on(`GET ${BASE}/zip-backups`, json({ character_id: CID, backups: [] }))
    fake.on(
      'POST /flist/backup-all',
      sse(
        ['start', { total: 3 }],
        ['character', { name: NAME, status: 'fetching' }],
        ['character', { name: NAME, status: 'saved', character_id: CID }],
        ['character', { name: 'Second', status: 'unchanged' }],
        ['character', { name: 'Third', status: 'error' }],
        ['done', {}]
      )
    )

    await useStore.getState().flistBackupAll()

    expect(useStore.getState().flistBackupAllStatus).toMatchObject({
      phase: 'done',
      total: 3,
      done: 3,
      saved: 1,
      unchanged: 1,
      failed: 1,
      currentName: null
    })
    // A character saved has fresh Live on disk: the window reads it.
    expect(asked()).toContain(`GET ${BASE}/live`)
    await vi.advanceTimersByTimeAsync(6000)
    expect(useStore.getState().flistBackupAllStatus.phase).toBe('idle')
  })

  it('a second Back up all while one runs is not started', async () => {
    useStore.setState({
      flistBackupAllStatus: { ...archiveInitialState().flistBackupAllStatus, phase: 'running' }
    })

    await useStore.getState().flistBackupAll()

    expect(fake.requests).toEqual([])
  })
})

describe('what the Workbench asks of the Archive', () => {
  it('Live the window holds is handed over without asking the sidecar', async () => {
    useStore.setState({ flistArchive: { [CID]: archiveEntry(livePayload({ name: NAME })) } })

    expect(await useStore.getState().flistEnsureLive(CID)).toMatchObject({ name: NAME })
    expect(fake.requests).toEqual([])
  })

  it('Live the window does not hold yet is read once and kept', async () => {
    fake.on(`GET ${BASE}/live`, json(livePayload({ name: NAME })))

    expect(await useStore.getState().flistEnsureLive(CID)).toMatchObject({ name: NAME })
    expect(archive()).toMatchObject({ live: { name: NAME }, pullStatus: 'idle' })
    await useStore.getState().flistEnsureLive(CID)
    expect(asked()).toEqual([`GET ${BASE}/live`])
  })

  it('a character without Live has none to hand over', async () => {
    fake.on(`GET ${BASE}/live`, refused('not found', 404))

    expect(await useStore.getState().flistEnsureLive(CID)).toBeNull()
    expect(archive()).toBeUndefined()
  })

  it('ending a browse puts back the Live it stood in for, and goes nowhere', () => {
    const published = livePayload({ name: NAME })
    const browsed = livePayload({ name: 'as it was' })
    useStore.setState({
      flistArchive: { [CID]: archiveEntry(browsed) },
      flistBrowseBackup: {
        characterId: CID,
        filename: NEW,
        status: 'ready',
        payload: browsed,
        previousLive: published,
        previousViewingLive: false
      },
      flistViewingLive: { [CID]: true }
    })

    useStore.getState().flistEndBrowse()

    expect(useStore.getState().flistBrowseBackup).toBeNull()
    expect(archive()?.live).toBe(published)
    // What the window shows next is the caller's to decide.
    expect(useStore.getState().flistViewingLive[CID]).toBe(true)
    expect(fake.requests).toEqual([])
  })

  it('ending a browse when none is open changes nothing', () => {
    const before = useStore.getState().flistArchive
    useStore.getState().flistEndBrowse()
    expect(useStore.getState().flistArchive).toBe(before)
  })
})
