// Tier 4 — flistResetWorkingToBackup integration. Covers:
// - lazy backup load via api.flistSnapshotRead when cache miss
// - DELETE working then PUT seeded-from-backup, with undo snapshot
// - drain in-flight save so a mid-flight PUT can't resurrect the
//   pre-reset payload (parity with reset-to-Live).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'

let fake: FakeApi

const SET_ID = 'aaaaaaaaaaaa'
const SAVE = `PUT /flist/character/99/sets/${SET_ID}/payload`
const SNAPSHOT_111 = 'GET /flist/character/99/snapshots/111.json'

function seedSlot(characterId: string, payload: Record<string, unknown>) {
  const slot = {
    payload: { _schema_version: 2, _overlay: ['character.description'], ...payload },
    overlay: ['character.description'],
    etag: 'seed',
    unsavedDirty: false,
    saveStatus: 'idle' as const,
    saveError: null,
    lastSavedAt: null,
    materialised: true
  }
  useStore.setState((s) => ({
    flistWorking: { ...s.flistWorking, [characterId]: slot },
    // Working sets v2: writes route through the active set's payload
    // endpoint, so a slot without an active set can never produce a PUT.
    flistSetWorking: { ...s.flistSetWorking, [SET_ID]: slot },
    flistActiveSetId: { ...s.flistActiveSetId, [characterId]: SET_ID },
    flistArchive: {
      ...s.flistArchive,
      [characterId]: {
        live: { character: { description: 'live' } },
        snapshots: [{ filename: '111.json', created_at: 111, size: 200 }],
        pullStatus: 'idle'
      }
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
    flistSetWorking: {},
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
    expect(useStore.getState().flistDiffBackupCache['99:111.json']).toBeDefined()
    // Idempotent on second call — fetch is not re-invoked.
    await useStore.getState().flistDiffLoadBackup('99', '111.json')
    expect(fake.requestsTo(SNAPSHOT_111)).toHaveLength(1)
  })
})

describe('flistDiffLoadWorkbench', () => {
  it(
    'resolves the bench set, reads its payload, caches under __workbench__',
    async () => {
      seedSlot('99', { character: { description: 'edited' } })
      fake.on(
        'GET /flist/character/99/workbench?create=false',
        json({ workbench: { id: SET_ID } })
      )
      fake.on(
        `GET /flist/character/99/sets/${SET_ID}/payload`,
        json({
          payload: {
            _overlay: ['character.description'],
            character: { description: 'edited' }
          },
          etag: 'p'
        })
      )
      await useStore.getState().flistDiffLoadWorkbench('99')
      expect(useStore.getState().flistDiffBackupCache['99:__workbench__']).toBeDefined()
      // Idempotent on second call — fetch is not re-invoked.
      await useStore.getState().flistDiffLoadWorkbench('99')
      expect(fake.requests).toHaveLength(2)
    }
  )
  it('marks error (not a spinner) when there is no bench', async () => {
    seedSlot('99', { character: { description: 'edited' } })
    fake.on(
      'GET /flist/character/99/workbench?create=false',
      json({ workbench: null, active_set_id: null })
    )
    await useStore.getState().flistDiffLoadWorkbench('99')
    expect(useStore.getState().flistDiffBackupStatus['99:__workbench__']).toBe('error')
    expect(
      useStore.getState().flistDiffBackupCache['99:__workbench__']
    ).toBeUndefined()
  })
})

describe('flistResetWorkingToBackup', () => {
  it('DELETEs working and seeds from backup, with undo snapshot stashed', async () => {
    seedSlot('99', { character: { description: 'edited' } })
    fake.on(SNAPSHOT_111, json({ character: { description: 'snapshot' } }))
    fake.on('DELETE /flist/character/99/working', json({ deleted: true }))
    // The PUT after the seed.
    fake.on(SAVE, json({ etag: 'restored' }))
    await useStore.getState().flistResetWorkingToBackup('99', '111.json')
    // Let the scheduled flush fire so the eager-PUT lands.
    await vi.advanceTimersByTimeAsync(1000)
    expect(fake.requestsTo('DELETE /flist/character/99/working')).toHaveLength(1)
    const slot = useStore.getState().flistWorking['99']
    const charDesc = (slot.payload.character as { description?: string } | undefined)
      ?.description
    expect(charDesc).toBe('snapshot')
    expect(useStore.getState().flistResetUndo?.characterId).toBe('99')
  })

  it('survives DELETE failure: eager PUT carries the prior etag so on-disk file is overwritten cleanly (QA P1-1)', async () => {
    seedSlot('99', { character: { description: 'edited' } })
    fake.on(SNAPSHOT_111, json({ character: { description: 'snapshot' } }))
    // The DELETE fails (server transient error).
    fake.on('DELETE /flist/character/99/working', json({ detail: 'transient' }, 500))
    // PUT with If-Match: 'seed' succeeds because the file is still there.
    fake.on(SAVE, json({ etag: 'overwritten' }))
    await useStore.getState().flistResetWorkingToBackup('99', '111.json')
    await vi.advanceTimersByTimeAsync(1000)
    const [put] = fake.requestsTo(SAVE)
    expect(put).toBeDefined()
    // The eager PUT must carry If-Match against the pre-reset etag so
    // an unsuccessful DELETE doesn't leave disk out-of-sync with local.
    expect(put?.headers['If-Match']).toBe('seed')
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
