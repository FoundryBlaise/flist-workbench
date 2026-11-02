// Each Backup in the window's list says what it holds (Live or the
// Workbench) and why it was made. Backups from before the app recorded
// that say their source is unknown.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { useStore } from '../../../state'
import { BackupsList } from '../BackupsList'
import type { FlistZipBackupEntry } from '../../../lib/api'

const CID = '42'

function backup(
  filename: string,
  origin: Pick<FlistZipBackupEntry, 'kind' | 'source' | 'occasion'>
): FlistZipBackupEntry {
  return {
    filename,
    created_at: 1793361600,
    size: 4096,
    name: null,
    holds_profile: origin.occasion !== 'migration',
    ...origin
  }
}

const BACKUPS: FlistZipBackupEntry[] = [
  backup('2026-10-30T120000Z.zip', {
    kind: 'manual_single',
    source: 'workbench',
    occasion: 'manual'
  }),
  backup('2026-10-29T120000Z.zip', {
    kind: 'manual_bulk',
    source: 'live',
    occasion: 'backup-all'
  }),
  backup('2026-10-28T120000Z.zip', {
    kind: 'pre_upload',
    source: 'live',
    occasion: 'before-upload'
  }),
  backup('2026-10-27T120000Z.zip', {
    kind: 'manual_single',
    source: 'workbench',
    occasion: 'before-restore'
  }),
  backup('2026-10-26T120000Z.zip', {
    kind: 'unknown',
    source: 'workbench',
    occasion: 'migration'
  }),
  backup('2026-06-01T120000Z.zip', {
    kind: 'manual_single',
    source: 'unknown',
    occasion: null
  })
]

let saved: ReturnType<typeof useStore.getState>

beforeEach(() => {
  saved = useStore.getState()
  useStore.setState({
    flistActiveCharacterId: CID,
    flistArchive: {
      [CID]: {
        live: null,
        pullStatus: 'idle',
        zipBackups: BACKUPS,
        zipBackupsStatus: 'ready',
        zipBackupsError: null
      }
    }
  } as never)
})

afterEach(() => {
  cleanup()
  useStore.setState(saved, true)
})

function originOf(filename: string): string {
  const row = screen.getByTitle(new RegExp(filename.replace('.', '\\.')))
  const origin = row.querySelector('[data-testid="backup-origin"]')
  return origin?.textContent ?? ''
}

it('shows what each Backup holds and why it was made', () => {
  render(<BackupsList />)

  expect(originOf('2026-10-30T120000Z.zip')).toBe('Workbench · manual')
  expect(originOf('2026-10-29T120000Z.zip')).toBe('Live · Back up all')
  expect(originOf('2026-10-28T120000Z.zip')).toBe('Live · before Upload')
  expect(originOf('2026-10-27T120000Z.zip')).toBe('Workbench · before Restore')
  expect(originOf('2026-10-26T120000Z.zip')).toBe('Workbench · migration')
})

it('says the source of an older Backup is unknown', () => {
  render(<BackupsList />)

  expect(originOf('2026-06-01T120000Z.zip')).toBe('Source unknown')
})
