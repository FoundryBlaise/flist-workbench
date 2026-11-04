// Every change to a character's Workbench payload goes through one
// commit point. These tests drive the store through its actions,
// the way the window does, and watch what each commit leaves on the
// character's undo stack: one entry per change, with its label, and
// none for a view.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { canUndo, resetUndoStacks } from '../undoStack'
import type { CommitLabel } from '../commit'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'
import {
  archiveEntry,
  livePayload,
  payloadRead,
  workbenchPayload,
  workbenchRead,
  workingSlot
} from '../../test/payloads'

const CID = '99'
const BENCH_URL = `/flist/character/${CID}/workbench/payload`

let fake: FakeApi

function seed(payload: Record<string, unknown>) {
  useStore.setState({
    flistWorking: { [CID]: workingSlot(workbenchPayload(payload)) },
    flistActiveCharacterId: CID,
    editorReadOnly: false,
    editorContent: '',
    editorDirty: false
  })
}

/** The labels on the character's undo stack, newest first. Undoes them
 *  all, so it comes last in a test. */
function undoLabels(): CommitLabel[] {
  const labels: CommitLabel[] = []
  for (
    let label = useStore.getState().flistUndo(CID);
    label;
    label = useStore.getState().flistUndo(CID)
  ) {
    labels.push(label)
  }
  return labels
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
    flistCustomKinksUI: {},
    flistBrowseBackup: null,
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

describe('one edit per tab is one commit labelled edit', () => {
  it('a profile field', () => {
    seed({ character: { description: '', custom_title: 'old' } })
    useStore.getState().flistSetWorkingField(CID, 'character.custom_title', 'new')
    const slot = useStore.getState().flistWorking[CID]
    expect((slot.payload.character as { custom_title: string }).custom_title).toBe('new')
    expect(slot.unsavedDirty).toBe(true)
    expect(undoLabels()).toEqual(['edit'])
  })

  it('a kink, even while the kinks are still the empty list F-list sends', () => {
    seed({ character: { description: '' }, kinks: [] })
    useStore.getState().flistStandardKinkSet(CID, '12', 'fave')
    expect(useStore.getState().flistWorking[CID].payload.kinks).toEqual({ '12': 'fave' })
    expect(undoLabels()).toEqual(['edit'])
  })

  it('an image', () => {
    seed({ character: { description: '' }, images: [] })
    useStore.getState().flistMoveImageToProfile(CID, 'img-1')
    expect(useStore.getState().flistWorking[CID].payload.images).toEqual([
      { image_id: 'img-1', description: '', sort_order: 0 }
    ])
    expect(undoLabels()).toEqual(['edit'])
  })

  it('the description', () => {
    seed({ character: { description: 'before' } })
    useStore.setState({ editorContent: 'before' })
    useStore.getState().setEditorContent('after')
    const slot = useStore.getState().flistWorking[CID]
    expect((slot.payload.character as { description: string }).description).toBe('after')
    expect(useStore.getState().editorContent).toBe('after')
    expect(useStore.getState().editorDirty).toBe(true)
    expect(undoLabels()).toEqual(['edit'])
  })
})

describe('what the sidecar wrote is one commit with its label, clean and over its etag', () => {
  it('a reset to Live', async () => {
    seed({ character: { description: 'mine' } })
    useStore.setState({ editorContent: 'mine' })
    fake.on(
      `POST /flist/character/${CID}/workbench/reset-to-live`,
      json({
        payload: workbenchPayload({ character: { description: 'live' } }),
        etag: 'after-reset',
        backed_up_first: null
      })
    )
    await useStore.getState().flistResetWorkingToLive(CID)
    const slot = useStore.getState().flistWorking[CID]
    expect(slot.etag).toBe('after-reset')
    expect(slot.unsavedDirty).toBe(false)
    expect(useStore.getState().editorContent).toBe('live')
    expect(undoLabels()).toEqual(['reset-to-live'])
  })

  it('a Restore', async () => {
    seed({ character: { description: 'mine' } })
    fake.on(
      `POST /flist/character/${CID}/workbench/load-backup`,
      json({
        workbench: { name: 'Workbench', created_at: 100, updated_at: 300 },
        payload: workbenchPayload({ character: { description: 'restored' } }),
        etag: 'after-restore',
        loaded: 'b.zip',
        backed_up_first: null
      })
    )
    await useStore.getState().flistLoadBackupIntoWorkbench(CID, 'b.zip')
    const slot = useStore.getState().flistWorking[CID]
    expect(slot.etag).toBe('after-restore')
    expect(slot.unsavedDirty).toBe(false)
    expect(useStore.getState().editorContent).toBe('restored')
    expect(undoLabels()).toEqual(['restore'])
  })

  it("a reload after a model's change, named after the tool", async () => {
    seed({ character: { description: 'mine' } })
    fake.on(
      `GET ${BENCH_URL}`,
      json(payloadRead(workbenchPayload({ character: { description: 'theirs' } }), 'theirs'))
    )
    // Nothing unsaved: the store takes the model's change in by itself.
    useStore.getState().flistNoteExternalChange(CID, {
      etag: 'theirs',
      origin: 'mcp:set_description'
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(useStore.getState().flistWorking[CID].etag).toBe('theirs')
    expect(useStore.getState().flistWorking[CID].unsavedDirty).toBe(false)
    expect(useStore.getState().editorContent).toBe('theirs')
    expect(undoLabels()).toEqual(['mcp:set_description'])
  })

  it('the Trash taking an image off the gallery, keeping what was typed meanwhile', async () => {
    seed({
      character: { description: '' },
      images: [
        { image_id: 'a', description: '', sort_order: 0 },
        { image_id: 'b', description: '', sort_order: 1 }
      ]
    })
    fake.on(
      `POST /flist/character/${CID}/images/trash`,
      json({
        trashed: [{ image_id: 'a', trash_id: 'a' }],
        not_found: [],
        off_gallery: ['a'],
        etag: 'after-trash'
      })
    )
    await useStore.getState().flistTrashImages(CID, ['a'])
    const slot = useStore.getState().flistWorking[CID]
    expect(slot.etag).toBe('after-trash')
    expect(slot.unsavedDirty).toBe(false)
    expect(slot.payload.images).toEqual([{ image_id: 'b', description: '', sort_order: 0 }])
    expect(undoLabels()).toEqual(['edit'])
  })
})

describe('loading a view is a commit that is not a change', () => {
  it('showing Live, then opening the Workbench again', async () => {
    seed({ character: { description: 'mine' } })
    useStore.setState({
      flistArchive: { [CID]: archiveEntry(livePayload({ character: { description: 'live' } })) }
    })
    await useStore.getState().flistShowLive(CID)
    expect(useStore.getState().editorContent).toBe('live')
    fake.on(
      `GET ${BENCH_URL}`,
      json(payloadRead(workbenchPayload({ character: { description: 'mine' } }), 'seed-etag'))
    )
    fake.on(`GET /flist/character/${CID}/workbench`, json(workbenchRead()))
    await useStore.getState().flistOpenWorking(CID)
    expect(useStore.getState().editorContent).toBe('mine')
    expect(canUndo(CID)).toBe(false)
  })

  it('signing out drops every slot, and what there was to undo', async () => {
    seed({ character: { description: 'mine' }, kinks: { '12': 'yes' } })
    useStore.getState().flistStandardKinkSet(CID, '12', 'fave')
    fake.fallback(json({}))
    await useStore.getState().flistSignOut()
    expect(useStore.getState().flistWorking).toEqual({})
    expect(canUndo(CID)).toBe(false)
  })
})

describe('the payload after a commit', () => {
  it('is a new object every time, even when it holds the same values', () => {
    seed({ character: { description: 'same' } })
    const first = useStore.getState().flistWorking[CID].payload
    useStore.getState().flistSetWorkingField(CID, 'character.description', 'same')
    const second = useStore.getState().flistWorking[CID].payload
    expect(second).not.toBe(first)
    expect(undoLabels()).toEqual(['edit'])
    const undone = useStore.getState().flistWorking[CID].payload
    expect(undone).not.toBe(first)
    expect(undone).not.toBe(second)
  })

  it('is what the editor shows after a per-row reset of the description', () => {
    seed({ character: { description: 'mine' } })
    useStore.setState({
      editorContent: 'mine',
      flistArchive: { [CID]: archiveEntry(livePayload({ character: { description: 'live' } })) }
    })
    useStore.getState().flistResetWorkingField(CID, 'character.description')
    expect(useStore.getState().editorContent).toBe('live')
    expect(undoLabels()).toEqual(['edit'])
  })
})
