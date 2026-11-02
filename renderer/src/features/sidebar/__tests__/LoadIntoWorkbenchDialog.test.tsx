// Restoring a Backup always keeps the Workbench it replaces as a Backup
// first (ADR 0003), so the confirm dialog asks only "load or not" and
// says the Workbench is kept.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LoadIntoWorkbenchDialog } from '../LoadIntoWorkbenchDialog'
import { installFakeApi, json, type FakeApi } from '../../../test/fakeApi'
import type { FlistZipBackupEntry } from '../../../lib/api'

const BACKUP: FlistZipBackupEntry = {
  filename: '2026-10-30T120000Z.zip',
  created_at: 1793361600,
  size: 4096,
  name: null,
  kind: 'manual_single',
  source: 'workbench',
  occasion: 'manual'
}

let fake: FakeApi

beforeEach(() => {
  fake = installFakeApi()
  fake.on(
    'GET /flist/character/42/workbench/load-backup/preflight',
    json({
      filename: BACKUP.filename,
      backup_created_at: BACKUP.created_at,
      live_pulled_at: null,
      live_diverged: false,
      workbench_has_edits: true
    })
  )
})

afterEach(() => {
  cleanup()
  fake.restore()
})

it('offers Cancel and Load only, and says the Workbench is kept as a Backup first', () => {
  const onConfirm = vi.fn()
  render(
    <LoadIntoWorkbenchDialog
      characterId="42"
      backup={BACKUP}
      onCancel={() => {}}
      onConfirm={onConfirm}
    />
  )

  expect(screen.queryByTestId('load-wb-backup-first')).toBeNull()
  expect(screen.getByTestId('load-into-workbench').textContent).toMatch(
    /saved as a Backup first/
  )

  fireEvent.click(screen.getByTestId('load-wb-load'))
  expect(onConfirm).toHaveBeenCalledTimes(1)
})
