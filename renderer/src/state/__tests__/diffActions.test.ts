// The Diff tab compares the Workbench with Live (the default) or with
// one of the character's Backups. Seam: the store, against the fake
// sidecar.
//
// - the picker's entries: Live, then the Backups with their source and
//   occasion, read from the Backup list the archive load fetched
// - choosing a Backup reads that Backup's payload
// - "reset to this" resets to Live, or Restores the chosen Backup

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectDiffSources, useStore } from '../../state'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'
import {
  archiveEntry,
  livePayload,
  payloadRead,
  workbenchPayload,
  workingSlot
} from '../../test/payloads'

let fake: FakeApi

const BENCH = '/flist/character/99/workbench/payload'
const SAVE = `PUT ${BENCH}`
const BACKUPS = 'GET /flist/character/99/zip-backups'
const OLDER = '2026-10-01T090000Z.zip'
const NEWER = '2026-10-30T120000Z.zip'
const backupPayloadRoute = (filename: string) =>
  `GET /flist/character/99/zip-backups/${filename}/payload`

const descOf = (body: unknown) =>
  ((body as { character?: { description?: string } } | undefined)?.character ?? {}).description

/** One row of the sidecar's Backup list. */
function backupRow(
  filename: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    filename,
    created_at: 1790000000,
    size: 2048,
    kind: 'manual_single',
    source: 'workbench',
    occasion: 'manual',
    holds_profile: true,
    name: null,
    ...overrides
  }
}

/** The sidecar's answer to reading a Backup's payload. */
function backupRead(filename: string, description: string) {
  return json({
    payload: workbenchPayload({ character: { description } }),
    filename,
    meta: { kind: 'manual_single' }
  })
}

function seedSlot(characterId: string, payload: Record<string, unknown>) {
  const slot = workingSlot(
    workbenchPayload({ _overlay: ['character.description'], ...payload }),
    { etag: 'seed' }
  )
  useStore.setState((s) => ({
    flistWorking: { ...s.flistWorking, [characterId]: slot },
    flistArchive: {
      ...s.flistArchive,
      [characterId]: archiveEntry(livePayload({ character: { description: 'live' } }))
    },
    flistActiveCharacterId: characterId
  }))
}

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeApi()
  useStore.setState({
    flistWorking: {},
    flistArchive: {},
    flistDiffRightSource: {},
    flistDiffBackupCache: {},
    flistDiffBackupStatus: {},
    flistResetUndo: null,
    flistActiveCharacterId: null,
    editorReadOnly: false
  })
})

afterEach(() => {
  fake.restore()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the Diff picker', () => {
  it('lists Live, then the Backups with their source and occasion', async () => {
    fake.on('GET /flist/character/99/live', json(livePayload({ fetched_at: 1790000500 })))
    fake.on(
      BACKUPS,
      json({
        backups: [
          backupRow(NEWER, { source: 'workbench', occasion: 'before-restore' }),
          backupRow(OLDER, { source: 'live', occasion: 'backup-all', kind: 'manual_bulk' }),
          backupRow('2025-01-01T000000Z.zip', { source: 'unknown', occasion: null })
        ]
      })
    )

    await useStore.getState().flistLoadArchive('99')

    expect(selectDiffSources(useStore.getState(), '99')).toEqual([
      { kind: 'live', lastPullAt: 1790000500 },
      {
        kind: 'backup',
        filename: NEWER,
        createdAt: 1790000000,
        name: null,
        origin: 'Workbench · before Restore'
      },
      {
        kind: 'backup',
        filename: OLDER,
        createdAt: 1790000000,
        name: null,
        origin: 'Live · Back up all'
      },
      {
        kind: 'backup',
        filename: '2025-01-01T000000Z.zip',
        createdAt: 1790000000,
        name: null,
        origin: 'Source unknown'
      }
    ])
  })

  it('leaves out the Backup of the files an earlier version left behind, which holds no profile', async () => {
    fake.on('GET /flist/character/99/live', json(livePayload({ fetched_at: 1790000500 })))
    fake.on(
      BACKUPS,
      json({
        backups: [
          backupRow(NEWER, {
            source: 'workbench',
            occasion: 'migration',
            kind: 'unknown',
            holds_profile: false
          }),
          backupRow(OLDER, { source: 'workbench', occasion: 'manual' })
        ]
      })
    )

    await useStore.getState().flistLoadArchive('99')

    expect(
      selectDiffSources(useStore.getState(), '99').flatMap((e) =>
        e.kind === 'backup' ? [e.filename] : []
      )
    ).toEqual([OLDER])
  })

  it('offers Live alone while the Backup list has not loaded', () => {
    seedSlot('99', {})
    expect(selectDiffSources(useStore.getState(), '99')).toEqual([
      { kind: 'live', lastPullAt: null }
    ])
  })
})

