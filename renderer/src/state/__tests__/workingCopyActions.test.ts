// Tier 2 §10 "Missing tests" — covers the action surface QA flagged
// as the most load-bearing untested paths: autosave debounce
// interleaving, 409 etag-mismatch handling, openWorking + archive race,
// reset-to-Live → undo round-trip, and signOut drains pending edits.
//
// All tests talk to the shared fake sidecar, so the real one isn't
// touched. Held requests (`fake.hold`) are how the in-flight races
// below are staged: a save stays open until the test releases it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { installFakeApi, json, networkError, type FakeApi } from '../../test/fakeApi'

let fake: FakeApi

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeApi()
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
  fake.restore()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const SET_ID = 'aaaaaaaaaaaa'
const BENCH_URL = `/flist/character/99/sets/${SET_ID}/payload`
const SAVE = `PUT ${BENCH_URL}`
const AUTOSAVE_MS = 500

const descOf = (body: unknown) =>
  ((body as { character?: { description?: string } }).character ?? {}).description

const conflict = json(
  { detail: { detail: 'etag_mismatch', current_etag: 'server-etag' } },
  409
)

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

function seedLive(live: Record<string, unknown>) {
  useStore.setState({
    flistArchive: { '99': { live, snapshots: [], pullStatus: 'idle' } }
  })
}

describe('autosave debouncer', () => {
  it('coalesces three keystrokes within 500 ms into a single PUT carrying the last payload', async () => {
    seedSlot('99', { character: { description: '' } })
    fake.on(SAVE, json({ etag: 'new1' }))

    useStore.getState().flistSetWorkingField('99', 'character.description', 'a')
    await vi.advanceTimersByTimeAsync(200)
    useStore.getState().flistSetWorkingField('99', 'character.description', 'ab')
    await vi.advanceTimersByTimeAsync(200)
    useStore.getState().flistSetWorkingField('99', 'character.description', 'abc')
    await vi.advanceTimersByTimeAsync(500)

    const puts = fake.requestsTo(SAVE)
    expect(puts.length).toBe(1)
    expect(descOf(puts[0].body)).toBe('abc')
  })

  it('keystrokes spaced wider than the debounce window each get their own save', async () => {
    // Coalescing is for bursts. Someone who types, pauses, and types
    // again has two versions worth keeping, and the first must not wait
    // for the second.
    seedSlot('99', { character: { description: '' } })
    fake.on(SAVE, json({ etag: 'saved' }))

    useStore.getState().setEditorContent('Azure')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100)
    expect(fake.requestsTo(SAVE).map((r) => descOf(r.body))).toEqual(['Azure'])

    useStore.getState().setEditorContent('Azure Viper')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100)

    expect(fake.requestsTo(SAVE).map((r) => descOf(r.body))).toEqual([
      'Azure',
      'Azure Viper'
    ])
    expect(useStore.getState().flistWorking['99'].unsavedDirty).toBe(false)
  })

  it('signOut drains pending working-copy edits via flistFlushWorking', async () => {
    seedSlot('99', { character: { description: 'before' } })
    fake.on(SAVE, json({ etag: 'flushed' }))
    fake.on('DELETE /flist/session', json({ signed_out: true }))
    useStore.getState().flistSetWorkingField('99', 'character.description', 'after')
    // Don't advance — leave the debounce armed; signOut should still flush.
    await useStore.getState().flistSignOut()
    const puts = fake.requestsTo(SAVE)
    expect(puts.length).toBe(1)
    expect(descOf(puts[0].body)).toBe('after')
  })
})

