// Working-sets v2 renderer slice. Covers initial state, the action
// surface (load/create/rename/duplicate/delete/activate), the
// selectWorkingSlot selector, and the autosave flow re-keyed on set id
// — especially that switching sets flushes pending edits on the prior
// set before the new one becomes active.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectWorkingSlot, useStore } from '../../state'

interface Capture {
  url: string
  method: string
  body?: unknown
  headers?: Record<string, string>
}

function mockFetch(routes: ((c: Capture) => Promise<Response>)[]): Capture[] {
  const calls: Capture[] = []
  let idx = 0
  ;(globalThis as { fetch?: unknown }).fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL).toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const headers: Record<string, string> = {}
      if (init?.headers) {
        for (const [k, v] of Object.entries(
          init.headers as Record<string, string>
        )) {
          headers[k] = String(v)
        }
      }
      let body: unknown = undefined
      try {
        body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      } catch {
        body = init?.body
      }
      const capture: Capture = { url, method, body, headers }
      calls.push(capture)
      const route = routes[Math.min(idx, routes.length - 1)]
      idx++
      return route(capture)
    }
  )
  return calls
}

function ok(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

beforeEach(() => {
  vi.useFakeTimers()
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

  it('returns the slot at flistSetWorking[activeId] when a set is active', () => {
    useStore.setState({
      flistActiveSetId: { '99': 'abc123' },
      flistSetWorking: {
        'abc123': {
          payload: {
            _schema_version: 5,
            _overlay: [],
            character: { description: 'hello' }
          },
          overlay: [],
          etag: 'etag-1',
          unsavedDirty: false,
          saveStatus: 'idle',
          saveError: null,
          lastSavedAt: null,
          materialised: true
        }
      }
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
    const calls = mockFetch([
      async () =>
        ok({
          sets: [
            { id: 'one', name: 'Main', created_at: 10, updated_at: 100 },
            { id: 'two', name: 'AU', created_at: 5, updated_at: 200 }
          ],
          active_set_id: 'two'
        }),
      async () => ok({ payload: { character: { description: 'au' } }, etag: 'e1' })
    ])
    await useStore.getState().flistLoadSets('99')
    const s = useStore.getState()
    expect(s.flistSetsStatus['99']).toBe('ready')
    expect(s.flistSets['99']?.map((m) => m.id)).toEqual(['two', 'one'])
    expect(s.flistActiveSetId['99']).toBe('two')
    expect(s.flistSetWorking['two']?.etag).toBe('e1')
    expect(calls[0].url).toMatch(/\/flist\/character\/99\/sets$/)
    expect(calls[1].url).toMatch(/\/sets\/two\/payload$/)
  })

  it('marks status error when the list call fails', async () => {
    mockFetch([
      async () =>
        ({
          ok: false,
          status: 500,
          json: async () => ({ detail: 'boom' }),
          text: async () => '{}'
        }) as unknown as Response
    ])
    await useStore.getState().flistLoadSets('99')
    expect(useStore.getState().flistSetsStatus['99']).toBe('error')
  })
})

describe('flistCreateSet', () => {
  it('POSTs, prepends to list, activates, and materialises the new slot', async () => {
    const calls = mockFetch([
      async () => ok({ set: { id: 'new1', name: 'Working set 1', created_at: 1, updated_at: 1 } }),
      async () => ok({ payload: { character: { description: 'seed' } }, etag: 'e-new' })
    ])
    const meta = await useStore.getState().flistCreateSet('99', 'Working set 1')
    expect(meta?.id).toBe('new1')
    const s = useStore.getState()
    expect(s.flistSets['99']?.[0].id).toBe('new1')
    expect(s.flistActiveSetId['99']).toBe('new1')
    expect(s.flistSetWorking['new1']?.etag).toBe('e-new')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toEqual({ name: 'Working set 1' })
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
    mockFetch([
      async () => ok({ set: { id: 'a', name: 'New', created_at: 1, updated_at: 3 } })
    ])
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
    mockFetch([
      async () => ok({ set: { id: 'dup', name: 'Source (copy)', created_at: 2, updated_at: 2 } })
    ])
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
    mockFetch([
      async () => ok({ active_set_id: 'b' }),
      async () => ok({ payload: { character: { description: 'b' } }, etag: 'e-b' })
    ])
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
    mockFetch([async () => ok({ active_set_id: null })])
    await useStore.getState().flistDeleteSet('99', 'only')
    const s = useStore.getState()
    expect(s.flistSets['99']).toEqual([])
    expect(s.flistActiveSetId['99']).toBeNull()
  })
})

describe('flistActivateSet', () => {
  it('flushes pending autosave on the outgoing set BEFORE activating', async () => {
    useStore.setState({
      flistSets: {
        '99': [
          { id: 'old', name: 'Old', createdAt: 1, updatedAt: 1 },
          { id: 'new', name: 'New', createdAt: 2, updatedAt: 2 }
        ]
      },
      flistActiveSetId: { '99': 'old' },
      flistSetWorking: {
        'old': {
          payload: { _schema_version: 5, _overlay: [], character: { description: 'edited' } },
          overlay: ['character.description'],
          etag: 'etag-old',
          // Pretend the user typed but the debounce hasn't fired yet.
          unsavedDirty: true,
          saveStatus: 'idle',
          saveError: null,
          lastSavedAt: null,
          materialised: true
        }
      }
    })
    const calls = mockFetch([
      // 1. flush of the outgoing set fires a PUT to /sets/old/payload
      async () => ok({ etag: 'flushed' }),
      // 2. activate the new set
      async () => ok({ active_set_id: 'new' }),
      // 3. materialise the new set's payload
      async () => ok({ payload: { character: { description: 'newly' } }, etag: 'e-new' })
    ])
    await useStore.getState().flistActivateSet('99', 'new')
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts.length).toBe(1)
    expect(puts[0].url).toMatch(/\/sets\/old\/payload$/)
    expect(calls.findIndex((c) => c.url.includes('/sets/new/activate'))).toBeGreaterThan(
      calls.findIndex((c) => c.method === 'PUT')
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
    useStore.setState({
      flistActiveSetId: { '99': 'cur' },
      flistSetWorking: {
        'cur': {
          payload: { _schema_version: 5, _overlay: [], character: { description: 'x' } },
          overlay: ['character.description'],
          etag: 'e',
          unsavedDirty: true,
          saveStatus: 'idle',
          saveError: null,
          lastSavedAt: null,
          materialised: true
        }
      }
    })
    const calls = mockFetch([
      async () => ok({ etag: 'flushed' }),
      async () => ok({ active_set_id: null })
    ])
    await useStore.getState().flistActivateFromFlist('99')
    expect(useStore.getState().flistActiveSetId['99']).toBeNull()
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts.length).toBe(1)
    expect(puts[0].url).toMatch(/\/sets\/cur\/payload$/)
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
    const calls = mockFetch([async () => ok({ etag: 'after' })])
    await useStore.getState().flistSetWorkingFlushPending('99', 'aaa')
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts.length).toBe(1)
    expect(puts[0].url).toMatch(/\/sets\/aaa\/payload$/)
    expect(useStore.getState().flistSetWorking['aaa']?.saveStatus).toBe('saved')
    expect(useStore.getState().flistSetWorking['aaa']?.etag).toBe('after')
  })

  it('409 etag-mismatch keeps unsavedDirty and adopts the server etag', async () => {
    useStore.setState({
      flistSetWorking: {
        'aaa': {
          payload: { _schema_version: 5, _overlay: [], character: { description: 'mine' } },
          overlay: ['character.description'],
          etag: 'stale',
          unsavedDirty: true,
          saveStatus: 'idle',
          saveError: null,
          lastSavedAt: null,
          materialised: true
        }
      }
    })
    mockFetch([
      async () =>
        ({
          ok: false,
          status: 409,
          json: async () => ({
            detail: { detail: 'etag_mismatch', current_etag: 'server' }
          }),
          text: async () => '{}'
        }) as unknown as Response
    ])
    await useStore.getState().flistSetWorkingFlushPending('99', 'aaa')
    const slot = useStore.getState().flistSetWorking['aaa']
    expect(slot?.unsavedDirty).toBe(true)
    expect(slot?.etag).toBe('server')
    expect(slot?.saveError).toMatch(/Another window/)
  })
})