describe('the Diff tab picks its right-hand side', () => {
  it('records the picked source per character', () => {
    useStore.getState().flistDiffSetRightSource('99', { kind: 'backup', filename: NEWER })
    expect(useStore.getState().flistDiffRightSource['99']).toEqual({
      kind: 'backup',
      filename: NEWER
    })
  })
})

describe('choosing a Backup compares the Workbench with its payload', () => {
  it("reads the Backup's payload once and keeps it for the comparison", async () => {
    seedSlot('99', { character: { description: 'edited' } })
    fake.on(backupPayloadRoute(NEWER), backupRead(NEWER, 'in the Backup'))

    await useStore.getState().flistDiffLoadBackup('99', NEWER)
    await useStore.getState().flistDiffLoadBackup('99', NEWER)

    expect(fake.requestsTo(backupPayloadRoute(NEWER))).toHaveLength(1)
    expect(descOf(useStore.getState().flistDiffBackupCache[`99:${NEWER}`])).toBe(
      'in the Backup'
    )
    expect(useStore.getState().flistDiffBackupStatus[`99:${NEWER}`]).toBe('loaded')
  })

  it('a Backup that cannot be read shows as an error, not a spinner', async () => {
    seedSlot('99', {})
    fake.on(
      backupPayloadRoute(OLDER),
      json({ code: 'backup_not_found', message: 'That Backup is gone.' }, 404)
    )

    await useStore.getState().flistDiffLoadBackup('99', OLDER)

    expect(useStore.getState().flistDiffBackupStatus[`99:${OLDER}`]).toBe('error')
    expect(useStore.getState().flistDiffBackupCache[`99:${OLDER}`]).toBeUndefined()
  })
})

describe('"reset to this" in the Diff tab', () => {
  const RESET = 'POST /flist/character/99/workbench/reset-to-live'
  const LOAD = 'POST /flist/character/99/workbench/load-backup'
  const BENCH_ID = 'aaaaaaaaaaaa'
  const KEPT = '2026-11-02T120000Z.zip'

  /** The Backup list after the sidecar kept the replaced Workbench. */
  function backupListWithKept() {
    fake.on('GET /flist/character/99/live', json(livePayload()))
    fake.on(
      BACKUPS,
      json({
        backups: [
          backupRow(KEPT, { source: 'workbench', occasion: 'before-restore' }),
          backupRow(NEWER)
        ]
      })
    )
  }

  const keptOrigins = () =>
    selectDiffSources(useStore.getState(), '99').flatMap((e) =>
      e.kind === 'backup' && e.filename === KEPT ? [e.origin] : []
    )

  it('on Live resets the Workbench to Live, which leaves a before-restore Backup', async () => {
    seedSlot('99', { character: { description: 'edited' } })
    fake.on(
      RESET,
      json({
        payload: workbenchPayload({ character: { description: 'live' } }),
        etag: 'after-reset',
        backed_up_first: { filename: KEPT, created_at: 1790000000 }
      })
    )
    backupListWithKept()

    await useStore.getState().flistDiffResetToSource('99')
    await vi.advanceTimersByTimeAsync(0)

    expect(fake.requestsTo(RESET)).toHaveLength(1)
    expect(fake.requestsTo(LOAD)).toHaveLength(0)
    expect(descOf(useStore.getState().flistWorking['99'].payload)).toBe('live')
    expect(keptOrigins()).toEqual(['Workbench · before Restore'])
  })

  it('on a Backup Restores that Backup, which leaves a before-restore Backup', async () => {
    seedSlot('99', { character: { description: 'edited' } })
    useStore.getState().flistDiffSetRightSource('99', { kind: 'backup', filename: NEWER })
    const restored = workbenchPayload({ character: { description: 'restored' } })
    fake.on(
      LOAD,
      json({
        workbench: { id: BENCH_ID, kind: 'bench', name: 'Workbench' },
        payload: restored,
        etag: 'after-restore',
        loaded: NEWER,
        backed_up_first: { filename: KEPT, created_at: 1790000000 }
      })
    )
    fake.on(`GET ${BENCH}`, json(payloadRead(restored, 'after-restore')))
    backupListWithKept()

    await useStore.getState().flistDiffResetToSource('99')

    const [load] = fake.requestsTo(LOAD)
    expect(load?.body).toEqual({ filename: NEWER })
    expect(fake.requestsTo(RESET)).toHaveLength(0)
    expect(fake.requestsTo(SAVE)).toHaveLength(0)
    expect(descOf(useStore.getState().flistWorking['99'].payload)).toBe('restored')
    expect(keptOrigins()).toEqual(['Workbench · before Restore'])
  })
})
