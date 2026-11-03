// A running Pull or Back up all offers Cancel, which stops its job in
// the sidecar by id. Closing the view does not: the job runs on.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useStore } from '../../../state'
import { installFakeApi, json, type FakeApi } from '../../../test/fakeApi'
import { BackupAllBanner } from '../BackupAllBanner'
import { FlistCharacterZone } from '../FlistCharacterZone'

const CID = '42'

let fake: FakeApi

beforeEach(() => {
  fake = installFakeApi()
  fake.on(/^DELETE \/jobs\//, json({}))
})

afterEach(() => {
  cleanup()
  fake.restore()
  vi.restoreAllMocks()
})

function seedPull(pullJobId: string | null) {
  useStore.setState({
    flistSession: { active: true } as never,
    flistActiveCharacterId: CID,
    flistRoster: [{ id: CID, name: 'Lady Amber Blaise', on_account: true }] as never,
    flistArchive: {
      [CID]: {
        live: null,
        pullStatus: 'running',
        pullStage: 'images',
        pullProgress: { done: 1, total: 3 },
        pullJobId
      }
    } as never,
    flistWorkbenchInfo: {},
    flistViewingLive: {},
    flistWorking: {}
  })
}

function seedBackupAll(jobId: string | null) {
  useStore.setState({
    flistBackupAllStatus: {
      phase: 'running',
      total: 3,
      done: 1,
      saved: 1,
      unchanged: 0,
      failed: 0,
      currentName: 'Lady Amber Blaise',
      errorMessage: null,
      jobId
    }
  })
}

it('a running Pull offers Cancel, which cancels its job', async () => {
  seedPull('j1')
  render(<FlistCharacterZone />)

  fireEvent.click(screen.getByTestId('flist-zone-pull-cancel'))

  await vi.waitFor(() => expect(fake.requestsTo('DELETE /jobs/j1')).toHaveLength(1))
})

it('a Pull without a job yet offers no Cancel', () => {
  seedPull(null)
  render(<FlistCharacterZone />)

  expect(screen.queryByTestId('flist-zone-pull-cancel')).toBeNull()
})

it('a running Back up all offers Cancel, which cancels its job', async () => {
  seedBackupAll('b1')
  render(<BackupAllBanner />)

  fireEvent.click(screen.getByTestId('backup-all-cancel'))

  await vi.waitFor(() => expect(fake.requestsTo('DELETE /jobs/b1')).toHaveLength(1))
})

it('a cancelled Back up all says so and counts what it wrote', () => {
  useStore.setState({
    flistBackupAllStatus: {
      phase: 'cancelled',
      total: 3,
      done: 1,
      saved: 1,
      unchanged: 0,
      failed: 0,
      currentName: null,
      errorMessage: null,
      jobId: null
    }
  })
  render(<BackupAllBanner />)

  const banner = screen.getByTestId('backup-all-banner')
  expect(banner.textContent).toContain('cancelled')
  expect(banner.textContent).toContain('1 backup')
  expect(screen.queryByTestId('backup-all-cancel')).toBeNull()
})
