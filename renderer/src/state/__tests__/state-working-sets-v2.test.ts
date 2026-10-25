// Working-sets v2 renderer slice. Covers initial state, the action
// surface (load/create/rename/duplicate/delete/activate), the
// selectWorkingSlot selector, and the autosave flow re-keyed on set id
// — especially that switching sets flushes pending edits on the prior
// set before the new one becomes active.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectWorkingSlot, useStore } from '../../state'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'

const SETS = '/flist/character/99/sets'

let fake: FakeApi

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeApi()
  useStore.setState({
    flistWorking: {},
    flistSets: {},
    flistSetsStatus: {},
    flistActiveSetId: {},
    flistSetWorking: {},
    flistSetWorkingLoadStatus: {},
    flistArchive: {}
  })
})

afterEach(() => {
  fake.restore()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('initial state', () => {
  it('starts with empty maps for every working-sets-v2 field', () => {
    const s = useStore.getState()
    expect(s.flistSets).toEqual({})
    expect(s.flistSetsStatus).toEqual({})
    expect(s.flistActiveSetId).toEqual({})
    expect(s.flistSetWorking).toEqual({})
    expect(s.flistSetWorkingLoadStatus).toEqual({})
  })
})

describe('selectWorkingSlot', () => {
  it('returns undefined when active set id is null (user viewing F-list)', () => {
    useStore.setState({
      flistActiveSetId: { '99': null },
      flistSetWorking: {
        'abc123': {
          payload: { _schema_version: 5, _overlay: [] },
          overlay: [],
          etag: null,
          unsavedDirty: false,
          saveStatus: 'idle',
          saveError: null,
          lastSavedAt: null,
          materialised: true
        }
      }
    })
    expect(selectWorkingSlot(useStore.getState(), '99')).toBeUndefined()
  })

  it('returns the active set payload when a set is active', () => {
    // `flistWorking[characterId]` is the canonical edit slot and
    // `flistSetWorking[setId]` the per-set mirror the activate flow
    // keeps in step; seed both, the way activation leaves them.
    const seeded = {
      payload: {
        _schema_version: 5,
        _overlay: [],
        character: { description: 'hello' }
      },
      overlay: [],
      etag: 'etag-1',
      unsavedDirty: false,
      saveStatus: 'idle' as const,
      saveError: null,
      lastSavedAt: null,
      materialised: true
    }
    useStore.setState({
      flistActiveSetId: { '99': 'abc123' },
      flistSetWorking: { 'abc123': seeded },
      flistWorking: { '99': seeded }
    })
    const slot = selectWorkingSlot(useStore.getState(), '99')
    expect(slot).toBeDefined()
    const char = slot?.payload.character as { description?: string } | undefined
    expect(char?.description).toBe('hello')
  })

  it('returns undefined when the active set id points at a missing slot', () => {
    useStore.setState({
      flistActiveSetId: { '99': 'abc123' },
      flistSetWorking: {}
    })
    expect(selectWorkingSlot(useStore.getState(), '99')).toBeUndefined()
  })
})

describe('flistLoadSets', () => {
  it('lists sets + loads the active payload + sorts by updatedAt desc', async () => {
    fake.on(
      `GET ${SETS}`,
      json({
        sets: [
          { id: 'one', name: 'Main', created_at: 10, updated_at: 100 },
          { id: 'two', name: 'AU', created_at: 5, updated_at: 200 }
        ],
        active_set_id: 'two'
      })
    )
    fake.on(`POST ${SETS}/two/activate`, json({ active_set_id: 'two' }))
    fake.on(
      `GET ${SETS}/two/payload`,
      json({ payload: { character: { description: 'au' } }, etag: 'e1' })
    )
    await useStore.getState().flistLoadSets('99')
    const s = useStore.getState()
    expect(s.flistSetsStatus['99']).toBe('ready')
    expect(s.flistSets['99']?.map((m) => m.id)).toEqual(['two', 'one'])
    expect(s.flistActiveSetId['99']).toBe('two')
    expect(s.flistSetWorking['two']?.etag).toBe('e1')
    // Loading routes through the activate flow so the editor's view
    // slot lands in sync with the server's active_set.json: list →
    // activate → read that set's payload.
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${SETS}`,
      `POST ${SETS}/two/activate`,
      `GET ${SETS}/two/payload`
    ])
  })

  it('marks status error when the list call fails', async () => {
    fake.on(`GET ${SETS}`, json({ detail: 'boom' }, 500))
    await useStore.getState().flistLoadSets('99')
    expect(useStore.getState().flistSetsStatus['99']).toBe('error')
  })
})

describe('flistCreateSet', () => {
  it('POSTs, prepends to list, activates, and materialises the new slot', async () => {
    fake.on(
      `POST ${SETS}`,
      json({ set: { id: 'new1', name: 'Working set 1', created_at: 1, updated_at: 1 } })
    )
    fake.on(`POST ${SETS}/new1/activate`, json({ active_set_id: 'new1' }))
    fake.on(
      `GET ${SETS}/new1/payload`,
      json({ payload: { character: { description: 'seed' } }, etag: 'e-new' })
    )
    const meta = await useStore.getState().flistCreateSet('99', 'Working set 1')
    expect(meta?.id).toBe('new1')
    const s = useStore.getState()
    expect(s.flistSets['99']?.[0].id).toBe('new1')
    expect(s.flistActiveSetId['99']).toBe('new1')
    expect(s.flistSetWorking['new1']?.etag).toBe('e-new')
    expect(fake.requestsTo(`POST ${SETS}`)[0].body).toEqual({ name: 'Working set 1' })
  })
})

describe('flistRenameSet', () => {
  it('PATCHes and updates meta in place without reordering', async () => {
    useStore.setState({
      flistSets: {
        '99': [
          { id: 'a', name: 'Old', createdAt: 1, updatedAt: 1 },
          { id: 'b', name: 'Other', createdAt: 2, updatedAt: 2 }
        ]
      }
    })
    fake.on(
      `PATCH ${SETS}/a`,
      json({ set: { id: 'a', name: 'New', created_at: 1, updated_at: 3 } })
    )
    await useStore.getState().flistRenameSet('99', 'a', 'New')
    const list = useStore.getState().flistSets['99']
    expect(list?.map((m) => `${m.id}:${m.name}`)).toEqual(['a:New', 'b:Other'])
  })
})

describe('flistDuplicateSet', () => {
  it('POSTs, prepends to top, does NOT auto-activate', async () => {
    useStore.setState({
      flistSets: { '99': [{ id: 'src', name: 'Source', createdAt: 1, updatedAt: 1 }] },
      flistActiveSetId: { '99': 'src' }
    })
    fake.on(
      `POST ${SETS}/src/duplicate`,
      json({ set: { id: 'dup', name: 'Source (copy)', created_at: 2, updated_at: 2 } })
    )
    const meta = await useStore.getState().flistDuplicateSet('99', 'src', 'Source (copy)')
    expect(meta?.id).toBe('dup')
    const s = useStore.getState()
    expect(s.flistSets['99']?.map((m) => m.id)).toEqual(['dup', 'src'])
    expect(s.flistActiveSetId['99']).toBe('src')
  })
})

describe('flistDeleteSet', () => {
  it('DELETEs, drops local state, mirrors the server-returned next active id', async () => {
    useStore.setState({
      flistSets: {
        '99': [
          { id: 'a', name: 'A', createdAt: 1, updatedAt: 2 },
          { id: 'b', name: 'B', createdAt: 1, updatedAt: 1 }
        ]
      },
      flistActiveSetId: { '99': 'a' },
      flistSetWorking: {
        'a': {
          payload: { _schema_version: 5, _overlay: [] },
          overlay: [],
          etag: 'e-a',
          unsavedDirty: false,
          saveStatus: 'idle',
          saveError: null,
          lastSavedAt: null,
          materialised: true
        }
      }
    })
    fake.on(`DELETE ${SETS}/a`, json({ active_set_id: 'b' }))
    fake.on(`POST ${SETS}/b/activate`, json({ active_set_id: 'b' }))
    fake.on(
      `GET ${SETS}/b/payload`,
      json({ payload: { character: { description: 'b' } }, etag: 'e-b' })
    )
    await useStore.getState().flistDeleteSet('99', 'a')
    const s = useStore.getState()
    expect(s.flistSets['99']?.map((m) => m.id)).toEqual(['b'])
    expect(s.flistActiveSetId['99']).toBe('b')
    expect(s.flistSetWorking['a']).toBeUndefined()
    expect(s.flistSetWorking['b']?.etag).toBe('e-b')
  })

  it('clears active id when server returns null (last set deleted)', async () => {
    useStore.setState({
      flistSets: { '99': [{ id: 'only', name: 'Only', createdAt: 1, updatedAt: 1 }] },
      flistActiveSetId: { '99': 'only' }
    })
    fake.on(`DELETE ${SETS}/only`, json({ active_set_id: null }))
    await useStore.getState().flistDeleteSet('99', 'only')
    const s = useStore.getState()
    expect(s.flistSets['99']).toEqual([])
    expect(s.flistActiveSetId['99']).toBeNull()
  })
})

describe('flistActivateSet', () => {
  it('flushes pending autosave on the outgoing set BEFORE activating', async () => {
    const outgoingSlot = {
      payload: { _schema_version: 5, _overlay: [], character: { description: 'edited' } },
      overlay: ['character.description'],
      etag: 'etag-old',
      // Pretend the user typed but the debounce hasn't fired yet.
      unsavedDirty: true,
      saveStatus: 'idle' as const,
      saveError: null,
      lastSavedAt: null,
      materialised: true
    }
    useStore.setState({
      flistSets: {
        '99': [
          { id: 'old', name: 'Old', createdAt: 1, updatedAt: 1 },
          { id: 'new', name: 'New', createdAt: 2, updatedAt: 2 }
        ]
      },
      flistActiveSetId: { '99': 'old' },
      flistSetWorking: { 'old': outgoingSlot },
      flistWorking: { '99': outgoingSlot }
    })
    // 1. flush of the outgoing set fires a PUT to /sets/old/payload
    fake.on(`PUT ${SETS}/old/payload`, json({ etag: 'flushed' }))
    // 2. activate the new set
    fake.on(`POST ${SETS}/new/activate`, json({ active_set_id: 'new' }))
    // 3. materialise the new set's payload
    fake.on(
      `GET ${SETS}/new/payload`,
      json({ payload: { character: { description: 'newly' } }, etag: 'e-new' })
    )
    await useStore.getState().flistActivateSet('99', 'new')
    const order = fake.requests.map((r) => `${r.method} ${r.path}`)
    expect(order.filter((r) => r.startsWith('PUT'))).toEqual([`PUT ${SETS}/old/payload`])
    expect(order.indexOf(`POST ${SETS}/new/activate`)).toBeGreaterThan(
      order.indexOf(`PUT ${SETS}/old/payload`)
    )
    expect(useStore.getState().flistActiveSetId['99']).toBe('new')
    expect(useStore.getState().flistSetWorking['new']?.etag).toBe('e-new')
    // The outgoing set's slot reflects the successful flush.
    expect(useStore.getState().flistSetWorking['old']?.unsavedDirty).toBe(false)
    expect(useStore.getState().flistSetWorking['old']?.etag).toBe('flushed')
  })
})

describe('flistActivateFromFlist', () => {
  it('flushes pending autosave then nulls the active id', async () => {
    const currentSlot = {
      payload: { _schema_version: 5, _overlay: [], character: { description: 'x' } },
      overlay: ['character.description'],
      etag: 'e',
      unsavedDirty: true,
      saveStatus: 'idle' as const,
      saveError: null,
      lastSavedAt: null,
      materialised: true
    }
    useStore.setState({
      flistActiveSetId: { '99': 'cur' },
      flistSetWorking: { 'cur': currentSlot },
      flistWorking: { '99': currentSlot }
    })
    fake.on(`PUT ${SETS}/cur/payload`, json({ etag: 'flushed' }))
    fake.on('POST /flist/character/99/from-flist/activate', json({ active_set_id: null }))
    await useStore.getState().flistActivateFromFlist('99')
    expect(useStore.getState().flistActiveSetId['99']).toBeNull()
    const puts = fake.requests.filter((r) => r.method === 'PUT')
    expect(puts.map((r) => r.path)).toEqual([`${SETS}/cur/payload`])
  })
})

describe('autosave keyed on set id', () => {
  it('flistSetWorkingFlushPending coalesces multiple armed writes per set', async () => {
    useStore.setState({
      flistActiveSetId: { '99': 'aaa' },
      flistSetWorking: {
        'aaa': {
          payload: { _schema_version: 5, _overlay: [], character: { description: 'first' } },
          overlay: ['character.description'],
          etag: null,
          unsavedDirty: true,
          saveStatus: 'idle',
          saveError: null,
          lastSavedAt: null,
          materialised: true
        }
      }
    })
    fake.on(`PUT ${SETS}/aaa/payload`, json({ etag: 'after' }))
    await useStore.getState().flistSetWorkingFlushPending('99', 'aaa')
    const puts = fake.requests.filter((r) => r.method === 'PUT')
    expect(puts.map((r) => r.path)).toEqual([`${SETS}/aaa/payload`])
    expect(useStore.getState().flistSetWorking['aaa']?.saveStatus).toBe('saved')
    expect(useStore.getState().flistSetWorking['aaa']?.etag).toBe('after')
  })
})
