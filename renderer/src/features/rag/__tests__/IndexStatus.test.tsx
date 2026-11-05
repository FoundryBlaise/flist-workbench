// The Index status in Settings. A model can ingest or wipe the Index
// over MCP while the window shows it; the sidecar announces that with
// `index-changed`, and the view has to read the status again instead
// of showing what it read when it opened.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useStore } from '../../../state'
import { api, RefusalError } from '../../../lib/api'
import type { IndexStatus as Status } from '../../../state/slices/settings'
import { IndexStatus } from '../IndexStatus'

const IDLE: Status = {
  embed_model: 'some-model',
  embed_dimension: 4,
  last_ingest_at: 1_700_000_000,
  busy: false,
  job: null,
  chunk_count: 0
}

const INGESTING: Status = {
  ...IDLE,
  busy: true,
  chunk_count: null,
  job: {
    id: 'job1',
    kind: 'ingest',
    resource: 'index',
    state: 'running',
    params: {},
    progress: {},
    result: null,
    error: null,
    cancel_requested: false,
    created_at: 1_700_000_000,
    finished_at: null
  }
}

beforeEach(() => {
  useStore.setState({ indexRevision: 0, indexStatus: null, indexStatusError: null })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('reads the status again when the Index changes', async () => {
  vi.spyOn(api, 'ragStatus')
    .mockResolvedValueOnce(IDLE)
    .mockResolvedValueOnce(INGESTING)
    .mockResolvedValueOnce({ ...IDLE, chunk_count: 1234 })
  render(<IndexStatus />)
  expect((await screen.findByTestId('rag-index-status')).textContent).toContain(
    'No chunks indexed yet'
  )

  // What applyWorkbenchEvent does on `index-changed`.
  act(() => useStore.getState().noteIndexChanged())
  expect((await screen.findByText(/being updated/)).textContent).toContain('ingest')

  act(() => useStore.getState().noteIndexChanged())
  expect(await screen.findByText('1,234')).toBeTruthy()
  expect(api.ragStatus).toHaveBeenCalledTimes(3)
})

it('says busy rather than zero chunks while a job holds the Index', async () => {
  vi.spyOn(api, 'ragStatus').mockResolvedValue(INGESTING)
  render(<IndexStatus />)

  const status = await screen.findByTestId('rag-index-status')
  expect(status.textContent).toContain('being updated')
  expect(status.textContent).not.toContain('No chunks')
})

it('shows an Index that cannot be read as an error, not as empty', async () => {
  vi.spyOn(api, 'ragStatus').mockRejectedValue(
    new RefusalError('index_unreadable', 500, 'The Index could not be read: boom', {})
  )
  render(<IndexStatus />)

  const status = await screen.findByTestId('rag-index-status')
  expect(status.textContent).toContain('could not be read')
  expect(status.textContent).not.toContain('No chunks')
})
