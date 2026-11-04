// A model's change while the window holds unsaved edits: the
// store merges the two field by field against the payload last saved.
// Changes to different fields both stay, as one undo entry and one save
// over the model's etag; a field both changed is asked about. A save
// refused because the Workbench changed on disk takes the same path.
// Driven through the event dispatch and the store's actions against the
// fake sidecar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { resetUndoStacks } from '../undoStack'
import { applyWorkbenchEvent } from '../workbenchEvents'
import type { WorkbenchEvent } from '../../lib/eventStream'
import type { WorkingPayload } from '../flist'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'
import { payloadRead, workbenchPayload, workingSlot } from '../../test/payloads'

const CID = '99'
const BENCH = `/flist/character/${CID}/workbench/payload`
const READ = `GET ${BENCH}`
const SAVE = `PUT ${BENCH}`
const AUTOSAVE_MS = 500

let fake: FakeApi

const slotOf = () => useStore.getState().flistWorking[CID]
const store = () => useStore.getState()
type Body = {
  character?: { description?: string; custom_title?: string }
  infotags?: Record<string, string>
  kinks?: Record<string, string>
  custom_kinks?: Record<string, Record<string, unknown>>
  _custom_kinks_order?: string[]
  images?: { image_id: string; description: string; sort_order: number }[]
  _overlay?: string[]
}
const bodyOf = (payload: unknown) => payload as Body

/** The Workbench as last saved: the base of every merge below. */
const SAVED = workbenchPayload({
  character: { description: 'as I left her', custom_title: 'the wanderer' },
  infotags: { '3': 'Elf' },
  kinks: { '10': 'yes', '11': 'no' }
})

function seed(payload: WorkingPayload = SAVED) {
  useStore.setState({ flistWorking: { [CID]: workingSlot(payload) } })
}

/** The Workbench as the model left it: the saved one with `change`. */
function theirs(change: (p: Body) => void, etag = 'theirs', saved: WorkingPayload = SAVED) {
  const payload = JSON.parse(JSON.stringify(saved)) as Body
  change(payload)
  return json(payloadRead(payload as WorkingPayload, etag))
}

function modelEvent(etag = 'theirs', origin = 'mcp:set_description'): WorkbenchEvent {
  return { event: 'set-payload-changed', at: 1, origin, character_id: CID, etag }
}

/** Saves as the sidecar answers them: refused unless they go over the
 *  etag on disk, which `disk.etag` holds; an accepted one moves it. */
function answerSaves(disk: { etag: string }, next = 'merged') {
  fake.on(SAVE, (req) => {
    if (req.headers['If-Match'] !== disk.etag) {
      return json(
        { code: 'etag_mismatch', message: 'changed', details: { current_etag: disk.etag } },
        409
      )
    }
    disk.etag = next
    return json({ etag: next })
  })
}

async function dispatch(event: WorkbenchEvent = modelEvent()) {
  applyWorkbenchEvent(event, store())
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeApi()
  resetUndoStacks()
  useStore.setState({
    flistWorking: {},
    flistExternalChange: {},
    flistMergeQuestion: {},
    flistArchive: {},
    flistViewingLive: {},
    flistBrowseBackup: null,
    flistWorkbenchNote: null,
    flistActiveCharacterId: CID,
    editorReadOnly: false,
    editorContent: 'as I left her',
    editorDirty: false
  })
})

afterEach(() => {
  fake.restore()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the model and I changed different fields', () => {
  it('both changes stay, as one undo entry and one save over the model etag', async () => {
    seed()
    store().flistSetWorkingField(CID, 'infotags.3', 'Half-elf')
    fake.on(READ, theirs((p) => { p.character!.description = 'as the model wrote her' }))
    answerSaves({ etag: 'theirs' })

    await dispatch()

    const merged = bodyOf(slotOf().payload)
    expect(merged.character?.description).toBe('as the model wrote her')
    expect(merged.infotags?.['3']).toBe('Half-elf')
    expect(slotOf().etag).toBe('theirs')
    expect(store().editorContent).toBe('as the model wrote her')
    expect(store().flistMergeQuestion[CID]).toBeFalsy()

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const saves = fake.requestsTo(SAVE)
    expect(saves).toHaveLength(1)
    expect(saves[0].headers['If-Match']).toBe('theirs')
    expect(bodyOf(saves[0].body).character?.description).toBe('as the model wrote her')
    expect(bodyOf(saves[0].body).infotags?.['3']).toBe('Half-elf')
    expect(slotOf().unsavedDirty).toBe(false)

    // One entry: undoing it leaves my edit without the model's change.
    expect(store().flistUndo(CID)).toBe('mcp:set_description')
    expect(bodyOf(slotOf().payload).character?.description).toBe('as I left her')
    expect(bodyOf(slotOf().payload).infotags?.['3']).toBe('Half-elf')
    expect(store().flistUndo(CID)).toBe('edit')
    expect(bodyOf(slotOf().payload).infotags?.['3']).toBe('Elf')
  })
})