describe('typing while a save is in flight', () => {
  it('keeps the slot unsaved when the save lands, then saves the newer text', async () => {
    // The save carried "draft"; "draft, revised" arrived during the
    // round-trip. Marking the slot saved on the response would drop the
    // revision the moment the user switched away.
    seedSlot('99', { character: { description: '' } })
    fake.hold(SAVE)

    useStore.getState().setEditorContent('draft')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const [first] = fake.pending(SAVE)
    expect(descOf(first.request.body)).toBe('draft')

    useStore.getState().setEditorContent('draft, revised')
    first.resolve(json({ etag: 'after-first' }))
    await vi.advanceTimersByTimeAsync(0)

    const slot = useStore.getState().flistWorking['99']
    expect(slot.unsavedDirty).toBe(true)
    expect(slot.etag).toBe('after-first')

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const [second] = fake.pending(SAVE)
    expect(descOf(second.request.body)).toBe('draft, revised')
    expect(second.request.headers['If-Match']).toBe('after-first')

    second.resolve(json({ etag: 'after-second' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(useStore.getState().flistWorking['99'].unsavedDirty).toBe(false)
    expect(fake.requestsTo(SAVE)).toHaveLength(2)
  })

  // Real bug, see #2: two flushes queued behind the same in-flight save
  // both wake when it lands and each sends a PUT. The two leave
  // together with the same text and the same If-Match, so against the
  // real sidecar the second gets a 409 and raises a conflict banner
  // for a conflict the window had with itself. Drop `.fails` once the
  // fix lands.
  it.fails('only one save is in flight at a time, however many queue behind it', async () => {
    seedSlot('99', { character: { description: '' } })
    fake.hold(SAVE)
    let mostInFlight = 0
    const settle = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms)
      mostInFlight = Math.max(mostInFlight, fake.pending(SAVE).length)
    }

    useStore.getState().setEditorContent('one')
    await settle(AUTOSAVE_MS)
    // A slow sidecar: two more pauses pass while the first save is open.
    useStore.getState().setEditorContent('one two')
    await settle(AUTOSAVE_MS)
    useStore.getState().setEditorContent('one two three')
    await settle(AUTOSAVE_MS)
    expect(fake.requestsTo(SAVE)).toHaveLength(1)

    fake.pending(SAVE)[0].resolve(json({ etag: 'e1' }))
    await settle(0)
    await settle(AUTOSAVE_MS)
    for (const p of fake.pending(SAVE)) p.resolve(json({ etag: 'e2' }))
    await settle(AUTOSAVE_MS)

    expect(mostInFlight).toBe(1)
    expect(fake.requestsTo(SAVE).map((r) => descOf(r.body))).toEqual([
      'one',
      'one two three'
    ])
  })
})

describe('flistFlushWorking 409 etag-mismatch path', () => {
  it('does NOT adopt the server etag, so a retry cannot overwrite', async () => {
    // The window is no longer the only writer: a model editing through
    // MCP hits the same set. Adopting the server's etag here would let
    // the next keystroke's autosave succeed and silently overwrite the
    // model's work — the whole point of the conflict.
    seedSlot('99', { character: { description: 'mine' } })
    fake.on(SAVE, conflict)
    useStore.getState().flistSetWorkingField('99', 'character.description', 'mine-updated')
    await vi.advanceTimersByTimeAsync(500)
    const slot = useStore.getState().flistWorking['99']
    expect(slot.unsavedDirty).toBe(true)
    expect(slot.saveError).toMatch(/whose version to keep/i)
    expect(slot.etag).toBe('seed-etag')
  })

  it('raises the conflict banner carrying the server etag', async () => {
    seedSlot('99', { character: { description: 'mine' } })
    fake.on(SAVE, conflict)
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
    fake.on(
      `GET ${BENCH_URL}`,
      json({
        payload: {
          _schema_version: 2,
          _overlay: [],
          character: { description: 'theirs' }
        },
        etag: 'theirs'
      })
    )
    await useStore.getState().flistReloadAfterExternalChange('99')
    const slot = useStore.getState().flistWorking['99']
    const char = slot.payload.character as { description?: string } | undefined
    expect(char?.description).toBe('theirs')
    expect(slot.unsavedDirty).toBe(false)
    expect(slot.etag).toBe('theirs')
    expect(useStore.getState().flistExternalChange['99']).toBeNull()
  })

  it('after the reload the editor shows the reloaded description', async () => {
    // The slot taking their version is half of it; the open editor has
    // to show it too, or the next keystroke saves the old text over it.
    seedSlot('99', { character: { description: 'Lady Amber Blaise, as I left her' } })
    useStore.setState({ editorContent: 'Lady Amber Blaise, as I left her' })
    useStore.getState().flistNoteExternalChange('99', {
      setId: SET_ID,
      etag: 'theirs',
      origin: 'mcp:set_description'
    })
    fake.on(
      `GET ${BENCH_URL}`,
      json({
        payload: {
          _schema_version: 2,
          _overlay: ['character.description'],
          character: { description: 'Lady Amber Blaise, as the model wrote her' }
        },
        etag: 'theirs'
      })
    )

    await useStore.getState().flistReloadAfterExternalChange('99')

    expect(useStore.getState().editorContent).toBe(
      'Lady Amber Blaise, as the model wrote her'
    )
    expect(useStore.getState().editorDirty).toBe(false)
  })

  it('keep-mine writes against their etag, which is what makes it win', async () => {
    seedSlot('99', { character: { description: 'mine' } })
    useStore.getState().flistNoteExternalChange('99', {
      setId: SET_ID,
      etag: 'theirs',
      origin: 'mcp:set_description'
    })
    fake.on(SAVE, json({ etag: 'mine-now' }))
    await useStore.getState().flistOverwriteAfterExternalChange('99')
    const [put] = fake.requestsTo(SAVE)
    expect(put?.headers['If-Match']).toBe('theirs')
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
    fake.on(SAVE, conflict)
    await useStore.getState().flistOverwriteAfterExternalChange('99')
    expect(useStore.getState().flistExternalChange['99']).toBeTruthy()
  })
})

describe('flistOpenWorking archive race (QA P1-3)', () => {
  it('fetches Live + caches it before seeding the working copy on 404', async () => {
    useStore.setState({ flistArchive: {}, flistRoster: [] })
    fake.on(
      'GET /flist/character/99/live',
      json({ character: { description: 'live-desc', id: '99' }, id: '99' })
    )
    fake.on('GET /flist/character/99/workbench', json({ detail: 'no workbench' }, 404))
    fake.on('GET /flist/character/99/working', json({ detail: 'no working copy' }, 404))
    await useStore.getState().flistOpenWorking('99')
    expect(fake.requestsTo('GET /flist/character/99/live')).toHaveLength(1)
    expect(fake.requestsTo('GET /flist/character/99/working')).toHaveLength(1)
    const slot = useStore.getState().flistWorking['99']
    expect(slot).toBeDefined()
    const char = slot.payload.character as { description?: string } | undefined
    expect(char?.description).toBe('live-desc')
    expect(slot.materialised).toBe(false)
  })
})

describe('flistOpenWorking asks the server before legacy storage (working.json 409)', () => {
  it('hydrates the real bench and reads its payload instead of working.json', async () => {
    useStore.setState({
      flistArchive: {
        '99': {
          live: { character: { description: 'live-desc' } },
          snapshots: [],
          pullStatus: 'idle'
        }
      },
      flistRoster: []
    })
    fake.on(
      'GET /flist/character/99/workbench?create=false',
      json({
        workbench: { id: 'bbbbbbbbbbbb', kind: 'bench', name: 'Workbench' },
        active_set_id: 'bbbbbbbbbbbb'
      })
    )
    fake.on(
      'GET /flist/character/99/sets/bbbbbbbbbbbb/payload',
      json({
        payload: {
          _schema_version: 2,
          _overlay: [],
          character: { description: 'bench-desc' }
        },
        etag: 'disk-etag'
      })
    )
    await useStore.getState().flistOpenWorking('99')
    expect(fake.requestsTo('GET /flist/character/99/workbench?create=false')).toHaveLength(1)
    expect(fake.requestsTo('GET /flist/character/99/working')).toHaveLength(0)
    expect(useStore.getState().flistActiveSetId['99']).toBe('bbbbbbbbbbbb')
    const slot = useStore.getState().flistWorking['99']
    expect(slot.etag).toBe('disk-etag')
    expect(slot.materialised).toBe(true)
    expect((slot.payload.character as { description?: string }).description).toBe('bench-desc')
  })

  it('a character with no bench yet still falls through to the legacy read', async () => {
    useStore.setState({
      flistArchive: {
        '99': {
          live: { character: { description: 'live-desc' } },
          snapshots: [],
          pullStatus: 'idle'
        }
      },
      flistRoster: []
    })
    fake.on(
      'GET /flist/character/99/workbench?create=false',
      json({ workbench: null, reason: 'no_workbench' })
    )
    fake.on('GET /flist/character/99/working', json({ detail: 'no working copy' }, 404))
    await useStore.getState().flistOpenWorking('99')
    expect(fake.requestsTo('GET /flist/character/99/workbench?create=false')).toHaveLength(1)
    expect(fake.requestsTo('GET /flist/character/99/working')).toHaveLength(1)
    const slot = useStore.getState().flistWorking['99']
    expect((slot.payload.character as { description?: string }).description).toBe('live-desc')
    expect(slot.materialised).toBe(false)
  })
})

describe('flistResetWorkingToLive writes the bench, not working.json', () => {
  it('replaces the bench on disk with Live, against the etag the window holds', async () => {
    seedLive({
      character: { description: 'live' },
      images: [
        { image_id: '1', description: '', sort_order: 0 },
        { image_id: '2', description: '', sort_order: 1 }
      ]
    })
    seedSlot('99', {
      character: { description: 'edited' },
      images: [
        { image_id: '2', description: '', sort_order: 0 },
        { image_id: '1', description: '', sort_order: 1 },
        { image_id: 'local-abc', description: '', sort_order: 2 }
      ],
      _overlay: ['character.description', 'images']
    })
    fake.on(SAVE, json({ etag: 'after-reset' }))

    await useStore.getState().flistResetWorkingToLive('99')

    expect(fake.requests.length).toBe(1)
    const [put] = fake.requests
    expect(put.method).toBe('PUT')
    expect(put.path).toBe(BENCH_URL)
    expect(put.headers['If-Match']).toBe('seed-etag')
    expect(descOf(put.body)).toBe('live')
    const images = (put.body as { images: { image_id: string }[] }).images
    expect(images.map((i) => i.image_id)).toEqual(['1', '2'])
    expect((put.body as { _overlay: string[] })._overlay).toEqual([])

    const slot = useStore.getState().flistWorking['99']
    expect(slot.etag).toBe('after-reset')
    expect(slot.unsavedDirty).toBe(false)
    expect(slot.materialised).toBe(true)
    expect(slot.overlay).toEqual([])
  })

  it('a follow-up flush armed before the reset never ships the pre-reset payload', async () => {
    seedLive({ character: { description: 'live' } })
    seedSlot('99', { character: { description: 'edited' } })
    fake.once(SAVE, json({ etag: 'next' }))
    fake.once(SAVE, json({ etag: 'after-reset' }))
    fake.on(SAVE, json({ etag: 'unexpected' }))
    // A save lands, then a newer edit arms the success branch's
    // follow-up flush; the reset arrives before that timer fires.
    useStore.getState().flistSetWorkingField('99', 'character.description', 'edited+')
    await vi.advanceTimersByTimeAsync(500)
    useStore.getState().flistSetWorkingField('99', 'character.description', 'edited++')
    await useStore.getState().flistResetWorkingToLive('99')
    await vi.advanceTimersByTimeAsync(1000)

    const puts = fake.requestsTo(SAVE)
    expect(puts.map((p) => descOf(p.body))).toEqual(['edited+', 'live'])
    // The reset writes over the etag the landed save left, not the
    // one the slot carried before it.
    expect(puts[1].headers['If-Match']).toBe('next')
    expect(fake.requests.some((r) => r.path.includes('/working'))).toBe(false)
    expect(useStore.getState().flistWorking['99'].etag).toBe('after-reset')
  })

  it('drains a save still in flight, then writes Live over the etag that save returned', async () => {
    // The reset is pressed while an autosave is on the wire. Writing
    // straight away would race it: whichever lands second wins, and
    // the reset's If-Match would name an etag the save is about to
    // replace.
    seedLive({ character: { description: 'live' } })
    seedSlot('99', { character: { description: 'edited' } })
    fake.hold(SAVE)

    useStore.getState().setEditorContent('edited, still saving')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const [inFlight] = fake.pending(SAVE)
    expect(descOf(inFlight.request.body)).toBe('edited, still saving')

    const reset = useStore.getState().flistResetWorkingToLive('99')
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.requestsTo(SAVE)).toHaveLength(1)

    inFlight.resolve(json({ etag: 'landed' }))
    await vi.advanceTimersByTimeAsync(0)
    const [resetWrite] = fake.pending(SAVE)
    expect(descOf(resetWrite.request.body)).toBe('live')
    expect(resetWrite.request.headers['If-Match']).toBe('landed')

    resetWrite.resolve(json({ etag: 'after-reset' }))
    await reset
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2)
    expect(fake.requestsTo(SAVE)).toHaveLength(2)
    expect(useStore.getState().flistWorking['99'].etag).toBe('after-reset')
    expect(useStore.getState().editorContent).toBe('live')
  })

  it('a slot that was never materialised is reseeded in memory only', async () => {
    seedLive({ character: { description: 'live' } })
    seedSlot('99', { character: { description: 'live' } })
    useStore.setState((s) => ({
      flistWorking: {
        ...s.flistWorking,
        '99': { ...s.flistWorking['99'], materialised: false, etag: null }
      }
    }))
    fake.on(SAVE, json({ etag: 'unexpected' }))

    await useStore.getState().flistResetWorkingToLive('99')
    await vi.advanceTimersByTimeAsync(1000)

    expect(fake.requests).toEqual([])
    expect(useStore.getState().flistWorking['99'].materialised).toBe(false)
  })
})

