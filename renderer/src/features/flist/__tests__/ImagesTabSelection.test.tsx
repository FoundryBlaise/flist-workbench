// Pool multi-select and the trash, as the user asked for them: ten
// images picked with Shift-click go to the trash with one confirm, the
// confirm says which are still used elsewhere, and they come back from
// the trash view.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useStore } from '../../../state'
import { ImagesTab } from '../ImagesTab'

const CID = '42'
const IDS = Array.from({ length: 12 }, (_, i) => `local-0000000${i.toString(16)}`)

type Call = { url: string; method: string; body: unknown }
let calls: Call[] = []
let trash: { image_id: string; extension: string; filename: string; size: number; deleted_at: number; deleted_by: string; source_name: null }[] = []

function json(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

beforeEach(() => {
  calls = []
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
    flistActiveSetId: { [CID]: 'set42' },
    flistSetWorking: { set42: slot },
    flistCharacterImages: { [CID]: { byId, status: 'ready' } },
    flistRoster: []
  } as never)
  ;(globalThis as { fetch?: unknown }).fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ url, method, body })
      if (url.endsWith('/images/repair')) return json({ repaired: false })
      if (url.endsWith('/image-references')) {
        return json({
          [IDS[0]]: { working_sets: [], live: true, snapshots: 1, newest_snapshot: '1.json' },
          [IDS[1]]: { working_sets: [], live: true, snapshots: 1, newest_snapshot: '1.json' }
        })
      }
      if (url.endsWith('/images/trash') && method === 'POST') {
        const ids = (body as { image_ids: string[] }).image_ids
        trash = ids.map((id) => ({
          image_id: id,
          extension: 'png',
          filename: `${id}.png`,
          size: 1000,
          deleted_at: 1,
          deleted_by: 'ui',
          source_name: null
        }))
        return json({ trashed: trash, not_found: [] })
      }
      if (url.endsWith('/trash/restore')) {
        const ids = (body as { image_ids: string[] }).image_ids
        trash = trash.filter((t) => !ids.includes(t.image_id))
        return json({
          restored: ids.map((id) => ({ image_id: id, deduplicated: false, from: id })),
          not_found: [],
          conflicts: []
        })
      }
      if (url.endsWith('/trash')) return json({ character_id: CID, items: trash })
      if (url.includes('/images')) {
        return json({ character_id: CID, images: [] })
      }
      return json({})
    }
  )
})

afterEach(() => {
  cleanup()
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
  await waitFor(() => expect(calls.some((c) => c.url.endsWith('/image-references'))).toBe(true))
  fireEvent.keyDown(rows[0], { key: 'Delete' })

  const confirm = await screen.findByTestId('flist-images-delete-confirm')
  expect(confirm.textContent).toContain('Move 10 images to the trash?')
  expect(within(confirm).getByTestId('flist-images-usage-notes').textContent).toContain(
    '2 of these are on the live profile'
  )
  fireEvent.click(within(confirm).getByTestId('flist-images-delete-confirm-btn'))

  await waitFor(() =>
    expect(calls.some((c) => c.url.endsWith('/images/trash') && c.method === 'POST')).toBe(true)
  )
  const sent = calls.find((c) => c.url.endsWith('/images/trash'))!.body as { image_ids: string[] }
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

it('the trash view restores what was trashed', async () => {
  trash = [
    {
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
  fireEvent.click(screen.getByTestId('flist-images-trash-restore'))

  await waitFor(() => expect(calls.some((c) => c.url.endsWith('/trash/restore'))).toBe(true))
  expect(calls.find((c) => c.url.endsWith('/trash/restore'))!.body).toEqual({
    image_ids: ['gone1']
  })
  await waitFor(() => expect(screen.getByText('The trash is empty.')).toBeTruthy())
})
