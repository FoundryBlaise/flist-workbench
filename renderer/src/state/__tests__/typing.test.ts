// Typing on the Workbench undo stack: keystrokes in one text
// field coalesce into one undo entry per pause or blur, the way an
// editor groups typing. Driven through the store the way the window
// does (the editor's and the caption's change handlers), against the
// fake sidecar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectEditorDescription, useStore } from '../../state'
import { TYPING_PAUSE_MS, resetUndoStacks } from '../undoStack'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'
import { payloadRead, workbenchPayload, workingSlot } from '../../test/payloads'

const CID = '99'
const SAVE = `PUT /flist/character/${CID}/workbench/payload`
const AUTOSAVE_MS = 500
/** Well inside a burst: typing this fast is one entry. */
const KEYSTROKE_MS = 120

type GalleryRow = { image_id: string; description: string; sort_order: number }

let fake: FakeApi

const store = () => useStore.getState()
const slotOf = () => store().flistWorking[CID]
const description = () =>
  (slotOf().payload.character as { description?: string }).description
const captionOf = (imageId: string) =>
  (slotOf().payload.images as { image_id: string; description: string }[]).find(
    (e) => e.image_id === imageId
  )?.description

function seed(payload: Record<string, unknown> = {}) {
  useStore.setState({
    flistWorking: { [CID]: workingSlot(workbenchPayload(payload)) },
    flistActiveCharacterId: CID,
    editorReadOnly: false
  })
}

/** Type `text` into the description one character at a time, quickly,
 *  as the editor reports it: the whole text after each keystroke. */
async function typeDescription(text: string) {
  const start = selectEditorDescription(store())
  for (let i = 1; i <= text.length; i++) {
    store().setEditorContent(start + text.slice(0, i))
    await vi.advanceTimersByTimeAsync(KEYSTROKE_MS)
  }
}

/** Type into an image's caption, as the Images tab's textarea does. */
async function typeCaption(imageId: string, text: string) {
  const images = slotOf().payload.images as GalleryRow[]
  const start = images.find((e) => e.image_id === imageId)?.description ?? ''
  for (let i = 1; i <= text.length; i++) {
    const now = slotOf().payload.images as GalleryRow[]
    store().flistSetGalleryImages(
      CID,
      now.map((e) => (e.image_id === imageId ? { ...e, description: start + text.slice(0, i) } : e)),
      { typing: `images.${imageId}.description` }
    )
    await vi.advanceTimersByTimeAsync(KEYSTROKE_MS)
  }
}

const pause = () => vi.advanceTimersByTimeAsync(TYPING_PAUSE_MS)

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeApi()
  fake.on(SAVE, json({ etag: 'e1' }))
  resetUndoStacks()
  useStore.setState({
    flistWorking: {},
    flistExternalChange: {},
    flistMergeQuestion: {},
    flistArchive: {},
    flistViewingLive: {},
    flistBrowseBackup: null,
    flistActiveCharacterId: null,
    editorActiveTab: 'description',
    editorReadOnly: false
  })
})

afterEach(() => {
  fake.restore()
  vi.useRealTimers()
})

describe('description typing', () => {
  it('a burst followed by a pause is one undo entry, and the undo is what gets saved', async () => {
    seed()
    await typeDescription('Hello')
    await pause()
    await typeDescription(' there')
    await pause()
    expect(description()).toBe('Hello there')

    fake.on(SAVE, json({ etag: 'e2' }))
    store().flistUndo(CID)
    expect(description()).toBe('Hello')
    expect(selectEditorDescription(store())).toBe('Hello')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const saves = fake.requestsTo(SAVE)
    expect((saves[saves.length - 1].body as { character: unknown }).character).toEqual({
      description: 'Hello'
    })

    store().flistUndo(CID)
    expect(description()).toBe('')
    expect(store().flistUndo(CID)).toBeNull()
  })

  it('typing without a pause stays one entry, however long the burst', async () => {
    seed()
    await typeDescription('A long sentence typed in one go')
    await pause()
    store().flistUndo(CID)
    expect(description()).toBe('')
  })

  it('blur ends the entry: typing on at once after it is a new one', async () => {
    seed()
    await typeDescription('Hello')
    store().flistEndTyping(CID)
    await typeDescription('!')
    store().flistUndo(CID)
    expect(description()).toBe('Hello')
    store().flistUndo(CID)
    expect(description()).toBe('')
  })

  it('another change in between ends the entry, and undo walks back in order', async () => {
    seed({ kinks: { '12': 'yes' } })
    await typeDescription('Hello')
    store().flistStandardKinkSet(CID, '12', 'fave')
    await typeDescription(' there')
    store().flistUndo(CID)
    expect(description()).toBe('Hello')
    expect(slotOf().payload.kinks).toEqual({ '12': 'fave' })
    store().flistUndo(CID)
    expect(slotOf().payload.kinks).toEqual({ '12': 'yes' })
    expect(description()).toBe('Hello')
    store().flistUndo(CID)
    expect(description()).toBe('')
  })

  it('an undo ends the entry: typing right after it is a new one and drops the redo', async () => {
    seed()
    await typeDescription('Hello')
    await pause()
    await typeDescription(' there')
    store().flistUndo(CID)
    expect(description()).toBe('Hello')
    await typeDescription('!')
    expect(store().flistRedo(CID)).toBeNull()
    store().flistUndo(CID)
    expect(description()).toBe('Hello')
    store().flistUndo(CID)
    expect(description()).toBe('')
  })

  it('redo puts the whole burst back', async () => {
    seed()
    await typeDescription('Hello')
    store().flistUndo(CID)
    store().flistRedo(CID)
    expect(description()).toBe('Hello')
    expect(selectEditorDescription(store())).toBe('Hello')
  })
})

