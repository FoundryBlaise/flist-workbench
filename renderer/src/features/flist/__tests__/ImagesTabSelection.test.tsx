// Pool multi-select and the Trash, as the user asked for them: ten
// images picked with Shift-click go to the Trash with one confirm, the
// confirm says which are still used elsewhere, and they come back from
// the Trash view. An image on the profile goes to the Trash through the
// same request as one in the pool.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useStore } from '../../../state'
import { ImagesTab } from '../ImagesTab'
import { installFakeApi, json, type FakeApi } from '../../../test/fakeApi'

const CID = '42'
const IDS = Array.from({ length: 12 }, (_, i) => `local-0000000${i.toString(16)}`)

const IMAGES = `/flist/character/${CID}/images`
const TRASH = `/flist/character/${CID}/trash`

let fake: FakeApi
let trash: { trash_id: string; image_id: string; extension: string; filename: string; size: number; deleted_at: number; deleted_by: string; source_name: null }[] = []

beforeEach(() => {
  trash = []
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
  const byId = Object.fromEntries(
    // Newest first in the pool: give the first id the latest mtime.
    IDS.map((id, i) => [id, { extension: 'png', size: 1000 + i, added_at: 100 - i }])
  )
  useStore.setState({
    flistWorking: { [CID]: slot },
    flistCharacterImages: { [CID]: { byId, status: 'ready' } },
    flistRoster: []
  } as never)
  fake = installFakeApi()
    .on(`POST ${IMAGES}/repair`, json({ repaired: false }))
    .on(`GET ${IMAGES}`, json({ character_id: CID, images: [] }))
    .on(
      `GET /flist/character/${CID}/image-references`,
      json({
        [IDS[0]]: { workbench: false, live: true, backups: 0, newest_backup: null, migration_backup: false },
        [IDS[1]]: { workbench: false, live: true, backups: 0, newest_backup: null, migration_backup: false }
      })
    )
    .on(`POST ${IMAGES}/trash`, (req) => {
      const ids = (req.body as { image_ids: string[] }).image_ids
      trash = ids.map((id) => ({
        trash_id: id,
        image_id: id,
        extension: 'png',
        filename: `${id}.png`,
        size: 1000,
        deleted_at: 1,
        deleted_by: 'ui',
        source_name: null
      }))
      return json({ trashed: trash, not_found: [], off_gallery: [], etag: null })
    })
    .on(`POST ${TRASH}/put-back`, (req) => {
      const ids = (req.body as { image_ids: string[] }).image_ids
      trash = trash.filter((t) => !ids.includes(t.trash_id))
      return json({
        restored: ids.map((id) => ({ image_id: id, deduplicated: false, from: id })),
        not_found: [],
        conflicts: []
      })
    })
    .on(`GET ${TRASH}`, () => json({ character_id: CID, items: trash }))
})

afterEach(() => {
  cleanup()
  fake.restore()
  vi.restoreAllMocks()
})

function checkbox(row: HTMLElement): HTMLInputElement {
  return within(row).getByRole('checkbox') as HTMLInputElement
}

it('shift-click selects ten, Delete asks once, and the confirm says what is still in use', async () => {
  render(<ImagesTab characterId={CID} />)
  const rows = screen.getAllByTestId('flist-images-pool-item')
  expect(rows).toHaveLength(12)

  fireEvent.click(checkbox(rows[0]))
  fireEvent.click(checkbox(rows[9]), { shiftKey: true })
  expect(screen.getByTestId('flist-images-actionbar').textContent).toContain('10 selected')

  // The references arrive asynchronously; the warning needs them.
  await waitFor(() => expect(fake.requestsTo(`GET /flist/character/${CID}/image-references`).length > 0).toBe(true))
  fireEvent.keyDown(rows[0], { key: 'Delete' })

  const confirm = await screen.findByTestId('flist-images-delete-confirm')
  expect(confirm.textContent).toContain('Move 10 images to the Trash?')
  expect(within(confirm).getByTestId('flist-images-usage-notes').textContent).toContain(
    '2 of these are on the live profile'
  )
  fireEvent.click(within(confirm).getByTestId('flist-images-delete-confirm-btn'))

  await waitFor(() =>
    expect(fake.requestsTo(`POST ${IMAGES}/trash`).length > 0).toBe(true)
  )
  const sent = fake.requestsTo(`POST ${IMAGES}/trash`)[0].body as { image_ids: string[] }
  expect(sent.image_ids).toEqual(IDS.slice(0, 10))
  await waitFor(() => expect(screen.getAllByTestId('flist-images-pool-item')).toHaveLength(2))
})

