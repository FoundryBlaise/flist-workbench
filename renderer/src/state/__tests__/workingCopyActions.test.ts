// Tier 2 §10 "Missing tests" — covers the action surface QA flagged
// as the most load-bearing untested paths: autosave debounce
// interleaving, 409 etag-mismatch handling, openWorking + archive race,
// reset-to-Live → undo round-trip, and signOut drains pending edits.
//
// All tests mock `fetch` so the real sidecar isn't touched.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'

interface Capture {
  url: string
  method: string
  body?: unknown
  headers?: Record<string, string>
}

function mockFetch(
  routes: ((c: Capture) => Promise<Response>)[]
): Capture[] {
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
    flistArchive: {},
    flistCustomKinksUI: {},
    flistResetUndo: null,
    flistTombstoneUndo: null,
    flistActiveCharacterId: null,
    activeDocId: null,
    editorReadOnly: false,
    editorContent: '',
    editorDirty: false,
    editorTitle: ''
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function seedSlot(characterId: string, payload: Record<string, unknown>) {
  useStore.setState((s) => ({
    flistWorking: {
      ...s.flistWorking,
      [characterId]: {
        payload: { _schema_version: 2, _overlay: [], ...payload },
        overlay: Array.isArray(payload._overlay)
          ? (payload._overlay as string[])
          : [],
        etag: 'seed-etag',
        unsavedDirty: false,
        saveStatus: 'idle',
        saveError: null,
        lastSavedAt: null,
        materialised: true
      }
    },
    flistActiveCharacterId: characterId
  }))
}

describe('autosave debouncer', () => {
  it('coalesces three keystrokes within 500 ms into a single PUT carrying the last payload', async () => {
    seedSlot('99', { character: { description: '' } })
    const calls = mockFetch([async () => ok({ etag: 'new1' })])

    useStore.getState().flistSetWorkingField('99', 'character.description', 'a')
    await vi.advanceTimersByTimeAsync(200)
    useStore.getState().flistSetWorkingField('99', 'character.description', 'ab')
    await vi.advanceTimersByTimeAsync(200)
    useStore.getState().flistSetWorkingField('99', 'character.description', 'abc')
    await vi.advanceTimersByTimeAsync(500)

    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts.length).toBe(1)
    expect((puts[0].body as Record<string, Record<string, string>>).character.description).toBe('abc')
  })

  it('signOut drains pending working-copy edits via flistFlushWorking', async () => {
    seedSlot('99', { character: { description: 'before' } })
    const calls = mockFetch([
      async () => ok({ etag: 'flushed' }),
      async () => ok({ signed_out: true })
    ])
    useStore.getState().flistSetWorkingField('99', 'character.description', 'after')
    // Don't advance — leave the debounce armed; signOut should still flush.
    await useStore.getState().flistSignOut()
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts.length).toBe(1)
    expect((puts[0].body as Record<string, Record<string, string>>).character.description).toBe('after')
  })
})

describe('flistFlushWorking 409 etag-mismatch path', () => {
  it('keeps unsavedDirty + sets refresh-or-overwrite saveError', async () => {
    seedSlot('99', { character: { description: 'mine' } })
    mockFetch([
      async () =>
        ({
          ok: false,
          status: 409,
          json: async () => ({
            detail: { detail: 'etag_mismatch', current_etag: 'server-etag' }
          }),
          text: async () => '{}'
        }) as unknown as Response
    ])
    useStore.getState().flistSetWorkingField('99', 'character.description', 'mine-updated')
    await vi.advanceTimersByTimeAsync(500)
    const slot = useStore.getState().flistWorking['99']
    expect(slot.unsavedDirty).toBe(true)
    expect(slot.saveError).toMatch(/Another window/i)
    expect(slot.etag).toBe('server-etag')
  })
})

describe('flistOpenWorking archive race (QA P1-3)', () => {
  it('fetches Live + caches it before seeding the working copy on 404', async () => {
    useStore.setState({ flistArchive: {}, flistRoster: [] })
    const calls = mockFetch([
      async () => ok({ character: { description: 'live-desc', id: '99' }, id: '99' }),
      async () =>
        ({
          ok: false,
          status: 404,
          json: async () => ({ detail: 'no working copy' }),
          text: async () => '{}'
        }) as unknown as Response
    ])
    await useStore.getState().flistOpenWorking('99')
    expect(calls.some((c) => c.url.includes('/flist/character/99/live'))).toBe(true)
    expect(calls.some((c) => c.url.includes('/working') && c.method === 'GET')).toBe(true)
    const slot = useStore.getState().flistWorking['99']
    expect(slot).toBeDefined()
    const char = slot.payload.character as { description?: string } | undefined
    expect(char?.description).toBe('live-desc')
    expect(slot.materialised).toBe(false)
  })
})

describe('flistResetWorkingToLive cancels armed follow-up flush', () => {
  it('a follow-up flush scheduled by a prior PUT success does not race the DELETE', async () => {
    useStore.setState({
      flistArchive: {
        '99': {
          live: { character: { description: 'live' } },
          backups: [],
          pullStatus: 'idle'
        }
      }
    })
    seedSlot('99', { character: { description: 'edited' } })
    const calls = mockFetch([
      // First PUT succeeds. flistFlushWorking's success branch may
      // arm a follow-up timer when newer payload is waiting; we keep
      // the slot 'dirty' across the await by editing immediately
      // after the PUT body is sent.
      async () => ok({ etag: 'next' }),
      async () => ok({ deleted: true }),
      async () => ok({ etag: 'restored' })
    ])
    // Arm an initial flush.
    useStore.getState().flistSetWorkingField('99', 'character.description', 'edited+')
    await vi.advanceTimersByTimeAsync(500)
    // Now edit again — this would schedule another flush in the success
    // branch via `_scheduleFlush`. Then reset before that timer fires.
    useStore.getState().flistSetWorkingField('99', 'character.description', 'edited++')
    await useStore.getState().flistResetWorkingToLive('99')
    // Let any potentially-stranded timers fire.
    await vi.advanceTimersByTimeAsync(1000)
    // Expect exactly one DELETE and no PUT *after* it (no resurrection
    // of the pre-reset payload).
    const idxDelete = calls.findIndex((c) => c.method === 'DELETE')
    expect(idxDelete).toBeGreaterThanOrEqual(0)
    const putsAfterDelete = calls
      .slice(idxDelete + 1)
      .filter((c) => c.method === 'PUT')
    expect(putsAfterDelete.length).toBe(0)
  })
})

describe('flistResetWorkingToLive + undo round-trip', () => {
  it('DELETEs, seeds from Live, then undo PUTs the original snapshot back', async () => {
    useStore.setState({
      flistArchive: {
        '99': {
          live: { character: { description: 'live' } },
          backups: [],
          pullStatus: 'idle'
        }
      }
    })
    seedSlot('99', {
      character: { description: 'edited' },
      _overlay: ['character.description']
    })
    const calls = mockFetch([
      async () => ok({ deleted: true }),
      async () => ok({ etag: 'restored' })
    ])
    await useStore.getState().flistResetWorkingToLive('99')
    const after = useStore.getState().flistWorking['99']
    const afterChar = after.payload.character as { description?: string } | undefined
    expect(afterChar?.description).toBe('live')
    expect(useStore.getState().flistResetUndo).not.toBeNull()
    await useStore.getState().flistUndoResetWorking()
    const restored = useStore.getState().flistWorking['99']
    const restoredChar = restored.payload.character as { description?: string } | undefined
    expect(restoredChar?.description).toBe('edited')
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
    expect(calls.some((c) => c.method === 'PUT')).toBe(true)
  })
})
