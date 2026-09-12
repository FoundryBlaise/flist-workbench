// The BBCode bar stays put when the document is read-only.
//
// It used to unmount, which took the whole bar of chrome with it and
// moved every line of the document up by that much. Toggling between
// Live on F-List and the Workbench then made the passage you were
// reading jump — worst at the top, where there is no scroll position to
// anchor it.

import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { useStore } from '../../../state'
import { Toolbar } from '../Toolbar'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function toolbar(disabled?: boolean) {
  const viewRef = { current: null }
  render(<Toolbar viewRef={viewRef} disabled={disabled} />)
}

it('dims the formatting buttons instead of removing them', () => {
  toolbar(true)

  expect(screen.getByTestId('editor-toolbar')).toBeTruthy()
  // Accessible names carry the shortcut ("Bold (Ctrl+B)"), so match
  // on the leading word.
  for (const label of [/^Bold/, /^Italic/, /^Character icon/]) {
    const btn = screen.getByRole('button', { name: label }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  }
  const more = screen.getByRole('button', {
    name: 'more…'
  }) as HTMLButtonElement
  expect(more.disabled).toBe(true)
})

it('leaves the view-mode toggle usable while read-only', () => {
  // Choosing how to look at a document is not an edit — and with the
  // bar gone there was no way back out of full-preview mode.
  useStore.setState({ editorViewMode: 'split' } as never)
  toolbar(true)

  const code = screen.getByTestId('view-mode-code') as HTMLButtonElement
  expect(code.disabled).toBe(false)
  code.click()
  expect(useStore.getState().editorViewMode).toBe('code')
})

it('enables everything for an editable document', () => {
  toolbar(false)

  const bold = screen.getByRole('button', {
    name: /^Bold/
  }) as HTMLButtonElement
  expect(bold.disabled).toBe(false)
})
