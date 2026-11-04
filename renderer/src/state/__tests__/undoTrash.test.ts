// Undo never quietly brings back an image whose file went to the Trash
// (#115). When an undo or redo puts back a gallery that names a file
// no longer in the pool, the window puts that file back from the Trash
// before the save, and says so; a file in neither place leaves the undo
// applied and the note says it is missing. Driven through the store's
// actions against the fake sidecar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { resetUndoStacks } from '../undoStack'
import { installFakeApi, json, type FakeApi, type RecordedRequest } from '../../test/fakeApi'
import { workbenchPayload, workingSlot } from '../../test/payloads'

const CID = '99'
const BASE = `/flist/character/${CID}`
const SAVE = `PUT ${BASE}/workbench/payload`
const TRASH_LIST = `GET ${BASE}/trash`
const PUT_BACK = `POST ${BASE}/trash/put-back`
const TRASH_IMAGES = `POST ${BASE}/images/trash`
const POOL = `GET ${BASE}/images`
const AUTOSAVE_MS = 500

type Row = { image_id: string; description: string; sort_order: number }
const row = (image_id: string, sort_order: number): Row => ({
  image_id,
  description: '',
  sort_order
})

let fake: FakeApi
let pool: string[]
let trash: { trash_id: string; image_id: string; source_name: string | null }[]

function seed(images: Row[], poolIds: string[], etag = 'seed-etag') {
  pool = [...poolIds]
  useStore.setState({
    flistWorking: { [CID]: workingSlot(workbenchPayload({ images }), { etag }) },
    flistCharacterImages: {
      [CID]: {
        byId: Object.fromEntries(poolIds.map((id) => [id, { extension: 'png', size: 1 }])),
        status: 'ready'
      }
    },
    flistActiveCharacterId: CID,
    editorReadOnly: false
  })
}

/** A sidecar with a pool and a Trash that behave like the real ones. */
function sidecar() {
  fake
    .on(TRASH_IMAGES, (req) => {
      const ids = (req.body as { image_ids: string[] }).image_ids
      const gallery = galleryIds()
      pool = pool.filter((id) => !ids.includes(id))
      trash.push(...ids.map((id) => ({ trash_id: id, image_id: id, source_name: null })))
      const offGallery = ids.filter((id) => gallery.includes(id))
      return json({
        trashed: ids.map((id) => ({ image_id: id, trash_id: id })),
        not_found: [],
        off_gallery: offGallery,
        etag: offGallery.length ? 'after-trash' : null
      })
    })
    .on(TRASH_LIST, () =>
      json({
        character_id: CID,
        items: trash.map((t) => ({
          ...t,
          extension: 'png',
          filename: `${t.trash_id}.png`,
          size: 1,
          deleted_at: 1,
          deleted_by: 'ui'
        }))
      })
    )
    .on(PUT_BACK, (req) => {
      const ids = (req.body as { image_ids: string[] }).image_ids
      const back = trash.filter((t) => ids.includes(t.trash_id))
      trash = trash.filter((t) => !ids.includes(t.trash_id))
      pool.push(...back.map((t) => t.image_id))
      return json({
        restored: back.map((t) => ({ image_id: t.image_id, deduplicated: false, from: t.trash_id })),
        not_found: ids.filter((id) => !back.some((t) => t.trash_id === id)),
        conflicts: []
      })
    })
    .on(POOL, () =>
      json({
        character_id: CID,
        images: pool.map((id) => ({ image_id: id, extension: 'png', size: 1 }))
      })
    )
    .on(SAVE, json({ etag: 'after-undo' }))
}

const slotOf = () => useStore.getState().flistWorking[CID]
const galleryIds = () => ((slotOf()?.payload.images ?? []) as Row[]).map((r) => r.image_id)
const noteOf = () => useStore.getState().flistUndoNotes[CID]?.text ?? null
const indexOf = (req: RecordedRequest) => fake.requests.indexOf(req)

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeApi()
  resetUndoStacks()
  trash = []
  useStore.setState({
    flistWorking: {},
    flistExternalChange: {},
    flistMergeQuestion: {},
    flistViewingLive: {},
    flistBrowseBackup: null,
    flistUndoNotes: {},
    flistActiveCharacterId: null,
    editorReadOnly: false,
    editorContent: '',
    editorDirty: false
  })
})

