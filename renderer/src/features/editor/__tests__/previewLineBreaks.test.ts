// Enter in the editable preview breaks the line instead of splitting
// the paragraph. Chromium's paragraph split copies the source-mapped
// span, and the copy used to take the text before the caret out of the
// source.

import { afterEach, expect, it, vi } from 'vitest'
import { enterAsLineBreak } from '../previewLineBreaks'

afterEach(() => {
  vi.restoreAllMocks()
})

function beforeInput(el: HTMLElement, inputType: string): InputEvent {
  const e = new InputEvent('beforeinput', { inputType, cancelable: true, bubbles: true })
  el.dispatchEvent(e)
  return e
}

function editable(): HTMLElement {
  const el = document.createElement('div')
  el.contentEditable = 'true'
  document.body.append(el)
  // jsdom has no editing commands; record what would run.
  document.execCommand = vi.fn(() => true)
  return el
}

it('turns Enter into a line break', () => {
  const el = editable()
  const stop = enterAsLineBreak(el)

  const e = beforeInput(el, 'insertParagraph')

  expect(e.defaultPrevented).toBe(true)
  expect(document.execCommand).toHaveBeenCalledWith('insertLineBreak')
  stop()
})

it('leaves typing and Shift+Enter to the browser', () => {
  const el = editable()
  const stop = enterAsLineBreak(el)

  expect(beforeInput(el, 'insertText').defaultPrevented).toBe(false)
  expect(beforeInput(el, 'insertLineBreak').defaultPrevented).toBe(false)
  expect(document.execCommand).not.toHaveBeenCalled()
  stop()
})

it('stops listening when told to', () => {
  const el = editable()
  enterAsLineBreak(el)()

  expect(beforeInput(el, 'insertParagraph').defaultPrevented).toBe(false)
})
