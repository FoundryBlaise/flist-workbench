// Tier 2 §10 "Vitest" — snapshot per field renderer × {unset, set,
// overlaid, read-only}. The plan called this out as missing; landing
// it here so a future refactor can't quietly break the value/empty/dirty
// renderings.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

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
  it('TextField unset matches snapshot', () => {
    const { asFragment } = render(
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
    expect(asFragment()).toMatchSnapshot()
  })

  it('TextField set + overlaid matches snapshot (renders F-list muted line)', () => {
    const { asFragment, getByTestId, getByText } = render(
      <TextField
        descriptor={baseDescriptor}
        value="Human (mod)"
        overlaid
        liveValue="Human"
        readOnly={false}
        onCommit={vi.fn()}
        onReset={vi.fn()}
      />
    )
    expect(getByTestId('infotag-9-input')).toBeTruthy()
    expect(getByText(/F-list: Human/)).toBeTruthy()
    expect(asFragment()).toMatchSnapshot()
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
