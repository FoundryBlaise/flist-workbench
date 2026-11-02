// A deleted Backup lands in the Trash beside the images. The Trash view
// lists it under its user-set name and restores it, and the restored
// Backup is back in the Backup list.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useStore } from '../../../state'
import { ImagesTab } from '../ImagesTab'
import { installFakeApi, json, type FakeApi } from '../../../test/fakeApi'

const CID = '42'
const CHAR = `/flist/character/${CID}`
const FILE = '2026-10-30T120000Z.zip'

const BACKUP_ROW = {
  filename: FILE,
  created_at: 1793361600,
  size: 4096,
  kind: 'manual_single',
  name: 'Before the big rewrite'
}

let fake: FakeApi
let trashedBackups: object[] = []
let backups: object[] = []

beforeEach(() => {
  trashedBackups = [
    {
      id: FILE,
      filename: FILE,
      name: 'Before the big rewrite',
      size: 4096,
      deleted_at: 1793400000,
      deleted_by: 'ui'
    }
  ]
  backups = []
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
    flistCharacterImages: { [CID]: { byId: {}, status: 'ready' } },
    flistRoster: []
  } as never)
  fake = installFakeApi()
    .on(`POST ${CHAR}/images/repair`, json({ repaired: false }))
    .on(`GET ${CHAR}/images`, json({ character_id: CID, images: [] }))
    .on(`GET ${CHAR}/image-references`, json({}))
    .on(`GET ${CHAR}/trash`, () =>
      json({ character_id: CID, items: [], backups: trashedBackups })
    )
    .on(`POST ${CHAR}/trash/backups/restore`, () => {
      trashedBackups = []
      backups = [BACKUP_ROW]
      return json({ restored: [FILE], not_found: [], conflicts: [] })
    })
    .on(`GET ${CHAR}/live`, json(null))
    .on(`GET ${CHAR}/zip-backups`, () => json({ character_id: CID, backups }))
})

afterEach(() => {
  cleanup()
  fake.restore()
  vi.restoreAllMocks()
})

it('a trashed Backup is listed under its name and restored to the Backup list', async () => {
  render(<ImagesTab characterId={CID} />)
  await waitFor(() =>
    expect(screen.getByTestId('flist-images-trash-toggle').textContent).toBe('Trash (1)')
  )
  fireEvent.click(screen.getByTestId('flist-images-trash-toggle'))

  const [row] = await screen.findAllByTestId('flist-trash-backup-item')
  expect(row.textContent).toContain('Before the big rewrite')
  fireEvent.click(within(row).getByRole('button', { name: /restore/i }))

  await waitFor(() =>
    expect(fake.requestsTo(`POST ${CHAR}/trash/backups/restore`)[0]?.body).toEqual({
      ids: [FILE]
    })
  )
  await waitFor(() =>
    expect(useStore.getState().flistArchive[CID]?.zipBackups).toEqual([BACKUP_ROW])
  )
  expect(screen.queryAllByTestId('flist-trash-backup-item')).toHaveLength(0)
  // The list is empty now; what happened is still said.
  expect(
    await screen.findByText('Before the big rewrite is back in the Backup list.')
  ).toBeTruthy()
})
