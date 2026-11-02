// Each Backup in the window's list says what it holds (Live or the
// Workbench) and why it was made. Backups from before the app recorded
// that say their source is unknown.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useStore } from '../../../state'
import { BackupsList } from '../BackupsList'
import type { FlistZipBackupEntry } from '../../../lib/api'

const CID = '42'

const MIGRATION_BACKUP = '2026-10-26T120000Z.zip'

function backup(
  filename: string,
  origin: Pick<FlistZipBackupEntry, 'kind' | 'source' | 'occasion'> &
    Partial<Pick<FlistZipBackupEntry, 'holds_profile'>>
): FlistZipBackupEntry {
  return {
    filename,
    created_at: 1793361600,
    size: 4096,
    name: null,
    holds_profile: true,
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
  backup(MIGRATION_BACKUP, {
    kind: 'unknown',
    source: 'workbench',
    occasion: 'migration',
    holds_profile: false
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
  const origin = rowOf(filename).querySelector('[data-testid="backup-origin"]')
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

function rowOf(filename: string): HTMLElement {
  return screen.getByTitle(new RegExp(filename.replace('.', '\\.')))
}

function menuFor(filename: string): string[] {
  fireEvent.contextMenu(rowOf(filename))
  return screen.getAllByRole('menuitem').map((item) => item.textContent ?? '')
}

it('offers a Backup that holds a profile for loading into the Workbench', () => {
  render(<BackupsList />)

  expect(menuFor('2026-10-30T120000Z.zip')).toEqual(
    expect.arrayContaining(['Browse backup', 'Load into Workbench…', 'Download ZIP…'])
  )
})

it('offers the Backup of the older files for download only, and says what it holds', () => {
  render(<BackupsList />)

  const offered = menuFor(MIGRATION_BACKUP)

  expect(offered).toContain('Download ZIP…')
  expect(offered).not.toContain('Load into Workbench…')
  expect(offered).not.toContain('Browse backup')
  expect(rowOf(MIGRATION_BACKUP).textContent).toMatch(
    /older copies from before the upgrade, kept so nothing is lost/
  )
})

it('shows why a Restore was turned down', () => {
  useStore.setState({
    flistRestoreRefusal: { [CID]: 'That Backup cannot be read.' }
  } as never)

  render(<BackupsList />)

  expect(screen.getByRole('alert').textContent).toMatch(
    /Couldn't load that Backup: That Backup cannot be read\./
  )
})
