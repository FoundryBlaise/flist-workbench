// The character zone has two rows: Live on F-List and the Workbench.
// Which one the window shows is the window's own business. It used to
// go through a pointer on the sidecar ("the active set"), so looking at
// Live wrote to disk and a second window or a model could flip the
// view under the user. A character has one Workbench now; there is
// nothing on disk to point at.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'
import {
  archiveEntry,
  livePayload,
  payloadRead,
  workbenchPayload,
  workingSlot
} from '../../test/payloads'

const CID = '99'
const BENCH_URL = `/flist/character/${CID}/workbench/payload`
const READ = `GET ${BENCH_URL}?create=false`
const SAVE = `PUT ${BENCH_URL}`

let fake: FakeApi

const described = (description: string) =>
  workbenchPayload({ _overlay: ['character.description'], character: { description } })

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeApi()
  useStore.setState({
    flistWorking: { [CID]: workingSlot(described('my draft'), { etag: 'e1' }) },
    flistViewingLive: {},
    flistWorkbenchInfo: {},
    flistExternalChange: {},
    flistMergeQuestion: {},
    flistArchive: {
      [CID]: archiveEntry(livePayload({ character: { description: 'published' } }))
    },
    flistRoster: [{ id: CID, name: 'Wren Ashdown' }] as never,
    flistActiveCharacterId: CID,
    flistBrowseBackup: null,
    flistRestoreRefusal: {},
    editorReadOnly: false,
    editorContent: 'my draft',
    editorDirty: false
  })
})

afterEach(() => {
  fake.restore()
  vi.useRealTimers()
})

describe('the Live row', () => {
  it('shows Live read-only and asks the sidecar nothing', async () => {
    await useStore.getState().flistShowLive(CID)

    const s = useStore.getState()
    expect(s.flistViewingLive[CID]).toBe(true)
    expect(s.editorReadOnly).toBe(true)
    expect(s.editorContent).toBe('published')
    expect(fake.requests).toEqual([])
  })

  it('saves what was typed into the Workbench before showing Live', async () => {
    fake.on(SAVE, json({ etag: 'e2' }))
    useStore.getState().setEditorContent('typed just now')

    await useStore.getState().flistShowLive(CID)

    const puts = fake.requestsTo(SAVE)
    expect(puts).toHaveLength(1)
    expect(puts[0].headers['If-Match']).toBe('e1')
    expect(useStore.getState().editorContent).toBe('published')
  })

  it('keeps edits that could not be saved on screen instead of showing Live', async () => {
    fake.on(
      SAVE,
      json({ code: 'etag_mismatch', message: 'changed', details: { current_etag: 'theirs' } }, 409)
    )
    useStore.getState().setEditorContent('typed just now')

    await useStore.getState().flistShowLive(CID)

    const s = useStore.getState()
    expect(s.flistViewingLive[CID]).not.toBe(true)
    expect(s.editorReadOnly).toBe(false)
    expect(s.flistWorking[CID].unsavedDirty).toBe(true)
    expect(s.editorContent).toBe('typed just now')
  })
})

describe('the Workbench row', () => {
  it('reads the Workbench again and makes the editor editable', async () => {
    fake.on(READ, json(payloadRead(described('my draft'), 'e1')))
    await useStore.getState().flistShowLive(CID)

    await useStore.getState().flistOpenWorking(CID)

    const s = useStore.getState()
    expect(s.flistViewingLive[CID]).toBe(false)
    expect(s.editorReadOnly).toBe(false)
    expect(s.editorContent).toBe('my draft')
    expect(s.flistWorking[CID].etag).toBe('e1')
    expect(fake.requests.map((r) => r.path).filter((p) => !p.startsWith(BENCH_URL))).toEqual([])
  })

  it('knows when the Workbench was last changed, without a list of drafts', async () => {
    fake.on(
      `GET /flist/character/${CID}/workbench?create=false`,
      json({ workbench: { name: 'Workbench', created_at: 100, updated_at: 200 } })
    )

    await useStore.getState().flistLoadWorkbenchInfo(CID)

    expect(useStore.getState().flistWorkbenchInfo[CID]).toEqual({ updatedAt: 200 })
  })

  it('knows when there is no Workbench yet', async () => {
    fake.on(
      `GET /flist/character/${CID}/workbench?create=false`,
      json({ workbench: null, reason: 'not_created_yet' })
    )

    await useStore.getState().flistLoadWorkbenchInfo(CID)

    expect(useStore.getState().flistWorkbenchInfo[CID]).toBeNull()
  })
})