describe('flistResetWorkingToLive + undo round-trip', () => {
  it('undo writes the snapshot back into the bench over the reset\'s etag', async () => {
    seedLive({ character: { description: 'live' } })
    seedSlot('99', {
      character: { description: 'edited' },
      _overlay: ['character.description']
    })
    fake.once(SAVE, json({ etag: 'after-reset' }))
    fake.once(SAVE, json({ etag: 'after-undo' }))

    await useStore.getState().flistResetWorkingToLive('99')
    expect(useStore.getState().flistResetUndo).not.toBeNull()
    await useStore.getState().flistUndoResetWorking()

    expect(fake.requests.length).toBe(2)
    const undoPut = fake.requests[1]
    expect(undoPut.method).toBe('PUT')
    expect(undoPut.path).toBe(BENCH_URL)
    expect(undoPut.headers['If-Match']).toBe('after-reset')
    expect(descOf(undoPut.body)).toBe('edited')

    const restored = useStore.getState().flistWorking['99']
    expect(descOf(restored.payload)).toBe('edited')
    expect(restored.overlay).toEqual(['character.description'])
    expect(restored.etag).toBe('after-undo')
    expect(restored.unsavedDirty).toBe(false)
    expect(useStore.getState().flistResetUndo).toBeNull()
  })
})