it('plain click on a thumbnail still puts the image on the profile; ctrl-click selects', () => {
  render(<ImagesTab characterId={CID} />)
  const rows = screen.getAllByTestId('flist-images-pool-item')
  const thumb = (row: HTMLElement) => row.querySelector('button.flist-images-thumb') as HTMLElement

  fireEvent.click(thumb(rows[2]), { ctrlKey: true })
  expect(checkbox(rows[2]).checked).toBe(true)
  expect(useStore.getState().flistWorking[CID].payload.images).toEqual([])

  fireEvent.click(thumb(rows[3]))
  const images = useStore.getState().flistWorking[CID].payload.images as { image_id: string }[]
  expect(images.map((i) => i.image_id)).toEqual([IDS[3]])
})

it('add to gallery appends in the order the images were picked', () => {
  render(<ImagesTab characterId={CID} />)
  const rows = screen.getAllByTestId('flist-images-pool-item')
  fireEvent.click(checkbox(rows[4]))
  fireEvent.click(checkbox(rows[1]))
  fireEvent.click(checkbox(rows[7]))

  fireEvent.click(screen.getByTestId('flist-images-add-selected'))

  const images = useStore.getState().flistWorking[CID].payload.images as { image_id: string }[]
  expect(images.map((i) => i.image_id)).toEqual([IDS[4], IDS[1], IDS[7]])
})

it('filters narrow the pool and select-all takes only what they show', () => {
  useStore.setState((s) => ({
    flistCharacterImages: {
      [CID]: {
        status: 'ready',
        byId: {
          ...s.flistCharacterImages[CID].byId,
          [IDS[0]]: { extension: 'jpg', size: 2_500_000, added_at: 100 }
        }
      }
    }
  }))
  render(<ImagesTab characterId={CID} />)

  fireEvent.click(screen.getByTestId('flist-images-filter-over2mb'))
  expect(screen.getAllByTestId('flist-images-pool-item')).toHaveLength(1)
  fireEvent.click(screen.getByTestId('flist-images-select-all'))
  expect(screen.getByTestId('flist-images-actionbar').textContent).toContain('1 selected')

  fireEvent.click(screen.getByTestId('flist-images-filter-over2mb'))
  fireEvent.click(screen.getByTestId('flist-images-filter-png'))
  expect(screen.getAllByTestId('flist-images-pool-item')).toHaveLength(11)
})

it('the Trash view puts back what was trashed', async () => {
  trash = [
    {
      trash_id: 'gone1',
      image_id: 'gone1',
      extension: 'png',
      filename: 'gone1.png',
      size: 1000,
      deleted_at: 1,
      deleted_by: 'mcp',
      source_name: null
    }
  ]
  render(<ImagesTab characterId={CID} />)
  await waitFor(() =>
    expect(screen.getByTestId('flist-images-trash-toggle').textContent).toBe('Trash (1)')
  )
  fireEvent.click(screen.getByTestId('flist-images-trash-toggle'))

  const items = await screen.findAllByTestId('flist-images-trash-item')
  expect(items[0].textContent).toContain('by a connected model')
  fireEvent.click(checkbox(items[0]))
  fireEvent.click(screen.getByTestId('flist-images-trash-put-back'))

  await waitFor(() => expect(fake.requestsTo(`POST ${TRASH}/put-back`).length > 0).toBe(true))
  expect(fake.requestsTo(`POST ${TRASH}/put-back`)[0].body).toEqual({
    image_ids: ['gone1']
  })
  await waitFor(() => expect(screen.getByText('The Trash is empty.')).toBeTruthy())
})

