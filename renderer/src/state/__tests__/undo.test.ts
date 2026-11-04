// Ctrl+Z / Ctrl+Y on every tab (#110): one undo stack per character of
// Workbench payloads. These tests drive the store through its actions,
// the way the window does, and watch the payload and the saves that
// reach the fake sidecar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { resetUndoStacks } from '../undoStack'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'
import { workbenchPayload, workingSlot } from '../../test/payloads'

const CID = '99'
const SAVE = `PUT /flist/character/${CID}/workbench/payload`
const AUTOSAVE_MS = 500

let fake: FakeApi

function seed(characterId: string, payload: Record<string, unknown>, etag = 'seed-etag') {
  useStore.setState((s) => ({
    flistWorking: {
      ...s.flistWorking,
      [characterId]: workingSlot(workbenchPayload(payload), { etag })
    },
    flistActiveCharacterId: characterId,
    editorReadOnly: false
  }))
}

const slotOf = (characterId = CID) => useStore.getState().flistWorking[characterId]
const kinksOf = (characterId = CID) => slotOf(characterId).payload.kinks

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeApi()
  resetUndoStacks()
  useStore.setState({
    flistWorking: {},
    flistExternalChange: {},
    flistArchive: {},
    flistViewingLive: {},
    flistCustomKinksUI: {},
    flistResetUndo: null,
    flistBrowseBackup: null,
    flistActiveCharacterId: null,
    editorActiveTab: 'description',
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

describe('Kinks tab', () => {
  it('undo puts the previous choice back and saves it over the etag the window holds', async () => {
    seed(CID, { kinks: { '12': 'yes' } })
    fake.on(SAVE, json({ etag: 'after-edit' }))
    useStore.getState().flistStandardKinkSet(CID, '12', 'fave')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(slotOf().etag).toBe('after-edit')

    fake.on(SAVE, json({ etag: 'after-undo' }))
    useStore.getState().flistUndo(CID)
    expect(kinksOf()).toEqual({ '12': 'yes' })
    expect(slotOf().unsavedDirty).toBe(true)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)

    const saves = fake.requestsTo(SAVE)
    expect(saves).toHaveLength(2)
    expect((saves[1].body as { kinks: unknown }).kinks).toEqual({ '12': 'yes' })
    expect(saves[1].headers['If-Match']).toBe('after-edit')
    expect(slotOf().unsavedDirty).toBe(false)
    expect(slotOf().etag).toBe('after-undo')
  })
})

describe('Ctrl+Z / Ctrl+Y sequences', () => {
  it('redo applies the undone change again and saves it', async () => {
    seed(CID, { kinks: { '12': 'yes' } })
    fake.on(SAVE, json({ etag: 'e1' }))
    useStore.getState().flistStandardKinkSet(CID, '12', 'fave')
    useStore.getState().flistStandardKinkSet(CID, '13', 'no')
    useStore.getState().flistUndo(CID)
    useStore.getState().flistUndo(CID)
    expect(kinksOf()).toEqual({ '12': 'yes' })
    useStore.getState().flistRedo(CID)
    expect(kinksOf()).toEqual({ '12': 'fave' })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const saves = fake.requestsTo(SAVE)
    expect(saves).toHaveLength(1)
    expect((saves[0].body as { kinks: unknown }).kinks).toEqual({ '12': 'fave' })
    expect(saves[0].headers['If-Match']).toBe('seed-etag')

    fake.on(SAVE, json({ etag: 'e2' }))
    useStore.getState().flistRedo(CID)
    expect(kinksOf()).toEqual({ '12': 'fave', '13': 'no' })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(fake.requestsTo(SAVE)[1].headers['If-Match']).toBe('e1')
  })

  it('a new change after an undo clears the redo entries', () => {
    seed(CID, { kinks: { '12': 'yes' } })
    useStore.getState().flistStandardKinkSet(CID, '12', 'fave')
    useStore.getState().flistUndo(CID)
    useStore.getState().flistStandardKinkSet(CID, '13', 'no')
    expect(useStore.getState().flistRedo(CID)).toBeNull()
    expect(kinksOf()).toEqual({ '12': 'yes', '13': 'no' })
    useStore.getState().flistUndo(CID)
    expect(kinksOf()).toEqual({ '12': 'yes' })
  })

  it('undo with nothing to undo, or redo with nothing undone, changes nothing', async () => {
    seed(CID, { kinks: { '12': 'yes' } })
    expect(useStore.getState().flistUndo(CID)).toBeNull()
    expect(useStore.getState().flistRedo(CID)).toBeNull()
    expect(slotOf().unsavedDirty).toBe(false)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(fake.requests).toEqual([])
  })

  it('undo names the change it undid', () => {
    seed(CID, { kinks: { '12': 'yes' } })
    useStore.getState().flistStandardKinkSet(CID, '12', 'fave')
    expect(useStore.getState().flistUndo(CID)).toBe('edit')
    expect(useStore.getState().flistRedo(CID)).toBe('edit')
  })
})

describe('Kinks tab, custom kinks', () => {
  const twoKinks = {
    custom_kinks: {
      '1': { name: 'A', choice: 'fave', children: [] },
      '2': { name: 'B', choice: 'yes', children: [] }
    },
    _custom_kinks_order: ['1', '2']
  }

  it('undo of a tombstone puts the custom kink and its overlay back exactly', () => {
    seed(CID, twoKinks)
    const before = JSON.stringify(slotOf().payload)
    useStore.getState().flistCustomKinksTombstone(CID, '1')
    expect(slotOf().overlay).toContain('custom_kinks.1._deleted')
    useStore.getState().flistUndo(CID)
    expect(JSON.stringify(slotOf().payload)).toBe(before)
    expect(slotOf().overlay).toEqual([])
  })

  it('a bulk tombstone is one undo entry', () => {
    seed(CID, twoKinks)
    const before = JSON.stringify(slotOf().payload)
    useStore.getState().flistCustomKinksBulkTombstone(CID, ['1', '2'])
    useStore.getState().flistUndo(CID)
    expect(JSON.stringify(slotOf().payload)).toBe(before)
    expect(useStore.getState().flistUndo(CID)).toBeNull()
  })

  it('a reorder and a choice undo one at a time, newest first', () => {
    seed(CID, twoKinks)
    useStore.getState().flistCustomKinksReorder(CID, ['2', '1'])
    useStore.getState().flistCustomKinksEdit(CID, '1', 'choice', 'no')
    useStore.getState().flistUndo(CID)
    const ck = slotOf().payload.custom_kinks as Record<string, { choice: string }>
    expect(ck['1'].choice).toBe('fave')
    expect(slotOf().payload._custom_kinks_order).toEqual(['2', '1'])
    useStore.getState().flistUndo(CID)
    expect(slotOf().payload._custom_kinks_order).toEqual(['1', '2'])
  })
})

describe('Profile fields tab', () => {
  it('undo of an infotag choice, saved with the etag the window holds', async () => {
    seed(CID, { infotags: { '3': 'old' } })
    fake.on(SAVE, json({ etag: 'e1' }))
    useStore.getState().flistSetWorkingField(CID, 'infotags.3', 'new')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    useStore.getState().flistUndo(CID)
    expect(slotOf().payload.infotags).toEqual({ '3': 'old' })
    expect(slotOf().overlay).toEqual([])
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const saves = fake.requestsTo(SAVE)
    expect(saves).toHaveLength(2)
    expect((saves[1].body as { infotags: unknown }).infotags).toEqual({ '3': 'old' })
    expect(saves[1].headers['If-Match']).toBe('e1')
  })

  it('undo of a per-row reset puts the edited value back', () => {
    seed(CID, {
      character: { description: '', custom_title: 'mine' },
      _overlay: ['character.custom_title']
    })
    useStore.setState({
      flistArchive: {
        [CID]: {
          live: { character: { description: '', custom_title: 'live' } },
          pullStatus: 'idle'
        }
      }
    })
    useStore.getState().flistResetWorkingField(CID, 'character.custom_title')
    expect((slotOf().payload.character as { custom_title: string }).custom_title).toBe('live')
    useStore.getState().flistUndo(CID)
    expect((slotOf().payload.character as { custom_title: string }).custom_title).toBe('mine')
    expect(slotOf().overlay).toEqual(['character.custom_title'])
  })
})

describe('Images tab', () => {
  const gallery = [
    { image_id: 'a', description: '', sort_order: 0 },
    { image_id: 'b', description: '', sort_order: 1 }
  ]

  it('undo of moving an image to the pool puts it back on the profile', async () => {
    seed(CID, { images: gallery })
    fake.on(SAVE, json({ etag: 'e1' }))
    useStore.getState().flistMoveImageToPool(CID, 'a')
    expect(slotOf().payload.images).toEqual([gallery[1]])
    useStore.getState().flistUndo(CID)
    expect(slotOf().payload.images).toEqual(gallery)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const saves = fake.requestsTo(SAVE)
    expect(saves).toHaveLength(1)
    expect((saves[0].body as { images: unknown }).images).toEqual(gallery)
  })

  it('undo and redo of a reorder', () => {
    seed(CID, { images: gallery })
    const swapped = [
      { image_id: 'b', description: '', sort_order: 0 },
      { image_id: 'a', description: '', sort_order: 1 }
    ]
    useStore.getState().flistSetGalleryImages(CID, swapped)
    useStore.getState().flistUndo(CID)
    expect(slotOf().payload.images).toEqual(gallery)
    useStore.getState().flistRedo(CID)
    expect(slotOf().payload.images).toEqual(swapped)
  })

  it('adding several picked images to the profile is one undo entry', () => {
    seed(CID, { images: gallery })
    useStore.getState().flistAddImagesToProfile(CID, ['c', 'd'])
    const ids = (slotOf().payload.images as { image_id: string }[]).map((e) => e.image_id)
    expect(ids).toEqual(['a', 'b', 'c', 'd'])
    useStore.getState().flistUndo(CID)
    expect(slotOf().payload.images).toEqual(gallery)
    expect(useStore.getState().flistUndo(CID)).toBeNull()
  })
})

describe('switching tabs or characters keeps each character its history', () => {
  const OTHER = '42'
  const OTHER_SAVE = `PUT /flist/character/${OTHER}/workbench/payload`

  it('edits on three tabs undo in reverse order across tab switches', async () => {
    seed(CID, {
      kinks: { '12': 'yes' },
      infotags: { '3': 'old' },
      images: [{ image_id: 'a', description: '', sort_order: 0 }]
    })
    fake.on(SAVE, json({ etag: 'e1' }))
    const store = () => useStore.getState()
    store().setEditorActiveTab('kinks')
    store().flistStandardKinkSet(CID, '12', 'fave')
    store().setEditorActiveTab('fields')
    store().flistSetWorkingField(CID, 'infotags.3', 'new')
    store().setEditorActiveTab('images')
    store().flistMoveImageToPool(CID, 'a')
    store().setEditorActiveTab('kinks')

    store().flistUndo(CID)
    expect(slotOf().payload.images).toEqual([{ image_id: 'a', description: '', sort_order: 0 }])
    store().setEditorActiveTab('description')
    store().flistUndo(CID)
    expect(slotOf().payload.infotags).toEqual({ '3': 'old' })
    expect(kinksOf()).toEqual({ '12': 'fave' })
    store().setEditorActiveTab('images')
    store().flistRedo(CID)
    expect(slotOf().payload.infotags).toEqual({ '3': 'new' })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const saves = fake.requestsTo(SAVE)
    expect(saves).toHaveLength(1)
    expect(saves[0].body).toMatchObject({
      kinks: { '12': 'fave' },
      infotags: { '3': 'new' },
      images: [{ image_id: 'a', description: '', sort_order: 0 }]
    })
  })

  it('a character switch and back: undo steps over that character’s change only', async () => {
    seed(OTHER, { kinks: { '7': 'no' } }, 'other-etag')
    seed(CID, { kinks: { '12': 'yes' } })
    fake.on(SAVE, json({ etag: 'e1' }))
    fake.on(OTHER_SAVE, json({ etag: 'other-e1' }))
    fake.fallback(json({}))
    const store = () => useStore.getState()

    store().flistStandardKinkSet(CID, '12', 'fave')
    await store().flistSelectCharacter(OTHER)
    expect(fake.requestsTo(SAVE)).toHaveLength(1)
    store().flistStandardKinkSet(OTHER, '7', 'yes')
    await store().flistSelectCharacter(CID)
    expect(fake.requestsTo(OTHER_SAVE)).toHaveLength(1)
    fake.on(
      `GET /flist/character/${CID}/workbench/payload`,
      json({ payload: workbenchPayload({ kinks: { '12': 'fave' } }), etag: 'e1' })
    )
    await store().flistOpenWorking(CID)

    fake.on(SAVE, json({ etag: 'e2' }))
    store().flistUndo(CID)
    expect(kinksOf()).toEqual({ '12': 'yes' })
    expect(kinksOf(OTHER)).toEqual({ '7': 'yes' })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const saves = fake.requestsTo(SAVE)
    expect(saves).toHaveLength(2)
    expect((saves[1].body as { kinks: unknown }).kinks).toEqual({ '12': 'yes' })
    expect(saves[1].headers['If-Match']).toBe('e1')

    store().flistUndo(OTHER)
    expect(kinksOf(OTHER)).toEqual({ '7': 'no' })
  })
})

describe('the undo save is an ordinary save', () => {
  it('a conflict on it is handled like any other save conflict', async () => {
    seed(CID, { kinks: { '12': 'yes' } })
    fake.on(SAVE, json({ etag: 'e1' }))
    useStore.getState().flistStandardKinkSet(CID, '12', 'fave')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)

    fake.on(
      SAVE,
      json(
        {
          code: 'etag_mismatch',
          message: 'The Workbench changed since it was read.',
          details: { current_etag: 'theirs' }
        },
        409
      )
    )
    useStore.getState().flistUndo(CID)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(fake.requestsTo(SAVE)[1].headers['If-Match']).toBe('e1')
    expect(slotOf().unsavedDirty).toBe(true)
    expect(kinksOf()).toEqual({ '12': 'yes' })
    expect(useStore.getState().flistExternalChange[CID]).toMatchObject({ etag: 'theirs' })
  })
})

