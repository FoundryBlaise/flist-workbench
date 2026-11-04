// Routing of Ctrl+Z / Ctrl+Y and the menus' Undo / Redo (#110): outside
// a text control they step the active character's Workbench back and
// forth; inside one they are left to it. Driven through the window's
// keydown handler and the dispatcher the menus call, against the real
// store and the fake sidecar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AppContextMenu } from '../../components/AppContextMenu'
import { useStore } from '../../state'
import { resetUndoStacks } from '../../state/undoStack'
import { handleUndoKeydown, runUndoRedo, workbenchUndoState } from '../undoRedo'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'
import { workbenchPayload, workingSlot } from '../../test/payloads'

const CID = '99'
const SAVE = `PUT /flist/character/${CID}/workbench/payload`

let fake: FakeApi

const kinks = () => useStore.getState().flistWorking[CID].payload.kinks

/** The Workbench after two kink choices: fave on 12, then no on 13. */
function twoChanges() {
  useStore.setState({
    flistWorking: { [CID]: workingSlot(workbenchPayload({ kinks: { '12': 'yes' } })) },
    flistActiveCharacterId: CID
  })
  useStore.getState().flistStandardKinkSet(CID, '12', 'fave')
  useStore.getState().flistStandardKinkSet(CID, '13', 'no')
}

function press(key: string, opts: KeyboardEventInit = {}, target: Element = document.body) {
  const e = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...opts })
  target.dispatchEvent(e)
  return e
}

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeApi()
  fake.on(SAVE, json({ etag: 'e1' }))
  resetUndoStacks()
  useStore.setState({
    mode: 'editor',
    foreignActive: false,
    flistWorking: {},
    flistViewingLive: {},
    flistBrowseBackup: null,
    flistActiveCharacterId: null,
    editorReadOnly: false
  })
  document.addEventListener('keydown', handleUndoKeydown)
})

afterEach(() => {
  document.removeEventListener('keydown', handleUndoKeydown)
  document.body.innerHTML = ''
  fake.restore()
  vi.useRealTimers()
})

describe('the keys outside a text control', () => {
  it('Ctrl+Z undoes the last change, Ctrl+Y redoes it', () => {
    twoChanges()
    const e = press('z')
    expect(e.defaultPrevented).toBe(true)
    expect(kinks()).toEqual({ '12': 'fave' })
    press('z')
    expect(kinks()).toEqual({ '12': 'yes' })
    press('y')
    expect(kinks()).toEqual({ '12': 'fave' })
  })

  it('Ctrl+Shift+Z redoes too', () => {
    twoChanges()
    press('z')
    press('Z', { shiftKey: true })
    expect(kinks()).toEqual({ '12': 'fave', '13': 'no' })
  })

  it('a focused checkbox or button is not a text control', () => {
    twoChanges()
    document.body.innerHTML = '<input type="checkbox" id="c"><button id="b">x</button>'
    press('z', {}, document.getElementById('c')!)
    expect(kinks()).toEqual({ '12': 'fave' })
    press('z', {}, document.getElementById('b')!)
    expect(kinks()).toEqual({ '12': 'yes' })
  })

  it('Z without Ctrl, or with Alt, is not undo', () => {
    twoChanges()
    press('z', { ctrlKey: false })
    press('z', { altKey: true })
    expect(kinks()).toEqual({ '12': 'fave', '13': 'no' })
  })
})

describe('the keys inside a text control are left to it', () => {
  it.each([
    ['a text input', '<input type="text" id="t">'],
    ['a textarea', '<textarea id="t"></textarea>'],
    ['the description editor', '<div class="cm-editor"><div id="t" contenteditable="true"></div></div>'],
    ['the preview', '<div id="t" contenteditable="true"></div>']
  ])('%s', (_name, html) => {
    twoChanges()
    document.body.innerHTML = html
    const e = press('z', {}, document.getElementById('t')!)
    expect(e.defaultPrevented).toBe(false)
    expect(kinks()).toEqual({ '12': 'fave', '13': 'no' })
  })
})