describe('browsing a Backup', () => {
  const BACKUP = '2026-10-01T120000Z.zip'

  function backupOnDisk() {
    fake.on(
      `GET /flist/character/${CID}/zip-backups/${BACKUP}/payload`,
      json({
        payload: livePayload({ character: { description: 'as it was' } }),
        filename: BACKUP,
        meta: null
      })
    )
  }

  it('returns to the Workbench it was opened from', async () => {
    backupOnDisk()
    fake.on(READ, json(payloadRead(described('my draft'), 'e1')))

    await useStore.getState().flistOpenBrowseBackup(CID, BACKUP)
    expect(useStore.getState().editorContent).toBe('as it was')
    useStore.getState().flistCloseBrowseBackup()
    await vi.runAllTimersAsync()

    const s = useStore.getState()
    expect(s.flistViewingLive[CID]).toBe(false)
    expect(s.editorReadOnly).toBe(false)
    expect(s.editorContent).toBe('my draft')
  })

  it('returns to Live it was opened from', async () => {
    backupOnDisk()
    await useStore.getState().flistShowLive(CID)

    await useStore.getState().flistOpenBrowseBackup(CID, BACKUP)
    useStore.getState().flistCloseBrowseBackup()
    await vi.runAllTimersAsync()

    const s = useStore.getState()
    expect(s.flistViewingLive[CID]).toBe(true)
    expect(s.editorReadOnly).toBe(true)
    expect(s.editorContent).toBe('published')
    expect(fake.requestsTo(READ)).toEqual([])
  })
})

describe('Restore', () => {
  it('puts the restored Workbench in the editor while the Workbench is shown', async () => {
    fake.on(
      `POST /flist/character/${CID}/workbench/load-backup`,
      json({
        workbench: { id: 'b1', name: 'Workbench', created_at: 100, updated_at: 300 },
        ...payloadRead(described('from the Backup'), 'e9'),
        loaded: '2026-10-01T120000Z.zip',
        backed_up_first: null
      })
    )

    const ok = await useStore
      .getState()
      .flistLoadBackupIntoWorkbench(CID, '2026-10-01T120000Z.zip')

    expect(ok).toBe(true)
    const s = useStore.getState()
    expect(s.editorContent).toBe('from the Backup')
    expect(s.flistWorking[CID].etag).toBe('e9')
    expect(s.flistWorkbenchInfo[CID]).toEqual({ updatedAt: 300 })
    expect(s.flistViewingLive[CID]).toBe(false)
    expect(s.editorReadOnly).toBe(false)
  })

  it('keeps the reason a Restore was turned down, and the Workbench as it was', async () => {
    fake.on(
      `POST /flist/character/${CID}/workbench/load-backup`,
      json(
        {
          code: 'backup_holds_no_profile',
          message: 'This Backup keeps older files, not a profile.'
        },
        409
      )
    )

    const ok = await useStore
      .getState()
      .flistLoadBackupIntoWorkbench(CID, '2026-10-01T120000Z.zip')

    expect(ok).toBe(false)
    const s = useStore.getState()
    expect(s.flistRestoreRefusal[CID]).toBe('This Backup keeps older files, not a profile.')
    expect(s.editorContent).toBe('my draft')
    expect(s.flistWorking[CID].etag).toBe('e1')
  })

  it('forgets an earlier refusal once a Restore goes through', async () => {
    useStore.setState({ flistRestoreRefusal: { [CID]: 'turned down before' } })
    fake.on(
      `POST /flist/character/${CID}/workbench/load-backup`,
      json({
        workbench: { id: 'b1', name: 'Workbench', created_at: 100, updated_at: 300 },
        ...payloadRead(described('from the Backup'), 'e9'),
        loaded: '2026-10-01T120000Z.zip',
        backed_up_first: null
      })
    )

    await useStore.getState().flistLoadBackupIntoWorkbench(CID, '2026-10-01T120000Z.zip')

    expect(useStore.getState().flistRestoreRefusal[CID]).toBeNull()
  })

  it('switches from Live to the restored Workbench', async () => {
    fake.on(
      `POST /flist/character/${CID}/workbench/load-backup`,
      json({
        workbench: { id: 'b1', name: 'Workbench', created_at: 100, updated_at: 300 },
        ...payloadRead(described('from the Backup'), 'e9'),
        loaded: '2026-10-01T120000Z.zip',
        backed_up_first: null
      })
    )
    await useStore.getState().flistShowLive(CID)

    await useStore.getState().flistLoadBackupIntoWorkbench(CID, '2026-10-01T120000Z.zip')

    const s = useStore.getState()
    expect(s.flistViewingLive[CID]).toBe(false)
    expect(s.editorContent).toBe('from the Backup')
    expect(s.editorReadOnly).toBe(false)
  })
})
