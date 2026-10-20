import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { api, type FlistTrashItem } from '../../lib/api'
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

const MAX_PREVIEW_THUMBS = 12

/** Confirmation for moving images to the trash, or deleting them for
 *  good. Shows what is about to go and, for the trash, where those
 *  pictures are still used. */
export function ImagesConfirmModal({
  title,
  body,
  notes = [],
  thumbs,
  confirmLabel,
  danger = false,
  onCancel,
  onConfirm
}: {
  title: string
  body: string
  notes?: string[]
  thumbs: { key: string; url: string }[]
  confirmLabel: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', handler)
    dialogRef.current?.querySelector<HTMLButtonElement>('button[data-autofocus]')?.focus()
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  const shown = thumbs.slice(0, MAX_PREVIEW_THUMBS)
  const more = thumbs.length - shown.length
  return (
    <div
      className="flist-images-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="flist-images-confirm-title"
    >
      <div
        ref={dialogRef}
        className="flist-images-modal flist-images-modal--batch"
        data-testid="flist-images-delete-confirm"
      >
        <h3 id="flist-images-confirm-title" className="flist-images-modal__title">
          {title}
        </h3>
        <div className="flist-images-modal__thumbs">
          {shown.map((t) => (
            <img key={t.key} src={t.url} alt="" loading="lazy" />
          ))}
          {more > 0 && <span className="flist-images-modal__more">+{more} more</span>}
        </div>
        <p className="flist-images-modal__text">{body}</p>
        {notes.length > 0 && (
          <ul className="flist-images-modal__notes" data-testid="flist-images-usage-notes">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        <div className="flist-images-modal__actions">
          <button
            type="button"
            className="flist-images-modal__btn"
            onClick={onCancel}
            data-autofocus
          >
            Cancel
          </button>
          <button
            type="button"
            className={`flist-images-modal__btn${danger ? ' flist-images-modal__btn--danger' : ''}`}
            onClick={onConfirm}
            data-testid="flist-images-delete-confirm-btn"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The character's image trash, shown in place of the pool. Restore
 *  puts files back into the pool, never onto the profile. Deleting for
 *  good lives here and nowhere else — MCP has no tool for it. */
export function ImagesTrash({
  characterId,
  readOnly,
  refreshKey,
  onBack,
  onCountChange
}: {
  characterId: string
  readOnly: boolean
  /** Changes whenever the pool listing reloads, so the trash does too. */
  refreshKey: unknown
  onBack: () => void
  onCountChange: (n: number) => void
}) {
  const loadCharacterImages = useStore((s) => s.flistLoadCharacterImages)
  const [items, setItems] = useState<FlistTrashItem[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION)
  const [confirm, setConfirm] = useState<null | 'purge' | 'empty'>(null)

  const load = async () => {
    try {
      const res = await api.flistTrashList(characterId)
      setItems(res.items)
      onCountChange(res.items.length)
    } catch (e) {
      setMessage(`Couldn’t read the trash: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  useEffect(() => {
    void load()
  }, [characterId, refreshKey])

  const visible = useMemo(() => (items ?? []).map((i) => i.image_id), [items])
  useEffect(() => {
    setSel((s) => pruneSelection(s, visible))
  }, [visible])

  const run = async (what: () => Promise<string>) => {
    setMessage(null)
    try {
      setMessage(await what())
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
    setSel(EMPTY_SELECTION)
    await load()
    void loadCharacterImages(characterId)
  }

  const restore = () =>
    run(async () => {
      const res = await api.flistTrashRestore(characterId, sel.ids)
      const twins = res.restored.filter((r) => r.deduplicated).length
      const parts = [`${res.restored.length} back in the pool`]
      if (twins) parts.push(`${twins} already there, so not copied twice`)
      if (res.conflicts.length) {
        parts.push(`${res.conflicts.length} left here: the pool has a different file under that name`)
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

  const click = (id: string, e: MouseEvent) => {
    setSel((s) => (e.shiftKey ? selectRange(s, id, visible) : toggleSelected(s, id)))
  }

  const thumbsFor = (ids: string[]) =>
    (items ?? [])
      .filter((i) => ids.includes(i.image_id))
      .map((i) => ({ key: i.image_id, url: api.flistTrashFileUrl(characterId, i.filename) }))

  return (
    <div className="flist-images-trash" data-testid="flist-images-trash">
      <div className="flist-images-toolbar">
        <button type="button" className="flist-images-toolbar__btn" onClick={onBack}>
          ← Pool
        </button>
        {!readOnly && visible.length > 0 && (
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
              Empty trash
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
            onClick={() => void restore()}
            data-testid="flist-images-trash-restore"
          >
            Restore to pool
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
          const selected = sel.ids.includes(item.image_id)
          return (
            <li
              key={item.image_id}
              className={`flist-images-pool-item${selected ? ' flist-images-pool-item--selected' : ''}`}
              data-testid="flist-images-trash-item"
            >
              {!readOnly && (
                <input
                  type="checkbox"
                  className="flist-images-select"
                  checked={selected}
                  onClick={(e) => click(item.image_id, e)}
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
        {items !== null && items.length === 0 && (
          <li className="flist-images-pool-empty">The trash is empty.</li>
        )}
      </ul>
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
          title="Empty the trash?"
          body={`All ${visible.length} file${visible.length === 1 ? '' : 's'} in this character’s trash are removed from disk. This can’t be undone.`}
          thumbs={thumbsFor(visible)}
          confirmLabel="Empty trash"
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
