// The description editor on the Workbench undo stack (#111): typing in
// it is a burst per pause or blur on the character's stack, Ctrl+Z in
// it goes to that stack, and the editor keeps no history of its own,
// so changes from outside it (a reload, another field) cannot land in
// one. Rendered with the real store, CodeMirror and the window's
// keydown handler, against the fake sidecar.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { EditorPane } from '../EditorPane'
import { PreviewPane } from '../PreviewPane'
import { useStore } from '../../../state'
import { TYPING_PAUSE_MS, resetUndoStacks } from '../../../state/undoStack'
import { handleUndoKeydown } from '../../../lib/undoRedo'
import { installFakeApi, json, type FakeApi } from '../../../test/fakeApi'
import { payloadRead, workbenchPayload, workingSlot } from '../../../test/payloads'

const CID = '99'
const SAVE = `PUT /flist/character/${CID}/workbench/payload`
const AUTOSAVE_MS = 500
const KEYSTROKE_MS = 120

let fake: FakeApi

const store = () => useStore.getState()
const description = () =>
  (store().flistWorking[CID].payload.character as { description?: string }).description

function seed(text = '', extra: Record<string, unknown> = {}) {
  useStore.setState({
    flistWorking: {
      [CID]: workingSlot(workbenchPayload({ character: { description: text }, ...extra }))
    },
    flistActiveCharacterId: CID,
    editorActiveTab: 'description',
    editorReadOnly: false,
    editorContent: text
  })
}

function renderEditor() {
  const viewRef = { current: null as EditorView | null }
  render(<EditorPane viewRef={viewRef} />)
  return viewRef
}

/** The editor's view, as it is mounted now. */
function view(): EditorView {
  const el = document.querySelector('.cm-editor') as HTMLElement | null
  if (!el) throw new Error('no editor mounted')
  const v = EditorView.findFromDOM(el)
  if (!v) throw new Error('no editor view')
  return v
}

/** Type `text` at the cursor, a keystroke at a time, quickly. */
async function type(text: string) {
  for (const ch of text) {
    act(() => {
      const v = view()
      const at = v.state.selection.main.head
      v.dispatch({
        changes: { from: at, insert: ch },
        selection: { anchor: at + ch.length },
        userEvent: 'input.type'
      })
    })
    await act(() => vi.advanceTimersByTimeAsync(KEYSTROKE_MS))
  }
}

const pause = () => act(() => vi.advanceTimersByTimeAsync(TYPING_PAUSE_MS))

/** Ctrl+Z (or Ctrl+Y) pressed with the focus in the editor. */
function pressInEditor(key: 'z' | 'y') {
  act(() => {
    fireEvent.keyDown(view().contentDOM, { key, ctrlKey: true })
  })
}

beforeAll(() => {
  // jsdom lays nothing out; CodeMirror measures text ranges after each
  // update, so give it empty boxes.
  const empty = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })
  Range.prototype.getClientRects = empty as unknown as Range['getClientRects']
  Range.prototype.getBoundingClientRect = () => new DOMRect()
})

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeApi()
  fake.on(SAVE, json({ etag: 'e1' }))
  fake.fallback(json({}))
  resetUndoStacks()
  useStore.setState({
    mode: 'editor',
    foreignActive: false,
    flistWorking: {},
    flistExternalChange: {},
    flistViewingLive: {},
    flistBrowseBackup: null,
    editorDirty: false
  })
  document.addEventListener('keydown', handleUndoKeydown)
})

afterEach(() => {
  cleanup()
  document.removeEventListener('keydown', handleUndoKeydown)
  fake.restore()
  vi.useRealTimers()
})

