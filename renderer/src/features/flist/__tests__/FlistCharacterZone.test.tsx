// The character zone shows two rows and only two: what F-list has, and
// the copy you edit.
//
// It used to list several named drafts with one of them active, plus a
// button to make another, plus rename / copy / delete / export on each
// row and an import beside them. Testers could not say what one was,
// how it related to the read-only row above it, or why Backups were a
// third thing beside both. The arrangement was the problem, not the
// wording, so these tests pin the arrangement.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useStore } from '../../../state'
import { FlistCharacterZone } from '../FlistCharacterZone'

const CID = '42'

function seed(opts: { workbench?: boolean; live?: boolean; viewingLive?: boolean }) {
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
    flistWorkbenchInfo: { [CID]: opts.workbench === false ? null : { updatedAt: 2000 } },
    flistViewingLive: { [CID]: opts.viewingLive ?? false },
    flistWorking: {}
  })
}

beforeEach(() => {
  useStore.setState({ flistWorkbenchInfo: {}, flistViewingLive: {} })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('shows Live on F-List and marks it read-only', () => {
  seed({})
  render(<FlistCharacterZone />)

  const row = screen.getByTestId('flist-zone-from-flist')
  expect(row.textContent).toContain('Live on F-List')
  // The label alone did not tell testers it was untouchable.
  expect(row.textContent).toContain('read-only')
  expect(row.textContent).not.toContain('From F-list')
})

it('shows one Workbench row with your edits', () => {
  seed({})
  render(<FlistCharacterZone />)

  const row = screen.getByTestId('flist-zone-workbench')
  expect(row.textContent).toContain('Workbench')
  expect(row.textContent).toContain('your edits')
})

it('offers the Workbench before one exists, as a copy of F-List', () => {
  seed({ workbench: false })
  render(<FlistCharacterZone />)

  const row = screen.getByTestId('flist-zone-workbench')
  expect(row.textContent).toContain('starts as a copy of F-List')
})

it('has no way to create, name, copy, delete, import or export a Workbench', () => {
  seed({})
  render(<FlistCharacterZone />)

  expect(screen.queryByTestId('flist-zone-newset')).toBeNull()
  expect(screen.queryByTestId('flist-zone-import')).toBeNull()
  expect(screen.queryByText(/Import/)).toBeNull()

  fireEvent.contextMenu(screen.getByTestId('flist-zone-workbench'))
  const menu = screen.getByRole('menu')
  expect(menu.textContent).not.toMatch(/Export|Import|Rename|Duplicate|Copy|Delete/)
})

it('marks the row the window shows, and switches without asking the sidecar', () => {
  seed({ viewingLive: false })
  const showLive = vi.fn().mockResolvedValue(undefined)
  const openWorkbench = vi.fn().mockResolvedValue(undefined)
  useStore.setState({ flistShowLive: showLive, flistOpenWorking: openWorkbench } as never)
  render(<FlistCharacterZone />)

  expect(screen.getByTestId('flist-zone-workbench').className).toContain('is-active')
  expect(screen.getByTestId('flist-zone-from-flist').className).not.toContain('is-active')

  fireEvent.click(screen.getByTestId('flist-zone-from-flist'))
  expect(showLive).toHaveBeenCalledWith(CID)
  // Already showing the Workbench: nothing to do.
  fireEvent.click(screen.getByTestId('flist-zone-workbench'))
  expect(openWorkbench).not.toHaveBeenCalled()
})

it('goes back to the Workbench from Live', () => {
  seed({ viewingLive: true })
  const openWorkbench = vi.fn().mockResolvedValue(undefined)
  useStore.setState({ flistOpenWorking: openWorkbench } as never)
  render(<FlistCharacterZone />)

  expect(screen.getByTestId('flist-zone-from-flist').className).toContain('is-active')
  expect(screen.getByTestId('flist-zone-workbench').className).not.toContain('is-active')

  fireEvent.click(screen.getByTestId('flist-zone-workbench'))
  expect(openWorkbench).toHaveBeenCalledWith(CID)
})

it('shows no Workbench row for a character that was never pulled', () => {
  // There is nothing to copy from yet, so offering the bench would be
  // offering a dead end.
  seed({ workbench: false, live: false })
  render(<FlistCharacterZone />)

  expect(screen.queryByTestId('flist-zone-workbench')).toBeNull()
})

it('backs the Workbench up without pulling from F-list', () => {
  // The bench holds edits that exist nowhere else. Pulling in order to
  // save them would move Live underneath them — and would fail offline,
  // for a backup that needs no network at all.
  seed({})
  const backup = vi.fn().mockResolvedValue(undefined)
  useStore.setState({ flistBackupCharacter: backup } as never)
  render(<FlistCharacterZone />)

  fireEvent.contextMenu(screen.getByTestId('flist-zone-workbench'))
  fireEvent.click(screen.getByText('Back up the Workbench'))

  expect(backup).toHaveBeenCalledWith('Lady Amber Blaise', { pull: false })
})

it('pulls first when backing up the read-only F-list row', () => {
  seed({})
  const backup = vi.fn().mockResolvedValue(undefined)
  useStore.setState({ flistBackupCharacter: backup } as never)
  render(<FlistCharacterZone />)

  fireEvent.contextMenu(screen.getByTestId('flist-zone-from-flist'))
  fireEvent.click(screen.getByText('Pull and back up'))

  expect(backup).toHaveBeenCalledWith('Lady Amber Blaise')
})

it('offers a way to the character on f-list.net', () => {
  // Workbench never publishes, so every finished profile ends with a
  // trip to the site — and finding that page meant copying a character
  // id out of a URL by hand.
  seed({})
  const openExternal = vi.fn()
  ;(window as unknown as { workbench: unknown }).workbench = { openExternal }
  render(<FlistCharacterZone />)

  fireEvent.click(screen.getByTestId('flist-zone-openflist'))

  expect(openExternal).toHaveBeenCalledWith(
    'https://www.f-list.net/character_edit.php?id=42'
  )
})

it('falls back to a plain window open outside Electron', () => {
  seed({})
  ;(window as unknown as { workbench?: unknown }).workbench = undefined
  const open = vi.spyOn(window, 'open').mockImplementation(() => null)
  render(<FlistCharacterZone />)

  fireEvent.click(screen.getByTestId('flist-zone-openflist'))

  expect(open).toHaveBeenCalledWith(
    'https://www.f-list.net/character_edit.php?id=42',
    '_blank',
    'noreferrer'
  )
})