describe('switching characters must not strand the last edit', () => {
  // Reported from the field: "switching between characters silently
  // discards all changes". Autosave waits 500 ms for quiet time, so an
  // edit followed straight away by a character switch is exactly the
  // window where bytes could be lost — and losing them without a word
  // is the worst version of it.
  it('flushes a pending edit before the switch', async () => {
    seedSlot('99', { character: { description: 'before' } })
    fake.on(SAVE, json({ etag: 'flushed' }))

    useStore
      .getState()
      .flistSetWorkingField('99', 'character.description', 'typed then left')
    // No timer advance: the debounce is still armed, the way it is when
    // someone types and immediately clicks another character.
    await useStore.getState().flistSelectCharacter('100')

    const puts = fake.requestsTo(SAVE)
    expect(puts.length).toBe(1)
    expect(descOf(puts[0].body)).toBe('typed then left')
    expect(useStore.getState().flistActiveCharacterId).toBe('100')
  })

  it('keeps the edit in the slot when the save fails, and says so', async () => {
    // The switch goes through either way — blocking it would trap the
    // user — so the edit has to survive in memory with the error
    // visible, not vanish quietly.
    seedSlot('99', { character: { description: 'before' } })
    fake.on(SAVE, networkError('sidecar down'))

    useStore
      .getState()
      .flistSetWorkingField('99', 'character.description', 'at risk')
    await useStore.getState().flistSelectCharacter('100')

    const slot = useStore.getState().flistWorking['99']
    expect(descOf(slot.payload)).toBe('at risk')
    expect(slot.unsavedDirty).toBe(true)
    expect(slot.saveStatus).toBe('error')
  })
})