describe('Ctrl+Z in the description editor', () => {
  it('after a pause undoes that burst through the undo stack, and the save matches', async () => {
    seed()
    renderEditor()
    await type('Hello')
    await pause()
    await type(' there')
    await pause()
    expect(description()).toBe('Hello there')

    fake.on(SAVE, json({ etag: 'e2' }))
    pressInEditor('z')
    expect(view().state.doc.toString()).toBe('Hello')
    expect(description()).toBe('Hello')
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_MS))
    const saves = fake.requestsTo(SAVE)
    expect((saves[saves.length - 1].body as { character: unknown }).character).toEqual({
      description: 'Hello'
    })

    pressInEditor('y')
    expect(view().state.doc.toString()).toBe('Hello there')
  })

  it('blur ends the burst', async () => {
    seed()
    renderEditor()
    await type('Hello')
    act(() => {
      fireEvent.blur(view().contentDOM)
    })
    await type('!')
    pressInEditor('z')
    expect(view().state.doc.toString()).toBe('Hello')
  })

  it('keeps the cursor where the undone typing was', async () => {
    seed('Hello world')
    renderEditor()
    act(() => view().dispatch({ selection: { anchor: 5 } }))
    await type(',')
    await pause()
    pressInEditor('z')
    expect(view().state.doc.toString()).toBe('Hello world')
    expect(view().state.selection.main.head).toBe(5)
  })
})

describe('the editor keeps no history of its own', () => {
  it('a change to another field undoes before the typing that came first', async () => {
    seed('', { kinks: { '12': 'yes' } })
    renderEditor()
    await type('Hello')
    await pause()
    act(() => store().flistStandardKinkSet(CID, '12', 'fave'))

    pressInEditor('z')
    expect(store().flistWorking[CID].payload.kinks).toEqual({ '12': 'yes' })
    expect(view().state.doc.toString()).toBe('Hello')
    pressInEditor('z')
    expect(view().state.doc.toString()).toBe('')
  })

  it('a reload after an external change is one step, not a rewrite of the editor’s history', async () => {
    seed()
    renderEditor()
    await type('Hello')
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_MS + TYPING_PAUSE_MS))
    fake.on(
      `GET /flist/character/${CID}/workbench/payload`,
      json(payloadRead(workbenchPayload({ character: { description: 'Hi from the model' } }), 'theirs'))
    )
    // Nothing unsaved: the store takes the model's change in by itself.
    await act(async () => {
      store().flistNoteExternalChange(CID, { etag: 'theirs', origin: 'mcp:set_description' })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(view().state.doc.toString()).toBe('Hi from the model')

    pressInEditor('z')
    expect(view().state.doc.toString()).toBe('Hello')
    pressInEditor('z')
    expect(view().state.doc.toString()).toBe('')
    pressInEditor('z')
    expect(view().state.doc.toString()).toBe('')
  })

  it('leaving the Description tab and coming back keeps the history, in order', async () => {
    seed('', { kinks: { '12': 'yes' } })
    renderEditor()
    await type('Hello')
    await pause()
    await type(' there')
    await pause()
    act(() => store().setEditorActiveTab('diff'))
    expect(document.querySelector('.cm-editor')).toBeNull()
    act(() => store().flistStandardKinkSet(CID, '12', 'fave'))
    act(() => store().setEditorActiveTab('description'))

    pressInEditor('z')
    expect(store().flistWorking[CID].payload.kinks).toEqual({ '12': 'yes' })
    pressInEditor('z')
    expect(view().state.doc.toString()).toBe('Hello')
    pressInEditor('z')
    expect(view().state.doc.toString()).toBe('')
    pressInEditor('y')
    pressInEditor('y')
    expect(view().state.doc.toString()).toBe('Hello there')
  })
})

describe('the preview beside the editor', () => {
  it('Ctrl+Z there undoes the description typing on the Workbench stack and shows the result', async () => {
    seed()
    render(<PreviewPane />)
    const preview = document.querySelector('[data-testid="preview-body"]') as HTMLElement
    act(() => store().setEditorContent('Hello'))
    await pause()
    act(() => store().setEditorContent('Hello there'))
    act(() => {
      preview.focus()
      fireEvent.keyDown(preview, { key: 'z', ctrlKey: true })
    })
    expect(description()).toBe('Hello')
    expect(preview.textContent).toBe('Hello')
  })
})
