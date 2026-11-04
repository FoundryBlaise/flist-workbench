import { useState } from 'react'
import { api, errorDetail, type FlistTrashedBackup, type FlistTrashedLabels } from '../../lib/api'
import { useStore } from '../../state'
import { ImagesConfirmModal } from './ImagesConfirmModal'
import { formatBytes } from './imageUsage'

/** What every Trash entry carries besides its own fields. */
type TrashedEntry = { id: string; deleted_at: number; deleted_by: string | null }

/** One kind of Trash entry (Backups, cleared Labels) as a list with
 *  Put back and Delete for good. Deleting for good asks first and is the
 *  window's alone. A message about the last action stays up even when
 *  that action emptied the list. */
function TrashedEntries<T extends TrashedEntry>({
  heading,
  testId,
  itemTestId,
  items,
  readOnly,
  label,
  detail,
  putBack,
  purge,
  purgeTitle,
  purgeBody,
  onChanged
}: {
  heading: string
  testId: string
  itemTestId: string
  items: T[]
  readOnly: boolean
  /** The entry's name in the list and in the confirm. */
  label: (item: T) => string
  /** What follows the deletion time, if anything. */
  detail?: (item: T) => string
  /** Put one entry back; resolves to the message to show. */
  putBack: (item: T) => Promise<string>
  /** Delete one entry for good; resolves to the message to show. */
  purge: (item: T) => Promise<string>
  purgeTitle: string
  purgeBody: string
  /** The Trash changed; reload it. */
  onChanged: () => Promise<void> | void
}) {
  const [message, setMessage] = useState<string | null>(null)
  const [purgeTarget, setPurgeTarget] = useState<T | null>(null)

  if (items.length === 0 && !message) return null

  const run = async (what: () => Promise<string>) => {
    setMessage(null)
    try {
      setMessage(await what())
    } catch (e) {
      setMessage(errorDetail(e))
    }
    await onChanged()
  }

  return (
    <div className="flist-trash-section" data-testid={testId}>
      <h4>{heading}</h4>
      {message && (
        <div className="flist-images-pane__notice" role="status">
          {message}
        </div>
      )}
      <ul className="flist-images-pool-list">
        {items.map((item) => (
          <li key={item.id} className="flist-images-pool-item" data-testid={itemTestId}>
            <div className="flist-images-trash__meta">
              <span>{label(item)}</span>
              <span>
                {new Date(item.deleted_at * 1000).toLocaleString()}
                {detail ? ` · ${detail(item)}` : ''}
                {item.deleted_by === 'mcp' ? ' · by a connected model' : ''}
              </span>
            </div>
            {!readOnly && (
              <>
                <button
                  type="button"
                  className="flist-images-toolbar__btn flist-images-toolbar__btn--add"
                  onClick={() => void run(() => putBack(item))}
                >
                  Put back
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
        <ImagesConfirmModal
          title={purgeTitle}
          body={`${label(purgeTarget)}. ${purgeBody}`}
          thumbs={[]}
          confirmLabel="Delete for good"
          danger
          onCancel={() => setPurgeTarget(null)}
          onConfirm={() => {
            const target = purgeTarget
            setPurgeTarget(null)
            void run(() => purge(target))
          }}
        />
      )}
    </div>
  )
}

/** The Backups in a character's Trash, shown in the Trash view beside
 *  the images. Put back returns one to the Backup list under the name
 *  it had. */
export function TrashedBackups({
  characterId,
  items,
  readOnly,
  onChanged
}: {
  characterId: string
  items: FlistTrashedBackup[]
  readOnly: boolean
  onChanged: () => Promise<void> | void
}) {
  const loadArchive = useStore((s) => s.flistLoadArchive)
  const name = (item: FlistTrashedBackup) => item.name ?? item.filename
  return (
    <TrashedEntries
      heading="Backups"
      testId="flist-trash-backups"
      itemTestId="flist-trash-backup-item"
      items={items}
      readOnly={readOnly}
      label={name}
      detail={(item) => formatBytes(item.size)}
      putBack={async (item) => {
        const res = await api.flistTrashBackupsPutBack(characterId, [item.id])
        await loadArchive(characterId)
        if (res.conflicts.length) {
          return `${name(item)} stays in the Trash: it has no usable Backup file name.`
        }
        return `${name(item)} is back in the Backup list.`
      }}
      purge={async (item) => {
        await api.flistTrashBackupsPurge(characterId, [item.id])
        return `${name(item)} deleted for good.`
      }}
      purgeTitle="Delete this Backup for good?"
      purgeBody="The ZIP is removed from disk. This can’t be undone."
      onChanged={onChanged}
    />
  )
}

/** Labels cleared in one go. Put back returns them; a message labelled
 *  again since keeps its newer Label. Shown in a character's Trash view
 *  and, for every character, in Settings → Labels: `putBack` and
 *  `purge` say which of the two the list talks to. */
export function TrashedLabels({
  heading = 'Labels',
  items,
  readOnly,
  putBack,
  purge,
  onChanged
}: {
  heading?: string
  items: FlistTrashedLabels[]
  readOnly: boolean
  putBack: (ids: string[]) => ReturnType<typeof api.labelsTrashPutBack>
  purge: (ids: string[]) => ReturnType<typeof api.labelsTrashPurge>
  onChanged: () => Promise<void> | void
}) {
  return (
    <TrashedEntries
      heading={heading}
      testId="flist-trash-labels"
      itemTestId="flist-trash-labels-item"
      items={items}
      readOnly={readOnly}
      label={(item) => `${plural(item.count, 'Label')} · ${scope(item)}`}
      putBack={async (item) => {
        const res = await putBack([item.id])
        const [done] = res.restored
        // The sidecar's labels-changed event refreshes an open Log.
        if (!done) return 'Those Labels are no longer in the Trash.'
        const parts = [
          `${plural(done.restored, 'Label')} ${done.restored === 1 ? 'is' : 'are'} back`
        ]
        if (done.skipped.length) {
          parts.push(
            `${plural(done.skipped.length, 'message')} kept the Label it was given since`
          )
        }
        return `${parts.join('; ')}.`
      }}
      purge={async (item) => {
        await purge([item.id])
        return `${plural(item.count, 'Label')} deleted for good.`
      }}
      purgeTitle="Delete these Labels for good?"
      purgeBody="The cleared Labels can’t be put back afterwards."
      onChanged={onChanged}
    />
  )
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
}

function scope(item: FlistTrashedLabels): string {
  if (!item.character) return 'messages in none of the Logs'
  return item.partner
    ? `${item.partner} with ${item.character}`
    : `every conversation of ${item.character}`
}
