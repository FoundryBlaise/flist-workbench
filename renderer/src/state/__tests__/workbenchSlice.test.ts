// The Workbench slice where it meets the other slices: picking a
// character, leaving a browsed Backup, a sign-in that lapsed. Seam: the
// one store, against the fake sidecar, asserting what the store holds.
// The Workbench's own save, merge and undo paths have their own files
// (workingCopyActions, workbenchEvents, undo, fieldMerge ...).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { workbenchInitialState } from '../slices/workbench'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'
import {
  archiveEntry,
  livePayload,
  payloadRead,
  workbenchPayload,
  workingSlot
} from '../../test/payloads'

const A = '41'
const B = '42'
const BACKUP = '2026-10-01T120000Z.zip'
const PUBLISHED = livePayload({ character: { description: 'published' } })
const AS_IT_WAS = livePayload({ character: { description: 'as it was' } })

let fake: FakeApi

const described = (description: string) =>
  workbenchPayload({ _overlay: ['character.description'], character: { description } })

function backupOnDisk() {
  fake.on(
    `GET /flist/character/${A}/zip-backups/${BACKUP}/payload`,
    json({ payload: AS_IT_WAS, filename: BACKUP, meta: null })
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeApi()
  // Anything the test does not name (the next character's Live, its
  // Backups, its Workbench) is simply not there.
  fake.fallback(json({ code: 'not_found', message: 'not there', details: {} }, 404))
  useStore.setState({
    ...workbenchInitialState(),
    flistWorking: { [A]: workingSlot(described('my draft'), { etag: 'e1' }) },
    flistActiveCharacterId: A,
    editorContent: 'my draft',
    flistArchive: { [A]: archiveEntry(PUBLISHED) },
    flistBrowseBackup: null,
    flistRoster: [
      { id: A, name: 'Wren Ashdown' },
      { id: B, name: 'Bram Holloway' }
    ] as never,
    flistSession: { active: false } as never,
    activeCharacter: 'Wren Ashdown',
    activePartner: 'Someone',
    foreignActive: true
  })
})

afterEach(() => {
  fake.restore()
  vi.useRealTimers()
})

describe('switching character ends a browsed Backup', () => {
  it('the character left behind gets its Live back', async () => {
    backupOnDisk()
    await useStore.getState().flistOpenBrowseBackup(A, BACKUP)
    expect(useStore.getState().flistArchive[A].live).toEqual(AS_IT_WAS)

    await useStore.getState().flistSelectCharacter(B)

    const s = useStore.getState()
    expect(s.flistBrowseBackup).toBeNull()
    expect(s.flistArchive[A].live).toEqual(PUBLISHED)
    expect(s.flistActiveCharacterId).toBe(B)
  })

  it('also when the character is picked by name', async () => {
    backupOnDisk()
    await useStore.getState().flistOpenBrowseBackup(A, BACKUP)

    useStore.getState().selectCharacter('Bram Holloway')
    await vi.runAllTimersAsync()

    const s = useStore.getState()
    expect(s.flistBrowseBackup).toBeNull()
    expect(s.flistArchive[A].live).toEqual(PUBLISHED)
    expect(s.flistActiveCharacterId).toBe(B)
  })
})

describe('picking a character by name', () => {
  it('shows its Logs with no partner open, and leaves the Foreign profile', async () => {
    useStore.getState().selectCharacter('Bram Holloway')
    await vi.runAllTimersAsync()

    const s = useStore.getState()
    expect(s.activeCharacter).toBe('Bram Holloway')
    expect(s.activePartner).toBeNull()
    expect(s.foreignActive).toBe(false)
  })

  it('a character with Logs but no F-list profile closes the open character', () => {
    useStore.setState({ editorReadOnly: true })

    useStore.getState().selectCharacter('Only In Logs')

    const s = useStore.getState()
    expect(s.activeCharacter).toBe('Only In Logs')
    expect(s.flistActiveCharacterId).toBeNull()
    expect(s.editorReadOnly).toBe(false)
  })
})

describe('closing a browsed Backup opened from the Workbench', () => {
  it('makes the editor editable at once, before the Workbench is read again', async () => {
    backupOnDisk()
    await useStore.getState().flistOpenBrowseBackup(A, BACKUP)
    expect(useStore.getState().editorReadOnly).toBe(true)
    fake.hold(`GET /flist/character/${A}/workbench/payload?create=false`)

    useStore.getState().flistCloseBrowseBackup()

    expect(useStore.getState().editorReadOnly).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    const [read] = fake.pending()
    expect(useStore.getState().editorReadOnly).toBe(false)
    read.resolve(json(payloadRead(described('my draft'), 'e1')))
    await vi.runAllTimersAsync()
    expect(useStore.getState().editorContent).toBe('my draft')
  })
})