describe('what is not on the stack', () => {
  it('nothing is undone or written while the window shows Live', async () => {
    seed(CID, { character: { description: 'mine' }, kinks: { '12': 'yes' } })
    useStore.setState({
      flistArchive: {
        [CID]: { live: { character: { description: 'live' }, kinks: {} }, pullStatus: 'idle' }
      }
    })
    useStore.getState().flistStandardKinkSet(CID, '12', 'fave')
    fake.on(SAVE, json({ etag: 'e1' }))
    await useStore.getState().flistShowLive(CID)
    const shown = slotOf().payload
    expect(useStore.getState().flistUndo(CID)).toBeNull()
    expect(useStore.getState().flistRedo(CID)).toBeNull()
    expect(slotOf().payload).toBe(shown)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(fake.requestsTo(SAVE)).toHaveLength(1)
  })

  it('nothing is undone while a Backup is being browsed', () => {
    seed(CID, { kinks: { '12': 'yes' } })
    useStore.getState().flistStandardKinkSet(CID, '12', 'fave')
    useStore.setState({
      flistBrowseBackup: { characterId: CID, filename: 'b.zip', status: 'ready' } as never
    })
    expect(useStore.getState().flistUndo(CID)).toBeNull()
    expect(kinksOf()).toEqual({ '12': 'fave' })
  })

  it('showing Live and opening the Workbench again are not undo steps', async () => {
    seed(CID, { character: { description: 'mine' }, kinks: { '12': 'yes' } })
    useStore.setState({
      flistArchive: {
        [CID]: { live: { character: { description: 'live' } }, pullStatus: 'idle' }
      }
    })
    fake.on(SAVE, json({ etag: 'e1' }))
    useStore.getState().flistStandardKinkSet(CID, '12', 'fave')
    await useStore.getState().flistShowLive(CID)
    fake.on(
      `GET /flist/character/${CID}/workbench/payload`,
      json({
        payload: workbenchPayload({ character: { description: 'mine' }, kinks: { '12': 'fave' } }),
        etag: 'e1'
      })
    )
    fake.on(`GET /flist/character/${CID}/workbench`, json({ workbench: { name: 'Workbench' } }))
    await useStore.getState().flistOpenWorking(CID)
    expect(useStore.getState().flistViewingLive[CID]).toBe(false)

    useStore.getState().flistUndo(CID)
    expect(kinksOf()).toEqual({ '12': 'yes' })
    expect((slotOf().payload.character as { description: string }).description).toBe('mine')
    expect(useStore.getState().flistUndo(CID)).toBeNull()
  })

  it('signing out forgets every character’s stack', async () => {
    seed(CID, { kinks: { '12': 'yes' } })
    useStore.getState().flistStandardKinkSet(CID, '12', 'fave')
    fake.fallback(json({}))
    await useStore.getState().flistSignOut()
    seed(CID, { kinks: { '12': 'fave' } })
    expect(useStore.getState().flistUndo(CID)).toBeNull()
  })
})