afterEach(() => {
  fake.restore()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('undo of a gallery image that went to the Trash', () => {
  it('puts the file back from the Trash, then saves over the current etag, and names it', async () => {
    seed([row('a', 0), row('b', 1)], ['a', 'b'])
    sidecar()
    await useStore.getState().flistTrashImages(CID, ['a'])
    trash[0].source_name = 'sunset.png'
    expect(galleryIds()).toEqual(['b'])
    expect(slotOf().etag).toBe('after-trash')

    fake.hold(PUT_BACK)
    useStore.getState().flistUndo(CID)
    expect(galleryIds()).toEqual(['a', 'b'])
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 4)
    // Nothing is saved while the file is still in the Trash.
    expect(fake.requestsTo(SAVE)).toHaveLength(0)

    const [held] = fake.pending(PUT_BACK)
    expect(held.request.body).toEqual({ image_ids: ['a'] })
    trash = []
    pool.push('a')
    held.resolve(json({ restored: [{ image_id: 'a', deduplicated: false, from: 'a' }], not_found: [], conflicts: [] }))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)

    const [putBack] = fake.requestsTo(PUT_BACK)
    const saves = fake.requestsTo(SAVE)
    expect(saves).toHaveLength(1)
    expect(indexOf(putBack)).toBeLessThan(indexOf(saves[0]))
    expect((saves[0].body as { images: Row[] }).images.map((r) => r.image_id)).toEqual(['a', 'b'])
    expect(saves[0].headers['If-Match']).toBe('after-trash')
    expect(slotOf().unsavedDirty).toBe(false)
    expect(useStore.getState().flistCharacterImages[CID].byId).toHaveProperty('a')
    expect(noteOf()).toBe('Undo put back sunset.png from the Trash.')
  })

  it('an image moved to the pool and then to the Trash comes back by redo too', async () => {
    seed([row('a', 0)], ['a', 'c'])
    sidecar()
    useStore.getState().flistAddImagesToProfile(CID, ['c'])
    useStore.getState().flistUndo(CID)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    await useStore.getState().flistTrashImages(CID, ['c'])
    expect(pool).toEqual(['a'])

    useStore.getState().flistRedo(CID)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)

    expect(galleryIds()).toEqual(['a', 'c'])
    expect(fake.requestsTo(PUT_BACK).map((r) => r.body)).toEqual([{ image_ids: ['c'] }])
    const saves = fake.requestsTo(SAVE)
    expect(indexOf(fake.requestsTo(PUT_BACK)[0])).toBeLessThan(indexOf(saves[saves.length - 1]))
    expect(noteOf()).toBe('Redo put back c.png from the Trash.')
  })

  it('a file the pool already had under another id: the gallery names that id', async () => {
    seed([row('a', 0), row('b', 1)], ['a', 'b'])
    sidecar()
    await useStore.getState().flistTrashImages(CID, ['a'])
    // A Pull fetched the same picture meanwhile, under F-list's id.
    fake.on(PUT_BACK, () => {
      trash = []
      pool.push('47000001')
      return json({
        restored: [{ image_id: '47000001', deduplicated: true, from: 'a' }],
        not_found: [],
        conflicts: []
      })
    })

    useStore.getState().flistUndo(CID)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)

    expect(galleryIds()).toEqual(['47000001', 'b'])
    const saves = fake.requestsTo(SAVE)
    expect((saves[saves.length - 1].body as { images: Row[] }).images.map((r) => r.image_id)).toEqual([
      '47000001',
      'b'
    ])
    expect(slotOf().unsavedDirty).toBe(false)
  })
})

describe('undo of a gallery image that is in neither the pool nor the Trash', () => {
  it('leaves the undo applied, saves it, and says the image is missing', async () => {
    seed([row('a', 0), row('b', 1)], ['b'])
    sidecar()
    useStore.getState().flistMoveImageToPool(CID, 'a')

    useStore.getState().flistUndo(CID)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)

    expect(galleryIds()).toEqual(['a', 'b'])
    expect(fake.requestsTo(PUT_BACK)).toHaveLength(0)
    const saves = fake.requestsTo(SAVE)
    expect(saves).toHaveLength(1)
    expect((saves[0].body as { images: Row[] }).images.map((r) => r.image_id)).toEqual(['a', 'b'])
    expect(noteOf()).toBe('Undo brought back image a, which is in neither the pool nor the Trash.')
  })
})

describe('undo that brings back no missing file', () => {
  it('asks the Trash nothing and shows no note', async () => {
    seed([row('a', 0), row('b', 1)], ['a', 'b'])
    sidecar()
    useStore.getState().flistMoveImageToPool(CID, 'a')

    useStore.getState().flistUndo(CID)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)

    expect(fake.requestsTo(TRASH_LIST)).toHaveLength(0)
    expect(fake.requestsTo(SAVE)).toHaveLength(1)
    expect(noteOf()).toBeNull()
  })

  it('with the pool not read yet, reads it before deciding', async () => {
    seed([row('a', 0), row('b', 1)], ['a', 'b'])
    useStore.setState({ flistCharacterImages: {} })
    sidecar()
    useStore.getState().flistMoveImageToPool(CID, 'a')

    useStore.getState().flistUndo(CID)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)

    expect(fake.requestsTo(POOL)).toHaveLength(1)
    expect(fake.requestsTo(TRASH_LIST)).toHaveLength(0)
    expect(indexOf(fake.requestsTo(POOL)[0])).toBeLessThan(indexOf(fake.requestsTo(SAVE)[0]))
    expect(noteOf()).toBeNull()
  })
})