describe('reopening a character must not discard what was typed', () => {
  // Reported from the field: "switching between characters silently
  // discards all changes." Two ways that happened, both fixed here.
  it('a picker click on the character already open keeps the edit', async () => {
    // The picker calls flistOpenWorking on every click — including on
    // the character already open, which is how a user leaves a
    // read-only Live view. That reseeded the slot from Live, and the
    // armed autosave then found nothing dirty and dropped the write.
    seedSlot('99', { character: { description: 'before' } })
    useStore.setState({
      flistRoster: [{ id: 99, name: 'Amber' }] as never,
      flistArchive: {
        '99': {
          live: { character: { name: 'Amber', description: 'live text' } },
          snapshots: [],
          pullStatus: 'idle'
        }
      } as never,
      editorReadOnly: false
    })
    fake.on(SAVE, json({ etag: 'x' }))

    useStore.getState().setEditorContent('typed just now')
    useStore.getState().selectCharacter('Amber')
    await vi.advanceTimersByTimeAsync(2000)

    const puts = fake.requestsTo(SAVE)
    expect(puts.length).toBe(1)
    expect(descOf(puts[0].body)).toBe('typed just now')
    expect(useStore.getState().editorContent).toBe('typed just now')
  })

  it('the first edit opens the Workbench instead of going nowhere', async () => {
    // With no set active the flush used to return early and write
    // nothing, while saveStatus stayed 'idle' — so the UI showed no
    // sign that the text was only in memory.
    seedSlot('99', { character: { description: 'before' } })
    useStore.setState((s) => ({
      flistActiveSetId: { ...s.flistActiveSetId, '99': null },
      editorReadOnly: false
    }))
    const NEW_BENCH = '/flist/character/99/sets/bbbbbbbbbbbb'
    // flistOpenWorkbench: resolve the bench, then activate it.
    fake.on(
      'GET /flist/character/99/workbench',
      json({
        workbench: { id: 'bbbbbbbbbbbb', name: 'Workbench', created_at: 1, updated_at: 2 },
        active_set_id: 'bbbbbbbbbbbb'
      })
    )
    fake.on(`POST ${NEW_BENCH}/activate`, json({ ok: true }))
    fake.on(
      `GET ${NEW_BENCH}/payload`,
      json({ payload: { character: { description: 'typed' } }, etag: 'e1' })
    )
    fake.on(`PUT ${NEW_BENCH}/payload`, json({ etag: 'saved' }))

    useStore.getState().setEditorContent('typed')
    await vi.advanceTimersByTimeAsync(2000)

    expect(fake.requestsTo(`PUT ${NEW_BENCH}/payload`).length).toBeGreaterThan(0)
  })
})

