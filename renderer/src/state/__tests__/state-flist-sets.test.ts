// Tier 7 Step 7 — slice surgery coverage.
//
// Asserts the new flistSets / flistActiveSetId / flistSetWorking /
// flistAccordion / flistBackupsList fields exist with the right initial
// shape, and that the new actions (set CRUD, snapshots, backups, undo,
// accordion) mutate the store correctly. All HTTP is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { selectWorkingSlot, emptyWorkingSlot } from '../flist'

interface RouteFn {
  match: RegExp
  method: string
  reply: () => Promise<{
    ok: boolean
    status: number
    json: () => Promise<unknown>
    text: () => Promise<string>
  }>
}

function mockFetchRoutes(routes: RouteFn[]) {
  ;(globalThis as { fetch?: unknown }).fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL).toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      for (const r of routes) {
        if (r.method === method && r.match.test(url)) {
          return (await r.reply()) as unknown as Response
        }
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({ detail: 'no route' }),
        text: async () => '{}'
      } as unknown as Response
    }
  )
}

function ok(body: unknown, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  })
}

beforeEach(() => {
  useStore.setState({
    flistSets: {},
    flistSetsStatus: {},
    flistActiveSetId: {},
    flistSetSnapshots: {},
    flistSetWorking: {},
    flistSetWorkingLoadStatus: {},
    flistSetUndoStack: {},
    flistSetRedoStack: {},
    flistBackupsList: {},
    flistBackupsStatus: {},
    flistAccordion: {},
    flistWorking: {},
    flistWorkingLoadStatus: {}
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('initial slice shape', () => {
  it('exposes the Tier 7 fields with empty defaults', () => {
    const s = useStore.getState()
    expect(s.flistSets).toEqual({})
    expect(s.flistSetsStatus).toEqual({})
    expect(s.flistActiveSetId).toEqual({})
    expect(s.flistSetSnapshots).toEqual({})
    expect(s.flistSetWorking).toEqual({})
    expect(s.flistSetWorkingLoadStatus).toEqual({})
    expect(s.flistSetUndoStack).toEqual({})
    expect(s.flistSetRedoStack).toEqual({})
    expect(s.flistBackupsList).toEqual({})
    expect(s.flistBackupsStatus).toEqual({})
    expect(s.flistAccordion).toEqual({})
  })

  it('exposes the Tier 7 action functions', () => {
    const s = useStore.getState()
    expect(typeof s.flistLoadSets).toBe('function')
    expect(typeof s.flistCreateSet).toBe('function')
    expect(typeof s.flistRenameSet).toBe('function')
    expect(typeof s.flistDeleteSet).toBe('function')
    expect(typeof s.flistActivateSet).toBe('function')
    expect(typeof s.flistLoadSnapshots).toBe('function')
    expect(typeof s.flistTakeSnapshot).toBe('function')
    expect(typeof s.flistRenameSnapshot).toBe('function')
    expect(typeof s.flistRevertToSnapshot).toBe('function')
    expect(typeof s.flistDeleteSnapshot).toBe('function')
    expect(typeof s.flistLoadBackups).toBe('function')
    expect(typeof s.flistCreateBackup).toBe('function')
    expect(typeof s.flistDeleteBackup).toBe('function')
    expect(typeof s.flistBackupAbsPath).toBe('function')
    expect(typeof s.flistRecordPatch).toBe('function')
    expect(typeof s.flistUndo).toBe('function')
    expect(typeof s.flistRedo).toBe('function')
    expect(typeof s.flistSetAccordion).toBe('function')
  })
})

describe('selectWorkingSlot', () => {
  it('returns the active set slot when active-set pointer is set', () => {
    const slot = { ...emptyWorkingSlot(), etag: 'abc' }
    useStore.setState({
      flistActiveSetId: { '7': 'set-A' },
      flistSetWorking: { 'set-A': slot }
    })
    const got = selectWorkingSlot(useStore.getState(), '7')
    expect(got?.etag).toBe('abc')
  })

  it('falls back to legacy flistWorking[characterId] when no set pointer', () => {
    const legacy = { ...emptyWorkingSlot(), etag: 'legacy' }
    useStore.setState({ flistWorking: { '7': legacy } })
    const got = selectWorkingSlot(useStore.getState(), '7')
    expect(got?.etag).toBe('legacy')
  })

  it('returns undefined when neither bucket has a slot', () => {
    expect(selectWorkingSlot(useStore.getState(), 'missing')).toBeUndefined()
  })
})

describe('flistRecordPatch + flistUndo/flistRedo', () => {
  it('records a patch onto the active set stack and clears redo', () => {
    useStore.setState({
      flistActiveSetId: { '7': 'set-A' },
      flistSetRedoStack: {
        'set-A': [
          { kind: 'set', path: 'character.description', before: 'a', after: 'b' }
        ]
      }
    })
    useStore.getState().flistRecordPatch('set-A', {
      kind: 'set',
      path: 'character.description',
      before: '',
      after: 'hi'
    })
    const s = useStore.getState()
    expect(s.flistSetUndoStack['set-A']).toHaveLength(1)
    expect(s.flistSetRedoStack['set-A']).toEqual([])
  })

  it('caps the undo stack at 50 entries (oldest drops)', () => {
    for (let i = 0; i < 55; i++) {
      useStore.getState().flistRecordPatch('set-A', {
        kind: 'set',
        path: 'character.description',
        before: String(i - 1),
        after: String(i)
      })
    }
    const stack = useStore.getState().flistSetUndoStack['set-A']
    expect(stack).toHaveLength(50)
    // First-pushed entries (0-4) should have fallen off; 5 is the new
    // oldest, 54 the newest.
    expect((stack[0] as { after: string }).after).toBe('5')
    expect((stack[49] as { after: string }).after).toBe('54')
  })

  it('round-trips a `set` patch through undo / redo', () => {
    const slot = {
      ...emptyWorkingSlot(),
      payload: { _overlay: [], character: { description: 'after' } }
    }
    useStore.setState({
      flistActiveSetId: { '7': 'set-A' },
      flistSetWorking: { 'set-A': slot },
      flistSetUndoStack: {
        'set-A': [
          {
            kind: 'set',
            path: 'character.description',
            before: 'before',
            after: 'after'
          }
        ]
      }
    })
    useStore.getState().flistUndo('7')
    const afterUndo = useStore.getState().flistSetWorking['set-A']
    expect(
      (afterUndo.payload as { character: { description: string } }).character
        .description
    ).toBe('before')
    expect(useStore.getState().flistSetUndoStack['set-A']).toHaveLength(0)
    expect(useStore.getState().flistSetRedoStack['set-A']).toHaveLength(1)

    useStore.getState().flistRedo('7')
    const afterRedo = useStore.getState().flistSetWorking['set-A']
    expect(
      (afterRedo.payload as { character: { description: string } }).character
        .description
    ).toBe('after')
    expect(useStore.getState().flistSetUndoStack['set-A']).toHaveLength(1)
    expect(useStore.getState().flistSetRedoStack['set-A']).toHaveLength(0)
  })

  it('flistUndo is a no-op when the stack is empty', () => {
    useStore.setState({
      flistActiveSetId: { '7': 'set-A' },
      flistSetWorking: { 'set-A': emptyWorkingSlot() },
      flistSetUndoStack: { 'set-A': [] }
    })
    expect(() => useStore.getState().flistUndo('7')).not.toThrow()
    expect(useStore.getState().flistSetRedoStack['set-A'] ?? []).toEqual([])
  })

  it('flistUndo is a no-op when no active-set pointer exists', () => {
    expect(() => useStore.getState().flistUndo('unknown')).not.toThrow()
  })
})

describe('sets / snapshots / backups action wiring', () => {
  it('loads sets and stamps the active-set pointer', async () => {
    mockFetchRoutes([
      {
        match: /\/flist\/character\/7\/sets$/,
        method: 'GET',
        reply: ok({
          sets: [
            {
              id: 'set-A',
              name: 'Main',
              createdAt: 1,
              updatedAt: 2,
              snapshotCount: 0
            }
          ],
          active_set_id: 'set-A'
        })
      }
    ])
    await useStore.getState().flistLoadSets('7')
    const s = useStore.getState()
    expect(s.flistSets['7']).toEqual([
      { id: 'set-A', name: 'Main', createdAt: 1, updatedAt: 2, snapshotCount: 0 }
    ])
    expect(s.flistActiveSetId['7']).toBe('set-A')
    expect(s.flistSetsStatus['7']).toBe('ready')
  })

  it('creates a set and prepends it to the per-character list', async () => {
    mockFetchRoutes([
      {
        match: /\/flist\/character\/7\/sets$/,
        method: 'POST',
        reply: ok(
          {
            set: {
              id: 'set-B',
              name: 'Modern AU',
              createdAt: 10,
              updatedAt: 10,
              snapshotCount: 0
            }
          },
          201
        )
      }
    ])
    useStore.setState({
      flistSets: {
        '7': [
          { id: 'set-A', name: 'Main', createdAt: 1, updatedAt: 2, snapshotCount: 0 }
        ]
      }
    })
    const created = await useStore.getState().flistCreateSet('7', {
      name: 'Modern AU',
      seed: 'live'
    })
    expect(created.id).toBe('set-B')
    expect(useStore.getState().flistSets['7']?.[0].id).toBe('set-B')
  })

  it('takes a snapshot and prepends it to the per-set snapshot list', async () => {
    mockFetchRoutes([
      {
        match: /\/flist\/character\/7\/sets\/set-A\/snapshots$/,
        method: 'POST',
        reply: ok(
          {
            snapshot: { id: 'snap-1', name: 'Pre-rewrite', createdAt: 42 }
          },
          201
        )
      }
    ])
    await useStore.getState().flistTakeSnapshot('7', 'set-A', 'Pre-rewrite')
    const snaps = useStore.getState().flistSetSnapshots['set-A']
    expect(snaps).toEqual([
      { id: 'snap-1', name: 'Pre-rewrite', createdAt: 42 }
    ])
  })

  it('loads backups and stamps `ready` status', async () => {
    mockFetchRoutes([
      {
        match: /\/flist\/character\/7\/backups-v6$/,
        method: 'GET',
        reply: ok({
          backups: [
            {
              filename: '2026-06-02T18-44-00__auto-pull__d2f8.zip',
              createdAt: 1700000000,
              size: 4_200_000,
              source: 'auto-pull',
              sourceName: null,
              payloadHash: 'd2f8abcd'
            }
          ]
        })
      }
    ])
    await useStore.getState().flistLoadBackups('7')
    const s = useStore.getState()
    expect(s.flistBackupsStatus['7']).toBe('ready')
    expect(s.flistBackupsList['7']?.[0]).toEqual({
      filename: '2026-06-02T18-44-00__auto-pull__d2f8.zip',
      createdAt: 1700000000,
      size: 4_200_000,
      source: 'auto-pull',
      sourceName: null,
      payloadHash: 'd2f8abcd'
    })
  })

  it('flistSetAccordion persists per-character open/closed map', () => {
    useStore.getState().flistSetAccordion('7', 'snippets', true)
    const s = useStore.getState()
    expect(s.flistAccordion['7']?.snippets).toBe(true)
    expect(s.flistAccordion['7']?.sets).toBe(true)
    expect(s.flistAccordion['7']?.backups).toBe(true)
  })
})

describe('flistActivateSet', () => {
  it('switches the active-set pointer and mirrors slot back into legacy flistWorking', async () => {
    mockFetchRoutes([
      {
        match: /\/flist\/character\/7\/sets\/set-B\/activate$/,
        method: 'POST',
        reply: ok({ active_set_id: 'set-B' })
      }
    ])
    const slotB = { ...emptyWorkingSlot(), etag: 'etag-B' }
    useStore.setState({
      flistActiveSetId: { '7': 'set-A' },
      flistSetWorking: {
        'set-A': { ...emptyWorkingSlot(), etag: 'etag-A' },
        'set-B': slotB
      },
      flistWorking: { '7': { ...emptyWorkingSlot(), etag: 'etag-A' } }
    })
    await useStore.getState().flistActivateSet('7', 'set-B')
    const s = useStore.getState()
    expect(s.flistActiveSetId['7']).toBe('set-B')
    expect(s.flistWorking['7']?.etag).toBe('etag-B')
    expect(selectWorkingSlot(s, '7')?.etag).toBe('etag-B')
  })
})
