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
import {
  archiveEntry,
  livePayload,
  payloadRead,
  workbenchPayload,
  workbenchRead,
  workingSlot
} from '../../test/payloads'

let fake: FakeApi

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeApi()
  useStore.setState({
    flistWorking: {},
    flistExternalChange: {},
    flistArchive: {},
    flistCustomKinksUI: {},
    flistResetUndo: null,
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

const BENCH_URL = '/flist/character/99/workbench/payload'
const SAVE = `PUT ${BENCH_URL}`
const RESET = 'POST /flist/character/99/workbench/reset-to-live'
const AUTOSAVE_MS = 500

const descOf = (body: unknown) =>
  ((body as { character?: { description?: string } }).character ?? {}).description

const refusal = (code: string, currentEtag: string | null) =>
  json(
    {
      code,
      message: 'The Workbench changed since it was read.',
      details: { current_etag: currentEtag }
    },
    409
  )
const conflict = refusal('etag_mismatch', 'server-etag')

/** What the sidecar answers to reset to Live: the fresh copy of Live,
 *  its etag, and the Backup it kept of the Workbench it replaced. */
const resetAnswer = (
  description: string,
  etag: string,
  kept: { filename: string; created_at: number } | null = null
) =>
  json({
    payload: workbenchPayload({ character: { description } }),
    etag,
    backed_up_first: kept
  })

function seedSlot(characterId: string, payload: Record<string, unknown>) {
  const slot = workingSlot(workbenchPayload(payload))
  useStore.setState((s) => ({
    flistWorking: { ...s.flistWorking, [characterId]: slot },
    flistActiveCharacterId: characterId
  }))
}

function seedLive(live: Record<string, unknown>) {
  useStore.setState({
    flistArchive: { '99': archiveEntry(livePayload(live)) }
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

  it('an edit saves the Workbench with its unknown top-level keys intact (forward-compat)', async () => {
    // A newer version may have written keys this one does not know;
    // saving an edit must carry them back to disk, not drop them.
    seedSlot('99', { character: { description: 'before' }, _future: { tier: 5 } })
    fake.on(SAVE, json({ etag: 'saved' }))

    useStore.getState().flistSetWorkingField('99', 'character.description', 'after')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100)

    const puts = fake.requestsTo(SAVE)
    expect(puts.map((r) => descOf(r.body))).toEqual(['after'])
    expect((puts[0].body as Record<string, unknown>)._future).toEqual({ tier: 5 })
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

  // A slow sidecar: the first save stays open while two more pauses
  // pass, so two flushes queue behind it; then every save lands.
  async function burstBehindASlowSave() {
    seedSlot('99', { character: { description: '' } })
    fake.hold(SAVE)

    useStore.getState().setEditorContent('one')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    useStore.getState().setEditorContent('one two')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    useStore.getState().setEditorContent('one two three')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const sentWhileOpen = fake.requestsTo(SAVE).length

    fake.pending(SAVE)[0].resolve(json({ etag: 'e1' }))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    for (const p of fake.pending(SAVE)) p.resolve(json({ etag: 'e2' }))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)

    return { sentWhileOpen, puts: fake.requestsTo(SAVE) }
  }

  it('edits behind a slow save wait for it, then the newest text is saved over its etag', async () => {
    const { sentWhileOpen, puts } = await burstBehindASlowSave()

    expect(sentWhileOpen).toBe(1)
    expect(descOf(puts[0].body)).toBe('one')
    expect(puts[0].headers['If-Match']).toBe('seed-etag')
    const after = puts.slice(1)
    expect(after.length).toBeGreaterThan(0)
    for (const put of after) {
      expect(descOf(put.body)).toBe('one two three')
      expect(put.headers['If-Match']).toBe('e1')
    }
    expect(fake.pending(SAVE)).toEqual([])
    expect(useStore.getState().flistWorking['99'].unsavedDirty).toBe(false)
  })

  // The flushes queued behind the in-flight save must not each send a
  // PUT over the same etag: the real sidecar answers the second with a
  // 409, and the window would raise a conflict banner for a conflict it
  // had with itself (#2).
  it('no two saves leave over the same etag', async () => {
    const { puts } = await burstBehindASlowSave()

    const etags = puts.map((r) => r.headers['If-Match'])
    expect(etags).toEqual([...new Set(etags)])
    expect(puts.map((r) => descOf(r.body))).toEqual(['one', 'one two three'])
    expect(useStore.getState().flistExternalChange['99']).toBeUndefined()
  })

  it('a burst behind a slow save raises no conflict banner against a sidecar that checks If-Match', async () => {
    // Like the real sidecar: a save is accepted only over the Workbench's
    // current etag, and each accepted save hands out a new one.
    let current = 'seed-etag'
    let version = 0
    const answerLikeTheSidecar = () => {
      for (const p of fake.pending(SAVE)) {
        if (p.request.headers['If-Match'] !== current) {
          p.resolve(refusal('etag_mismatch', current))
          continue
        }
        current = `v${++version}`
        p.resolve(json({ etag: current }))
      }
    }
    seedSlot('99', { character: { description: '' } })
    fake.hold(SAVE)

    useStore.getState().setEditorContent('one')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    useStore.getState().setEditorContent('one two')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    useStore.getState().setEditorContent('one two three')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    for (let round = 0; round < 4; round++) {
      answerLikeTheSidecar()
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    }

    expect(fake.requestsTo(SAVE).map((r) => descOf(r.body))).toEqual(['one', 'one two three'])
    expect(useStore.getState().flistExternalChange['99']).toBeUndefined()
    const slot = useStore.getState().flistWorking['99']
    expect(slot.unsavedDirty).toBe(false)
    expect(slot.saveError).toBeNull()
    expect(slot.etag).toBe(current)
  })

  it('quitting while a save is in flight keeps the last edit: the close-time flush resolves only after it reaches the Workbench', async () => {
    seedSlot('99', { character: { description: '' } })
    fake.hold(SAVE)

    useStore.getState().setEditorContent('draft')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const [inFlight] = fake.pending(SAVE)
    expect(descOf(inFlight.request.body)).toBe('draft')

    // The user types, then quits before the autosave pause has passed.
    useStore.getState().setEditorContent('draft, final')
    let flushed = false
    const closing = useStore
      .getState()
      .flistFlushAllWorking()
      .then(() => {
        flushed = true
      })
    await vi.advanceTimersByTimeAsync(0)
    expect(flushed).toBe(false)
    expect(fake.requestsTo(SAVE)).toHaveLength(1)

    inFlight.resolve(json({ etag: 'after-draft' }))
    await vi.advanceTimersByTimeAsync(0)
    const [lastEdit] = fake.pending(SAVE)
    expect(descOf(lastEdit.request.body)).toBe('draft, final')
    expect(lastEdit.request.headers['If-Match']).toBe('after-draft')
    expect(flushed).toBe(false)

    lastEdit.resolve(json({ etag: 'after-final' }))
    await closing
    expect(flushed).toBe(true)
    expect(fake.requestsTo(SAVE)).toHaveLength(2)
    const slot = useStore.getState().flistWorking['99']
    expect(slot.unsavedDirty).toBe(false)
    expect(slot.etag).toBe('after-final')
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
    expect(change?.etag).toBe('server-etag')
  })
})

describe('external-change resolution', () => {
  // With nothing unsaved the store takes a change in by itself
  // (modelChange.test.ts); these are the cases with unsaved edits, where
  // the banner asks.
  function seedUnsaved(characterId: string, payload: Record<string, unknown>) {
    seedSlot(characterId, payload)
    useStore.setState((s) => ({
      flistWorking: {
        ...s.flistWorking,
        [characterId]: { ...s.flistWorking[characterId], unsavedDirty: true }
      }
    }))
  }

  it('ignores a change carrying the etag we already hold', () => {
    // Our own write comes back over the event stream too.
    seedSlot('99', { character: { description: 'mine' } })
    useStore.getState().flistNoteExternalChange('99', {
      etag: 'seed-etag',
      origin: 'mcp:set_description'
    })
    expect(useStore.getState().flistExternalChange['99']).toBeUndefined()
  })

  it('raises a banner for a change made by something else', () => {
    seedUnsaved('99', { character: { description: 'mine' } })
    useStore.getState().flistNoteExternalChange('99', {
      etag: 'theirs',
      origin: 'mcp:set_description'
    })
    const change = useStore.getState().flistExternalChange['99']
    expect(change?.origin).toBe('mcp:set_description')
  })

  it('reload takes their version and clears the banner', async () => {
    seedUnsaved('99', { character: { description: 'mine' } })
    useStore.getState().flistNoteExternalChange('99', {
      etag: 'theirs',
      origin: 'mcp:set_description'
    })
    fake.on(
      `GET ${BENCH_URL}`,
      json(payloadRead(workbenchPayload({ character: { description: 'theirs' } }), 'theirs'))
    )
    await useStore.getState().flistReloadAfterExternalChange('99')
    const slot = useStore.getState().flistWorking['99']
    const char = slot.payload.character as { description?: string } | undefined
    expect(char?.description).toBe('theirs')
    expect(slot.unsavedDirty).toBe(false)
    expect(slot.etag).toBe('theirs')
    expect(useStore.getState().flistExternalChange['99']).toBeNull()
  })

  it('after discarding mine the editor shows the reloaded description', async () => {
    // The slot taking their version is half of it; the open editor has
    // to show it too, or the next keystroke saves the old text over it.
    seedUnsaved('99', { character: { description: 'Lady Amber Blaise, as I left her' } })
    useStore.setState({ editorContent: 'Lady Amber Blaise, as I left her' })
    useStore.getState().flistNoteExternalChange('99', {
      etag: 'theirs',
      origin: 'mcp:set_description'
    })
    fake.on(
      `GET ${BENCH_URL}`,
      json(
        payloadRead(
          workbenchPayload({
            _overlay: ['character.description'],
            character: { description: 'Lady Amber Blaise, as the model wrote her' }
          }),
          'theirs'
        )
      )
    )

    await useStore.getState().flistReloadAfterExternalChange('99')

    expect(useStore.getState().editorContent).toBe(
      'Lady Amber Blaise, as the model wrote her'
    )
    expect(useStore.getState().editorDirty).toBe(false)
    expect(useStore.getState().flistWorking['99'].unsavedDirty).toBe(false)
  })

  it('keep-mine writes against their etag, which is what makes it win', async () => {
    seedUnsaved('99', { character: { description: 'mine' } })
    useStore.getState().flistNoteExternalChange('99', {
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
    seedUnsaved('99', { character: { description: 'mine' } })
    useStore.getState().flistNoteExternalChange('99', {
      etag: 'theirs',
      origin: 'mcp:set_description'
    })
    fake.on(SAVE, conflict)
    await useStore.getState().flistOverwriteAfterExternalChange('99')
    expect(useStore.getState().flistExternalChange['99']).toBeTruthy()
  })
})

const noWorkbench = json({ code: 'no_workbench', message: 'this character has no Workbench yet' }, 404)

describe('flistOpenWorking archive race (QA P1-3)', () => {
  it('fetches Live + caches it before seeding the working copy when there is no Workbench', async () => {
    useStore.setState({ flistArchive: {}, flistRoster: [] })
    fake.on(
      'GET /flist/character/99/live',
      json({ character: { description: 'live-desc', id: '99' }, id: '99' })
    )
    fake.on('GET /flist/character/99/workbench', json({ workbench: null, reason: 'not_created_yet' }))
    fake.on(`GET ${BENCH_URL}?create=false`, noWorkbench)
    await useStore.getState().flistOpenWorking('99')
    expect(fake.requestsTo('GET /flist/character/99/live')).toHaveLength(1)
    const slot = useStore.getState().flistWorking['99']
    expect(slot).toBeDefined()
    const char = slot.payload.character as { description?: string } | undefined
    expect(char?.description).toBe('live-desc')
    expect(slot.materialised).toBe(false)
  })
})

describe('flistOpenWorking reads the one Workbench endpoint', () => {
  it('reads the Workbench payload with its etag, and the row points at the Workbench', async () => {
    useStore.setState({
      flistArchive: {
        '99': archiveEntry(livePayload({ character: { description: 'live-desc' } }))
      },
      flistRoster: []
    })
    fake.on(
      'GET /flist/character/99/workbench?create=false',
      json(workbenchRead())
    )
    fake.on(
      `GET ${BENCH_URL}?create=false`,
      json(payloadRead(workbenchPayload({ character: { description: 'bench-desc' } }), 'disk-etag'))
    )
    await useStore.getState().flistOpenWorking('99')
    expect(fake.requestsTo(`GET ${BENCH_URL}?create=false`)).toHaveLength(1)
    expect(fake.requestsTo('GET /flist/character/99/working')).toHaveLength(0)
    expect(useStore.getState().flistViewingLive['99']).toBe(false)
    const slot = useStore.getState().flistWorking['99']
    expect(slot.etag).toBe('disk-etag')
    expect(slot.materialised).toBe(true)
    expect((slot.payload.character as { description?: string }).description).toBe('bench-desc')
  })

  it('a character with no Workbench yet is seeded from Live in memory, and nothing is written', async () => {
    useStore.setState({
      flistArchive: {
        '99': archiveEntry(livePayload({ character: { description: 'live-desc' } }))
      },
      flistRoster: []
    })
    fake.on(
      'GET /flist/character/99/workbench?create=false',
      json({ workbench: null, reason: 'not_created_yet' })
    )
    fake.on(`GET ${BENCH_URL}?create=false`, noWorkbench)
    await useStore.getState().flistOpenWorking('99')
    const slot = useStore.getState().flistWorking['99']
    expect((slot.payload.character as { description?: string }).description).toBe('live-desc')
    expect(slot.materialised).toBe(false)
    expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([])
  })
})

describe('the first edit of a character with no Workbench', () => {
  function seedUnmaterialised() {
    seedLive({ character: { description: 'published' } })
    useStore.setState({
      flistWorking: {
        '99': workingSlot(workbenchPayload({ character: { description: 'published' } }), {
          etag: null,
          materialised: false
        })
      },
      flistActiveCharacterId: '99',
      editorReadOnly: false
    })
  }

  it('makes the Workbench from Live, then saves over the etag that read handed out', async () => {
    // With no Workbench yet the flush used to return early and write
    // nothing, while saveStatus stayed 'idle' — so the UI showed no
    // sign that the text was only in memory.
    seedUnmaterialised()
    fake.on(
      `GET ${BENCH_URL}`,
      json({
        ...payloadRead(workbenchPayload({ character: { description: 'published' } }), 'fresh'),
        created: true
      })
    )
    fake.on('GET /flist/character/99/workbench?create=false', json(workbenchRead()))
    fake.on(SAVE, json({ etag: 'saved' }))

    useStore.getState().setEditorContent('typed')
    await vi.advanceTimersByTimeAsync(2000)

    const puts = fake.requestsTo(SAVE)
    expect(puts).toHaveLength(1)
    expect(puts[0].headers['If-Match']).toBe('fresh')
    expect(descOf(puts[0].body)).toBe('typed')
    const slot = useStore.getState().flistWorking['99']
    expect(slot.etag).toBe('saved')
    expect(slot.unsavedDirty).toBe(false)
    expect(useStore.getState().flistWorkbenchInfo['99']?.updatedAt).toBeGreaterThan(0)
  })

  it('a Workbench something else made meanwhile is not overwritten: the edit waits for the user', async () => {
    seedUnmaterialised()
    fake.on(
      `GET ${BENCH_URL}`,
      json({
        ...payloadRead(
          workbenchPayload({
            _overlay: ['character.description'],
            character: { description: 'by the model' }
          }),
          'theirs'
        ),
        created: false
      })
    )
    fake.on(SAVE, json({ etag: 'unexpected' }))

    useStore.getState().setEditorContent('typed')
    await vi.advanceTimersByTimeAsync(2000)

    expect(fake.requestsTo(SAVE)).toHaveLength(0)
    const slot = useStore.getState().flistWorking['99']
    expect(slot.unsavedDirty).toBe(true)
    expect(descOf(slot.payload)).toBe('typed')
    expect(useStore.getState().flistExternalChange['99']?.etag).toBe('theirs')
  })

  it('a character never pulled keeps the edit in memory and says so', async () => {
    seedUnmaterialised()
    fake.on(`GET ${BENCH_URL}`, noWorkbench)

    useStore.getState().setEditorContent('typed')
    await vi.advanceTimersByTimeAsync(2000)

    const slot = useStore.getState().flistWorking['99']
    expect(slot.saveStatus).toBe('error')
    expect(slot.unsavedDirty).toBe(true)
    expect(slot.saveError).toMatch(/pull this character first/)
    expect(fake.requestsTo(SAVE)).toHaveLength(0)
  })
})

describe('the window addresses the Workbench, never a set', () => {
  it('open, autosave and the close-time flush send no set id', async () => {
    seedLive({ character: { description: 'published' } })
    useStore.setState({ flistActiveCharacterId: '99', flistRoster: [] })
    fake.on('GET /flist/character/99/workbench?create=false', json(workbenchRead()))
    fake.on(
      `GET ${BENCH_URL}?create=false`,
      json(payloadRead(workbenchPayload({ character: { description: 'on disk' } }), 'e1'))
    )
    fake.on(SAVE, (req) => json({ etag: `after-${String(req.headers['If-Match'])}` }))

    await useStore.getState().flistOpenWorking('99')
    useStore.getState().setEditorContent('autosaved')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100)
    useStore.getState().setEditorContent('flushed on close')
    await useStore.getState().flistFlushAllWorking()

    expect(fake.requestsTo(SAVE).map((r) => descOf(r.body))).toEqual([
      'autosaved',
      'flushed on close'
    ])
    expect(fake.requestsTo(SAVE).map((r) => r.headers['If-Match'])).toEqual(['e1', 'after-e1'])
    expect(fake.requests.map((r) => r.path).filter((p) => p.includes('/sets/'))).toEqual([])
  })
})

describe('reset to Live asks the sidecar, which keeps the Workbench as a Backup first', () => {
  it('saves what was typed, then has the sidecar reset, and adopts the payload and etag it answers', async () => {
    seedLive({ character: { description: 'live' } })
    seedSlot('99', {
      character: { description: 'edited' },
      _overlay: ['character.description']
    })
    fake.on(SAVE, json({ etag: 'typed-saved' }))
    fake.on(RESET, resetAnswer('live', 'after-reset'))

    // Typed, and reset before the autosave fired: the Backup the
    // sidecar keeps must hold this text, so it is saved first.
    useStore.getState().setEditorContent('edited, not saved yet')
    await useStore.getState().flistResetWorkingToLive('99')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2)

    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([SAVE, RESET])
    expect(descOf(fake.requests[0].body)).toBe('edited, not saved yet')

    const slot = useStore.getState().flistWorking['99']
    expect(descOf(slot.payload)).toBe('live')
    expect(slot.etag).toBe('after-reset')
    expect(slot.unsavedDirty).toBe(false)
    expect(slot.materialised).toBe(true)
    expect(slot.overlay).toEqual([])
    expect(useStore.getState().editorContent).toBe('live')
    const undo = useStore.getState().flistResetUndo
    expect(undo?.etag).toBe('after-reset')
    expect(undo?.awaitingWrite).toBe(false)
    expect(descOf(undo?.snapshot.payload)).toBe('edited, not saved yet')
  })

  it('drains a save still in flight before asking for the reset', async () => {
    seedLive({ character: { description: 'live' } })
    seedSlot('99', { character: { description: 'edited' } })
    fake.hold(SAVE)
    fake.on(RESET, resetAnswer('live', 'after-reset'))

    useStore.getState().setEditorContent('edited, still saving')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const [inFlight] = fake.pending(SAVE)

    const reset = useStore.getState().flistResetWorkingToLive('99')
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.requestsTo(RESET)).toHaveLength(0)

    inFlight.resolve(json({ etag: 'landed' }))
    await reset
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2)
    expect(fake.requestsTo(RESET)).toHaveLength(1)
    expect(fake.requestsTo(SAVE)).toHaveLength(1)
    expect(useStore.getState().flistWorking['99'].etag).toBe('after-reset')
    expect(useStore.getState().editorContent).toBe('live')
  })

  it('typed text that cannot be saved stops the reset: no Backup would hold it', async () => {
    seedLive({ character: { description: 'live' } })
    seedSlot('99', { character: { description: 'edited' } })
    fake.on(SAVE, conflict)
    fake.on(RESET, resetAnswer('live', 'after-reset'))

    useStore.getState().setEditorContent('typed, and the save is refused')
    await useStore.getState().flistResetWorkingToLive('99')

    expect(fake.requestsTo(RESET)).toHaveLength(0)
    const slot = useStore.getState().flistWorking['99']
    expect(descOf(slot.payload)).toBe('typed, and the save is refused')
    expect(slot.unsavedDirty).toBe(true)
    expect(useStore.getState().flistResetUndo).toBeNull()
  })

  it('shows the new Backup in the list when the sidecar kept one', async () => {
    seedLive({ character: { description: 'live' } })
    seedSlot('99', { character: { description: 'edited' } })
    const kept = { filename: '2026-11-02T120000Z.zip', created_at: 1793620800 }
    fake.on(RESET, resetAnswer('live', 'after-reset', kept))
    fake.on(
      'GET /flist/character/99/zip-backups',
      json({
        backups: [
          {
            ...kept,
            size: 10,
            kind: 'manual_single',
            source: 'workbench',
            occasion: 'before-restore',
            name: null
          }
        ]
      })
    )

    await useStore.getState().flistResetWorkingToLive('99')
    await vi.advanceTimersByTimeAsync(0)

    const listed = useStore.getState().flistArchive['99'].zipBackups ?? []
    expect(listed.map((b) => b.filename)).toEqual([kept.filename])
  })

  it('when the sidecar cannot keep the Workbench, nothing is reset and the window says why', async () => {
    seedLive({ character: { description: 'live' } })
    seedSlot('99', {
      character: { description: 'edited' },
      _overlay: ['character.description']
    })
    useStore.setState({ editorContent: 'edited' })
    fake.on(
      RESET,
      json(
        {
          code: 'workbench_not_kept',
          message:
            'The Workbench could not be saved as a Backup first, so it was not replaced: disk full'
        },
        500
      )
    )

    await useStore.getState().flistResetWorkingToLive('99')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2)

    const slot = useStore.getState().flistWorking['99']
    expect(descOf(slot.payload)).toBe('edited')
    expect(slot.etag).toBe('seed-etag')
    expect(slot.saveError).toContain('not replaced')
    expect(useStore.getState().editorContent).toBe('edited')
    expect(useStore.getState().flistResetUndo).toBeNull()
    expect(fake.requestsTo(SAVE)).toHaveLength(0)
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

    await useStore.getState().flistResetWorkingToLive('99')
    await vi.advanceTimersByTimeAsync(1000)

    expect(fake.requests).toEqual([])
    expect(useStore.getState().flistWorking['99'].materialised).toBe(false)
  })
})

