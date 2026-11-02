// The Settings window's sections. Scheduled backups are gone, so there
// is no schedule or retention to set and no Backups section to show.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { api } from '../../../lib/api'
import { SettingsModal } from '../SettingsModal'

const SETTINGS = {
  fchat_data_dir: null,
  fchat_data_dir_effective: 'C:/fchat/data',
  fchat_data_dir_env_locked: false,
  labels: { threshold_chars: 200 },
  rag: {
    embed_model: 'm',
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
  },
  image_import_roots: []
}

beforeEach(() => {
  vi.spyOn(api, 'settingsGet').mockResolvedValue(SETTINGS as never)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('opens without a backup schedule and offers no Backups section', async () => {
  render(<SettingsModal onClose={() => {}} />)

  expect(await screen.findByText('General')).toBeTruthy()
  expect(screen.getByText('F-list')).toBeTruthy()
  expect(screen.queryByText('Backups')).toBeNull()
  expect(screen.queryByText(/retention/i)).toBeNull()
  expect(screen.queryByText(/scheduled/i)).toBeNull()
})
