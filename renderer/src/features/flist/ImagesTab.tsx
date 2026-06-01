import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type FlistPoolEntry } from '../../lib/api'
import { useStore } from '../../state'

type GalleryEntry = { sha256: string; description: string }

// Gallery entries live on the working copy under `images: [{sha256,
// description}]`. The accessor never throws on an empty/malformed
// payload — it returns [].
function galleryFromSlot(payload: unknown): GalleryEntry[] {
  if (!payload || typeof payload !== 'object') return []
  const raw = (payload as { images?: unknown }).images
  if (!Array.isArray(raw)) return []
  const out: GalleryEntry[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as { sha256?: unknown; description?: unknown }
    if (typeof e.sha256 !== 'string') continue
    out.push({
      sha256: e.sha256,
      description: typeof e.description === 'string' ? e.description : ''
    })
  }
  return out
}

const TOAST_MS = 5000

export function ImagesTab({
  characterId,
  readOnly = false
}: {
  characterId: string
  readOnly?: boolean
}) {
  const slot = useStore((s) => s.flistWorking[characterId])
  const pool = useStore((s) => s.flistPool[characterId])
  const live = useStore((s) => s.flistArchive[characterId]?.live ?? null)
  const roster = useStore((s) => s.flistRoster)
  const loadPool = useStore((s) => s.flistLoadPool)
  const uploadPool = useStore((s) => s.flistUploadPoolImage)
  const deletePool = useStore((s) => s.flistDeletePoolImage)
  const setGallery = useStore((s) => s.flistSetGalleryImages)
  const openExportRestore = useStore((s) => s.flistOpenExportRestore)

  useEffect(() => {
    if (!characterId) return
    if (!pool || pool.status === 'idle') {
      void loadPool(characterId)
    }
  }, [characterId, pool, loadPool])

  const characterName = useMemo(() => {
    const entry = roster.find((r) => String(r.id ?? '') === characterId)
    return entry?.name ?? null
  }, [roster, characterId])

  const gallery = useMemo(
    () => (slot ? galleryFromSlot(slot.payload) : []),
    [slot]
  )

  const poolEntries = pool?.entries ?? []
  const inGallery = useMemo(
    () => new Set(gallery.map((e) => e.sha256)),
    [gallery]
  )
  const poolBySha = useMemo(() => {
    const m = new Map<string, FlistPoolEntry>()
    for (const entry of poolEntries) m.set(entry.sha256, entry)
    return m
  }, [poolEntries])

  // All pool entries, F-list-pulled first, newest-first within each
  // source group. In-gallery entries appear here too (with a distinct
  // affordance) so the pool is the single place to delete a stored
  // image — including ones currently referenced by the working set's
  // gallery, in which case a cascade warning fires.
  const sortedPool = useMemo(() => {
    return poolEntries
      .slice()
      .sort((a, b) => {
        if (a.source !== b.source) {
          if (a.source === 'flist_pull') return -1
          if (b.source === 'flist_pull') return 1
        }
        return b.added_at - a.added_at
      })
  }, [poolEntries])

  // Live-gallery shas not in the working set. Used both for the
  // expandable notice and for resolving thumbnails of orphan images
  // (the pool already has bytes for every Live image since pulls
  // populate the pool).
  const liveOnlyShas = useMemo(() => {
    const liveImages =
      live && Array.isArray((live as { images?: unknown }).images)
        ? ((live as { images: unknown[] }).images as unknown[])
        : []
    const liveShas = new Set<string>()
    for (const entry of liveImages) {
      if (!entry || typeof entry !== 'object') continue
      const sha = (entry as { sha256?: unknown }).sha256
      if (typeof sha === 'string') liveShas.add(sha)
    }
    return [...liveShas].filter((sha) => !inGallery.has(sha))
  }, [live, inGallery])

  // ---- file drop / picker + upload error toast ------------------------
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)

  useEffect(() => {
    if (!uploadError) return
    const id = window.setTimeout(() => setUploadError(null), TOAST_MS)
    return () => window.clearTimeout(id)
  }, [uploadError])

  const uploadFiles = async (files: FileList | File[]) => {
    setUploadError(null)
    for (const file of Array.from(files)) {
      // Client-side reject of obviously-wrong types so the user sees a
      // useful message rather than a generic server 415.
      if (
        file.type
        && !/^image\/(png|jpeg|gif)$/.test(file.type)
      ) {
        setUploadError(
          `"${file.name}" isn't supported. Only PNG, JPG, or GIF can be uploaded to F-list.`
        )
        break
      }
      try {
        await uploadPool(characterId, file)
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err)
        setUploadError(`"${file.name}" wasn't accepted: ${raw}`)
        break
      }
    }
  }

  // ---- gallery actions -------------------------------------------------
  const addToGallery = (entry: FlistPoolEntry) => {
    setGallery(characterId, [
      ...gallery,
      { sha256: entry.sha256, description: '' }
    ])
  }

  // Gallery-remove with 5s undo. The undo entry holds the snapshot of
  // the array AND the position so a re-insert lands at the same row.
  const [galleryUndo, setGalleryUndo] = useState<
    | { previous: GalleryEntry[]; removedSha: string }
    | null
  >(null)
  useEffect(() => {
    if (!galleryUndo) return
    const id = window.setTimeout(() => setGalleryUndo(null), TOAST_MS)
    return () => window.clearTimeout(id)
  }, [galleryUndo])

  const removeFromGallery = (sha: string) => {
    setGalleryUndo({ previous: gallery, removedSha: sha })
    setGallery(characterId, gallery.filter((e) => e.sha256 !== sha))
  }
  const undoGalleryRemove = () => {
    if (!galleryUndo) return
    setGallery(characterId, galleryUndo.previous)
    setGalleryUndo(null)
  }

  const moveGalleryEntry = (sha: string, dir: -1 | 1) => {
    const idx = gallery.findIndex((e) => e.sha256 === sha)
    if (idx < 0) return
    const target = idx + dir
    if (target < 0 || target >= gallery.length) return
    const next = gallery.slice()
    const tmp = next[idx]
    next[idx] = next[target]
    next[target] = tmp
    setGallery(characterId, next)
  }

  const setCaption = (sha: string, description: string) => {
    setGallery(
      characterId,
      gallery.map((e) =>
        e.sha256 === sha ? { ...e, description } : e
      )
    )
  }

  // ---- pool delete (with cascade warning when gallery-referenced) -----
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const doDeletePool = async (sha: string) => {
    try {
      await deletePool(characterId, sha)
    } catch {
      // 404 / store already strips the row; surface other errors only
      // via the upload-toast surface for now.
    } finally {
      setConfirmDelete(null)
    }
  }

  // ---- divergence expander --------------------------------------------
  const [divergenceOpen, setDivergenceOpen] = useState(false)
  useEffect(() => {
    if (liveOnlyShas.length === 0 && divergenceOpen) setDivergenceOpen(false)
  }, [liveOnlyShas.length, divergenceOpen])

  if (!slot) {
    return (
      <div className="flist-images-tab flist-images-tab--empty">
        Open a working copy to manage images.
      </div>
    )
  }

  const avatarUrl = characterName ? api.flistAvatarUrl(characterName) : null

  return (
    <div className="flist-images-tab">
      <div className="flist-images-tab__panes">
        {/* ---- Pool pane ---- */}
        <section
          className={`flist-images-pane flist-images-pane--pool ${
            dragActive ? 'flist-images-pane--drag' : ''
          }`}
          onDragOver={(e) => {
            if (readOnly) return
            e.preventDefault()
            setDragActive(true)
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            if (readOnly) return
            e.preventDefault()
            setDragActive(false)
            if (e.dataTransfer?.files?.length) {
              void uploadFiles(e.dataTransfer.files)
            }
          }}
        >
          <header className="flist-images-pane__header">
            <h3>Pool</h3>
            <span className="flist-images-pane__count">
              {poolEntries.length} image{poolEntries.length === 1 ? '' : 's'}
            </span>
            {!readOnly && (
              <button
                type="button"
                className="flist-images-pane__add"
                onClick={() => fileInputRef.current?.click()}
              >
                + Add image
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) {
                  void uploadFiles(e.target.files)
                  e.target.value = ''
                }
              }}
            />
          </header>
          {pool?.status === 'loading' && (
            <div className="flist-images-pane__loading">Loading pool…</div>
          )}
          <ul className="flist-images-pool-list">
            {sortedPool.map((entry) => (
              <PoolRow
                key={entry.sha256}
                characterId={characterId}
                entry={entry}
                inGallery={inGallery.has(entry.sha256)}
                readOnly={readOnly}
                onAdd={() => addToGallery(entry)}
                confirming={confirmDelete === entry.sha256}
                onConfirmStart={() => setConfirmDelete(entry.sha256)}
                onConfirmCancel={() => setConfirmDelete(null)}
                onConfirmDelete={() => void doDeletePool(entry.sha256)}
              />
            ))}
            {!sortedPool.length && pool?.status === 'ready' && (
              <li className="flist-images-pool-empty">
                {readOnly
                  ? 'Pool is empty for this character.'
                  : 'No images yet. Drop PNG / JPG / GIF files here or click + Add image. Pulls from F-list also populate this pool.'}
              </li>
            )}
          </ul>
        </section>

        {/* ---- Gallery pane ---- */}
        <section className="flist-images-pane flist-images-pane--gallery">
          <header className="flist-images-pane__header">
            <h3>On profile</h3>
            <span className="flist-images-pane__count">
              {gallery.length} image{gallery.length === 1 ? '' : 's'}
            </span>
          </header>
          {avatarUrl && (
            <div className="flist-images-avatar-slot" title="Pulled fresh from F-list when the character is refreshed">
              <img
                src={avatarUrl}
                alt={`Avatar for ${characterName}`}
                className="flist-images-avatar"
              />
              <div className="flist-images-avatar-meta">
                <div className="flist-images-avatar-label">Avatar</div>
                <div className="flist-images-avatar-hint">
                  Pulled from F-list. Edit on the F-list website; Workbench
                  bundles whatever’s on disk into the restore ZIP.
                </div>
              </div>
            </div>
          )}
          {liveOnlyShas.length > 0 && (
            <div className="flist-images-divergence">
              <button
                type="button"
                className="flist-images-divergence__toggle"
                aria-expanded={divergenceOpen}
                onClick={() => setDivergenceOpen((v) => !v)}
              >
                {divergenceOpen ? '▾' : '▸'} {liveOnlyShas.length} image
                {liveOnlyShas.length === 1 ? '' : 's'} on Live not in this set
              </button>
              <div className="flist-images-divergence__hint">
                Workbench cannot remove images from F-list. Delete on the
                F-list website if you want them gone.
              </div>
              {divergenceOpen && (
                <ul className="flist-images-divergence__list">
                  {liveOnlyShas.map((sha) => {
                    const poolEntry = poolBySha.get(sha)
                    return (
                      <li key={sha} className="flist-images-divergence__item">
                        {poolEntry ? (
                          <PoolThumb
                            characterId={characterId}
                            entry={poolEntry}
                          />
                        ) : (
                          <div className="flist-images-gallery-item__missing">
                            missing
                          </div>
                        )}
                        <div className="flist-images-divergence__meta">
                          {poolEntry?.image_id
                            ? `F-list image_id ${poolEntry.image_id}`
                            : `sha ${sha.slice(0, 12)}…`}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}
          <ol className="flist-images-gallery-list">
            {gallery.map((entry, index) => {
              const poolEntry = poolBySha.get(entry.sha256)
              return (
                <li
                  key={entry.sha256}
                  className="flist-images-gallery-item"
                  tabIndex={readOnly ? -1 : 0}
                  onKeyDown={(e) => {
                    if (readOnly) return
                    // Alt+↑/↓ reorder. Plain arrows are left to the
                    // textarea inside the row so caret movement still
                    // works as expected.
                    if (e.altKey && e.key === 'ArrowUp') {
                      e.preventDefault()
                      moveGalleryEntry(entry.sha256, -1)
                    } else if (e.altKey && e.key === 'ArrowDown') {
                      e.preventDefault()
                      moveGalleryEntry(entry.sha256, 1)
                    }
                  }}
                >
                  <div className="flist-images-gallery-item__pos">
                    {index + 1}
                  </div>
                  {poolEntry ? (
                    <PoolThumb characterId={characterId} entry={poolEntry} />
                  ) : (
                    <div className="flist-images-gallery-item__missing">
                      missing
                    </div>
                  )}
                  <div className="flist-images-gallery-item__body">
                    <textarea
                      className="flist-images-gallery-item__caption"
                      value={entry.description}
                      placeholder="(no description)"
                      disabled={readOnly}
                      onChange={(e) => setCaption(entry.sha256, e.target.value)}
                      rows={2}
                    />
                  </div>
                  {!readOnly && (
                    <div className="flist-images-gallery-item__actions">
                      <button
                        type="button"
                        className="flist-images-gallery-item__btn"
                        onClick={() => moveGalleryEntry(entry.sha256, -1)}
                        disabled={index === 0}
                        title="Move up (Alt+↑)"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="flist-images-gallery-item__btn"
                        onClick={() => moveGalleryEntry(entry.sha256, 1)}
                        disabled={index === gallery.length - 1}
                        title="Move down (Alt+↓)"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="flist-images-gallery-item__btn"
                        onClick={() => removeFromGallery(entry.sha256)}
                        title="Remove from gallery (keeps pool entry)"
                      >
                        ×
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
            {!gallery.length && (
              <li className="flist-images-gallery-empty">
                Empty gallery.{' '}
                {readOnly ? '' : 'Add images from the pool on the left.'}
              </li>
            )}
          </ol>
        </section>
      </div>

      {!readOnly && (
        <footer className="flist-images-tab__footer">
          <span className="flist-images-tab__footer-hint">
            Done curating? Export the working set as a ZIP for restore via the
            flistcharexporter userscript.
          </span>
          <button
            type="button"
            className="flist-images-tab__export"
            onClick={() => openExportRestore(characterId)}
            data-testid="flist-images-tab-export"
          >
            ⬇ Export for restore…
          </button>
        </footer>
      )}

      {/* ---- Toasts ---- */}
      {uploadError && (
        <div
          className="flist-images-toast flist-images-toast--error"
          role="alert"
          data-testid="flist-images-upload-error"
        >
          <span>{uploadError}</span>
          <button
            type="button"
            className="flist-images-toast__close"
            onClick={() => setUploadError(null)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {galleryUndo && (
        <div
          className="flist-images-toast flist-images-toast--undo"
          role="status"
        >
          <span>Removed from gallery.</span>
          <button
            type="button"
            className="flist-images-toast__action"
            onClick={undoGalleryRemove}
            data-testid="flist-images-gallery-undo"
          >
            Undo
          </button>
        </div>
      )}
    </div>
  )
}

function PoolRow({
  characterId,
  entry,
  inGallery,
  readOnly,
  onAdd,
  confirming,
  onConfirmStart,
  onConfirmCancel,
  onConfirmDelete
}: {
  characterId: string
  entry: FlistPoolEntry
  inGallery: boolean
  readOnly: boolean
  onAdd: () => void
  confirming: boolean
  onConfirmStart: () => void
  onConfirmCancel: () => void
  onConfirmDelete: () => void
}) {
  return (
    <li className="flist-images-pool-item">
      <PoolThumb
        characterId={characterId}
        entry={entry}
        onClick={() => !readOnly && onAdd()}
      />
      <div className="flist-images-pool-item__meta">
        <SourceBadge entry={entry} />
        {!readOnly && (
          <>
            {inGallery ? (
              <span
                className="flist-images-pool-item__in-gallery"
                title="This image is in the current gallery — see the right pane"
              >
                ✓ In gallery
              </span>
            ) : (
              <button
                type="button"
                className="flist-images-pool-item__btn flist-images-pool-item__btn--add"
                onClick={onAdd}
                title="Add to gallery"
              >
                → Add
              </button>
            )}
            {confirming ? (
              <div className="flist-images-pool-item__confirm">
                <div className="flist-images-pool-item__confirm-msg">
                  {inGallery
                    ? "This image is in the gallery. Deleting here removes it from this set too."
                    : 'Delete from pool? The image file will be removed from disk.'}
                </div>
                <div className="flist-images-pool-item__confirm-actions">
                  <button
                    type="button"
                    className="flist-images-pool-item__btn flist-images-pool-item__btn--danger"
                    onClick={onConfirmDelete}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="flist-images-pool-item__btn"
                    onClick={onConfirmCancel}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="flist-images-pool-item__btn"
                onClick={onConfirmStart}
                title="Remove from pool (file deleted)"
              >
                ×
              </button>
            )}
          </>
        )}
      </div>
    </li>
  )
}

function SourceBadge({ entry }: { entry: FlistPoolEntry }) {
  if (entry.image_id) {
    return (
      <span
        className="flist-images-pool-item__source flist-images-pool-item__source--flist_pull"
        title={`Mirrors F-list image_id ${entry.image_id}`}
      >
        F-list · {entry.image_id}
      </span>
    )
  }
  return (
    <span
      className="flist-images-pool-item__source flist-images-pool-item__source--user_upload"
      title={`Local upload · sha ${entry.sha256.slice(0, 12)}…`}
    >
      Local · {entry.sha256.slice(0, 8)}
    </span>
  )
}

function PoolThumb({
  characterId,
  entry,
  onClick
}: {
  characterId: string
  entry: FlistPoolEntry
  onClick?: () => void
}) {
  const url = api.flistPoolFileUrl(characterId, entry.sha256, entry.extension)
  return (
    <button
      type="button"
      className="flist-images-thumb"
      onClick={onClick}
      title={
        entry.image_id
          ? `F-list image_id ${entry.image_id}`
          : `Local upload · ${entry.sha256.slice(0, 12)}…`
      }
    >
      <img src={url} alt="" loading="lazy" />
    </button>
  )
}
