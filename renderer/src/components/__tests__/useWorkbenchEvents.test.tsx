// The layout's watch on the sidecar: a frame on the event stream goes
// to the store, which re-reads what changed. A model's tool call, from
// the stream to the undo entry, against the fake sidecar.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { selectEditorDescription, useStore } from '../../state'
import { resetUndoStacks } from '../../state/undoStack'
import { useWorkbenchEvents } from '../useWorkbenchEvents'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'
import { installFakeEventSource, type FakeEventSources } from '../../test/fakeEventSource'
import { payloadRead, workbenchPayload, workingSlot } from '../../test/payloads'

const CID = '99'
const READ = `GET /flist/character/${CID}/workbench/payload`

let fake: FakeApi
let sources: FakeEventSources

const descOf = () =>
  (useStore.getState().flistWorking[CID].payload.character as { description?: string }).description

function modelWrote(etag: string, tool = 'set_description') {
  sources.last().emit('set-payload-changed', {
    event: 'set-payload-changed',
    at: 1,
    origin: `mcp:${tool}`,
    character_id: CID,
    etag
  })
}

beforeEach(() => {
  fake = installFakeApi()
  sources = installFakeEventSource()
  resetUndoStacks()
  useStore.setState({
    flistWorking: {
      [CID]: workingSlot(workbenchPayload({ character: { description: 'as I left her' } }))
    },
    flistExternalChange: {},
    flistMergeQuestion: {},
    flistViewingLive: {},
    flistBrowseBackup: null,
    flistWorkbenchNote: null,
    flistActiveCharacterId: CID,
    editorReadOnly: false
  })
})

afterEach(() => {
  cleanup()
  sources.restore()
  fake.restore()
})

it('a model’s change on the stream is reloaded and becomes one entry named after the tool', async () => {
  fake.on(READ, json(payloadRead(workbenchPayload({ character: { description: 'theirs' } }), 'theirs')))
  renderHook(() => useWorkbenchEvents())

  modelWrote('theirs')

  await vi.waitFor(() => expect(descOf()).toBe('theirs'))
  expect(selectEditorDescription(useStore.getState())).toBe('theirs')
  expect(useStore.getState().flistUndo(CID)).toBe('mcp:set_description')
  expect(useStore.getState().flistUndo(CID)).toBeNull()
})

it('the event’s etag reaches the store: a write the window already holds is not read again', async () => {
  // The read after the first tool call already brought in the second.
  fake.on(READ, json(payloadRead(workbenchPayload({ character: { description: 'both' } }), 'second')))
  renderHook(() => useWorkbenchEvents())

  modelWrote('first')
  await vi.waitFor(() => expect(descOf()).toBe('both'))
  modelWrote('second', 'set_profile_field')
  await new Promise((r) => setTimeout(r, 0))

  expect(fake.requestsTo(READ)).toHaveLength(1)
  expect(useStore.getState().flistExternalChange[CID]).toBeFalsy()
})

it('the layout going away closes the stream', () => {
  const { unmount } = renderHook(() => useWorkbenchEvents())
  unmount()
  expect(sources.last().closed).toBe(true)
})