describe('caption typing', () => {
  const gallery = [
    { image_id: 'a', description: '', sort_order: 0 },
    { image_id: 'b', description: 'old', sort_order: 1 }
  ]

  it('a burst in one caption is one entry, saved when undone', async () => {
    seed({ images: gallery })
    await typeCaption('a', 'A sunset')
    await pause()
    await typeCaption('a', ' at sea')
    expect(captionOf('a')).toBe('A sunset at sea')
    store().flistUndo(CID)
    expect(captionOf('a')).toBe('A sunset')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const saves = fake.requestsTo(SAVE)
    expect((saves[saves.length - 1].body as { images: unknown }).images).toEqual([
      { image_id: 'a', description: 'A sunset', sort_order: 0 },
      { image_id: 'b', description: 'old', sort_order: 1 }
    ])
    store().flistUndo(CID)
    expect(captionOf('a')).toBe('')
  })

  it('moving on to another caption, or to the description, starts a new entry', async () => {
    seed({ images: gallery })
    await typeCaption('a', 'Sea')
    await typeCaption('b', 'er')
    await typeDescription('Hi')
    store().flistUndo(CID)
    expect(description()).toBe('')
    expect(captionOf('b')).toBe('older')
    store().flistUndo(CID)
    expect(captionOf('b')).toBe('old')
    expect(captionOf('a')).toBe('Sea')
    store().flistUndo(CID)
    expect(captionOf('a')).toBe('')
  })

  it('a reorder is never part of a caption burst', async () => {
    seed({ images: gallery })
    await typeCaption('a', 'Sea')
    store().flistSetGalleryImages(CID, [...(slotOf().payload.images as typeof gallery)].reverse())
    store().flistUndo(CID)
    expect((slotOf().payload.images as typeof gallery).map((e) => e.image_id)).toEqual(['a', 'b'])
    expect(captionOf('a')).toBe('Sea')
  })
})

describe('writes from outside end the burst', () => {
  it('a reload after an external change is its own entry between two bursts', async () => {
    seed()
    await typeDescription('Hello')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    fake.on(
      `GET /flist/character/${CID}/workbench/payload`,
      json(payloadRead(workbenchPayload({ character: { description: 'Hello from the model' } }), 'theirs'))
    )
    // Nothing unsaved: the store takes the model's change in by itself.
    store().flistNoteExternalChange(CID, { etag: 'theirs', origin: 'mcp:set_description' })
    await vi.advanceTimersByTimeAsync(0)
    expect(selectEditorDescription(store())).toBe('Hello from the model')
    await typeDescription('!')

    store().flistUndo(CID)
    expect(description()).toBe('Hello from the model')
    expect(store().flistUndo(CID)).toBe('mcp:set_description')
    expect(description()).toBe('Hello')
    store().flistUndo(CID)
    expect(description()).toBe('')
  })

  it('opening the Workbench afresh ends the burst too', async () => {
    seed()
    await typeDescription('Hello')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    fake.on(
      `GET /flist/character/${CID}/workbench/payload`,
      json(payloadRead(workbenchPayload({ character: { description: 'Hello' } }), 'e1'))
    )
    await store().flistOpenWorking(CID)
    await typeDescription('!')
    store().flistUndo(CID)
    expect(description()).toBe('Hello')
  })
})
