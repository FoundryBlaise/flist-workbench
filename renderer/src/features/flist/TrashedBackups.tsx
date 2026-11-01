import { useEffect, useState } from 'react'
import { api, type FlistTrashedBackup } from '../../lib/api'
import { useStore } from '../../state'
import { formatBytes } from './imageUsage'

/** The Backups in a character's Trash, shown in the Trash view beside
 *  the images. Restore puts one back in the Backup list under the name
 *  it had; deleting for good is the window's alone. */
export function TrashedBackups({
  characterId,
  items,
  readOnly,
  onChanged
}: {
  characterId: string
  items: FlistTrashedBackup[]
  readOnly: boolean
  /** The Trash changed; reload it. */
  onChanged: () => Promise<void> | void
}) {
  const loadArchive = useStore((s) => s.flistLoadArchive)
  const [message, setMessage] = useState<string | null>(null)
  const [purgeTarget, setPurgeTarget] = useState<FlistTrashedBackup | null>(null)

  if (items.length === 0) return null

  const run = async (what: () => Promise<string>) => {
    setMessage(null)
    try {
      setMessage(await what())
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
    await onChanged()
  }

  const restore = (item: FlistTrashedBackup) =>
    run(async () => {
      const res = await api.flistTrashBackupsRestore(characterId, [item.id])
      await loadArchive(characterId)
      if (res.conflicts.length) {
        return 'Left in the Trash: the Backup list has a different file under that name.'
      }
      return `${label(item)} is back in the Backup list.`
    })

  const purge = (item: FlistTrashedBackup) =>
    run(async () => {
      await api.flistTrashBackupsPurge(characterId, [item.id])
      return `${label(item)} deleted for good.`
    })

  return (
    <div className="flist-trash-backups" data-testid="flist-trash-backups">
      <h4>Backups</h4>
      {message && (
        <div className="flist-images-pane__notice" role="status">
          {message}
        </div>
      )}
      <ul className="flist-images-pool-list">
        {items.map((item) => (
          <li key={item.id} className="flist-images-pool-item" data-testid="flist-trash-backup-item">
            <div className="flist-images-trash__meta">
              <span>{label(item)}</span>
              <span>
                {new Date(item.deleted_at * 1000).toLocaleString()} · {formatBytes(item.size)}
                {item.deleted_by === 'mcp' ? ' · by a connected model' : ''}
              </span>
            </div>
            {!readOnly && (
              <>
                <button
                  type="button"
                  className="flist-images-toolbar__btn flist-images-toolbar__btn--add"
                  onClick={() => void restore(item)}
                >
                  Restore
                </button>
                <button
                  type="button"
                  className="flist-images-toolbar__btn flist-images-toolbar__btn--danger"
                  onClick={() => setPurgeTarget(item)}
                >
                  Delete for good
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {purgeTarget && (
        <PurgeBackupConfirm
          item={purgeTarget}
          onCancel={() => setPurgeTarget(null)}
          onConfirm={() => {
            const target = purgeTarget
            setPurgeTarget(null)
            void purge(target)
          }}
        />
      )}
    </div>
  )
}

function label(item: FlistTrashedBackup): string {
  return item.name ?? item.filename
}

function PurgeBackupConfirm({
  item,
  onCancel,
  onConfirm
}: {
  item: FlistTrashedBackup
  onCancel: () => void
  onConfirm: () => void
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  return (
    <div className="modal-backdrop" data-testid="flist-trash-backup-purge-confirm">
      <div className="modal modal-confirm" role="dialog" aria-modal="true">
        <h3 className="modal-title">Delete this Backup for good?</h3>
        <p>
          <strong>{label(item)}</strong>
        </p>
        <p>The ZIP is removed from disk. This can’t be undone.</p>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn-danger" onClick={onConfirm} autoFocus>
            Delete for good
          </button>
        </div>
      </div>
    </div>
  )
}