describe('coming back to a character shows the Workbench, not Live', () => {
  it('loads the active set payload instead of reseeding from Live', async () => {
    // Reported from the field: edit a character, switch away, switch
    // back — the Workbench row is selected but the editor shows the
    // published profile. The edits were fine on disk; the window was
    // reading the wrong thing. Clicking Live and then Workbench fixed
    // it, because that path goes through flistActivateSet, which does
    // read the set's payload.
    seedSlot('99', { character: { description: 'stale' } })
    useStore.setState((s) => ({
      flistWorking: {},
      flistArchive: {
        '99': {
          live: { character: { name: 'Amber', description: 'what the site has' } },
          snapshots: [],
          pullStatus: 'idle'
        }
      } as never,
      flistActiveSetId: { ...s.flistActiveSetId, '99': SET_ID },
      flistActiveCharacterId: '99'
    }))
    fake.on(
      `GET ${BENCH_URL}`,
      json({
        payload: {
          _schema_version: 2,
          _overlay: ['character.description'],
          character: { description: 'what I typed earlier' }
        },
        etag: 'e1'
      })
    )

    await useStore.getState().flistOpenWorking('99')

    expect(useStore.getState().editorContent).toBe('what I typed earlier')
    const slot = useStore.getState().flistWorking['99']
    expect(descOf(slot.payload)).toBe('what I typed earlier')
  })
})

