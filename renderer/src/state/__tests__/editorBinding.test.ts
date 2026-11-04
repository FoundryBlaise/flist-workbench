// The editor binds to the description in the Workbench payload: what it
// shows is read from the active character's slot, and typing in it is an
// edit to that payload, saved like any other. Nothing else in the store
// holds the description, its inline images or the title. Seam: the one
// store, against the fake sidecar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  selectEditorDescription,
  selectEditorDirty,
  selectEditorInlines,
  selectEditorTitle,
  useStore
} from '../../state'
import { workbenchInitialState } from '../slices/workbench'
import { resetUndoStacks } from '../undoStack'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'
import {
  archiveEntry,
  livePayload,
  payloadRead,
  workbenchPayload,
  workingSlot
} from '../../test/payloads'

const CID = '99'
const BENCH = `/flist/character/${CID}/workbench/payload`
const SAVE = `PUT ${BENCH}`
const AUTOSAVE_MS = 500

let fake: FakeApi
const store = () => useStore.getState()
const shown = () => selectEditorDescription(store())
const descriptionIn = (payload: unknown) =>
  ((payload as { character?: { description?: string } }).character?.description ?? '')
const slotOf = () => store().flistWorking[CID]

function seed(description: string, extra: Record<string, unknown> = {}) {
  useStore.setState({
    flistWorking: {
      [CID]: workingSlot(workbenchPayload({ character: { description }, ...extra }))
    },
    flistActiveCharacterId: CID
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeApi()
  resetUndoStacks()
  useStore.setState({
    ...workbenchInitialState(),
    flistArchive: {},
    flistBrowseBackup: null,
    flistRoster: [{ id: CID, name: 'Wren Ashdown' }] as never
  })
})

afterEach(() => {
  fake.restore()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the store keeps the description only in the Workbench payload', () => {
  it('has no editor copy of the description, the inline images or the title', () => {
    seed('in the payload')
    const s = store() as unknown as Record<string, unknown>
    for (const copy of ['editorContent', 'editorInlines', 'editorTitle', 'editorDirty']) {
      expect(s).not.toHaveProperty(copy)
    }
    expect(shown()).toBe('in the payload')
  })
})

describe('typing in the editor', () => {
  it('changes the payload’s description, and the autosave writes it', async () => {
    seed('Hello')
    fake.on(SAVE, json({ etag: 'e1' }))

    store().setEditorContent('Hello there')

    expect(descriptionIn(slotOf().payload)).toBe('Hello there')
    expect(shown()).toBe('Hello there')
    expect(selectEditorDirty(store())).toBe(true)

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)

    const saves = fake.requestsTo(SAVE)
    expect(saves).toHaveLength(1)
    expect(descriptionIn(saves[0].body)).toBe('Hello there')
    expect(selectEditorDirty(store())).toBe(false)
  })
})

describe('the editor shows the payload’s description after', () => {
  it('a Restore', async () => {
    seed('mine')
    fake.on(
      `POST /flist/character/${CID}/workbench/load-backup`,
      json({
        workbench: { name: 'Workbench', created_at: 100, updated_at: 300 },
        ...payloadRead(workbenchPayload({ character: { description: 'restored' } }), 'e9'),
        loaded: 'b.zip',
        backed_up_first: null
      })
    )

    await store().flistLoadBackupIntoWorkbench(CID, 'b.zip')

    expect(shown()).toBe('restored')
    expect(selectEditorDirty(store())).toBe(false)
  })

  it('answering a merge question', async () => {
    seed('as I left her')
    fake.on(SAVE, json({ etag: 'merged' }))
    store().setEditorContent('as I left her, and mine')
    fake.on(
      `GET ${BENCH}`,
      json(payloadRead(workbenchPayload({ character: { description: 'as the model wrote her' } }), 'theirs'))
    )
    store().flistNoteExternalChange(CID, { etag: 'theirs', origin: 'mcp:set_description' })
    await vi.advanceTimersByTimeAsync(0)
    expect(store().flistMergeQuestion[CID]?.fields).toEqual(['character.description'])

    store().flistAnswerMerge(CID, { 'character.description': 'theirs' })

    expect(shown()).toBe('as the model wrote her')
  })

  it('an undo, and a redo', () => {
    seed('Hello')
    store().setEditorContent('Hello there')

    store().flistUndo(CID)
    expect(shown()).toBe('Hello')

    store().flistRedo(CID)
    expect(shown()).toBe('Hello there')
  })

  it('a reload of a change another writer made', async () => {
    seed('as I left her')
    fake.on(
      `GET ${BENCH}`,
      json(payloadRead(workbenchPayload({ character: { description: 'as the model wrote her' } }), 'theirs'))
    )

    store().flistNoteExternalChange(CID, { etag: 'theirs', origin: 'mcp:set_description' })
    await vi.advanceTimersByTimeAsync(0)

    expect(shown()).toBe('as the model wrote her')
    expect(selectEditorDirty(store())).toBe(false)
  })
})

