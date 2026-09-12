import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { FlistZipBackupEntry } from '../../lib/api'

/** Three-way confirm for overwriting the workbench with a backup.
 *
 *  Cancel, load, or back up and load. The third button exists because
 *  the bench holds work that is not published anywhere: a misclick here
 *  would be the one action in the app that destroys something
 *  irreplaceable. It is offered rather than done automatically —
 *  whether the current contents are worth a backup is the user's call,
 *  and quietly writing a ZIP on their behalf every time would fill the
 *  list with rescues nobody asked for.
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
  onConfirm: (backUpFirst: boolean) => void
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
          backup.
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
            onClick={() => onConfirm(true)}
            data-testid="load-wb-backup-first"
          >
            Back up first, then load
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => onConfirm(false)}
            data-testid="load-wb-load"
          >
            Load
          </button>
        </div>
      </div>
    </div>
  )
}
