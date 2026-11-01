// Settings → Security tells the user whether the browser extension is
// paired, and lets them revoke the pairing. The renderer never holds
// the pairing token, so it asks the sidecar, which answers only
// `{paired}` (ADR 0002).

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  backups: { scheduled_interval_days: 7, scheduled_keep_last_n: 5 },
  image_import_roots: []
}

beforeEach(() => {
  vi.spyOn(api, 'settingsGet').mockResolvedValue(SETTINGS as never)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function openSecurity() {
  render(<SettingsModal onClose={() => {}} initialSection="security" />)
}

it('shows Paired with Rotate enabled when the sidecar says paired', async () => {
  vi.spyOn(api, 'pairingStatus').mockResolvedValue({ paired: true })
  openSecurity()

  expect(await screen.findByText('● Paired')).toBeTruthy()
  expect(
    (screen.getByTestId('settings-security-rotate') as HTMLButtonElement).disabled
  ).toBe(false)
})

it('shows Not paired with Rotate disabled when the sidecar says not paired', async () => {
  vi.spyOn(api, 'pairingStatus').mockResolvedValue({ paired: false })
  openSecurity()

  expect(await screen.findByText('○ Not paired')).toBeTruthy()
  expect(
    (screen.getByTestId('settings-security-rotate') as HTMLButtonElement).disabled
  ).toBe(true)
})

it('says the status is unavailable, with Rotate disabled, when it cannot be read', async () => {
  vi.spyOn(api, 'pairingStatus').mockRejectedValue(new Error('offline'))
  openSecurity()

  expect(await screen.findByText('Pairing status unavailable')).toBeTruthy()
  expect(screen.queryByText('● Paired')).toBeNull()
  expect(screen.queryByText('… Checking')).toBeNull()
  expect(
    (screen.getByTestId('settings-security-rotate') as HTMLButtonElement).disabled
  ).toBe(true)
})

it('rotating revokes the pairing and then shows Not paired', async () => {
  const status = vi
    .spyOn(api, 'pairingStatus')
    .mockResolvedValueOnce({ paired: true })
    .mockResolvedValue({ paired: false })
  const revoke = vi.spyOn(api, 'restoreRevokeToken').mockResolvedValue({ ok: true })
  openSecurity()

  await screen.findByText('● Paired')
  fireEvent.click(screen.getByTestId('settings-security-rotate'))
  await screen.findByText('○ Not paired')

  expect(revoke).toHaveBeenCalledTimes(1)
  expect(status).toHaveBeenCalledTimes(2)
  expect(
    (screen.getByTestId('settings-security-rotate') as HTMLButtonElement).disabled
  ).toBe(true)
})
