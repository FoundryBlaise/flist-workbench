// Settings → Labels, where "Reset all labels" lives, lists every
// cleared-Labels entry in the Trash: also those of a Log character with
// no Workbench, whose character Trash view does not exist. Restore puts
// them back; deleting for good asks first.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { api } from '../../../lib/api'
import { SettingsModal } from '../SettingsModal'

const SETTINGS = {
  fchat_data_dir: null,
  fchat_data_dir_effective: 'C:/fchat/data',
  fchat_data_dir_env_locked: false,
  labels: { threshold_chars: 200, defaults: { threshold_chars: 200 } },
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

const ENTRY = {
  id: '1793400000-0123456789ab',
  character: 'Corin Vale',
  partner: 'Daelan Envale',
  count: 4,
  deleted_at: 1793400000,
  deleted_by: 'ui'
}

beforeEach(() => {
  vi.spyOn(api, 'settingsGet').mockResolvedValue(SETTINGS as never)
  vi.spyOn(api, 'labelsRollup').mockResolvedValue({
    character_count: 1,
    total: 0,
    ic: 0,
    ooc: 0,
    manual: 0,
    unlabeled: 0
  } as never)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function openLabels() {
  render(<SettingsModal onClose={() => {}} initialSection="labels" />)
}

it('lists a Log-only character’s cleared Labels and restores them', async () => {
  let entries = [ENTRY]
  vi.spyOn(api, 'labelsTrashList').mockImplementation(async () => ({ labels: entries }))
  const restore = vi.spyOn(api, 'labelsTrashRestore').mockImplementation(async () => {
    entries = []
    return { restored: [{ id: ENTRY.id, restored: 4, skipped: [] }], not_found: [] }
  })
  openLabels()

  const section = await screen.findByTestId('labels-trash')
  const [row] = await within(section).findAllByTestId('flist-trash-labels-item')
  expect(row.textContent).toContain('4 Labels')
  expect(row.textContent).toContain('Daelan Envale with Corin Vale')
  fireEvent.click(within(row).getByRole('button', { name: /restore/i }))

  await waitFor(() => expect(restore).toHaveBeenCalledWith([ENTRY.id]))
  // The last entry is gone, and the message saying so stays visible.
  expect(await within(section).findByText('4 Labels are back.')).toBeTruthy()
  expect(within(section).queryAllByTestId('flist-trash-labels-item')).toHaveLength(0)
})

it('deleting an entry for good asks first', async () => {
  vi.spyOn(api, 'labelsTrashList').mockResolvedValue({ labels: [ENTRY] })
  const purge = vi
    .spyOn(api, 'labelsTrashPurge')
    .mockResolvedValue({ purged: [ENTRY.id], not_found: [] })
  openLabels()

  const [row] = await screen.findAllByTestId('flist-trash-labels-item')
  fireEvent.click(within(row).getByRole('button', { name: /delete for good/i }))
  expect(purge).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('flist-images-delete-confirm-btn'))

  await waitFor(() => expect(purge).toHaveBeenCalledWith([ENTRY.id]))
})

it('the reset confirm says where the copy can be restored', async () => {
  vi.spyOn(api, 'labelsTrashList').mockResolvedValue({ labels: [] })
  vi.spyOn(api, 'labelsRollup').mockResolvedValue({
    character_count: 1,
    total: 3,
    ic: 3,
    ooc: 0,
    manual: 0,
    unlabeled: 0
  } as never)
  const ask = vi.spyOn(window, 'confirm').mockReturnValue(false)
  openLabels()

  const reset = await screen.findByTestId('labels-reset-all')
  await waitFor(() => expect((reset as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(reset)

  expect(ask.mock.calls[0][0]).toContain('Cleared Labels')
  expect(ask.mock.calls[0][0]).not.toContain('character’s Trash')
})
