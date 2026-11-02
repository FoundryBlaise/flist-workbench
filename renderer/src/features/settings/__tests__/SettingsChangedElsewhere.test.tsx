// A model can change settings over MCP while Settings is open. The
// sidecar announces it (`settings-changed`); the open window shows the
// new values without being reopened, and keeps what the user is typing.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api } from '../../../lib/api'
import { useStore } from '../../../state'
import { SettingsModal } from '../SettingsModal'

const RAG = {
  embed_model: 'org/m',
  top_k: 8,
  rerank_candidates: 40,
  neighbors: 1,
  rerank_model: 'disabled',
  rerank_min_ratio: 0,
  hybrid_enabled: false,
  hybrid_bm25_candidates: 40,
  chunk_max_chars: 2000,
  chunk_soft_split_chars: 1500,
  chunk_overlap_msgs: 1
}

const SETTINGS = {
  fchat_data_dir: null,
  fchat_data_dir_effective: 'C:/fchat/data',
  fchat_data_dir_env_locked: false,
  labels: { threshold_chars: 200, defaults: { threshold_chars: 200 } },
  rag: { ...RAG, defaults: RAG },
  image_import_roots: []
}

beforeEach(() => {
  vi.spyOn(api, 'settingsGet').mockResolvedValueOnce(SETTINGS as never)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const input = (id: string) => screen.getByTestId(id) as HTMLInputElement

it('shows a setting a model changed while Settings is open', async () => {
  render(<SettingsModal onClose={() => {}} initialSection="retrieval" />)
  await screen.findByTestId('rag-top-k-input')
  // The user is halfway through changing another field.
  fireEvent.change(input('rag-neighbors-input'), { target: { value: '3' } })

  vi.spyOn(api, 'settingsGet').mockResolvedValueOnce({
    ...SETTINGS,
    rag: { ...SETTINGS.rag, top_k: 50, neighbors: 2 }
  } as never)
  act(() => useStore.getState().noteSettingsChanged(['rag.top_k', 'rag.neighbors']))

  await waitFor(() => expect(input('rag-top-k-input').value).toBe('50'))
  expect(input('rag-neighbors-input').value).toBe('3')
})