describe('the Workbench’s own text fields put their typing on its stack', () => {
  it.each([
    ['the description editor', '<div data-undo="workbench"><div class="cm-editor"><div id="t" contenteditable="true"></div></div></div>'],
    ['the preview', '<div id="t" data-undo="workbench" contenteditable="true"></div>'],
    ['a caption', '<textarea id="t" data-undo="workbench"></textarea>'],
    ['an infotag field', '<input type="text" id="t" data-undo="workbench">']
  ])('Ctrl+Z and Ctrl+Y in %s step the Workbench', (_name, html) => {
    twoChanges()
    document.body.innerHTML = html
    const t = document.getElementById('t')!
    expect(press('z', {}, t).defaultPrevented).toBe(true)
    expect(kinks()).toEqual({ '12': 'fave' })
    press('y', {}, t)
    expect(kinks()).toEqual({ '12': 'fave', '13': 'no' })
  })

  it('Ctrl+Z in a text input of the window never reaches the Workbench or its editor', () => {
    twoChanges()
    document.body.innerHTML =
      '<div data-undo="workbench"><div class="cm-editor"><div contenteditable="true"></div></div></div>' +
      '<input type="search" id="t">'
    const input = document.getElementById('t') as HTMLInputElement
    input.focus()
    expect(press('z', {}, input).defaultPrevented).toBe(false)
    runUndoRedo('undo')
    expect(kinks()).toEqual({ '12': 'fave', '13': 'no' })
  })
})

describe('the menus go through the same routing', () => {
  it('Edit → Undo / Redo with nothing focused step the Workbench', () => {
    twoChanges()
    runUndoRedo('undo')
    expect(kinks()).toEqual({ '12': 'fave' })
    runUndoRedo('redo')
    expect(kinks()).toEqual({ '12': 'fave', '13': 'no' })
  })

  it('Edit → Undo with a text input focused leaves the Workbench alone', () => {
    twoChanges()
    document.body.innerHTML = '<input type="text" id="t">'
    const input = document.getElementById('t') as HTMLInputElement
    input.focus()
    runUndoRedo('undo')
    expect(kinks()).toEqual({ '12': 'fave', '13': 'no' })
  })

  it('the right-click menu knows what there is to undo and redo', () => {
    twoChanges()
    expect(workbenchUndoState()).toEqual({ undo: true, redo: false })
    runUndoRedo('undo', document.body)
    expect(workbenchUndoState()).toEqual({ undo: true, redo: true })
  })

  it('right-click → Undo / Redo outside a text control step the Workbench', () => {
    twoChanges()
    render(<AppContextMenu />)
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    fireEvent.contextMenu(pane)
    expect(screen.getByRole('menuitem', { name: 'Redo' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Undo' }))
    expect(kinks()).toEqual({ '12': 'fave' })
    fireEvent.contextMenu(pane)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Redo' }))
    expect(kinks()).toEqual({ '12': 'fave', '13': 'no' })
    cleanup()
  })
})

describe('where there is no Workbench to undo', () => {
  it('the Logs, a Foreign profile and no character leave it alone', () => {
    twoChanges()
    useStore.setState({ mode: 'logs' })
    press('z')
    useStore.setState({ mode: 'editor', foreignActive: true })
    press('z')
    expect(kinks()).toEqual({ '12': 'fave', '13': 'no' })
    expect(workbenchUndoState()).toBeNull()
    useStore.setState({ foreignActive: false, flistActiveCharacterId: null })
    press('z')
    expect(kinks()).toEqual({ '12': 'fave', '13': 'no' })
  })

  it('the right-click menu offers no Undo while the window shows Live or a Backup', () => {
    twoChanges()
    useStore.setState({ editorReadOnly: true })
    expect(workbenchUndoState()).toBeNull()
  })
})
