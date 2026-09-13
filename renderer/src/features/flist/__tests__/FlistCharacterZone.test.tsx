// The character zone shows two rows and only two: what F-list has, and
// the copy you edit.
//
// It used to list N named working sets with one of them active, plus a
// "+ New working set" button, plus rename / copy / delete on each row.
// Testers could not say what a working set was, how it related to the
// read-only row above it, or why backups were a third thing beside
// both. The arrangement was the problem, not the wording, so these
// tests pin the arrangement.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useStore } from '../../../state'
import { FlistCharacterZone } from '../FlistCharacterZone'

const CID = '42'

function seed(opts: { sets?: { id: string; name: string }[]; live?: boolean }) {
  const sets = (opts.sets ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    createdAt: 1000,
    updatedAt: 2000
  }))
  useStore.setState({
    flistSession: { active: true } as never,
    flistActiveCharacterId: CID,
    flistRoster: [{ id: CID, name: 'Lady Amber Blaise' }] as never,
    flistArchive: {
      [CID]: {
        live: opts.live === false ? null : { character: { name: 'Amber' } },
        lastPullAt: Math.floor(Date.now() / 1000) - 60,
        pullStatus: 'idle',
        zipBackups: [],
        zipBackupsStatus: 'idle'
      }
    } as never,
    flistSets: { [CID]: sets } as never,
    flistActiveSetId: { [CID]: sets.length ? sets[0].id : null },
    flistSetsStatus: { [CID]: 'ready' } as never
  })
}

beforeEach(() => {
  useStore.setState({ flistSetsStatus: {} as never })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('shows Live on F-List and marks it read-only', () => {
  seed({ sets: [{ id: 'bench1', name: 'Workbench' }] })
  render(<FlistCharacterZone />)

  const row = screen.getByTestId('flist-zone-from-flist')
  expect(row.textContent).toContain('Live on F-List')
  // The label alone did not tell testers it was untouchable.
  expect(row.textContent).toContain('read-only')
  expect(row.textContent).not.toContain('From F-list')
})

it('shows one Workbench row whatever the set is called', () => {
  // An archive from before the rename holds a set with the user's own
  // name on it. The row is the Workbench regardless — the name stays on
  // disk and stops being something the user has to think about.
  seed({ sets: [{ id: 'bench1', name: 'Experiling' }] })
  render(<FlistCharacterZone />)

  const row = screen.getByTestId('flist-zone-workbench')
  expect(row.textContent).toContain('Workbench')
  expect(row.textContent).not.toContain('Experiling')
  expect(row.textContent).toContain('your edits')
})

it('offers the Workbench before one exists, as a copy of F-List', () => {
  seed({ sets: [] })
  render(<FlistCharacterZone />)

  const row = screen.getByTestId('flist-zone-workbench')
  expect(row.textContent).toContain('starts as a copy of F-List')
})

it('has no way to create, name or delete a draft', () => {
  seed({ sets: [{ id: 'bench1', name: 'Workbench' }] })
  render(<FlistCharacterZone />)

  expect(screen.queryByTestId('flist-zone-newset')).toBeNull()
  expect(screen.queryByText(/New working set/i)).toBeNull()
  expect(screen.queryByText(/No working sets yet/i)).toBeNull()
})

it('shows no Workbench row for a character that was never pulled', () => {
  // There is nothing to copy from yet, so offering the bench would be
  // offering a dead end.
  seed({ sets: [], live: false })
  render(<FlistCharacterZone />)

  expect(screen.queryByTestId('flist-zone-workbench')).toBeNull()
})

it('hides extra drafts an older version left behind', () => {
  // The sidecar decides which one is the bench and logs the choice.
  // The window shows one row either way.
  seed({
    sets: [
      { id: 'bench1', name: 'Experiling' },
      { id: 'bench2', name: 'Copy_old' }
    ]
  })
  render(<FlistCharacterZone />)

  expect(screen.getAllByTestId('flist-zone-workbench')).toHaveLength(1)
  expect(screen.queryByText(/Copy_old/)).toBeNull()
})

it('backs the Workbench up without pulling from F-list', () => {
  // The bench holds edits that exist nowhere else. Pulling in order to
  // save them would move Live underneath them — and would fail offline,
  // for a backup that needs no network at all.
  seed({ sets: [{ id: 'bench1', name: 'Workbench' }] })
  const backup = vi.fn().mockResolvedValue(undefined)
  useStore.setState({ flistBackupCharacter: backup } as never)
  render(<FlistCharacterZone />)

  fireEvent.contextMenu(screen.getByTestId('flist-zone-workbench'))
  fireEvent.click(screen.getByText('Back up the Workbench'))

  expect(backup).toHaveBeenCalledWith('Lady Amber Blaise', { pull: false })
})

it('pulls first when backing up the read-only F-list row', () => {
  seed({ sets: [{ id: 'bench1', name: 'Workbench' }] })
  const backup = vi.fn().mockResolvedValue(undefined)
  useStore.setState({ flistBackupCharacter: backup } as never)
  render(<FlistCharacterZone />)

  fireEvent.contextMenu(screen.getByTestId('flist-zone-from-flist'))
  fireEvent.click(screen.getByText('Pull and back up'))

  expect(backup).toHaveBeenCalledWith('Lady Amber Blaise')
})