describe('Live and Backup views', () => {
  const BACKUP = '2026-10-01T120000Z.zip'

  it('show Live read-only, ignore typing, and keep the Workbench they hide', async () => {
    seed('my draft')
    useStore.setState({
      flistArchive: { [CID]: archiveEntry(livePayload({ character: { description: 'published' } })) }
    })

    await store().flistShowLive(CID)
    expect(store().editorReadOnly).toBe(true)
    expect(shown()).toBe('published')

    store().setEditorContent('typed into Live')
    expect(shown()).toBe('published')
    expect(fake.requestsTo(SAVE)).toEqual([])

    fake.on(`GET ${BENCH}?create=false`, json(payloadRead(workbenchPayload({ character: { description: 'my draft' } }), 'seed-etag')))
    await store().flistOpenWorking(CID)
    expect(store().editorReadOnly).toBe(false)
    expect(shown()).toBe('my draft')
  })

  it('show a browsed Backup read-only, with its inline images', async () => {
    seed('my draft')
    useStore.setState({ flistArchive: { [CID]: archiveEntry(livePayload()) } })
    fake.on(
      `GET /flist/character/${CID}/zip-backups/${BACKUP}/payload`,
      json({
        payload: livePayload({
          character: { description: 'from the Backup [img=7]x[/img]' },
          inlines: { '7': { hash: 'abc', extension: 'png', nsfw: false } }
        }),
        filename: BACKUP,
        meta: null
      })
    )

    await store().flistOpenBrowseBackup(CID, BACKUP)

    expect(store().editorReadOnly).toBe(true)
    expect(shown()).toBe('from the Backup [img=7]x[/img]')
    expect(selectEditorInlines(store())).toEqual({
      '7': { hash: 'abc', extension: 'png', nsfw: false }
    })
  })
})

describe('the inline images and the title', () => {
  it('the inline images are the payload’s, Live filling in any it lacks', () => {
    seed('[img=1]a[/img] [img=2]b[/img]', {
      inlines: { '1': { hash: 'mine', extension: 'png', nsfw: false } }
    })
    useStore.setState({
      flistArchive: {
        [CID]: archiveEntry(
          livePayload({
            inlines: {
              '1': { hash: 'older', extension: 'png', nsfw: false },
              '2': { hash: 'new-on-flist', extension: 'gif', nsfw: true }
            }
          })
        )
      }
    })

    const inlines = selectEditorInlines(store())

    expect(inlines).toEqual({
      '1': { hash: 'mine', extension: 'png', nsfw: false },
      '2': { hash: 'new-on-flist', extension: 'gif', nsfw: true }
    })
    // Read again with nothing changed: the same answer, so the preview
    // does not render again.
    expect(selectEditorInlines(store())).toBe(inlines)
  })

  it('the title names the character’s Workbench, and stays while an edit waits', () => {
    seed('Hello')
    expect(selectEditorTitle(store())).toBe('Wren Ashdown — Workbench')

    store().setEditorContent('Hello there')

    expect(selectEditorTitle(store())).toBe('Wren Ashdown — Workbench')
    expect(selectEditorDirty(store())).toBe(true)
  })

  it('the title says the Workbench is loading until its read lands', () => {
    useStore.setState({ flistActiveCharacterId: CID })
    expect(selectEditorTitle(store())).toBe('Wren Ashdown — Workbench (loading)')
    expect(shown()).toBe('')
  })
})

describe('one cache of the Workbench per character', () => {
  it('a keystroke changes the one slot, and nothing else in the store holds the text', () => {
    seed('Hello')
    store().setEditorContent('Hello, once')

    const holders = Object.entries(store() as unknown as Record<string, unknown>)
      .filter(([, value]) => typeof value !== 'function')
      .filter(([, value]) => (JSON.stringify(value) ?? '').includes('Hello, once'))
      .map(([key]) => key)
    expect(holders).toEqual(['flistWorking'])
  })
})
