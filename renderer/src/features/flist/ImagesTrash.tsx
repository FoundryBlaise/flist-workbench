import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import {
  api,
  errorDetail,
  type FlistTrashItem,
  type FlistTrashedBackup,
  type FlistTrashedLabels
} from '../../lib/api'
import { useStore } from '../../state'
import {
  EMPTY_SELECTION,
  pruneSelection,
  selectAll,
  selectRange,
  toggleSelected,
  type Selection
} from './imageSelection'
import { formatBytes } from './imageUsage'
import { ImagesConfirmModal } from './ImagesConfirmModal'
import { TrashedBackups, TrashedLabels } from './TrashedEntries'

/** How many entries a Trash listing holds: images, Backups and
 *  cleared Labels. */
export function trashEntryCount(res: {
  items: unknown[]
  backups?: unknown[]
  labels?: unknown[]
}): number {
  return res.items.length + (res.backups?.length ?? 0) + (res.labels?.length ?? 0)
}

/** The character's Trash, shown in place of the pool: its images, and
 *  below them its Backups and cleared Labels. Put back returns files
 *  to the pool, never onto the profile. Deleting for good lives here
 *  and nowhere else — MCP has no tool for it. */
export function ImagesTrash({
  characterId,
  readOnly,
  refreshKey,
  onBack,
  onCountChange
}: {
  characterId: string
  readOnly: boolean
  /** Changes whenever the pool listing reloads, so the Trash does too. */
  refreshKey: unknown
  onBack: () => void
  onCountChange: (n: number) => void
}) {
  const loadCharacterImages = useStore((s) => s.flistLoadCharacterImages)
  // Cleared Labels are Trash entries too; a model may clear them.
  const labelsRevision = useStore((s) => s.labelsRevision)
  const [items, setItems] = useState<FlistTrashItem[] | null>(null)
  const [backups, setBackups] = useState<FlistTrashedBackup[]>([])
  const [labels, setLabels] = useState<FlistTrashedLabels[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION)
  const [confirm, setConfirm] = useState<null | 'purge' | 'empty'>(null)

  const load = async () => {
    try {
      const res = await api.flistTrashList(characterId)
      setItems(res.items)
      setBackups(res.backups ?? [])
      setLabels(res.labels ?? [])
      onCountChange(trashEntryCount(res))
    } catch (e) {
      setMessage(`Couldn’t read the Trash: ${errorDetail(e)}`)
    }
  }

  useEffect(() => {
    void load()
  }, [characterId, refreshKey, labelsRevision])

  const visible = useMemo(() => (items ?? []).map((i) => i.trash_id), [items])
  useEffect(() => {
    setSel((s) => pruneSelection(s, visible))
  }, [visible])

  const run = async (what: () => Promise<string>) => {
    setMessage(null)
    try {
      setMessage(await what())
    } catch (e) {
      setMessage(errorDetail(e))
    }
    setSel(EMPTY_SELECTION)
    await load()
    void loadCharacterImages(characterId)
  }

  const putBack = () =>
    run(async () => {
      const res = await api.flistTrashPutBack(characterId, sel.ids)
      const twins = res.restored.filter((r) => r.deduplicated).length
      const parts = [`${res.restored.length} back in the Pool`]
      if (twins) parts.push(`${twins} already there, so not copied twice`)
      if (res.conflicts.length) {
        parts.push(`${res.conflicts.length} left here: the Pool has a different file under that name`)
      }
      return `${parts.join('; ')}.`
    })

  const purge = () =>
    run(async () => {
      const res = await api.flistTrashPurge(characterId, sel.ids)
      return `${res.purged.length} deleted for good.`
    })

  const empty = () =>
    run(async () => {
      const res = await api.flistTrashEmpty(characterId)
      return `Trash emptied — ${res.purged} deleted for good.`
    })

  const entries = visible.length + backups.length + labels.length

  const click = (id: string, e: MouseEvent) => {
    setSel((s) => (e.shiftKey ? selectRange(s, id, visible) : toggleSelected(s, id)))
  }

  const thumbsFor = (ids: string[]) =>
    (items ?? [])
      .filter((i) => ids.includes(i.trash_id))
      .map((i) => ({ key: i.trash_id, url: api.flistTrashFileUrl(characterId, i.filename) }))

  return (
    <div className="flist-images-trash" data-testid="flist-images-trash">
      <div className="flist-images-toolbar">
        <button type="button" className="flist-images-toolbar__btn" onClick={onBack}>
          ← Pool
        </button>
        {!readOnly && entries > 0 && (
          <>
            <button
              type="button"
              className="flist-images-toolbar__btn"
              onClick={() => setSel(sel.ids.length ? EMPTY_SELECTION : selectAll(visible))}
            >
              {sel.ids.length ? 'Clear selection' : 'Select all'}
            </button>
            <span className="flist-images-toolbar__spacer" />
            <button
              type="button"
              className="flist-images-toolbar__btn flist-images-toolbar__btn--danger"
              onClick={() => setConfirm('empty')}
              data-testid="flist-images-trash-empty"
            >
              Empty Trash
            </button>
          </>
        )}
      </div>
      {!readOnly && sel.ids.length > 0 && (
        <div className="flist-images-actionbar" data-testid="flist-images-trash-actionbar">
          <span>{sel.ids.length} selected</span>
          <button
            type="button"
            className="flist-images-toolbar__btn flist-images-toolbar__btn--add"
            onClick={() => void putBack()}
            data-testid="flist-images-trash-put-back"
          >
            Put back in Pool
          </button>
          <button
            type="button"
            className="flist-images-toolbar__btn flist-images-toolbar__btn--danger"
            onClick={() => setConfirm('purge')}
            data-testid="flist-images-trash-purge"
          >
            Delete for good
          </button>
        </div>
      )}
      {message && (
        <div className="flist-images-pane__notice" role="status">
          {message}
        </div>
      )}
      <ul className="flist-images-pool-list">
        {(items ?? []).map((item) => {
          const selected = sel.ids.includes(item.trash_id)
          return (
            <li
              key={item.trash_id}
              className={`flist-images-pool-item${selected ? ' flist-images-pool-item--selected' : ''}`}
              data-testid="flist-images-trash-item"
            >
              {!readOnly && (
                <input
                  type="checkbox"
                  className="flist-images-select"
                  checked={selected}
                  onClick={(e) => click(item.trash_id, e)}
                  onChange={() => {}}
                  aria-label={`Select ${item.image_id}`}
                />
              )}
              <div className="flist-images-thumb">
                <img
                  src={api.flistTrashFileUrl(characterId, item.filename)}
                  alt=""
                  loading="lazy"
                />
              </div>
              <div className="flist-images-trash__meta">
                <span>{item.source_name ?? item.image_id}</span>
                <span>
                  {new Date(item.deleted_at * 1000).toLocaleString()} ·{' '}
                  {formatBytes(item.size)}
                  {item.deleted_by === 'mcp' ? ' · by a connected model' : ''}
                </span>
              </div>
            </li>
          )
        })}
        {items !== null && entries === 0 && (
          <li className="flist-images-pool-empty">The Trash is empty.</li>
        )}
      </ul>
      <TrashedBackups
        characterId={characterId}
        items={backups}
        readOnly={readOnly}
        onChanged={load}
      />
      <TrashedLabels
        items={labels}
        readOnly={readOnly}
        putBack={(ids) => api.flistTrashLabelsPutBack(characterId, ids)}
        purge={(ids) => api.flistTrashLabelsPurge(characterId, ids)}
        onChanged={load}
      />
      {confirm === 'purge' && (
        <ImagesConfirmModal
          title={`Delete ${sel.ids.length} image${sel.ids.length === 1 ? '' : 's'} for good?`}
          body="These files are removed from disk. This can’t be undone."
          thumbs={thumbsFor(sel.ids)}
          confirmLabel="Delete for good"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null)
            void purge()
          }}
        />
      )}
      {confirm === 'empty' && (
        <ImagesConfirmModal
          title="Empty the Trash?"
          body={`Everything in this character’s Trash (${entries} entr${entries === 1 ? 'y' : 'ies'}) is deleted for good. This can’t be undone.`}
          thumbs={thumbsFor(visible)}
          confirmLabel="Empty Trash"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null)
            void empty()
          }}
        />
      )}
    </div>
  )
}
