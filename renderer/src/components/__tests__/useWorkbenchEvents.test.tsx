// The layout's watch on the sidecar: a frame on the event stream goes
// to the store, which re-reads what changed. A model's tool call, from
// the stream to the undo entry, against the fake sidecar.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { selectEditorDescription, useStore } from '../../state'
import { resetUndoStacks } from '../../state/undoStack'
import { useWorkbenchEvents } from '../useWorkbenchEvents'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'
import { payloadRead, workbenchPayload, workingSlot } from '../../test/payloads'

const CID = '99'
const READ = `GET /flist/character/${CID}/workbench/payload`

let fake: FakeApi

const descOf = () =>
  (useStore.getState().flistWorking[CID].payload.character as { description?: string }).description

const EVENTS = 'GET /events'

/** The stream the layout opened. */
async function opened() {
  await vi.waitFor(() => expect(fake.streams(EVENTS)).toHaveLength(1))
  return fake.streams(EVENTS)[0]
}

async function modelWrote(etag: string, tool = 'set_description') {
  ;(await opened()).send('set-payload-changed', {
    event: 'set-payload-changed',
    at: 1,
    origin: `mcp:${tool}`,
    character_id: CID,
    etag
  })
}

beforeEach(() => {
  fake = installFakeApi().stream(EVENTS)
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
  fake.restore()
})

it('a model’s change on the stream is reloaded and becomes one entry named after the tool', async () => {
  fake.on(READ, json(payloadRead(workbenchPayload({ character: { description: 'theirs' } }), 'theirs')))
  renderHook(() => useWorkbenchEvents())

  await modelWrote('theirs')

  await vi.waitFor(() => expect(descOf()).toBe('theirs'))
  expect(selectEditorDescription(useStore.getState())).toBe('theirs')
  expect(useStore.getState().flistUndo(CID)).toBe('mcp:set_description')
  expect(useStore.getState().flistUndo(CID)).toBeNull()
})

it('the event’s etag reaches the store: a write the window already holds is not read again', async () => {
  // The read after the first tool call already brought in the second.
  fake.on(READ, json(payloadRead(workbenchPayload({ character: { description: 'both' } }), 'second')))
  renderHook(() => useWorkbenchEvents())

  await modelWrote('first')
  await vi.waitFor(() => expect(descOf()).toBe('both'))
  await modelWrote('second', 'set_profile_field')
  await new Promise((r) => setTimeout(r, 0))

  expect(fake.requestsTo(READ)).toHaveLength(1)
  expect(useStore.getState().flistExternalChange[CID]).toBeFalsy()
})

it('the layout going away closes the stream', async () => {
  const { unmount } = renderHook(() => useWorkbenchEvents())
  const stream = await opened()
  unmount()
  expect(stream.closed).toBe(true)
})
