// The editor's Kinks tab: four columns, one per assigned choice. The
// Foreign view draws its kinks with the same columns, so these pin what
// the editor itself shows and lets the user do with them.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useStore } from '../../../state'
import { KinksPane } from '../KinksPane'
import { KINK_DRAG_MIME } from '../KinkRow'

const CID = '42'

const MAPPING = {
  infotags: [],
  infotag_groups: [],
  kinks: [
    { id: 12, name: 'Biting', description: 'Teeth involved', group_id: 3 },
    { id: 13, name: 'Vore', description: '', group_id: 3 },
    { id: 14, name: 'Untouched', description: '', group_id: 3 }
  ],
  kink_groups: [{ id: 3, name: 'Body' }],
  listitems: []
}

const PAYLOAD = {
  kinks: { '12': 'fave', '13': 'no' },
  custom_kinks: { '7': { name: 'Invented', description: '', choice: 'no' } }
}

function seed(readOnly: boolean) {
  useStore.setState({
    editorReadOnly: readOnly,
    flistMapping: { status: 'ready', payload: MAPPING, error: null },
    flistLoadMapping: vi.fn().mockResolvedValue(undefined),
    flistStandardKinkSet: vi.fn(),
    flistCustomKinksEdit: vi.fn(),
    flistWorking: { [CID]: { payload: PAYLOAD } },
    flistArchive: { [CID]: { live: PAYLOAD } }
  } as never)
}

beforeEach(() => seed(false))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('lays the assigned kinks out in Fave, Yes, Maybe and No columns', () => {
  render(<KinksPane characterId={CID} />)

  const titles = Array.from(
    screen.getByTestId('kinks-pane').querySelectorAll('.kink-column-title')
  ).map((t) => t.textContent)
  expect(titles).toEqual(['★ Fave', 'Yes', 'Maybe', 'No'])

  const fave = screen.getByTestId('kink-column-fave')
  expect(fave.querySelector('.kink-column-count')?.textContent).toBe('1')
  const biting = fave.querySelector('.kink-row')
  expect(biting?.textContent).toBe('Biting')
  expect(biting?.getAttribute('title')).toBe('Teeth involved')

  const no = screen.getByTestId('kink-column-no')
  expect(no.querySelector('.kink-column-count')?.textContent).toBe('2')
  expect(no.querySelector('.kink-row-custom .kink-row-pip')).not.toBeNull()
  expect(screen.queryByText('Untouched')).toBeNull()
})

it('an empty column invites a drop while editing', () => {
  render(<KinksPane characterId={CID} />)
  expect(screen.getByTestId('kink-column-yes').textContent).toContain('drop here')
})

it('a key on a focused row moves the kink to that column', () => {
  render(<KinksPane characterId={CID} />)
  const row = screen.getByTestId('kink-column-fave').querySelector('.kink-row')!
  expect(row.getAttribute('draggable')).toBe('true')

  fireEvent.keyDown(row, { key: 'n' })
  expect(useStore.getState().flistStandardKinkSet).toHaveBeenCalledWith(CID, '12', 'no')
})

it('dropping a row on a column moves the kink there', () => {
  render(<KinksPane characterId={CID} />)
  const data = JSON.stringify([{ type: 'custom', id: '7' }])
  fireEvent.drop(screen.getByTestId('kink-column-maybe'), {
    dataTransfer: { getData: (mime: string) => (mime === KINK_DRAG_MIME ? data : '') }
  })
  expect(useStore.getState().flistCustomKinksEdit).toHaveBeenCalledWith(
    CID,
    '7',
    'choice',
    'maybe'
  )
})

it('read-only views offer no drop and no keys', () => {
  seed(true)
  render(<KinksPane characterId={CID} />)

  expect(screen.getByTestId('kink-column-yes').textContent).toContain('—')
  const row = screen.getByTestId('kink-column-fave').querySelector('.kink-row')!
  expect(row.getAttribute('draggable')).toBe('false')
  fireEvent.keyDown(row, { key: 'n' })
  expect(useStore.getState().flistStandardKinkSet).not.toHaveBeenCalled()
})
