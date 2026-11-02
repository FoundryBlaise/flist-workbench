import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { FlistZipBackupEntry } from '../../lib/api'

/** Confirm a Restore: overwriting the Workbench with a Backup.
 *
 *  Cancel or load. The sidecar always saves the Workbench as a Backup
 *  before a Restore replaces it (ADR 0003), so a misclick here costs
 *  nothing: restoring that Backup undoes it. The dialog says so.
 *
 *  Two things the user cannot see for themselves come from the
 *  preflight: whether the bench actually holds edits, and whether
 *  F-list has moved on since the backup was taken. Both are stated,
 *  neither blocks — loading an older backup on purpose is a legitimate
 *  thing to want.
 */
export function LoadIntoWorkbenchDialog({
  characterId,
  backup,
  onCancel,
  onConfirm
}: {
  characterId: string
  backup: FlistZipBackupEntry
  onCancel: () => void
  onConfirm: () => void
}) {
  const [preflight, setPreflight] = useState<{
    live_diverged: boolean
    workbench_has_edits: boolean
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    void api
      .flistWorkbenchLoadPreflight(characterId, backup.filename)
      .then((res) => {
        if (!cancelled) setPreflight(res)
      })
      .catch(() => {
        // The dialog still works without it; it just cannot add the
        // two warnings. Better than refusing to open.
        if (!cancelled) setPreflight(null)
      })
    return () => {
      cancelled = true
    }
  }, [characterId, backup.filename])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const label = backup.name || backup.filename

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="load-wb-title"
        data-testid="load-into-workbench"
      >
        <h2 id="load-wb-title">Load “{label}” into the Workbench?</h2>
        <p>
          Everything currently in the Workbench will be replaced by this
          backup. The Workbench is saved as a Backup first, so you can
          restore it if you change your mind.
        </p>
        {preflight?.workbench_has_edits === false && (
          <p className="modal-note" data-testid="load-wb-no-edits">
            The Workbench has no edits of its own yet, so nothing of yours
            is at stake.
          </p>
        )}
        {preflight?.live_diverged && (
          <p className="modal-warn" role="alert" data-testid="load-wb-diverged">
            Careful: F-List has been pulled since this backup was taken, so
            it does not match what is live any more. You can still load it.
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onCancel} data-testid="load-wb-cancel">
            Cancel
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => onConfirm()}
            data-testid="load-wb-load"
          >
            Load
          </button>
        </div>
      </div>
    </div>
  )
}
