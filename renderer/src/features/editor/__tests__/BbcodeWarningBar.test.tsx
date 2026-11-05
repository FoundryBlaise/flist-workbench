// The warning bar above the preview says what F-list will make of the
// text, in words that fit the problem.
//
// Two kinds of verdict need two kinds of wording. A tag that is not
// allowed where it stands is refused, and the [big] hint helps. A tag
// that is not closed, or closed in the wrong order, is not refused at
// all: the profile goes live with that part as plain text, and the fix
// is closing tags in the reverse order they were opened.

import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { validateBbcode } from '../../../lib/bbcode/validate'
import { selectEditorDescription, useStore } from '../../../state'
import { workbenchPayload, workingSlot } from '../../../test/payloads'
import { BbcodeWarningBar } from '../BbcodeWarningBar'
import { PreviewPane } from '../PreviewPane'

afterEach(cleanup)

const bar = (source: string) => {
  render(<BbcodeWarningBar warnings={validateBbcode(source)} />)
  return screen.queryByTestId('preview-bbcode-warning')?.textContent ?? null
}

it('says nothing when F-list has nothing to say', () => {
  expect(bar('[b]ok[/b] [i]ok[/i]')).toBeNull()
})

it('says a crossed pair will show as plain text, and how to fix it', () => {
  const text = bar('[color=green][b]x[/color][/b]')

  expect(text).toContain('F-list will show this part as plain text — 2 places.')
  expect(text).toContain('Bad BBCode in [b] tag')
  expect(text).toContain('reverse order')
  expect(text).not.toContain('refuse')
  expect(text).not.toContain('[big]')
})

it('gives the reverse-order hint for a single unclosed tag too', () => {
  const text = bar('[b]x')

  expect(text).toContain('F-list will show this part as plain text.')
  expect(text).toContain('Open [b] tag is not properly closed (with [/b]).')
  expect(text).toContain('reverse order')
})

it('keeps the refusal wording and the [big] hint for a tag not allowed there', () => {
  const text = bar('[big][b][color=cyan]X[/color][/b][/big]')

  expect(text).toContain('F-list will refuse this.')
  expect(text).toContain('The [color] tag is not allowed here')
  expect(text).toContain('Only one level of formatting fits inside [big]')
  expect(text).not.toContain('plain text')
})

it('says both, with both hints, when both kinds occur', () => {
  const text = bar(
    '[big][b][color=cyan]X[/color][/b][/big] [color=green][b]x[/color][/b]'
  )

  expect(text).toContain(
    'F-list will refuse part of this and show part as plain text — 3 places.'
  )
  // F-list lists the structural warning first, so that one is quoted.
  expect(text).toContain('Bad BBCode in [b] tag')
  expect(text).toContain('reverse order')
  expect(text).toContain('Only one level of formatting fits inside [big]')
})

it('sits above the preview, which still holds the broken text', () => {
  // The bar warns; it never stops anyone writing. A broken description
  // has to stay in the Workbench to be fixable.
  const broken = '[color=green][b]x[/color][/b]'
  useStore.setState({
    flistWorking: { '7': workingSlot(workbenchPayload({ character: { description: broken } })) },
    flistActiveCharacterId: '7',
    editorActiveTab: 'description',
    editorReadOnly: false
  })
  render(<PreviewPane />)

  expect(screen.getByTestId('preview-bbcode-warning').textContent).toContain(
    'F-list will show this part as plain text — 2 places.'
  )
  expect(selectEditorDescription(useStore.getState())).toBe(broken)
})