it('two files trashed under one image id are listed and put back one by one', async () => {
  const entry = (trash_id: string, deleted_at: number) => ({
    trash_id,
    image_id: '47000002',
    extension: 'png',
    filename: `${trash_id}.png`,
    size: 1000,
    deleted_at,
    deleted_by: 'ui',
    source_name: null
  })
  trash = [entry('47000002-0a1b2c3d', 2), entry('47000002', 1)]
  render(<ImagesTab characterId={CID} />)
  await waitFor(() =>
    expect(screen.getByTestId('flist-images-trash-toggle').textContent).toBe('Trash (2)')
  )
  fireEvent.click(screen.getByTestId('flist-images-trash-toggle'))

  const items = await screen.findAllByTestId('flist-images-trash-item')
  expect(items).toHaveLength(2)
  fireEvent.click(checkbox(items[1]))
  expect(checkbox(items[0]).checked).toBe(false)
  fireEvent.click(screen.getByTestId('flist-images-trash-put-back'))

  await waitFor(() => expect(fake.requestsTo(`POST ${TRASH}/put-back`).length > 0).toBe(true))
  expect(fake.requestsTo(`POST ${TRASH}/put-back`)[0].body).toEqual({
    image_ids: ['47000002']
  })
  await waitFor(() => expect(screen.getAllByTestId('flist-images-trash-item')).toHaveLength(1))
})

it('a gallery image goes to the Trash through the same request as a pool image', async () => {
  const gallery = [
    { image_id: IDS[0], description: 'first', sort_order: 0 },
    { image_id: IDS[1], description: 'second', sort_order: 1 }
  ]
  useStore.setState((s) => ({
    flistWorking: {
      [CID]: {
        ...s.flistWorking[CID],
        payload: { _schema_version: 2, _overlay: ['images'], images: gallery },
        overlay: ['images']
      }
    }
  }))
  fake.on(`POST ${IMAGES}/trash`, (req) => {
    const ids = (req.body as { image_ids: string[] }).image_ids
    return json({
      trashed: ids.map((id) => ({ trash_id: id, image_id: id })),
      not_found: [],
      off_gallery: ids,
      etag: 'after-delete'
    })
  })
  render(<ImagesTab characterId={CID} />)
  expect(screen.getAllByTestId('flist-images-pool-item')).toHaveLength(10)

  fireEvent.click(screen.getAllByTestId('flist-images-gallery-trash')[0])
  const confirm = await screen.findByTestId('flist-images-delete-confirm')
  expect(confirm.textContent).toContain('Move 1 image to the Trash?')
  expect(confirm.textContent).toContain('off the profile')
  fireEvent.click(within(confirm).getByTestId('flist-images-delete-confirm-btn'))

  await waitFor(() => expect(fake.requestsTo(`POST ${IMAGES}/trash`)).toHaveLength(1))
  expect(fake.requestsTo(`POST ${IMAGES}/trash`)[0].body).toEqual({ image_ids: [IDS[0]] })
  // The sidecar took it off the gallery: the window shows that, and its
  // next save goes over the etag it was given, with nothing left to save.
  await waitFor(() => expect(useStore.getState().flistWorking[CID].etag).toBe('after-delete'))
  const slot = useStore.getState().flistWorking[CID]
  expect(slot.payload.images).toEqual([{ image_id: IDS[1], description: 'second', sort_order: 0 }])
  expect(slot.unsavedDirty).toBe(false)
  expect(useStore.getState().flistCharacterImages[CID].byId[IDS[0]]).toBeUndefined()
  expect(fake.requestsTo(/^PUT /)).toHaveLength(0)
  // It went to the Trash, not into the pool.
  expect(screen.getAllByTestId('flist-images-pool-item')).toHaveLength(10)
})

it('what was typed is saved before a gallery image goes to the Trash', async () => {
  useStore.setState((s) => ({
    flistWorking: {
      [CID]: {
        ...s.flistWorking[CID],
        payload: {
          _schema_version: 2,
          _overlay: ['images'],
          images: [{ image_id: IDS[0], description: 'typed', sort_order: 0 }]
        },
        overlay: ['images'],
        unsavedDirty: true
      }
    }
  }))
  fake
    .on(`PUT /flist/character/${CID}/workbench/payload`, json({ etag: 'saved' }))
    .on(`POST ${IMAGES}/trash`, (req) =>
      json({
        trashed: [],
        not_found: [],
        off_gallery: (req.body as { image_ids: string[] }).image_ids,
        etag: 'after-delete'
      })
    )

  await useStore.getState().flistTrashImages(CID, [IDS[0]])

  const order = fake.requests.map((r) => `${r.method} ${r.path.split('?')[0]}`)
  expect(order.indexOf(`PUT /flist/character/${CID}/workbench/payload`)).toBeGreaterThanOrEqual(0)
  expect(order.indexOf(`PUT /flist/character/${CID}/workbench/payload`)).toBeLessThan(
    order.indexOf(`POST ${IMAGES}/trash`)
  )
  expect(useStore.getState().flistWorking[CID].etag).toBe('after-delete')
})
