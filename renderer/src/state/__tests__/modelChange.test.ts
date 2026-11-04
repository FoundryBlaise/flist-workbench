// A model's change to the Workbench while the window holds nothing
// unsaved: the store reloads it by itself, for any character, and
// the change is one undo entry named after the tool. Undoing it is a
// real save over the etag the reload took. Driven through the event
// dispatch and the store's actions against the fake sidecar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { resetUndoStacks } from '../undoStack'
import { applyWorkbenchEvent } from '../workbenchEvents'
import type { WorkbenchEvent } from '../../lib/eventStream'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'
import { archiveEntry, livePayload, payloadRead, workbenchPayload, workingSlot } from '../../test/payloads'

const CID = '99'
const BENCH = `/flist/character/${CID}/workbench/payload`
const READ = `GET ${BENCH}`
const SAVE = `PUT ${BENCH}`
const AUTOSAVE_MS = 500

let fake: FakeApi

const slotOf = (characterId = CID) => useStore.getState().flistWorking[characterId]
const descOf = (payload: unknown) =>
  ((payload as { character?: { description?: string } }).character ?? {}).description

function seed(description: string, characterId = CID) {
  useStore.setState((s) => ({
    flistWorking: {
      ...s.flistWorking,
      [characterId]: workingSlot(workbenchPayload({ character: { description } }))
    }
  }))
}

/** The sidecar's answer to reading the Workbench after the model wrote. */
function theirs(description: string, etag: string) {
  return json(
    payloadRead(
      workbenchPayload({ _overlay: ['character.description'], character: { description } }),
      etag
    )
  )
}

/** The event the sidecar publishes after a model's tool call. */
function modelEvent(etag: string, origin = 'mcp:set_description', characterId = CID): WorkbenchEvent {
  return { event: 'set-payload-changed', at: 1, origin, character_id: characterId, etag }
}

async function dispatch(event: WorkbenchEvent) {
  applyWorkbenchEvent(event, useStore.getState())
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
    editorContent: '',
    editorDirty: false
  })
})

