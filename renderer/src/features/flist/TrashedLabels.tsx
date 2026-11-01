import { useEffect, useState } from 'react'
import { api, type FlistTrashedLabels } from '../../lib/api'

/** Labels cleared in one go, shown in the Trash view beside the images
 *  and Backups. Restore puts them back; a message labelled again since
 *  keeps its newer Label. Deleting for good is the window's alone. */
export function TrashedLabels({
  characterId,
  items,
  readOnly,
  onChanged
}: {
  characterId: string
  items: FlistTrashedLabels[]
  readOnly: boolean
  /** The Trash changed; reload it. */
  onChanged: () => Promise<void> | void
}) {
  const [message, setMessage] = useState<string | null>(null)
  const [purgeTarget, setPurgeTarget] = useState<FlistTrashedLabels | null>(null)

  if (items.length === 0 && !message) return null

  const run = async (what: () => Promise<string>) => {
    setMessage(null)
    try {
      setMessage(await what())
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
    await onChanged()
  }

  const restore = (item: FlistTrashedLabels) =>
    run(async () => {
      const res = await api.flistTrashLabelsRestore(characterId, [item.id])
      const [done] = res.restored
      // The sidecar's labels-changed event refreshes an open Log.
      if (!done) return 'Those Labels are no longer in the Trash.'
      const parts = [`${plural(done.restored, 'Label')} ${done.restored === 1 ? 'is' : 'are'} back`]
      if (done.skipped.length) {
        parts.push(`${plural(done.skipped.length, 'message')} kept the Label it was given since`)
      }
      return `${parts.join('; ')}.`
    })

  const purge = (item: FlistTrashedLabels) =>
    run(async () => {
      await api.flistTrashLabelsPurge(characterId, [item.id])
      return `${plural(item.count, 'Label')} deleted for good.`
    })

  return (
    <div className="flist-trash-backups" data-testid="flist-trash-labels">
      <h4>Labels</h4>
      {message && (
        <div className="flist-images-pane__notice" role="status">
          {message}
        </div>
      )}
      <ul className="flist-images-pool-list">
        {items.map((item) => (
          <li
            key={item.id}
            className="flist-images-pool-item"
            data-testid="flist-trash-labels-item"
          >
            <div className="flist-images-trash__meta">
              <span>
                {plural(item.count, 'Label')} · {scope(item)}
              </span>
              <span>
                {new Date(item.deleted_at * 1000).toLocaleString()}
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
        <PurgeLabelsConfirm
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

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
}

function scope(item: FlistTrashedLabels): string {
  return item.partner
    ? `${item.partner} with ${item.character}`
    : `every conversation of ${item.character}`
}

function PurgeLabelsConfirm({
  item,
  onCancel,
  onConfirm
}: {
  item: FlistTrashedLabels
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
    <div className="modal-backdrop" data-testid="flist-trash-labels-purge-confirm">
      <div className="modal modal-confirm" role="dialog" aria-modal="true">
        <h3 className="modal-title">Delete these Labels for good?</h3>
        <p>
          <strong>
            {plural(item.count, 'Label')} · {scope(item)}
          </strong>
        </p>
        <p>The cleared Labels can’t be restored afterwards.</p>
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