describe('Restore from the window', () => {
  const LOAD = 'POST /flist/character/99/workbench/load-backup'
  const FILENAME = '2026-10-30T120000Z.zip'

  it('saves what was typed first, so the Backup the sidecar keeps holds it, and offers no choice about that Backup', async () => {
    seedLive({ character: { description: 'live' } })
    seedSlot('99', { character: { description: 'edited' } })
    fake.on(SAVE, json({ etag: 'typed-saved' }))
    fake.on(
      LOAD,
      json({
        workbench: { name: 'Workbench', created_at: 100, updated_at: 300 },
        payload: workbenchPayload({ character: { description: 'restored' } }),
        etag: 'after-restore',
        loaded: FILENAME,
        backed_up_first: null
      })
    )
    fake.on(
      `GET ${BENCH_URL}`,
      json(payloadRead(workbenchPayload({ character: { description: 'restored' } }), 'after-restore'))
    )

    useStore.getState().setEditorContent('typed just before the Restore')
    const ok = await useStore.getState().flistLoadBackupIntoWorkbench('99', FILENAME)

    expect(ok).toBe(true)
    const [save, load] = fake.requests
    expect(`${save.method} ${save.path}`).toBe(SAVE)
    expect(descOf(save.body)).toBe('typed just before the Restore')
    expect(`${load.method} ${load.path}`).toBe(LOAD)
    expect(load.body).toEqual({ filename: FILENAME })
    expect(fake.requestsTo(SAVE)).toHaveLength(1)
  })

  it('typed text that cannot be saved stops the Restore', async () => {
    seedLive({ character: { description: 'live' } })
    seedSlot('99', { character: { description: 'edited' } })
    fake.on(SAVE, conflict)

    useStore.getState().setEditorContent('typed, and the save is refused')
    const ok = await useStore.getState().flistLoadBackupIntoWorkbench('99', FILENAME)

    expect(ok).toBe(false)
    expect(fake.requestsTo(LOAD)).toHaveLength(0)
    expect(descOf(useStore.getState().flistWorking['99'].payload)).toBe(
      'typed, and the save is refused'
    )
  })
})

