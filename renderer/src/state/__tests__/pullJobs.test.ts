// Pull and Back up all run as jobs in the sidecar: the window follows a
// job's progress stream, cancels it by id, and picks a running one up
// again after a reload. Against a fake sidecar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { installFakeApi, json, sse, type FakeApi } from '../../test/fakeApi'

const CID = '5150'
const NAME = 'Corin Ashvale'

let fake: FakeApi

function job(id: string, kind: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind,
    resource: kind === 'pull' ? `character:${CID}` : 'character',
    state: 'running',
    params: kind === 'pull' ? { name: NAME } : {},
    progress: {},
    result: null,
    error: null,
    cancel_requested: false,
    created_at: 0,
    finished_at: null,
    ...extra
  }
}

const IDLE_BACKUP_ALL = {
  phase: 'idle' as const,
  total: 0,
  done: 0,
  saved: 0,
  unchanged: 0,
  failed: 0,
  currentName: null,
  errorMessage: null,
  jobId: null
}

beforeEach(() => {
  fake = installFakeApi()
  // What a finished Pull reloads.
  fake
    .on(`GET /flist/character/${CID}/live`, json({ name: NAME, fetched_at: 1 }))
    .on(`GET /flist/character/${CID}/zip-backups`, json({ character_id: CID, backups: [] }))
    .on(`GET /flist/character/${CID}/images`, json({ images: [] }))
    .on('GET /flist/characters', json({ characters: [] }))
  useStore.setState({
    flistArchive: {},
    flistRoster: [
      {
        id: Number(CID),
        name: NAME,
        on_account: true,
        has_archive: true,
        last_pulled_at: null
      } as never
    ],
    flistBackupAllStatus: { ...IDLE_BACKUP_ALL }
  })
})

afterEach(() => {
  fake.restore()
  vi.restoreAllMocks()
})

describe('a Pull', () => {
  it('keeps its job id while it runs, and Cancel stops that job', async () => {
    fake.on(
      `POST /flist/character/${encodeURIComponent(NAME)}/pull`,
      sse(['job', job('j1', 'pull')], ['ticket', {}], ['images', { total: 3 }])
    )
    fake.on('DELETE /jobs/j1', json(job('j1', 'pull', { cancel_requested: true })))

    await useStore.getState().flistPullCharacter(NAME, CID)
    expect(useStore.getState().flistArchive[CID].pullJobId).toBe('j1')
    expect(useStore.getState().flistArchive[CID].pullStatus).toBe('running')

    await useStore.getState().flistCancelPull(CID)

    expect(fake.requestsTo('DELETE /jobs/j1')).toHaveLength(1)
  })

  it('ends quietly when it was cancelled', async () => {
    fake.on(
      `POST /flist/character/${encodeURIComponent(NAME)}/pull`,
      sse(['job', job('j1', 'pull')], ['images', { total: 3 }], ['cancelled', {}])
    )

    await useStore.getState().flistPullCharacter(NAME, CID)

    const slot = useStore.getState().flistArchive[CID]
    expect(slot.pullStatus).toBe('idle')
    expect(slot.pullError).toBeNull()
    expect(slot.pullJobId).toBeNull()
  })
})

describe('Back up all', () => {
  it('keeps its job id while it runs, and Cancel stops that job', async () => {
    fake.on(
      'POST /flist/backup-all',
      sse(['job', job('b1', 'backup-all')], ['start', { total: 2 }], ['character', { name: NAME, status: 'fetching' }])
    )
    fake.on('DELETE /jobs/b1', json(job('b1', 'backup-all', { cancel_requested: true })))

    await useStore.getState().flistBackupAll()
    expect(useStore.getState().flistBackupAllStatus.jobId).toBe('b1')

    await useStore.getState().flistCancelBackupAll()

    expect(fake.requestsTo('DELETE /jobs/b1')).toHaveLength(1)
  })

  it('says it was cancelled when it was', async () => {
    fake.on(
      'POST /flist/backup-all',
      sse(['job', job('b1', 'backup-all')], ['start', { total: 2 }], ['cancelled', {}])
    )

    await useStore.getState().flistBackupAll()

    const status = useStore.getState().flistBackupAllStatus
    expect(status.phase).toBe('cancelled')
    expect(status.jobId).toBeNull()
  })
})