describe('the model and I changed the same field', () => {
  async function bothChangedTheField() {
    seed()
    store().flistSetWorkingField(CID, 'infotags.3', 'Half-elf')
    store().flistSetWorkingField(CID, 'kinks.10', 'fave')
    fake.on(
      READ,
      theirs((p) => {
        p.infotags!['3'] = 'Drow'
        p.kinks!['11'] = 'maybe'
      })
    )
    answerSaves({ etag: 'theirs' })
    await dispatch(modelEvent('theirs', 'mcp:set_profile_field'))
  }

  it('asks about exactly that field, and nothing is saved until answered', async () => {
    await bothChangedTheField()

    expect(store().flistMergeQuestion[CID]).toMatchObject({
      label: 'mcp:set_profile_field',
      fields: ['infotags.3']
    })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 4)
    // The autosave goes over the etag the window read and is refused:
    // nothing of theirs is overwritten while the question is open.
    for (const save of fake.requestsTo(SAVE)) {
      expect(save.headers['If-Match']).toBe('seed-etag')
    }
    expect(bodyOf(slotOf().payload).infotags?.['3']).toBe('Half-elf')
    // The refusal is about the version already asked about: no new read.
    expect(fake.requestsTo(READ)).toHaveLength(1)
    expect(store().flistMergeQuestion[CID]?.fields).toEqual(['infotags.3'])
  })

  it('keeping mine keeps my value there and their change elsewhere, as one entry and one save', async () => {
    await bothChangedTheField()

    store().flistAnswerMerge(CID, { 'infotags.3': 'mine' })

    expect(store().flistMergeQuestion[CID]).toBeFalsy()
    const merged = bodyOf(slotOf().payload)
    expect(merged.infotags?.['3']).toBe('Half-elf')
    expect(merged.kinks).toEqual({ '10': 'fave', '11': 'maybe' })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const [save] = fake.requestsTo(SAVE)
    expect(save.headers['If-Match']).toBe('theirs')
    expect(bodyOf(save.body).infotags?.['3']).toBe('Half-elf')
    expect(bodyOf(save.body).kinks).toEqual({ '10': 'fave', '11': 'maybe' })
    expect(slotOf().etag).toBe('merged')

    expect(store().flistUndo(CID)).toBe('mcp:set_profile_field')
    expect(bodyOf(slotOf().payload).kinks).toEqual({ '10': 'fave', '11': 'no' })
  })

  it('taking theirs puts their value there and keeps my change elsewhere', async () => {
    await bothChangedTheField()

    store().flistAnswerMerge(CID, { 'infotags.3': 'theirs' })

    const merged = bodyOf(slotOf().payload)
    expect(merged.infotags?.['3']).toBe('Drow')
    expect(merged.kinks).toEqual({ '10': 'fave', '11': 'maybe' })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const [save] = fake.requestsTo(SAVE)
    expect(save.headers['If-Match']).toBe('theirs')
    expect(bodyOf(save.body).infotags?.['3']).toBe('Drow')
    expect(bodyOf(save.body).kinks?.['10']).toBe('fave')
  })

  it('a field I changed after the question was asked, which they changed too, is asked about before anything is applied', async () => {
    await bothChangedTheField()
    // Typed behind the dialog: their kink 11 is now mine to decide too.
    store().flistSetWorkingField(CID, 'kinks.11', 'yes')

    store().flistAnswerMerge(CID, { 'infotags.3': 'mine' })

    expect(store().flistMergeQuestion[CID]?.fields).toEqual(['kinks.11'])
    expect(bodyOf(slotOf().payload).kinks?.['11']).toBe('yes')
    expect(slotOf().etag).toBe('seed-etag')

    store().flistAnswerMerge(CID, { 'kinks.11': 'theirs' })

    expect(store().flistMergeQuestion[CID]).toBeFalsy()
    const merged = bodyOf(slotOf().payload)
    expect(merged.infotags?.['3']).toBe('Half-elf')
    expect(merged.kinks).toEqual({ '10': 'fave', '11': 'maybe' })
    expect(slotOf().etag).toBe('theirs')
  })
})