afterEach(() => {
  fake.restore()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a model changes the Workbench while nothing is unsaved', () => {
  it('the window reloads it, shows the new description, and the change is one entry named after the tool', async () => {
    seed('as I left her')
    useStore.setState({ editorContent: 'as I left her' })
    fake.on(READ, theirs('as the model wrote her', 'theirs'))

    await dispatch(modelEvent('theirs'))

    expect(descOf(slotOf().payload)).toBe('as the model wrote her')
    expect(slotOf().etag).toBe('theirs')
    expect(slotOf().unsavedDirty).toBe(false)
    expect(useStore.getState().editorContent).toBe('as the model wrote her')
    expect(useStore.getState().editorDirty).toBe(false)
    expect(useStore.getState().flistExternalChange[CID]).toBeFalsy()

    expect(useStore.getState().flistUndo(CID)).toBe('mcp:set_description')
    expect(descOf(slotOf().payload)).toBe('as I left her')
    expect(useStore.getState().flistUndo(CID)).toBeNull()
  })

  it('undoing it saves the previous payload over the etag the reload took, and redo saves theirs again', async () => {
    seed('as I left her')
    fake.on(READ, theirs('as the model wrote her', 'theirs'))
    await dispatch(modelEvent('theirs'))

    fake.on(SAVE, json({ etag: 'after-undo' }))
    useStore.getState().flistUndo(CID)
    expect(slotOf().unsavedDirty).toBe(true)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const [undone] = fake.requestsTo(SAVE)
    expect(descOf(undone.body)).toBe('as I left her')
    expect(undone.headers['If-Match']).toBe('theirs')
    expect(slotOf().unsavedDirty).toBe(false)

    fake.on(SAVE, json({ etag: 'after-redo' }))
    expect(useStore.getState().flistRedo(CID)).toBe('mcp:set_description')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    const redone = fake.requestsTo(SAVE)[1]
    expect(descOf(redone.body)).toBe('as the model wrote her')
    expect(redone.headers['If-Match']).toBe('after-undo')
    expect(slotOf().etag).toBe('after-redo')
  })

  it('an event for a write the reload already brought in is not a second entry', async () => {
    // Two tool calls in a row: the read after the first already sees
    // the second, so the second event carries the etag the window holds.
    seed('as I left her')
    fake.on(READ, theirs('after two tool calls', 'second'))
    await dispatch(modelEvent('first'))
    await dispatch(modelEvent('second', 'mcp:set_profile_field'))

    expect(fake.requestsTo(READ)).toHaveLength(1)
    expect(descOf(slotOf().payload)).toBe('after two tool calls')
    expect(useStore.getState().flistUndo(CID)).toBe('mcp:set_description')
    expect(useStore.getState().flistUndo(CID)).toBeNull()
  })

  it('a character the window is not showing is reloaded too, and the editor keeps the active one', async () => {
    seed('the active one', '7')
    seed('as I left her')
    useStore.setState({ flistActiveCharacterId: '7', editorContent: 'the active one' })
    fake.on(READ, theirs('as the model wrote her', 'theirs'))

    await dispatch(modelEvent('theirs'))

    expect(descOf(slotOf().payload)).toBe('as the model wrote her')
    expect(useStore.getState().editorContent).toBe('the active one')
    expect(useStore.getState().flistUndo(CID)).toBe('mcp:set_description')
  })

  it('a maintenance pass and the browser extension are entries too, labelled with their origin', async () => {
    seed('as I left her')
    fake.once(READ, theirs('gallery repaired', 'e1'))
    await dispatch(modelEvent('e1', 'internal:gallery-repair'))
    fake.once(READ, theirs('backed up', 'e2'))
    await dispatch(modelEvent('e2', 'extension:upload'))

    expect(useStore.getState().flistUndo(CID)).toBe('extension:upload')
    expect(useStore.getState().flistUndo(CID)).toBe('internal:gallery-repair')
  })

  it('typing in the description while the reload is out is kept, and the description is asked about', async () => {
    seed('as I left her')
    useStore.setState({ editorContent: 'as I left her' })
    fake.hold(READ)
    await dispatch(modelEvent('theirs'))
    useStore.getState().setEditorContent('as I left her, and more')
    fake.pending(READ)[0].resolve(theirs('as the model wrote her', 'theirs'))
    await vi.advanceTimersByTimeAsync(0)

    expect(descOf(slotOf().payload)).toBe('as I left her, and more')
    expect(slotOf().unsavedDirty).toBe(true)
    // Both wrote the description (fieldMerge.test.ts has the rest).
    expect(useStore.getState().flistMergeQuestion[CID]).toMatchObject({
      label: 'mcp:set_description',
      fields: ['character.description']
    })
  })

  it('while the window shows Live, Live stays on screen, and back on the Workbench the change is one entry', async () => {
    seed('as I left her')
    useStore.setState({ flistArchive: { [CID]: archiveEntry(livePayload({ character: { description: 'as published' } })) } })
    await useStore.getState().flistShowLive(CID)
    fake.on(READ, theirs('as the model wrote her', 'theirs'))

    await dispatch(modelEvent('theirs'))

    expect(useStore.getState().flistViewingLive[CID]).toBe(true)
    expect(descOf(slotOf().payload)).toBe('as published')
    expect(useStore.getState().editorContent).toBe('as published')
    expect(useStore.getState().flistExternalChange[CID]).toBeFalsy()

    await useStore.getState().flistOpenWorking(CID)
    expect(descOf(slotOf().payload)).toBe('as the model wrote her')
    expect(useStore.getState().flistUndo(CID)).toBe('mcp:set_description')
    expect(descOf(slotOf().payload)).toBe('as I left her')
    expect(useStore.getState().flistUndo(CID)).toBeNull()
  })

  it('showing Live while the reload is out still makes the change one entry', async () => {
    seed('as I left her')
    useStore.setState({ flistArchive: { [CID]: archiveEntry(livePayload()) } })
    fake.hold(READ)
    await dispatch(modelEvent('theirs'))
    await useStore.getState().flistShowLive(CID)
    fake.pending(READ)[0].resolve(theirs('as the model wrote her', 'theirs'))
    await vi.advanceTimersByTimeAsync(0)
    fake.pending(READ)[0].resolve(theirs('as the model wrote her', 'theirs'))
    await vi.advanceTimersByTimeAsync(0)
    expect(useStore.getState().flistExternalChange[CID]).toBeFalsy()

    const opened = useStore.getState().flistOpenWorking(CID)
    await vi.advanceTimersByTimeAsync(0)
    fake.pending(READ)[0].resolve(theirs('as the model wrote her', 'theirs'))
    await opened
    expect(useStore.getState().flistUndo(CID)).toBe('mcp:set_description')
    expect(descOf(slotOf().payload)).toBe('as I left her')
  })

  it('while Live is shown, an event for a write already taken in is not a second entry', async () => {
    seed('as I left her')
    useStore.setState({ flistArchive: { [CID]: archiveEntry(livePayload()) } })
    await useStore.getState().flistShowLive(CID)
    fake.on(READ, theirs('after two tool calls', 'second'))

    await dispatch(modelEvent('first'))
    await dispatch(modelEvent('second', 'mcp:set_profile_field'))

    await useStore.getState().flistOpenWorking(CID)
    expect(useStore.getState().flistUndo(CID)).toBe('mcp:set_description')
    expect(descOf(slotOf().payload)).toBe('as I left her')
    expect(useStore.getState().flistUndo(CID)).toBeNull()
  })

  it('the window notes the reload, and what an undo or redo stepped over, by origin', async () => {
    seed('as I left her')
    fake.on(READ, theirs('as the model wrote her', 'theirs'))
    await dispatch(modelEvent('theirs'))
    expect(useStore.getState().flistWorkbenchNote).toMatchObject({
      characterId: CID,
      action: 'updated',
      label: 'mcp:set_description'
    })

    useStore.getState().flistUndo(CID)
    expect(useStore.getState().flistWorkbenchNote).toMatchObject({
      characterId: CID,
      action: 'undo',
      label: 'mcp:set_description'
    })
    useStore.getState().flistRedo(CID)
    expect(useStore.getState().flistWorkbenchNote).toMatchObject({ action: 'redo', label: 'mcp:set_description' })
  })

  it('a character with nothing open is not read: opening it reads the change from disk', async () => {
    await dispatch(modelEvent('theirs'))
    expect(fake.requests).toHaveLength(0)
    expect(useStore.getState().flistExternalChange[CID]).toBeFalsy()
  })
})
