export interface SetMeta {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  snapshotCount: number
}

export interface SnapshotMeta {
  id: string
  name: string
  createdAt: number
}

export type BackupSource =
  | 'auto-pull'
  | 'manual-set'
  | 'manual-snapshot'
  | 'legacy-json'

export interface BackupListing {
  filename: string
  createdAt: number
  size: number
  source: BackupSource
  sourceName: string | null
  payloadHash: string
}

export type NewSetSeed =
  | { kind: 'live' }
  | { kind: 'empty' }
  | { kind: 'fork'; setId: string }