describe('the description is one field', () => {
  it('both changing it is one question, and either answer is one whole text', async () => {
    seed()
    store().setEditorContent('as I left her, with a new first line')
    store().flistSetWorkingField(CID, 'character.custom_title', 'the returned')
    fake.on(READ, theirs((p) => { p.character!.description = 'as I left her, with a new last line' }))
    answerSaves({ etag: 'theirs' })
    await dispatch()

    expect(store().flistMergeQuestion[CID]?.fields).toEqual(['character.description'])

    store().flistAnswerMerge(CID, { 'character.description': 'theirs' })
    expect(bodyOf(slotOf().payload).character).toEqual({
      description: 'as I left her, with a new last line',
      custom_title: 'the returned'
    })
    expect(store().editorContent).toBe('as I left her, with a new last line')
  })

  it('keeping mine keeps my text whole', async () => {
    seed()
    store().setEditorContent('as I left her, with a new first line')
    fake.on(READ, theirs((p) => { p.character!.description = 'as I left her, with a new last line' }))
    answerSaves({ etag: 'theirs' })
    await dispatch()

    store().flistAnswerMerge(CID, { 'character.description': 'mine' })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const [save] = fake.requestsTo(SAVE).filter((r) => r.headers['If-Match'] === 'theirs')
    expect(bodyOf(save.body).character?.description).toBe('as I left her, with a new first line')
  })
})

describe('a save refused because the Workbench changed on disk', () => {
  it('reads their version and merges, as for a model event', async () => {
    seed()
    const disk = { etag: 'theirs' }
    answerSaves(disk)
    fake.on(READ, theirs((p) => { p.character!.custom_title = 'renamed elsewhere' }))
    store().flistSetWorkingField(CID, 'infotags.3', 'Half-elf')

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    // Refused, read, merged; then saved over their etag.
    expect(fake.requestsTo(READ)).toHaveLength(1)
    expect(slotOf().etag).toBe('theirs')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)

    const saves = fake.requestsTo(SAVE)
    expect(saves.map((r) => r.headers['If-Match'])).toEqual(['seed-etag', 'theirs'])
    expect(bodyOf(saves[1].body).character?.custom_title).toBe('renamed elsewhere')
    expect(bodyOf(saves[1].body).infotags?.['3']).toBe('Half-elf')
    expect(slotOf().unsavedDirty).toBe(false)
    expect(slotOf().saveError).toBeNull()
    expect(store().flistUndo(CID)).toBe('unknown')
  })

  it('asks about a field both changed, the same question', async () => {
    seed()
    answerSaves({ etag: 'theirs' })
    fake.on(READ, theirs((p) => { p.infotags!['3'] = 'Drow' }))
    store().flistSetWorkingField(CID, 'infotags.3', 'Half-elf')

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)

    expect(store().flistMergeQuestion[CID]).toMatchObject({ label: 'unknown', fields: ['infotags.3'] })
    // Taking theirs for my only edit leaves their version as it is on
    // disk: nothing left to save.
    store().flistAnswerMerge(CID, { 'infotags.3': 'theirs' })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(fake.requestsTo(SAVE)).toHaveLength(1)
    expect(slotOf()).toMatchObject({ etag: 'theirs', unsavedDirty: false, saveError: null })
    expect(bodyOf(slotOf().payload).infotags?.['3']).toBe('Drow')
    expect(store().flistUndo(CID)).toBe('unknown')
    expect(bodyOf(slotOf().payload).infotags?.['3']).toBe('Half-elf')
  })
})