describe('gallery changes save themselves', () => {
  // Reported from the field: three images moved from the pool onto the
  // profile, the view updated, and the set sat at "unsaved edits"
  // indefinitely. The restore ZIP still held the version from twenty
  // minutes earlier, so the extension uploaded a profile without them.
  // Every other mutation schedules a flush; this one did not.
  it('adding an image to the profile writes it to disk', async () => {
    seedSlot('99', { character: { description: 'x' }, images: [] })
    fake.on(SAVE, json({ etag: 'saved' }))

    useStore.getState().flistMoveImageToProfile('99', 'local-abc12345')
    await vi.advanceTimersByTimeAsync(1000)

    const puts = fake.requestsTo(SAVE)
    expect(puts.length).toBe(1)
    const body = puts[0].body as { images: { image_id: string }[] }
    expect(body.images.map((i) => i.image_id)).toEqual(['local-abc12345'])
    expect(useStore.getState().flistWorking['99'].unsavedDirty).toBe(false)
  })

  it('moving one back to the pool saves too', async () => {
    seedSlot('99', {
      character: { description: 'x' },
      images: [{ image_id: '47002195', description: '', sort_order: 0 }]
    })
    fake.on(SAVE, json({ etag: 'saved' }))

    useStore.getState().flistMoveImageToPool('99', '47002195')
    await vi.advanceTimersByTimeAsync(1000)

    const puts = fake.requestsTo(SAVE)
    expect(puts.length).toBe(1)
    expect((puts[0].body as { images: unknown[] }).images).toEqual([])
  })

  it('reordering coalesces into one write', async () => {
    // Clicking ↑ four times should not send four PUTs.
    seedSlot('99', {
      character: { description: 'x' },
      images: [
        { image_id: 'a', description: '', sort_order: 0 },
        { image_id: 'b', description: '', sort_order: 1 }
      ]
    })
    fake.on(SAVE, json({ etag: 'saved' }))

    const setGallery = useStore.getState().flistSetGalleryImages
    for (let i = 0; i < 4; i++) {
      const rows = (useStore.getState().flistWorking['99'].payload as {
        images: { image_id: string; description: string; sort_order: number }[]
      }).images
      setGallery('99', [...rows].reverse().map((r, n) => ({ ...r, sort_order: n })))
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(1000)

    expect(fake.requestsTo(SAVE).length).toBe(1)
  })
})
