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
    flistSetWorking: {},
    flistActiveSetId: {},
    flistSets: {},
    flistExternalChange: {},
    flistArchive: {},
    flistCustomKinksUI: {},
    flistResetUndo: null,
    flistTombstoneUndo: null,
    flistActiveCharacterId: null,
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

const SET_ID = 'aaaaaaaaaaaa'

function seedSlot(characterId: string, payload: Record<string, unknown>) {
  const slot = {
    payload: { _schema_version: 2, _overlay: [], ...payload },
    overlay: Array.isArray(payload._overlay)
      ? (payload._overlay as string[])
      : [],
    etag: 'seed-etag',
    unsavedDirty: false,
    saveStatus: 'idle' as const,
    saveError: null,
    lastSavedAt: null,
    materialised: true
  }
  useStore.setState((s) => ({
    flistWorking: { ...s.flistWorking, [characterId]: slot },
    // Working sets v2: a flush routes through the *active set's*
    // payload endpoint and silently no-ops when no set is active
    // (that's F-list read-only mode). Without this the autosave
    // assertions below can never see a PUT.
    flistSetWorking: { ...s.flistSetWorking, [SET_ID]: slot },
    flistActiveSetId: { ...s.flistActiveSetId, [characterId]: SET_ID },
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

const conflictResponse = async () =>
  ({
    ok: false,
    status: 409,
    json: async () => ({
      detail: { detail: 'etag_mismatch', current_etag: 'server-etag' }
    }),
    text: async () => '{}'
  }) as unknown as Response

describe('flistFlushWorking 409 etag-mismatch path', () => {
  it('does NOT adopt the server etag, so a retry cannot overwrite', async () => {
    // The window is no longer the only writer: a model editing through
    // MCP hits the same set. Adopting the server's etag here would let
    // the next keystroke's autosave succeed and silently overwrite the
    // model's work — the whole point of the conflict.
    seedSlot('99', { character: { description: 'mine' } })
    mockFetch([conflictResponse])
    useStore.getState().flistSetWorkingField('99', 'character.description', 'mine-updated')
    await vi.advanceTimersByTimeAsync(500)
    const slot = useStore.getState().flistWorking['99']
    expect(slot.unsavedDirty).toBe(true)
    expect(slot.saveError).toMatch(/whose version to keep/i)
    expect(slot.etag).toBe('seed-etag')
  })

  it('raises the conflict banner carrying the server etag', async () => {
    seedSlot('99', { character: { description: 'mine' } })
    mockFetch([conflictResponse])
    useStore.getState().flistSetWorkingField('99', 'character.description', 'mine-updated')
    await vi.advanceTimersByTimeAsync(500)
    const change = useStore.getState().flistExternalChange['99']
    expect(change).toBeTruthy()
    expect(change?.setId).toBe(SET_ID)
    expect(change?.etag).toBe('server-etag')
  })
})

describe('external-change resolution', () => {
  it('ignores a change carrying the etag we already hold', () => {
    // Our own write comes back over the event stream too.
    seedSlot('99', { character: { description: 'mine' } })
    useStore.getState().flistNoteExternalChange('99', {
      setId: SET_ID,
      etag: 'seed-etag',
      origin: 'mcp:set_description'
    })
    expect(useStore.getState().flistExternalChange['99']).toBeUndefined()
  })

  it('raises a banner for a change made by something else', () => {
    seedSlot('99', { character: { description: 'mine' } })
    useStore.getState().flistNoteExternalChange('99', {
      setId: SET_ID,
      etag: 'theirs',
      origin: 'mcp:set_description'
    })
    const change = useStore.getState().flistExternalChange['99']
    expect(change?.origin).toBe('mcp:set_description')
  })

  it('reload takes their version and clears the banner', async () => {
    seedSlot('99', { character: { description: 'mine' } })
    useStore.getState().flistNoteExternalChange('99', {
      setId: SET_ID,
      etag: 'theirs',
      origin: 'mcp:set_description'
    })
    mockFetch([
      async () =>
        ok({
          payload: {
            _schema_version: 2,
            _overlay: [],
            character: { description: 'theirs' }
          },
          etag: 'theirs'
        })
    ])
    await useStore.getState().flistReloadAfterExternalChange('99')
    const slot = useStore.getState().flistWorking['99']
    const char = slot.payload.character as { description?: string } | undefined
    expect(char?.description).toBe('theirs')
    expect(slot.unsavedDirty).toBe(false)
    expect(slot.etag).toBe('theirs')
    expect(useStore.getState().flistExternalChange['99']).toBeNull()
  })

  it('keep-mine writes against their etag, which is what makes it win', async () => {
    seedSlot('99', { character: { description: 'mine' } })
    useStore.getState().flistNoteExternalChange('99', {
      setId: SET_ID,
      etag: 'theirs',
      origin: 'mcp:set_description'
    })
    const calls = mockFetch([async () => ok({ etag: 'mine-now' })])
    await useStore.getState().flistOverwriteAfterExternalChange('99')
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.headers?.['If-Match']).toBe('theirs')
    const slot = useStore.getState().flistWorking['99']
    expect(slot.etag).toBe('mine-now')
    expect(slot.unsavedDirty).toBe(false)
    expect(useStore.getState().flistExternalChange['99']).toBeNull()
  })

  it('a failed keep-mine leaves the banner up', async () => {
    seedSlot('99', { character: { description: 'mine' } })
    useStore.getState().flistNoteExternalChange('99', {
      setId: SET_ID,
      etag: 'theirs',
      origin: 'mcp:set_description'
    })
    mockFetch([conflictResponse])
    await useStore.getState().flistOverwriteAfterExternalChange('99')
    expect(useStore.getState().flistExternalChange['99']).toBeTruthy()
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
          snapshots: [],
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
          snapshots: [],
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
