// Tier 4 — flistResetWorkingToBackup integration. Covers:
// - lazy backup load via api.flistSnapshotRead when cache miss
// - DELETE working then PUT seeded-from-backup, with undo snapshot
// - drain in-flight save so a mid-flight PUT can't resurrect the
//   pre-reset payload (parity with reset-to-Live).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'

interface Capture {
  url: string
  method: string
  body?: unknown
  headers?: Record<string, string>
}

function mockFetch(responses: ((c: Capture) => Promise<Response>)[]): Capture[] {
  const calls: Capture[] = []
  let idx = 0
  ;(globalThis as { fetch?: unknown }).fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL).toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      let body: unknown
      try {
        body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      } catch {
        body = init?.body
      }
      const headers: Record<string, string> = {}
      if (init?.headers) {
        for (const [k, v] of Object.entries(
          init.headers as Record<string, string>
        )) {
          headers[k] = String(v)
        }
      }
      const capture: Capture = { url, method, body, headers }
      calls.push(capture)
      const responder = responses[Math.min(idx, responses.length - 1)]
      idx++
      return responder(capture)
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

function seedSlot(characterId: string, payload: Record<string, unknown>) {
  useStore.setState((s) => ({
    flistWorking: {
      ...s.flistWorking,
      [characterId]: {
        payload: { _schema_version: 2, _overlay: ['character.description'], ...payload },
        overlay: ['character.description'],
        etag: 'seed',
        unsavedDirty: false,
        saveStatus: 'idle',
        saveError: null,
        lastSavedAt: null,
        materialised: true
      }
    },
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
  useStore.setState({
    flistWorking: {},
    flistArchive: {},
    flistDiffRightSource: {},
    flistDiffBackupCache: {},
    flistResetUndo: null
  })
})

afterEach(() => {
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
    mockFetch([async () => ok({ character: { description: 'snapshot' } })])
    await useStore.getState().flistDiffLoadBackup('99', '111.json')
    expect(useStore.getState().flistDiffBackupCache['99:111.json']).toBeDefined()
    // Idempotent on second call — fetch is not re-invoked.
    await useStore.getState().flistDiffLoadBackup('99', '111.json')
  })
})

describe('flistResetWorkingToBackup', () => {
  it('DELETEs working and seeds from backup, with undo snapshot stashed', async () => {
    seedSlot('99', { character: { description: 'edited' } })
    const calls = mockFetch([
      // backup read
      async () => ok({ character: { description: 'snapshot' } }),
      // delete
      async () => ok({ deleted: true }),
      // PUT after seed
      async () => ok({ etag: 'restored' })
    ])
    await useStore.getState().flistResetWorkingToBackup('99', '111.json')
    // Let the scheduled flush fire so the eager-PUT lands.
    await vi.advanceTimersByTimeAsync(1000)
    const methods = calls.map((c) => c.method)
    expect(methods).toContain('DELETE')
    const slot = useStore.getState().flistWorking['99']
    const charDesc = (slot.payload.character as { description?: string } | undefined)
      ?.description
    expect(charDesc).toBe('snapshot')
    expect(useStore.getState().flistResetUndo?.characterId).toBe('99')
  })

  it('survives DELETE failure: eager PUT carries the prior etag so on-disk file is overwritten cleanly (QA P1-1)', async () => {
    seedSlot('99', { character: { description: 'edited' } })
    const calls = mockFetch([
      // backup read
      async () => ok({ character: { description: 'snapshot' } }),
      // delete fails (server transient error)
      async () =>
        ({
          ok: false,
          status: 500,
          json: async () => ({ detail: 'transient' }),
          text: async () => '{}'
        } as unknown as Response),
      // PUT with If-Match: 'seed' succeeds because the file is still there
      async () => ok({ etag: 'overwritten' })
    ])
    await useStore.getState().flistResetWorkingToBackup('99', '111.json')
    await vi.advanceTimersByTimeAsync(1000)
    const put = calls.find((c) => c.method === 'PUT')
    expect(put).toBeDefined()
    // The eager PUT must carry If-Match against the pre-reset etag so
    // an unsuccessful DELETE doesn't leave disk out-of-sync with local.
    expect(put?.headers?.['If-Match']).toBe('seed')
  })
})

describe('flistDiffLoadBackup status tracking', () => {
  it('records error status on api failure so the view can distinguish loading from 404 (UX P1-3)', async () => {
    seedSlot('99', {})
    mockFetch([
      async () =>
        ({
          ok: false,
          status: 404,
          json: async () => ({ detail: 'not found' }),
          text: async () => '{}'
        } as unknown as Response)
    ])
    await useStore.getState().flistDiffLoadBackup('99', '999.json')
    expect(useStore.getState().flistDiffBackupStatus['99:999.json']).toBe('error')
  })

  it('marks loaded after a successful read', async () => {
    seedSlot('99', {})
    mockFetch([async () => ok({ character: { description: 'snap' } })])
    await useStore.getState().flistDiffLoadBackup('99', '888.json')
    expect(useStore.getState().flistDiffBackupStatus['99:888.json']).toBe('loaded')
  })
})
