// Payload builders for the renderer tests, the counterpart of the
// sidecar's shared Log writer (sidecar/tests/fchat_logs.py): each
// returns a fresh, realistic default and takes overrides, so a test
// spells out only what it is about.
//
//   seed: workingSlot(workbenchPayload({ character: { description: 'mine' } }))
//   reply: json(payloadRead(workbenchPayload(...), 'e1'))
//
// Overrides replace top-level keys whole (`character` included); they
// are not merged deeply.

import type { useStore } from '../state'
import {
  WORKING_SCHEMA_VERSION,
  type FlistWorkingSlot,
  type WorkingPayload
} from '../state/flist'

type ArchiveEntry = ReturnType<typeof useStore.getState>['flistArchive'][string]

/** A character's Workbench payload, as the sidecar stores it. */
export function workbenchPayload(overrides: Record<string, unknown> = {}): WorkingPayload {
  return {
    _schema_version: WORKING_SCHEMA_VERSION,
    _overlay: [],
    character: { description: '' },
    ...overrides
  }
}

/** A character's Live: the profile as last pulled from F-list. */
export function livePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { character: { description: '' }, ...overrides }
}

/** The store's slot holding a Workbench: saved, on disk, nothing
 *  pending. Its overlay mirrors the payload's `_overlay`. */
export function workingSlot(
  payload: WorkingPayload = workbenchPayload(),
  overrides: Partial<FlistWorkingSlot> = {}
): FlistWorkingSlot {
  return {
    payload,
    overlay: [...(payload._overlay ?? [])],
    etag: 'seed-etag',
    unsavedDirty: false,
    saveStatus: 'idle',
    saveError: null,
    lastSavedAt: null,
    materialised: true,
    ...overrides
  }
}

/** The store's archive entry for a character: its Live, no Backups
 *  listed, no Pull running. */
export function archiveEntry(
  live: Record<string, unknown> | null = livePayload(),
  overrides: Partial<ArchiveEntry> = {}
): ArchiveEntry {
  return { live, snapshots: [], pullStatus: 'idle', ...overrides }
}

/** What the sidecar answers to reading a Workbench payload. */
export function payloadRead(
  payload: WorkingPayload,
  etag: string
): { payload: WorkingPayload; etag: string } {
  return { payload, etag }
}

/** What the sidecar answers to resolving a character's Workbench. */
export function workbenchRead(id: string): {
  workbench: { id: string; kind: 'bench'; name: string }
  active_set_id: string
} {
  return { workbench: { id, kind: 'bench', name: 'Workbench' }, active_set_id: id }
}
