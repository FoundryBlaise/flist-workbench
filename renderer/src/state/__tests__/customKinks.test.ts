// Tier 3 §"Testing strategy → Vitest" — exhaustive coverage of the
// custom-kinks + standard-kinks action surface. Tests run against the
// real Zustand store (vs an extracted reducer) so they double as
// integration tests for the autosave debouncer wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { installFakeApi, type FakeApi } from '../../test/fakeApi'
import { workbenchPayload, workingSlot } from '../../test/payloads'

// No test here waits out the autosave debounce, so none should reach
// the sidecar; afterEach checks that none did.
let fake: FakeApi

function seedSlot(characterId: string, payload: Record<string, unknown>) {
  useStore.setState({
    flistWorking: {
      ...useStore.getState().flistWorking,
      [characterId]: workingSlot(workbenchPayload(payload), { etag: 'seed' })
    },
    flistActiveCharacterId: characterId,
    editorReadOnly: false
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeApi()
  useStore.setState({
    flistWorking: {},
    flistCustomKinksUI: {},
    flistTombstoneUndo: null,
    flistResetUndo: null
  })
})

afterEach(() => {
  fake.restore()
  vi.useRealTimers()
  vi.restoreAllMocks()
  expect(fake.requests).toEqual([])
})

describe('custom-kinks reducer surface', () => {
  it('Add: assigns local: id, appends to order, does NOT pre-overlay .name', () => {
    seedSlot('99', { custom_kinks: {}, _custom_kinks_order: [] })
    const localId = useStore.getState().flistCustomKinksAdd('99')
    expect(localId.startsWith('local:')).toBe(true)
    const slot = useStore.getState().flistWorking['99']
    expect(slot.overlay).toContain('custom_kinks._order')
    expect(slot.overlay).not.toContain(`custom_kinks.${localId}.name`)
    expect((slot.payload._custom_kinks_order as string[]).at(-1)).toBe(localId)
    expect((slot.payload.custom_kinks as Record<string, unknown>)[localId]).toBeDefined()
  })

  it('Edit: writes through correct overlay path including local: ids', () => {
    seedSlot('99', { custom_kinks: {}, _custom_kinks_order: [] })
    const id = useStore.getState().flistCustomKinksAdd('99')
    useStore.getState().flistCustomKinksEdit('99', id, 'name', 'My new kink')
    const slot = useStore.getState().flistWorking['99']
    expect(slot.overlay).toContain(`custom_kinks.${id}.name`)
    const ck = slot.payload.custom_kinks as Record<string, Record<string, unknown>>
    expect(ck[id].name).toBe('My new kink')
  })

  it('Tombstone numeric id writes _deleted + overlay path', () => {
    seedSlot('99', {
      custom_kinks: { '12345': { name: 'A', choice: 'fave', children: [] } },
      _custom_kinks_order: ['12345']
    })
    useStore.getState().flistCustomKinksTombstone('99', '12345')
    const slot = useStore.getState().flistWorking['99']
    const ck = slot.payload.custom_kinks as Record<string, Record<string, unknown>>
    expect(ck['12345']._deleted).toBe(true)
    expect(slot.overlay).toContain('custom_kinks.12345._deleted')
  })

  it('Tombstone local: id deletes outright from dict + order', () => {
    seedSlot('99', { custom_kinks: {}, _custom_kinks_order: [] })
    const id = useStore.getState().flistCustomKinksAdd('99')
    useStore.getState().flistCustomKinksTombstone('99', id)
    const slot = useStore.getState().flistWorking['99']
    const ck = slot.payload.custom_kinks as Record<string, unknown>
    expect(ck[id]).toBeUndefined()
    expect(slot.payload._custom_kinks_order).not.toContain(id)
  })

  it('Undo tombstone restores the pre-delete snapshot exactly', () => {
    seedSlot('99', {
      custom_kinks: { '12345': { name: 'A', choice: 'fave', children: [] } },
      _custom_kinks_order: ['12345']
    })
    const before = JSON.stringify(useStore.getState().flistWorking['99'].payload)
    useStore.getState().flistCustomKinksTombstone('99', '12345')
    useStore.getState().flistUndoTombstone()
    const after = JSON.stringify(useStore.getState().flistWorking['99'].payload)
    expect(after).toBe(before)
  })

  it('Bulk tombstone marks all selected ids in a single batch + arms one undo', () => {
    seedSlot('99', {
      custom_kinks: {
        '1': { name: 'A', choice: 'fave', children: [] },
        '2': { name: 'B', choice: 'yes', children: [] },
        '3': { name: 'C', choice: 'no', children: [] }
      },
      _custom_kinks_order: ['1', '2', '3']
    })
    useStore.getState().flistCustomKinksBulkTombstone('99', ['1', '2', '3'])
    const slot = useStore.getState().flistWorking['99']
    const ck = slot.payload.custom_kinks as Record<string, Record<string, unknown>>
    expect(ck['1']._deleted).toBe(true)
    expect(ck['2']._deleted).toBe(true)
    expect(ck['3']._deleted).toBe(true)
    expect(slot.overlay).toContain('custom_kinks.1._deleted')
    expect(slot.overlay).toContain('custom_kinks.2._deleted')
    expect(slot.overlay).toContain('custom_kinks.3._deleted')
    const undo = useStore.getState().flistTombstoneUndo
    expect(undo?.kinkIds.length).toBe(3)
  })

  it('Reorder writes _custom_kinks_order + adds custom_kinks._order to overlay', () => {
    seedSlot('99', {
      custom_kinks: {
        '1': { name: 'A', choice: 'fave', children: [] },
        '2': { name: 'B', choice: 'yes', children: [] }
      },
      _custom_kinks_order: ['1', '2']
    })
    useStore.getState().flistCustomKinksReorder('99', ['2', '1'])
    const slot = useStore.getState().flistWorking['99']
    expect(slot.payload._custom_kinks_order).toEqual(['2', '1'])
    expect(slot.overlay).toContain('custom_kinks._order')
  })

  it('Bulk set choice overlays N .choice paths', () => {
    seedSlot('99', {
      custom_kinks: {
        '1': { name: 'A', choice: 'undecided', children: [] },
        '2': { name: 'B', choice: 'undecided', children: [] }
      },
      _custom_kinks_order: ['1', '2']
    })
    useStore.getState().flistCustomKinksBulkSetChoice('99', ['1', '2'], 'fave')
    const slot = useStore.getState().flistWorking['99']
    expect(slot.overlay).toContain('custom_kinks.1.choice')
    expect(slot.overlay).toContain('custom_kinks.2.choice')
  })
})

describe('standard-kinks coercion (QA P1-4)', () => {
  it('flistStandardKinkSet on a list-shape kinks block coerces to dict', () => {
    seedSlot('99', { kinks: [] })
    useStore.getState().flistStandardKinkSet('99', 'fetish_71', 'fave')
    const kinks = useStore.getState().flistWorking['99'].payload.kinks
    expect(Array.isArray(kinks)).toBe(false)
    expect((kinks as Record<string, unknown>).fetish_71).toBe('fave')
  })

  it('flistStandardKinksBulkSetChoice on empty kinks materialises the dict', () => {
    seedSlot('99', {})
    useStore
      .getState()
      .flistStandardKinksBulkSetChoice('99', ['fetish_1', 'fetish_2'], 'yes')
    const slot = useStore.getState().flistWorking['99']
    expect(slot.overlay).toContain('kinks.fetish_1')
    expect(slot.overlay).toContain('kinks.fetish_2')
    const kinks = slot.payload.kinks as Record<string, unknown>
    expect(kinks.fetish_1).toBe('yes')
    expect(kinks.fetish_2).toBe('yes')
  })
})

describe('reducer interop with seedWorkingFromLive', () => {
  it('seed coerces kinks list to dict so first set lands cleanly', async () => {
    const { seedWorkingFromLive } = await import('../flist')
    const seeded = seedWorkingFromLive({
      character: { description: '' },
      kinks: []
    })
    expect(Array.isArray(seeded.kinks)).toBe(false)
  })
})
