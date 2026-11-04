// The profile field renderers of the Workbench's Profile fields tab:
// what each shows for an empty, a set and an edited field, and what the
// user can do with it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

afterEach(() => {
  cleanup()
})
import {
  TextField,
  NumberField,
  ListField,
  UnknownField
} from '../infotagFields/TextField'
import type { InfotagDescriptor } from '../infotagsResolver'

const baseDescriptor: InfotagDescriptor = {
  id: '9',
  fieldName: 'info_9',
  label: 'Species',
  type: 'text',
  groupId: 'general',
  uiHint: {}
}

const listDescriptor: InfotagDescriptor = {
  ...baseDescriptor,
  id: '2',
  label: 'Orientation',
  type: 'list',
  listItems: [
    { value: '4', label: 'Straight' },
    { value: '5', label: 'Gay' }
  ]
}

const numberDescriptor: InfotagDescriptor = {
  ...baseDescriptor,
  id: '1',
  label: 'Age',
  type: 'number',
  uiHint: { min: 18, max: 200, unitSuffix: 'yrs' }
}

describe('infotag field renderers', () => {
  it('TextField with no value shows its label and an empty input, with nothing to reset', () => {
    render(
      <TextField
        descriptor={baseDescriptor}
        value=""
        overlaid={false}
        liveValue={null}
        readOnly={false}
        onCommit={vi.fn()}
        onReset={vi.fn()}
      />
    )
    expect(screen.getByText('Species')).toBeTruthy()
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('—')
    expect(input.disabled).toBe(false)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(/F-list:/)).toBeNull()
  })

  it('TextField edited away from Live shows the F-list value and resets to it', () => {
    const reset = vi.fn()
    render(
      <TextField
        descriptor={baseDescriptor}
        value="Human (mod)"
        overlaid
        liveValue="Human"
        readOnly={false}
        onCommit={vi.fn()}
        onReset={reset}
      />
    )
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Human (mod)')
    expect(screen.getByText('F-list: Human')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Reset Species to F-list value' }))
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('TextField hands every keystroke to the Workbench as typing, and ends typing on leaving', () => {
    const commit = vi.fn()
    const endTyping = vi.fn()
    render(
      <TextField
        descriptor={baseDescriptor}
        value=""
        overlaid={false}
        liveValue={null}
        readOnly={false}
        onCommit={commit}
        onEndTyping={endTyping}
        onReset={vi.fn()}
      />
    )
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'E' } })
    fireEvent.change(input, { target: { value: 'Elf' } })
    expect(commit.mock.calls).toEqual([
      ['E', { typing: true }],
      ['Elf', { typing: true }]
    ])
    expect(input.value).toBe('Elf')
    expect(endTyping).not.toHaveBeenCalled()

    fireEvent.blur(input)
    expect(endTyping).toHaveBeenCalledTimes(1)
  })

  it('TextField read-only disables the input', () => {
    const { getByTestId } = render(
      <TextField
        descriptor={baseDescriptor}
        value="Human"
        overlaid={false}
        liveValue={null}
        readOnly
        onCommit={vi.fn()}
        onReset={vi.fn()}
      />
    )
    expect((getByTestId('infotag-9-input') as HTMLInputElement).disabled).toBe(true)
  })

  it('ListField unset shows the placeholder option', () => {
    const { getByTestId } = render(
      <ListField
        descriptor={listDescriptor}
        value=""
        overlaid={false}
        liveValue={null}
        readOnly={false}
        onCommit={vi.fn()}
        onReset={vi.fn()}
      />
    )
    const select = getByTestId('infotag-2-select') as HTMLSelectElement
    expect(select.options[0].textContent).toBe('—')
  })

  it('ListField set populates the matching option', () => {
    const { getByTestId } = render(
      <ListField
        descriptor={listDescriptor}
        value="5"
        overlaid
        liveValue="Straight"
        readOnly={false}
        onCommit={vi.fn()}
        onReset={vi.fn()}
      />
    )
    expect((getByTestId('infotag-2-select') as HTMLSelectElement).value).toBe('5')
  })

  it('NumberField echoes the out-of-range value in the error copy', () => {
    const { getByTestId, queryByText } = render(
      <NumberField
        descriptor={numberDescriptor}
        value=""
        overlaid={false}
        liveValue={null}
        readOnly={false}
        onCommit={vi.fn()}
        onReset={vi.fn()}
      />
    )
    const input = getByTestId('infotag-1-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '999' } })
    fireEvent.blur(input)
    expect(queryByText(/must be between 18 and 200/)).toBeTruthy()
  })

  it('NumberField echoes a non-numeric input verbatim', () => {
    const { getByTestId, queryByText } = render(
      <NumberField
        descriptor={numberDescriptor}
        value=""
        overlaid={false}
        liveValue={null}
        readOnly={false}
        onCommit={vi.fn()}
        onReset={vi.fn()}
      />
    )
    const input = getByTestId('infotag-1-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'old' } })
    fireEvent.blur(input)
    expect(queryByText(/“old” isn't a number/)).toBeTruthy()
  })

  it('UnknownField is disabled + surfaces a Refresh mapping list CTA', () => {
    const refresh = vi.fn()
    const { getByText, getByTestId } = render(
      <UnknownField
        descriptor={{ ...baseDescriptor, id: '500', type: 'unknown' }}
        value="?"
        overlaid={false}
        onForceRefreshMapping={refresh}
      />
    )
    expect(getByTestId('infotag-500-unknown')).toBeTruthy()
    const btn = getByText(/Refresh mapping list/) as HTMLButtonElement
    btn.click()
    expect(refresh).toHaveBeenCalled()
  })
})