describe('timing', () => {
  it('keystrokes typed while the read is out count as mine and are saved', async () => {
    seed()
    fake.hold(READ)
    answerSaves({ etag: 'theirs' })
    await dispatch()
    store().setEditorContent('as I left her, typed during the read')
    fake.pending(READ)[0].resolve(theirs((p) => { p.infotags!['3'] = 'Drow' }))
    await vi.advanceTimersByTimeAsync(0)

    expect(bodyOf(slotOf().payload).character?.description).toBe('as I left her, typed during the read')
    expect(bodyOf(slotOf().payload).infotags?.['3']).toBe('Drow')
    expect(store().editorContent).toBe('as I left her, typed during the read')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const saves = fake.requestsTo(SAVE)
    expect(saves).toHaveLength(1)
    expect(saves[0].headers['If-Match']).toBe('theirs')
    expect(bodyOf(saves[0].body).character?.description).toBe('as I left her, typed during the read')
    expect(bodyOf(saves[0].body).infotags?.['3']).toBe('Drow')
  })

  it('a merge while my save is out: the refused save does not undo the merge, the next goes over their etag', async () => {
    seed()
    fake.hold(SAVE)
    store().flistSetWorkingField(CID, 'infotags.3', 'Half-elf')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const [stale] = fake.pending(SAVE)
    expect(stale.request.headers['If-Match']).toBe('seed-etag')

    fake.on(READ, theirs((p) => { p.character!.custom_title = 'renamed by the model' }))
    await dispatch()
    expect(slotOf().etag).toBe('theirs')

    stale.resolve(json({ code: 'etag_mismatch', message: 'changed', details: { current_etag: 'theirs' } }, 409))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(fake.requestsTo(READ)).toHaveLength(1)
    const [next] = fake.pending(SAVE)
    expect(next.request.headers['If-Match']).toBe('theirs')
    expect(bodyOf(next.request.body).character?.custom_title).toBe('renamed by the model')
    expect(bodyOf(next.request.body).infotags?.['3']).toBe('Half-elf')
    next.resolve(json({ etag: 'merged' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(slotOf().unsavedDirty).toBe(false)
    expect(slotOf().saveError).toBeNull()
    expect(slotOf().etag).toBe('merged')
  })

  it('my save answered after the model wrote over it leaves the slot on the model version, and undo of the model sticks', async () => {
    seed()
    fake.hold(SAVE)
    store().flistSetWorkingField(CID, 'infotags.3', 'Half-elf')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const [mine] = fake.pending(SAVE)

    // My save reached the disk (E1); the model wrote over it (E2), and
    // its event arrives before my save's answer.
    fake.on(READ, theirs((p) => {
      p.infotags!['3'] = 'Half-elf'
      p.character!.custom_title = 'renamed by the model'
      p._overlay = ['infotags.3', 'character.custom_title']
    }))
    await dispatch()
    expect(slotOf()).toMatchObject({ etag: 'theirs', unsavedDirty: false })
    mine.resolve(json({ etag: 'mine' }))
    await vi.advanceTimersByTimeAsync(0)

    expect(slotOf().etag).toBe('theirs')
    expect(bodyOf(slotOf().saved).character?.custom_title).toBe('renamed by the model')

    expect(store().flistUndo(CID)).toBe('mcp:set_description')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const [undo] = fake.pending(SAVE)
    expect(undo.request.headers['If-Match']).toBe('theirs')
    undo.resolve(json({ etag: 'undone' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(slotOf()).toMatchObject({ etag: 'undone', unsavedDirty: false })
    expect(bodyOf(slotOf().payload).character?.custom_title).toBe('the wanderer')
    expect(bodyOf(slotOf().payload).infotags?.['3']).toBe('Half-elf')
  })
})

describe('the gallery: each image is a field, and so is the order', () => {
  const row = (image_id: string, description = '', sort_order = 0) => ({ image_id, description, sort_order })
  const GALLERY = workbenchPayload({
    character: { description: 'as I left her' },
    images: [row('a', '', 0), row('b', '', 1), row('c', '', 2)]
  })
  const ids = () => bodyOf(slotOf().payload).images?.map((r) => r.image_id)
  const captionOf = (id: string) => bodyOf(slotOf().payload).images?.find((r) => r.image_id === id)?.description

  async function modelChanges(change: (p: Body) => void) {
    fake.on(READ, theirs(change, 'theirs', GALLERY))
    answerSaves({ etag: 'theirs' })
    await dispatch(modelEvent('theirs', 'mcp:set_image_description'))
  }

  it('my reordering and their caption both stay', async () => {
    seed(GALLERY)
    store().flistSetGalleryImages(CID, [row('c', '', 0), row('a', '', 1), row('b', '', 2)])
    await modelChanges((p) => { p.images![1].description = 'a caption' })

    expect(store().flistMergeQuestion[CID]).toBeFalsy()
    expect(ids()).toEqual(['c', 'a', 'b'])
    expect(captionOf('b')).toBe('a caption')
  })

  it('an image they added at the end joins my reordered gallery at the end', async () => {
    seed(GALLERY)
    store().flistSetGalleryImages(CID, [row('c', '', 0), row('a', '', 1), row('b', '', 2)])
    await modelChanges((p) => { p.images!.push(row('d', '', 3)) })

    expect(store().flistMergeQuestion[CID]).toBeFalsy()
    expect(ids()).toEqual(['c', 'a', 'b', 'd'])
  })

  it('both reordering differently asks about the order alone', async () => {
    seed(GALLERY)
    store().flistSetGalleryImages(CID, [row('c', '', 0), row('a', '', 1), row('b', '', 2)])
    await modelChanges((p) => { p.images = [row('b', '', 0), row('a', '', 1), row('c', '', 2)] })

    expect(store().flistMergeQuestion[CID]?.fields).toEqual(['images#order'])
    store().flistAnswerMerge(CID, { 'images#order': 'theirs' })
    expect(ids()).toEqual(['b', 'a', 'c'])
  })

  it('they removed an image I captioned: asked about that image', async () => {
    seed(GALLERY)
    store().flistSetGalleryImages(CID, [row('a', '', 0), row('b', 'my caption', 1), row('c', '', 2)])
    await modelChanges((p) => { p.images = p.images!.filter((r) => r.image_id !== 'b') })

    expect(store().flistMergeQuestion[CID]?.fields).toEqual(['images.b'])
    store().flistAnswerMerge(CID, { 'images.b': 'mine' })
    expect(ids()).toEqual(['a', 'b', 'c'])
    expect(captionOf('b')).toBe('my caption')
  })

  it('they removed an image I captioned, and I take theirs: it is off the gallery', async () => {
    seed(GALLERY)
    store().flistSetGalleryImages(CID, [row('a', '', 0), row('b', 'my caption', 1), row('c', '', 2)])
    await modelChanges((p) => { p.images = p.images!.filter((r) => r.image_id !== 'b') })

    store().flistAnswerMerge(CID, { 'images.b': 'theirs' })
    expect(ids()).toEqual(['a', 'c'])
  })
})

describe('custom kinks: each is a field, and so is their order', () => {
  const KINKS = workbenchPayload({
    character: { description: 'as I left her' },
    custom_kinks: { '1': { name: 'Stargazing', description: '', choice: 'fave' } },
    _custom_kinks_order: ['1']
  })

  it('my edit to one and the one they added both stay, in order', async () => {
    seed(KINKS)
    store().flistCustomKinksEdit(CID, '1', 'choice', 'yes')
    fake.on(
      READ,
      theirs(
        (p) => {
          p.custom_kinks!['local:x'] = { name: 'Rain', description: '', choice: 'fave' }
          p._custom_kinks_order = ['1', 'local:x']
        },
        'theirs',
        KINKS
      )
    )
    answerSaves({ etag: 'theirs' })
    await dispatch(modelEvent('theirs', 'mcp:add_custom_kink'))

    expect(store().flistMergeQuestion[CID]).toBeFalsy()
    const merged = bodyOf(slotOf().payload)
    expect(merged.custom_kinks?.['1'].choice).toBe('yes')
    expect(merged.custom_kinks?.['local:x'].name).toBe('Rain')
    expect(merged._custom_kinks_order).toEqual(['1', 'local:x'])
  })
})

describe('what the merge keeps besides values', () => {
  it('the overlay holds the paths both sides authored', async () => {
    seed()
    store().flistSetWorkingField(CID, 'infotags.3', 'Half-elf')
    fake.on(
      READ,
      theirs((p) => {
        p.character!.description = 'as the model wrote her'
        p._overlay = ['character.description']
      })
    )
    answerSaves({ etag: 'theirs' })
    await dispatch()

    expect([...(bodyOf(slotOf().payload)._overlay ?? [])].sort()).toEqual([
      'character.description',
      'infotags.3'
    ])
    expect([...slotOf().overlay].sort()).toEqual(['character.description', 'infotags.3'])
  })

  it('a first save that finds a Workbench made elsewhere merges onto it, from Live as the base', async () => {
    useStore.setState({
      flistWorking: {
        [CID]: workingSlot(SAVED, { etag: null, materialised: false })
      }
    })
    store().flistSetWorkingField(CID, 'infotags.3', 'Half-elf')
    // The Workbench a model made meanwhile, from the same Live.
    fake.on(READ, theirs((p) => { p.character!.custom_title = 'the model was here' }))
    answerSaves({ etag: 'theirs' })

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)

    const [save] = fake.requestsTo(SAVE)
    expect(save.headers['If-Match']).toBe('theirs')
    expect(bodyOf(save.body).character?.custom_title).toBe('the model was here')
    expect(bodyOf(save.body).infotags?.['3']).toBe('Half-elf')
    expect(slotOf()).toMatchObject({ materialised: true, unsavedDirty: false, etag: 'merged' })
  })
})
