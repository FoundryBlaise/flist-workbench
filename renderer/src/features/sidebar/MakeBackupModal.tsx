import { useEffect, useState } from 'react'
import type { SetMeta, SnapshotMeta } from './tier7Types'

export type MakeBackupSource =
  | { kind: 'set'; setId: string }
  | { kind: 'snapshot'; setId: string; snapshotId: string }

export interface MakeBackupModalProps {
  activeSet: SetMeta | null
  snapshotsForActiveSet: SnapshotMeta[]
  onCancel: () => void
  onConfirm: (source: MakeBackupSource) => void
}

export function MakeBackupModal({
  activeSet,
  snapshotsForActiveSet,
  onCancel,
  onConfirm
}: MakeBackupModalProps) {
  const [pick, setPick] = useState<string>('active')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const confirm = () => {
    if (!activeSet) return
    if (pick === 'active') {
      onConfirm({ kind: 'set', setId: activeSet.id })
      return
    }
    onConfirm({ kind: 'snapshot', setId: activeSet.id, snapshotId: pick })
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      data-testid="make-backup-modal"
    >
      <div className="modal make-backup-modal">
        <header className="modal-head">
          <h2 className="modal-title">Make backup</h2>
          <button
            type="button"
            className="modal-close"
            onClick={onCancel}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="modal-body make-backup-body">
          <p className="make-backup-hint">
            Backups are self-contained ZIPs (image bytes included). They are
            kept forever; you can hand them to the flistcharexporter
            userscript to restore this character on F-list.
          </p>
          <label className="make-backup-field">
            <span className="make-backup-field-l">Source</span>
            <select
              className="make-backup-select"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              data-testid="make-backup-source"
            >
              <option value="active">
                Active set{activeSet ? ` — ${activeSet.name}` : ''}
              </option>
              {snapshotsForActiveSet.map((s) => (
                <option key={s.id} value={s.id}>
                  Snapshot: {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <footer className="modal-foot">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={confirm}
            disabled={!activeSet}
            data-testid="make-backup-confirm"
          >
            Create
          </button>
        </footer>
      </div>
    </div>
  )
}
