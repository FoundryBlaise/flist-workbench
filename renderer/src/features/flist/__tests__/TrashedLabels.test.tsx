// Clearing Labels keeps them in the Trash. The Trash view lists the
// entry with its scope and how many Labels it holds, and Restore puts
// them back, saying which messages kept a newer Label.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useStore } from '../../../state'
import { ImagesTab } from '../ImagesTab'
import { installFakeApi, json, type FakeApi } from '../../../test/fakeApi'

const CID = '42'
const CHAR = `/flist/character/${CID}`
const ENTRY = '1793400000-0123456789ab'

let fake: FakeApi
let trashedLabels: object[] = []

beforeEach(() => {
  trashedLabels = [
    {
      id: ENTRY,
      character: 'Lady Amber Blaise',
      partner: 'Daelan Envale',
      count: 3,
      deleted_at: 1793400000,
      deleted_by: 'mcp'
    }
  ]
  const slot = {
    payload: { _schema_version: 2, _overlay: [], images: [] },
    overlay: [],
    etag: 'e',
    unsavedDirty: false,
    saveStatus: 'idle' as const,
    saveError: null,
    lastSavedAt: null,
    materialised: true
  }
  useStore.setState({
    flistWorking: { [CID]: slot },
    flistActiveSetId: { [CID]: 'set42' },
    flistCharacterImages: { [CID]: { byId: {}, status: 'ready' } },
    flistRoster: []
  } as never)
  fake = installFakeApi()
    .on(`POST ${CHAR}/images/repair`, json({ repaired: false }))
    .on(`GET ${CHAR}/images`, json({ character_id: CID, images: [] }))
    .on(`GET ${CHAR}/image-references`, json({}))
    .on(`GET ${CHAR}/trash`, () =>
      json({ character_id: CID, items: [], backups: [], labels: trashedLabels })
    )
    .on(`POST ${CHAR}/trash/labels/restore`, () => {
      trashedLabels = []
      return json({
        restored: [{ id: ENTRY, restored: 2, skipped: ['aaaabbbbccccdddd'] }],
        not_found: []
      })
    })
    .on(`GET ${CHAR}/live`, json(null))
    .on(`GET ${CHAR}/snapshots`, json({ snapshots: [] }))
    .on(`GET ${CHAR}/zip-backups`, json({ character_id: CID, backups: [] }))
})

afterEach(() => {
  cleanup()
  fake.restore()
  vi.restoreAllMocks()
})

it('cleared Labels are listed with their scope and count, and restored', async () => {
  render(<ImagesTab characterId={CID} />)
  await waitFor(() =>
    expect(screen.getByTestId('flist-images-trash-toggle').textContent).toBe('Trash (1)')
  )
  fireEvent.click(screen.getByTestId('flist-images-trash-toggle'))

  const [row] = await screen.findAllByTestId('flist-trash-labels-item')
  expect(row.textContent).toContain('3 Labels')
  expect(row.textContent).toContain('Daelan Envale')
  expect(row.textContent).toContain('by a connected model')
  fireEvent.click(within(row).getByRole('button', { name: /restore/i }))

  await waitFor(() =>
    expect(fake.requestsTo(`POST ${CHAR}/trash/labels/restore`)[0]?.body).toEqual({
      ids: [ENTRY]
    })
  )
  const notice = await screen.findByText(/2 Labels are back/)
  expect(notice.textContent).toContain('1 message kept the Label it was given since')
  expect(screen.queryAllByTestId('flist-trash-labels-item')).toHaveLength(0)
})

it('a clear of every conversation says so', async () => {
  trashedLabels = [{ ...(trashedLabels[0] as object), partner: null, deleted_by: 'ui' }]
  render(<ImagesTab characterId={CID} />)
  await waitFor(() =>
    expect(screen.getByTestId('flist-images-trash-toggle').textContent).toBe('Trash (1)')
  )
  fireEvent.click(screen.getByTestId('flist-images-trash-toggle'))

  const [row] = await screen.findAllByTestId('flist-trash-labels-item')
  expect(row.textContent).toContain('every conversation')
})