describe('flistResetWorkingToLive + undo round-trip', () => {
  it('undo writes the snapshot back into the bench over the reset etag', async () => {
    seedLive({ character: { description: 'live' } })
    seedSlot('99', {
      character: { description: 'edited' },
      _overlay: ['character.description']
    })
    fake.on(RESET, resetAnswer('live', 'after-reset'))
    fake.once(SAVE, json({ etag: 'after-undo' }))

    await useStore.getState().flistResetWorkingToLive('99')
    expect(useStore.getState().flistResetUndo).not.toBeNull()
    await useStore.getState().flistUndoResetWorking()

    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([RESET, SAVE])
    const undoPut = fake.requests[1]
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

describe('undo of reset to Live never reverts a change made after the reset', () => {
  // The Workbench on disk, answering like the sidecar: a save lands
  // only over the etag the disk holds, and each landed save hands out
  // a new etag. Anything else writing the bench goes through write().
  function benchOnDisk(description: string) {
    const disk = { etag: 'seed-etag', payload: workbenchPayload({ character: { description } }) }
    let version = 0
    fake.on(SAVE, (req) => {
      if (req.headers['If-Match'] !== disk.etag) {
        return refusal('etag_mismatch', disk.etag)
      }
      disk.etag = `disk-${++version}`
      disk.payload = req.body as typeof disk.payload
      return json({ etag: disk.etag })
    })
    fake.on(`GET ${BENCH_URL}`, () => json(payloadRead(disk.payload, disk.etag)))
    // Reset to Live, done by the sidecar: Live replaces what is on disk.
    fake.on(RESET, () => {
      disk.etag = `disk-${++version}`
      disk.payload = workbenchPayload({ character: { description: 'Amber on F-list' } })
      return json({ payload: disk.payload, etag: disk.etag, backed_up_first: null })
    })
    return {
      disk,
      write(text: string) {
        disk.etag = `disk-${++version}`
        disk.payload = workbenchPayload({ character: { description: text } })
        return disk.etag
      }
    }
  }

  beforeEach(() => {
    seedLive({ character: { description: 'Amber on F-list' } })
    seedSlot('99', {
      character: { description: 'Amber keeps bees.' },
      _overlay: ['character.description']
    })
  })

  it('a model edit the window reloaded is not overwritten: the user is asked, and keeping it leaves it on disk', async () => {
    const bench = benchOnDisk('Amber keeps bees.')
    await useStore.getState().flistResetWorkingToLive('99')
    expect(descOf(bench.disk.payload)).toBe('Amber on F-list')

    // A connected model rewrites the description; the event stream
    // tells the window, which reloads it (no unsaved edits here).
    const modelEtag = bench.write('Amber keeps wasps now.')
    useStore.getState().flistNoteExternalChange('99', {
      etag: modelEtag,
      origin: 'mcp:set_description'
    })
    await useStore.getState().flistReloadAfterExternalChange('99')
    const putsBeforeUndo = fake.requestsTo(SAVE).length

    await useStore.getState().flistUndoResetWorking()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2)

    expect(fake.requestsTo(SAVE)).toHaveLength(putsBeforeUndo)
    const undo = useStore.getState().flistResetUndo
    expect(undo?.characterId).toBe('99')
    expect(undo?.conflict).toBe(true)
    expect(descOf(useStore.getState().flistWorking['99'].payload)).toBe('Amber keeps wasps now.')

    useStore.getState().flistDismissResetUndo()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2)

    expect(useStore.getState().flistResetUndo).toBeNull()
    expect(fake.requestsTo(SAVE)).toHaveLength(putsBeforeUndo)
    expect(descOf(bench.disk.payload)).toBe('Amber keeps wasps now.')
    expect(bench.disk.etag).toBe(modelEtag)
  })

  it('text typed in the window after the reset and saved is not overwritten either', async () => {
    const bench = benchOnDisk('Amber keeps bees.')
    await useStore.getState().flistResetWorkingToLive('99')
    useStore.getState().setEditorContent('Amber on F-list, and a new line.')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100)
    expect(descOf(bench.disk.payload)).toBe('Amber on F-list, and a new line.')
    const typedEtag = bench.disk.etag
    const putsBeforeUndo = fake.requestsTo(SAVE).length

    await useStore.getState().flistUndoResetWorking()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2)

    expect(fake.requestsTo(SAVE)).toHaveLength(putsBeforeUndo)
    expect(useStore.getState().flistResetUndo?.conflict).toBe(true)
    expect(useStore.getState().editorContent).toBe('Amber on F-list, and a new line.')
    expect(bench.disk.etag).toBe(typedEtag)
  })

  it('choosing to undo anyway puts the previous Workbench back over the model edit', async () => {
    const bench = benchOnDisk('Amber keeps bees.')
    await useStore.getState().flistResetWorkingToLive('99')
    const modelEtag = bench.write('Amber keeps wasps now.')
    useStore.getState().flistNoteExternalChange('99', {
      etag: modelEtag,
      origin: 'mcp:set_description'
    })
    await useStore.getState().flistReloadAfterExternalChange('99')
    await useStore.getState().flistUndoResetWorking()
    expect(useStore.getState().flistResetUndo?.conflict).toBe(true)

    await useStore.getState().flistUndoResetWorking({ overwrite: true })

    const [undoWrite] = fake.requestsTo(SAVE).slice(-1)
    expect(undoWrite.headers['If-Match']).toBe(modelEtag)
    expect(descOf(bench.disk.payload)).toBe('Amber keeps bees.')
    expect(useStore.getState().flistResetUndo).toBeNull()
    expect(useStore.getState().editorContent).toBe('Amber keeps bees.')
  })

  it('without a change since the reset, undo puts the previous Workbench back on disk', async () => {
    const bench = benchOnDisk('Amber keeps bees.')
    await useStore.getState().flistResetWorkingToLive('99')
    expect(descOf(bench.disk.payload)).toBe('Amber on F-list')

    await useStore.getState().flistUndoResetWorking()

    expect(descOf(bench.disk.payload)).toBe('Amber keeps bees.')
    expect(useStore.getState().flistResetUndo).toBeNull()
    expect(useStore.getState().flistWorking['99'].etag).toBe(bench.disk.etag)
    expect(useStore.getState().editorContent).toBe('Amber keeps bees.')
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
        '99': archiveEntry(
          livePayload({ character: { name: 'Amber', description: 'live text' } })
        )
      },
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
})

describe('coming back to a character shows the Workbench, not Live', () => {
  it('loads the active set payload instead of reseeding from Live', async () => {
    // Reported from the field: edit a character, switch away, switch
    // back — the Workbench row is selected but the editor shows the
    // published profile. The edits were fine on disk; the window was
    // reading the wrong thing. Clicking Live and then Workbench fixed
    // it, because that path read the Workbench again.
    seedSlot('99', { character: { description: 'stale' } })
    useStore.setState({
      flistWorking: {},
      flistArchive: {
        '99': archiveEntry(
          livePayload({ character: { name: 'Amber', description: 'what the site has' } })
        )
      },
      flistActiveCharacterId: '99'
    })
    fake.on(
      `GET ${BENCH_URL}`,
      json(
        payloadRead(
          workbenchPayload({
            _overlay: ['character.description'],
            character: { description: 'what I typed earlier' }
          }),
          'e1'
        )
      )
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

describe('opening a character never applies a stale read', () => {
  // Two characters, each with its own Workbench. Clicking quickly
  // between them leaves several reads in flight; whichever lands last
  // must not decide what the editor shows, nor which text the next
  // keystroke saves into which Workbench.
  const AMBER = '99'
  const BIRCH = '100'
  const AMBER_SET = 'aaaaaaaaaaaa'
  const BIRCH_SET = 'bbbbbbbbbbbb'
  const benchUrl = (id: string, _set: string) => `/flist/character/${id}/workbench/payload`
  const AMBER_READ = `GET ${benchUrl(AMBER, AMBER_SET)}`
  const BIRCH_READ = `GET ${benchUrl(BIRCH, BIRCH_SET)}`
  const AMBER_SAVE = `PUT ${benchUrl(AMBER, AMBER_SET)}`
  const BIRCH_SAVE = `PUT ${benchUrl(BIRCH, BIRCH_SET)}`
  const AMBER_TEXT = 'Amber keeps bees.'
  const BIRCH_TEXT = 'Birch climbs cliffs.'

  const amberBench = () => workbenchPayload({ character: { description: AMBER_TEXT } })
  const birchBench = () => workbenchPayload({ character: { description: BIRCH_TEXT } })

  beforeEach(() => {
    useStore.setState({
      flistRoster: [
        { id: 99, name: 'Amber' },
        { id: 100, name: 'Birch' }
      ] as never,
      flistArchive: {
        [AMBER]: archiveEntry(livePayload({ character: { description: 'Amber on F-list' } })),
        [BIRCH]: archiveEntry(livePayload({ character: { description: 'Birch on F-list' } }))
      }
    })
    // What selectCharacter loads alongside the Workbench: Live and the
    // Backup lists. Answered at once; only the Workbench reads race.
    for (const id of [AMBER, BIRCH]) {
      fake.on(`GET /flist/character/${id}/live`, json(livePayload()))
      fake.on(`GET /flist/character/${id}/zip-backups`, json({ backups: [] }))
    }
    fake.on(AMBER_SAVE, json({ etag: 'amber-saved' }))
    fake.on(BIRCH_SAVE, json({ etag: 'birch-saved' }))
  })

  it('A, then B, then A with the reads landing out of order: the editor shows A and each Workbench holds only its own text', async () => {
    fake.hold(AMBER_READ).hold(BIRCH_READ)

    useStore.getState().selectCharacter('Amber')
    await vi.advanceTimersByTimeAsync(0)
    useStore.getState().selectCharacter('Birch')
    await vi.advanceTimersByTimeAsync(0)
    useStore.getState().selectCharacter('Amber')
    await vi.advanceTimersByTimeAsync(0)

    const [amberFirst, amberSecond] = fake.pending(AMBER_READ)
    const [birch] = fake.pending(BIRCH_READ)
    // The newest read lands first, the older ones after it.
    amberSecond.resolve(json(payloadRead(amberBench(), 'amber-2')))
    await vi.advanceTimersByTimeAsync(0)
    amberFirst.resolve(json(payloadRead(amberBench(), 'amber-1')))
    await vi.advanceTimersByTimeAsync(0)
    birch.resolve(json(payloadRead(birchBench(), 'birch-1')))
    await vi.advanceTimersByTimeAsync(0)

    const s = useStore.getState()
    expect(s.flistActiveCharacterId).toBe(AMBER)
    expect(s.editorContent).toBe(AMBER_TEXT)
    expect(descOf(s.flistWorking[AMBER].payload)).toBe(AMBER_TEXT)
    expect(descOf(s.flistWorking[BIRCH].payload)).toBe(BIRCH_TEXT)
    // The older of Amber's two reads is stale; the slot keeps the etag
    // of the newest one.
    expect(s.flistWorking[AMBER].etag).toBe('amber-2')

    // The next keystroke edits Amber's own text and saves it into
    // Amber's Workbench only.
    useStore.getState().setEditorContent(`${AMBER_TEXT} And wasps.`)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100)

    expect(fake.requestsTo(AMBER_SAVE).map((r) => descOf(r.body))).toEqual([
      `${AMBER_TEXT} And wasps.`
    ])
    expect(fake.requestsTo(BIRCH_SAVE)).toEqual([])
  })

  it('keystrokes typed while the read is held stay in the editor and are saved', async () => {
    // Amber is open; a click on her again (or a refresh) re-reads her
    // Workbench. The user keeps typing while that read is slow.
    useStore.setState({
      flistWorking: { [AMBER]: workingSlot(amberBench(), { etag: 'amber-1' }) },
      flistActiveCharacterId: AMBER,
      editorContent: AMBER_TEXT
    })
    fake.hold(AMBER_READ)

    useStore.getState().selectCharacter('Amber')
    await vi.advanceTimersByTimeAsync(0)
    useStore.getState().setEditorContent(`${AMBER_TEXT} And wasps.`)
    // The read lands inside the autosave's quiet time, carrying what
    // is on disk: the text from before the keystrokes.
    fake.pending(AMBER_READ)[0].resolve(json(payloadRead(amberBench(), 'amber-1')))
    await vi.advanceTimersByTimeAsync(0)

    expect(useStore.getState().editorContent).toBe(`${AMBER_TEXT} And wasps.`)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100)
    expect(fake.requestsTo(AMBER_SAVE).map((r) => descOf(r.body))).toEqual([
      `${AMBER_TEXT} And wasps.`
    ])
  })

  it('a read that went out before a save landed does not put the older text back', async () => {
    // The keystrokes were saved while the read was still in flight; the
    // read then brings back what was on disk before that save.
    useStore.setState({
      flistWorking: { [AMBER]: workingSlot(amberBench(), { etag: 'amber-1' }) },
      flistActiveCharacterId: AMBER,
      editorContent: AMBER_TEXT
    })
    fake.hold(AMBER_READ)

    useStore.getState().selectCharacter('Amber')
    await vi.advanceTimersByTimeAsync(0)
    useStore.getState().setEditorContent(`${AMBER_TEXT} And wasps.`)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100)
    expect(fake.requestsTo(AMBER_SAVE)).toHaveLength(1)
    fake.pending(AMBER_READ)[0].resolve(json(payloadRead(amberBench(), 'amber-1')))
    await vi.advanceTimersByTimeAsync(0)

    const slot = useStore.getState().flistWorking[AMBER]
    expect(descOf(slot.payload)).toBe(`${AMBER_TEXT} And wasps.`)
    expect(slot.etag).toBe('amber-saved')
    expect(useStore.getState().editorContent).toBe(`${AMBER_TEXT} And wasps.`)
  })

  it('a read landing after the user switched away leaves the active editor untouched', async () => {
    fake.hold(BIRCH_READ)
    fake.on(AMBER_READ, json(payloadRead(amberBench(), 'amber-1')))

    useStore.getState().selectCharacter('Birch')
    await vi.advanceTimersByTimeAsync(0)
    useStore.getState().selectCharacter('Amber')
    await vi.advanceTimersByTimeAsync(0)
    expect(useStore.getState().editorContent).toBe(AMBER_TEXT)
    useStore.getState().setEditorContent(`${AMBER_TEXT} And wasps.`)

    fake.pending(BIRCH_READ)[0].resolve(json(payloadRead(birchBench(), 'birch-1')))
    await vi.advanceTimersByTimeAsync(0)

    const s = useStore.getState()
    expect(s.editorContent).toBe(`${AMBER_TEXT} And wasps.`)
    expect(s.editorTitle).toBe('Amber — Workbench')
    expect(descOf(s.flistWorking[BIRCH].payload)).toBe(BIRCH_TEXT)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100)
    expect(fake.requestsTo(AMBER_SAVE).map((r) => descOf(r.body))).toEqual([
      `${AMBER_TEXT} And wasps.`
    ])
    expect(fake.requestsTo(BIRCH_SAVE)).toEqual([])
  })

  it('typing straight after a switch, before the read lands, edits the new character’s own text', async () => {
    // Birch was opened earlier, so her Workbench is in memory. Until her
    // read lands the editor must not keep showing Amber's text under
    // Birch's name: a keystroke there would save Amber's description
    // into Birch's Workbench.
    useStore.setState({
      flistWorking: {
        [AMBER]: workingSlot(amberBench(), { etag: 'amber-1' }),
        [BIRCH]: workingSlot(birchBench(), { etag: 'birch-1' })
      },
      flistActiveCharacterId: AMBER,
      editorContent: AMBER_TEXT
    })
    fake.hold(BIRCH_READ)

    useStore.getState().selectCharacter('Birch')
    await vi.advanceTimersByTimeAsync(0)
    expect(useStore.getState().editorContent).toBe(BIRCH_TEXT)
    useStore.getState().setEditorContent(`${BIRCH_TEXT} Twice.`)
    fake.pending(BIRCH_READ)[0].resolve(json(payloadRead(birchBench(), 'birch-1')))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100)

    expect(useStore.getState().editorContent).toBe(`${BIRCH_TEXT} Twice.`)
    expect(fake.requestsTo(BIRCH_SAVE).map((r) => descOf(r.body))).toEqual([
      `${BIRCH_TEXT} Twice.`
    ])
    expect(fake.requestsTo(AMBER_SAVE)).toEqual([])
  })

  it('a switch to a character not yet in memory shows a read-only loading state until the read lands', async () => {
    // Birch has never been opened, so there is no Workbench in memory to
    // show. The editor must neither keep showing Amber's text under
    // Birch's name nor accept keystrokes the read would then overwrite.
    useStore.setState({
      flistWorking: { [AMBER]: workingSlot(amberBench(), { etag: 'amber-1' }) },
      flistActiveCharacterId: AMBER,
      editorContent: AMBER_TEXT,
      editorTitle: 'Amber — Workbench'
    })
    fake.hold(BIRCH_READ)

    useStore.getState().selectCharacter('Birch')
    await vi.advanceTimersByTimeAsync(0)

    let s = useStore.getState()
    expect(s.editorContent).toBe('')
    expect(s.editorReadOnly).toBe(true)
    expect(s.editorTitle).toBe('Birch — Workbench (loading)')

    fake.pending(BIRCH_READ)[0].resolve(json(payloadRead(birchBench(), 'birch-1')))
    await vi.advanceTimersByTimeAsync(0)

    s = useStore.getState()
    expect(s.editorReadOnly).toBe(false)
    expect(s.editorContent).toBe(BIRCH_TEXT)
    expect(s.editorTitle).toBe('Birch — Workbench')

    useStore.getState().setEditorContent(`${BIRCH_TEXT} Twice.`)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100)
    expect(fake.requestsTo(BIRCH_SAVE).map((r) => descOf(r.body))).toEqual([
      `${BIRCH_TEXT} Twice.`
    ])
    expect(fake.requestsTo(AMBER_SAVE)).toEqual([])
  })
})