describe('a reopened window', () => {
  it('follows the Pull and Back up all the sidecar is still running', async () => {
    fake.on(
      'GET /jobs',
      json({ jobs: [job('j9', 'pull'), job('b9', 'backup-all'), job('old', 'pull', { state: 'done' })] })
    )
    fake.on(
      'GET /jobs/j9/events',
      sse(
        ['job', job('j9', 'pull')],
        ['images', { total: 2 }],
        ['image', { index: 1, total: 2, image_id: '1', ok: true }]
      )
    )
    fake.on(
      'GET /jobs/b9/events',
      sse(['job', job('b9', 'backup-all')], ['start', { total: 4 }], ['character', { name: NAME, status: 'fetching' }])
    )

    await useStore.getState().flistResumeJobs()

    await vi.waitFor(() => {
      const slot = useStore.getState().flistArchive[CID]
      expect(slot?.pullJobId).toBe('j9')
      expect(slot?.pullProgress).toEqual({ done: 1, total: 2 })
    })
    await vi.waitFor(() => {
      const status = useStore.getState().flistBackupAllStatus
      expect(status.phase).toBe('running')
      expect(status.jobId).toBe('b9')
      expect(status.total).toBe(4)
      expect(status.currentName).toBe(NAME)
    })
    expect(fake.requestsTo('GET /jobs/old/events')).toEqual([])
  })
})

/** The sidecar's refusal while a job holds the character. */
function busy(kind: 'pull' | 'backup-all', jobId = 'other') {
  return json(
    {
      code: 'character_busy',
      message: `The character is busy: a ${kind} job (${jobId}) is running. Wait for it to finish (get_job) or cancel it (cancel_job), then try again.`,
      details: { job_id: jobId, kind, resource: kind === 'pull' ? `character:${CID}` : 'character' }
    },
    409
  )
}

describe('a busy character', () => {
  it('a Pull refused while Back up all runs says so plainly', async () => {
    fake.on(`POST /flist/character/${encodeURIComponent(NAME)}/pull`, busy('backup-all'))

    await useStore.getState().flistPullCharacter(NAME, CID)

    const slot = useStore.getState().flistArchive[CID]
    expect(slot.pullStatus).toBe('error')
    expect(slot.pullError).toMatch(/^Back up all is running/)
    expect(slot.pullError).not.toMatch(/HTTP|job|cancel_job/)
  })

  it('a Pull refused while another Pull of it runs says so plainly', async () => {
    fake.on(`POST /flist/character/${encodeURIComponent(NAME)}/pull`, busy('pull'))

    await useStore.getState().flistPullCharacter(NAME, CID)

    const slot = useStore.getState().flistArchive[CID]
    expect(slot.pullError).toMatch(/already being pulled/)
    expect(slot.pullError).not.toMatch(/HTTP|job|cancel_job/)
  })

  it('Back up all refused while a Pull runs says so plainly', async () => {
    fake.on('POST /flist/backup-all', busy('pull'))

    await useStore.getState().flistBackupAll()

    const status = useStore.getState().flistBackupAllStatus
    expect(status.phase).toBe('error')
    expect(status.errorMessage).toMatch(/Pull is running/)
    expect(status.errorMessage).not.toMatch(/HTTP|job|cancel_job/)
  })

  it('Refresh all skips a busy character instead of marking it failed', async () => {
    const OTHER_CID = '5151'
    const OTHER = 'Daelan Envale'
    useStore.setState({
      flistSession: { active: true, account: 'a' } as never,
      flistRoster: [
        { id: Number(CID), name: NAME, on_account: true, has_archive: true, last_pulled_at: null } as never,
        { id: Number(OTHER_CID), name: OTHER, on_account: true, has_archive: true, last_pulled_at: null } as never
      ]
    })
    fake.on(`POST /flist/character/${encodeURIComponent(NAME)}/pull`, busy('pull'))
    fake.on(
      `POST /flist/character/${encodeURIComponent(OTHER)}/pull`,
      sse(['job', job('j2', 'pull')], ['done', { character_id: OTHER_CID, name: OTHER, image_count: 0, image_failed: 0 }])
    )
    fake
      .on(`GET /flist/character/${OTHER_CID}/live`, json({ name: OTHER, fetched_at: 1 }))
      .on(`GET /flist/character/${OTHER_CID}/zip-backups`, json({ character_id: OTHER_CID, backups: [] }))
      .on(`GET /flist/character/${OTHER_CID}/images`, json({ images: [] }))

    await useStore.getState().flistRefreshAllAccount()

    const skipped = useStore.getState().flistArchive[CID]
    expect(skipped.pullStatus).not.toBe('error')
    expect(skipped.pullError).toBeNull()
    expect(skipped.pullStage).toBe('busy')
    expect(useStore.getState().flistArchive[OTHER_CID].pullStatus).toBe('done')
  })
})

it('Refresh all leaves alone a character whose Pull this window is following', async () => {
  useStore.setState({
    flistSession: { active: true, account: 'a' } as never,
    flistArchive: {
      [CID]: { live: null, pullStatus: 'running', pullStage: 'images', pullJobId: 'j1' } as never
    }
  })

  await useStore.getState().flistRefreshAllAccount()

  expect(fake.requestsTo(`POST /flist/character/${encodeURIComponent(NAME)}/pull`)).toEqual([])
  expect(useStore.getState().flistArchive[CID]).toMatchObject({ pullStatus: 'running', pullJobId: 'j1' })
})
