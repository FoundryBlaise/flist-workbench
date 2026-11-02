// Tier 4 — flistResetWorkingToBackup integration. Covers:
// - lazy backup load via api.flistSnapshotRead when cache miss
// - PUT seeded-from-backup over the Workbench's etag, with undo stashed
// - drain in-flight save so a mid-flight PUT can't resurrect the
//   pre-reset payload (parity with reset-to-Live).

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

let fake: FakeApi

const SET_ID = 'aaaaaaaaaaaa'
const BENCH = '/flist/character/99/workbench/payload'
const SAVE = `PUT ${BENCH}`
const SNAPSHOT_111 = 'GET /flist/character/99/snapshots/111.json'

const descOf = (body: unknown) =>
  ((body as { character?: { description?: string } } | undefined)?.character ?? {}).description

function seedSlot(characterId: string, payload: Record<string, unknown>) {
  const slot = workingSlot(
    workbenchPayload({ _overlay: ['character.description'], ...payload }),
    { etag: 'seed' }
  )
  useStore.setState((s) => ({
    flistWorking: { ...s.flistWorking, [characterId]: slot },
    // Working sets v2: writes route through the active set's payload
    // endpoint, so a slot without an active set can never produce a PUT.
    flistActiveSetId: { ...s.flistActiveSetId, [characterId]: SET_ID },
    flistArchive: {
      ...s.flistArchive,
      [characterId]: archiveEntry(livePayload({ character: { description: 'live' } }), {
        snapshots: [{ filename: '111.json', created_at: 111, size: 200 }]
      })
    },
    flistActiveCharacterId: characterId,
    flistDiffRightSource: {},
    flistDiffBackupCache: {}
  }))
}

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeApi()
  useStore.setState({
    flistWorking: {},
    flistActiveSetId: {},
    flistSets: {},
    flistArchive: {},
    flistDiffRightSource: {},
    flistDiffBackupCache: {},
    flistResetUndo: null
  })
})

afterEach(() => {
  fake.restore()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('flistDiffSetRightSource', () => {
  it('records the picked source per character', () => {
    useStore.getState().flistDiffSetRightSource('99', {
      kind: 'backup',
      filename: '111.json'
    })
    expect(useStore.getState().flistDiffRightSource['99']).toEqual({
      kind: 'backup',
      filename: '111.json'
    })
  })
})

describe('flistDiffLoadBackup', () => {
  it('caches the fetched backup payload under (characterId, filename)', async () => {
    seedSlot('99', { character: { description: 'edited' } })
    fake.on(SNAPSHOT_111, json({ character: { description: 'snapshot' } }))
    await useStore.getState().flistDiffLoadBackup('99', '111.json')
    expect(useStore.getState().flistDiffBackupCache['99:111.json']).toEqual({
      character: { description: 'snapshot' }
    })
    // Idempotent on second call: fetch is not re-invoked, and the
    // cached Backup is still the one that was read.
    fake.on(SNAPSHOT_111, json({ character: { description: 'changed' } }))
    await useStore.getState().flistDiffLoadBackup('99', '111.json')
    expect(fake.requestsTo(SNAPSHOT_111)).toHaveLength(1)
    expect(useStore.getState().flistDiffBackupCache['99:111.json']).toEqual({
      character: { description: 'snapshot' }
    })
  })
})

describe('flistDiffLoadWorkbench', () => {
  it(
    'reads the Workbench payload and caches it under __workbench__',
    async () => {
      seedSlot('99', { character: { description: 'edited' } })
      const onDisk = workbenchPayload({
        _overlay: ['character.description'],
        character: { description: 'on disk' }
      })
      fake.on(`GET ${BENCH}?create=false`, json(payloadRead(onDisk, 'p')))
      await useStore.getState().flistDiffLoadWorkbench('99')
      expect(useStore.getState().flistDiffBackupCache['99:__workbench__']).toEqual(onDisk)
      // Idempotent on second call: fetch is not re-invoked, and the
      // cached Workbench is still the one that was read.
      await useStore.getState().flistDiffLoadWorkbench('99')
      expect(fake.requests).toHaveLength(1)
      expect(useStore.getState().flistDiffBackupCache['99:__workbench__']).toEqual(onDisk)
    }
  )
  it('marks error (not a spinner) when there is no bench', async () => {
    seedSlot('99', { character: { description: 'edited' } })
    fake.on(
      `GET ${BENCH}?create=false`,
      json({ code: 'no_workbench', message: 'this character has no Workbench yet' }, 404)
    )
    await useStore.getState().flistDiffLoadWorkbench('99')
    expect(useStore.getState().flistDiffBackupStatus['99:__workbench__']).toBe('error')
    expect(
      useStore.getState().flistDiffBackupCache['99:__workbench__']
    ).toBeUndefined()
  })
})

describe('flistResetWorkingToBackup', () => {
  it('saves the Backup over the Workbench it replaces, with undo stashed, and never touches the legacy working-copy route', async () => {
    seedSlot('99', { character: { description: 'edited' } })
    fake.on(SNAPSHOT_111, json({ character: { description: 'snapshot' } }))
    fake.on(SAVE, json({ etag: 'restored' }))
    await useStore.getState().flistResetWorkingToBackup('99', '111.json')
    // Let the scheduled flush fire so the eager-PUT lands.
    await vi.advanceTimersByTimeAsync(1000)
    const [put] = fake.requestsTo(SAVE)
    expect(put?.headers['If-Match']).toBe('seed')
    expect(descOf(put?.body)).toBe('snapshot')
    expect(fake.requests.map((r) => r.path).filter((p) => p.endsWith('/working'))).toEqual([])
    const slot = useStore.getState().flistWorking['99']
    expect(descOf(slot.payload)).toBe('snapshot')
    expect(slot.etag).toBe('restored')
    expect(useStore.getState().flistResetUndo?.characterId).toBe('99')
  })
})

describe('flistDiffLoadBackup status tracking', () => {
  it('records error status on api failure so the view can distinguish loading from 404 (UX P1-3)', async () => {
    seedSlot('99', {})
    fake.on(
      'GET /flist/character/99/snapshots/999.json',
      json({ detail: 'not found' }, 404)
    )
    await useStore.getState().flistDiffLoadBackup('99', '999.json')
    expect(useStore.getState().flistDiffBackupStatus['99:999.json']).toBe('error')
  })

  it('marks loaded after a successful read', async () => {
    seedSlot('99', {})
    fake.on(
      'GET /flist/character/99/snapshots/888.json',
      json({ character: { description: 'snap' } })
    )
    await useStore.getState().flistDiffLoadBackup('99', '888.json')
    expect(useStore.getState().flistDiffBackupStatus['99:888.json']).toBe('loaded')
  })
})
