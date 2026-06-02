import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useStore, selectWorkingSlot } from '../../state'

type GalleryEntry = { image_id: string; description: string; sort_order: number }

// Gallery entries live on the working copy under
// `images: [{image_id, description, sort_order}]`. The accessor never
// throws on an empty/malformed payload — it returns [].
function galleryFromSlot(payload: unknown): GalleryEntry[] {
  if (!payload || typeof payload !== 'object') return []
  const raw = (payload as { images?: unknown }).images
  if (!Array.isArray(raw)) return []
  const out: GalleryEntry[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as {
      image_id?: unknown
      description?: unknown
      sort_order?: unknown
    }
    if (typeof e.image_id !== 'string') continue
    const sort =
      typeof e.sort_order === 'number'
        ? e.sort_order
        : typeof e.sort_order === 'string'
          ? Number(e.sort_order)
          : out.length
    out.push({
      image_id: e.image_id,
      description: typeof e.description === 'string' ? e.description : '',
      sort_order: Number.isFinite(sort) ? (sort as number) : out.length
    })
  }
  out.sort((a, b) => a.sort_order - b.sort_order)
  return out
}

const TOAST_MS = 5000

// MIME markers for cross-pane drags. Custom types so they don't conflict
// with the system's text/uri-list or text/plain that drag events also
// dispatch. Each direction has its own type so a drop handler can refuse
// the wrong direction (e.g. profile pane shouldn't accept profile→pool).
const DRAG_MIME_PROFILE_TO_POOL = 'application/x-flist-image-to-pool'
const DRAG_MIME_POOL_TO_PROFILE = 'application/x-flist-image-to-profile'
// Drag from any gallery view (here or the right-pane preview) onto
// another gallery item — reorders within working.json's `images`.
// Same MIME both panes use so reorders sync automatically.
const DRAG_MIME_GALLERY_REORDER = 'application/x-flist-gallery-reorder'

function reorderGallery(
  list: GalleryEntry[],
  movedId: string,
  targetId: string
): GalleryEntry[] {
  if (movedId === targetId) return list
  const from = list.findIndex((e) => e.image_id === movedId)
  const to = list.findIndex((e) => e.image_id === targetId)
  if (from < 0 || to < 0) return list
  const next = list.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next.map((e, i) => ({ ...e, sort_order: i }))
}

type PoolEntry = {
  image_id: string
  extension: string
  size: number
  added_at?: number
}

export function ImagesTab({
  characterId,
  readOnly = false
}: {
  characterId: string
  readOnly?: boolean
}) {
  const slot = useStore((s) => selectWorkingSlot(s, characterId))
  const characterImages = useStore((s) => s.flistCharacterImages[characterId])
  const roster = useStore((s) => s.flistRoster)
  const loadCharacterImages = useStore((s) => s.flistLoadCharacterImages)
  const uploadImage = useStore((s) => s.flistUploadImage)
  const deleteImage = useStore((s) => s.flistDeleteImage)
  const moveToProfile = useStore((s) => s.flistMoveImageToProfile)
  const moveToPool = useStore((s) => s.flistMoveImageToPool)
  const setGallery = useStore((s) => s.flistSetGalleryImages)
  const openExportRestore = useStore((s) => s.flistOpenExportRestore)

  useEffect(() => {
    if (!characterId) return
    if (!characterImages || characterImages.status === 'idle') {
      void loadCharacterImages(characterId)
    }
  }, [characterId, characterImages, loadCharacterImages])

  const characterName = useMemo(() => {
    const entry = roster.find((r) => String(r.id ?? '') === characterId)
    return entry?.name ?? null
  }, [roster, characterId])

  const gallery = useMemo(
    () => (slot ? galleryFromSlot(slot.payload) : []),
    [slot]
  )

  const galleryImageIds = useMemo(
    () => new Set(gallery.map((e) => e.image_id)),
    [gallery]
  )

  // Pool view: every file in `<char>/images/` that working.json's
  // gallery does NOT currently reference. Newest-first by mtime so
  // a fresh upload lands at the top of the pane.
  const poolEntries = useMemo<PoolEntry[]>(() => {
    const byId = characterImages?.byId ?? {}
    const out: PoolEntry[] = []
    for (const [imageId, meta] of Object.entries(byId)) {
      if (galleryImageIds.has(imageId)) continue
      out.push({
        image_id: imageId,
        extension: meta.extension,
        size: meta.size,
        added_at: meta.added_at
      })
    }
    out.sort((a, b) => (b.added_at ?? 0) - (a.added_at ?? 0))
    return out
  }, [characterImages, galleryImageIds])

  // ---- file drop / picker + upload error toast ------------------------
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [poolDragActive, setPoolDragActive] = useState(false)
  const [profileDragActive, setProfileDragActive] = useState(false)

  useEffect(() => {
    if (!uploadError) return
    const id = window.setTimeout(() => setUploadError(null), TOAST_MS)
    return () => window.clearTimeout(id)
  }, [uploadError])

  const uploadFiles = async (files: FileList | File[]) => {
    setUploadError(null)
    for (const file of Array.from(files)) {
      if (file.type && !/^image\/(png|jpeg|gif)$/.test(file.type)) {
        setUploadError(
          `"${file.name}" isn't supported. Only PNG, JPG, or GIF can be uploaded to F-list.`
        )
        break
      }
      try {
        await uploadImage(characterId, file)
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err)
        setUploadError(`"${file.name}" wasn't accepted: ${raw}`)
        break
      }
    }
  }

  // ---- gallery <-> pool moves (5s undo toast) -------------------------
  const [moveUndo, setMoveUndo] = useState<
    | {
        previous: GalleryEntry[]
        message: string
      }
    | null
  >(null)
  useEffect(() => {
    if (!moveUndo) return
    const id = window.setTimeout(() => setMoveUndo(null), TOAST_MS)
    return () => window.clearTimeout(id)
  }, [moveUndo])

  const handleMoveToPool = (imageId: string) => {
    setMoveUndo({
      previous: gallery,
      message: 'Moved to pool. Bytes stay on disk.'
    })
    moveToPool(characterId, imageId)
  }

  const handleMoveToProfile = (imageId: string) => {
    setMoveUndo({
      previous: gallery,
      message: 'Added to profile.'
    })
    moveToProfile(characterId, imageId)
  }

  const undoMove = () => {
    if (!moveUndo) return
    setGallery(characterId, moveUndo.previous)
    setMoveUndo(null)
  }

  const moveGalleryEntry = (imageId: string, dir: -1 | 1) => {
    const idx = gallery.findIndex((e) => e.image_id === imageId)
    if (idx < 0) return
    const target = idx + dir
    if (target < 0 || target >= gallery.length) return
    const next = gallery.slice()
    const tmp = next[idx]
    next[idx] = next[target]
    next[target] = tmp
    setGallery(
      characterId,
      next.map((e, i) => ({ ...e, sort_order: i }))
    )
  }

  const setCaption = (imageId: string, description: string) => {
    setGallery(
      characterId,
      gallery.map((e) => (e.image_id === imageId ? { ...e, description } : e))
    )
  }

  // ---- permanent delete (modal confirm) --------------------------------
  const [confirmDelete, setConfirmDelete] = useState<PoolEntry | null>(null)

  const handleDelete = async () => {
    if (!confirmDelete) return
    const entry = confirmDelete
    setConfirmDelete(null)
    try {
      await deleteImage(characterId, entry.image_id)
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      setUploadError(`Couldn’t delete: ${raw}`)
    }
  }

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
        {/* ---- Pool pane (left) ---- */}
        <section
          className={`flist-images-pane flist-images-pane--pool ${
            poolDragActive ? 'flist-images-pane--drag' : ''
          }`}
          onDragOver={(e) => {
            if (readOnly) return
            const dt = e.dataTransfer
            const droppingProfileRow =
              dt && Array.from(dt.types).includes(DRAG_MIME_PROFILE_TO_POOL)
            const droppingFiles = dt && dt.types.includes('Files')
            if (!droppingProfileRow && !droppingFiles) return
            e.preventDefault()
            setPoolDragActive(true)
          }}
          onDragLeave={() => setPoolDragActive(false)}
          onDrop={(e) => {
            if (readOnly) return
            e.preventDefault()
            setPoolDragActive(false)
            const profileId = e.dataTransfer?.getData(DRAG_MIME_PROFILE_TO_POOL)
            if (profileId) {
              handleMoveToPool(profileId)
              return
            }
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
          {characterImages?.status === 'loading' && (
            <div className="flist-images-pane__loading">Loading images…</div>
          )}
          <ul className="flist-images-pool-list">
            {poolEntries.map((entry) => (
              <PoolRow
                key={entry.image_id}
                characterId={characterId}
                entry={entry}
                readOnly={readOnly}
                onAdd={() => handleMoveToProfile(entry.image_id)}
                onDelete={() => setConfirmDelete(entry)}
              />
            ))}
            {!poolEntries.length && characterImages?.status === 'ready' && (
              <li className="flist-images-pool-empty">
                {readOnly
                  ? 'Pool is empty.'
                  : 'Nothing here. Drop PNG / JPG / GIF files to add one, or drag an image off the profile.'}
              </li>
            )}
          </ul>
        </section>

        {/* ---- Profile pane (right) ---- */}
        <section
          className={`flist-images-pane flist-images-pane--gallery ${
            profileDragActive ? 'flist-images-pane--drag' : ''
          }`}
          onDragOver={(e) => {
            if (readOnly) return
            const dt = e.dataTransfer
            if (!dt || !Array.from(dt.types).includes(DRAG_MIME_POOL_TO_PROFILE)) return
            e.preventDefault()
            setProfileDragActive(true)
          }}
          onDragLeave={() => setProfileDragActive(false)}
          onDrop={(e) => {
            if (readOnly) return
            e.preventDefault()
            setProfileDragActive(false)
            const poolId = e.dataTransfer?.getData(DRAG_MIME_POOL_TO_PROFILE)
            if (poolId) {
              handleMoveToProfile(poolId)
            }
          }}
        >
          <header className="flist-images-pane__header">
            <h3>On profile</h3>
            <span className="flist-images-pane__count">
              {gallery.length} image{gallery.length === 1 ? '' : 's'}
            </span>
          </header>
          {avatarUrl && (
            <div
              className="flist-images-avatar-slot"
              title="Pulled fresh from F-list when the character is refreshed"
            >
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
          <ol className="flist-images-gallery-list">
            {gallery.map((entry, index) => (
              <li
                key={entry.image_id}
                className="flist-images-gallery-item"
                tabIndex={readOnly ? -1 : 0}
                draggable={!readOnly}
                onDragStart={(e) => {
                  if (readOnly) return
                  e.dataTransfer.setData(
                    DRAG_MIME_PROFILE_TO_POOL,
                    entry.image_id
                  )
                  e.dataTransfer.setData(
                    DRAG_MIME_GALLERY_REORDER,
                    entry.image_id
                  )
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e) => {
                  if (readOnly) return
                  if (!e.dataTransfer.types.includes(DRAG_MIME_GALLERY_REORDER)) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                }}
                onDrop={(e) => {
                  if (readOnly) return
                  const movedId = e.dataTransfer.getData(DRAG_MIME_GALLERY_REORDER)
                  if (!movedId || movedId === entry.image_id) return
                  e.preventDefault()
                  e.stopPropagation()
                  setGallery(
                    characterId,
                    reorderGallery(gallery, movedId, entry.image_id)
                  )
                }}
                onKeyDown={(e) => {
                  if (readOnly) return
                  if (e.altKey && e.key === 'ArrowUp') {
                    e.preventDefault()
                    moveGalleryEntry(entry.image_id, -1)
                  } else if (e.altKey && e.key === 'ArrowDown') {
                    e.preventDefault()
                    moveGalleryEntry(entry.image_id, 1)
                  }
                }}
              >
                <div className="flist-images-gallery-item__pos">{index + 1}</div>
                <CharacterImageThumb
                  characterId={characterId}
                  imageId={entry.image_id}
                />
                <div className="flist-images-gallery-item__body">
                  <textarea
                    className="flist-images-gallery-item__caption"
                    value={entry.description}
                    placeholder="(no description)"
                    disabled={readOnly}
                    onChange={(e) => setCaption(entry.image_id, e.target.value)}
                    rows={2}
                  />
                </div>
                {!readOnly && (
                  <div className="flist-images-gallery-item__actions">
                    <button
                      type="button"
                      className="flist-images-gallery-item__btn"
                      onClick={() => moveGalleryEntry(entry.image_id, -1)}
                      disabled={index === 0}
                      title="Move up (Alt+↑)"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="flist-images-gallery-item__btn"
                      onClick={() => moveGalleryEntry(entry.image_id, 1)}
                      disabled={index === gallery.length - 1}
                      title="Move down (Alt+↓)"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="flist-images-gallery-item__btn"
                      onClick={() => handleMoveToPool(entry.image_id)}
                      title="Move to pool (image stays on disk)"
                    >
                      ×
                    </button>
                  </div>
                )}
              </li>
            ))}
            {!gallery.length && (
              <li className="flist-images-gallery-empty">
                Empty gallery.{' '}
                {readOnly
                  ? ''
                  : 'Drag from the pool, or use → on a pool row to add.'}
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
      {moveUndo && (
        <div
          className="flist-images-toast flist-images-toast--undo"
          role="status"
        >
          <span>{moveUndo.message}</span>
          <button
            type="button"
            className="flist-images-toast__action"
            onClick={undoMove}
            data-testid="flist-images-move-undo"
          >
            Undo
          </button>
        </div>
      )}

      {/* ---- Delete-confirmation modal (only destructive path) ---- */}
      {confirmDelete && (
        <DeleteConfirmModal
          entry={confirmDelete}
          characterId={characterId}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void handleDelete()}
        />
      )}
    </div>
  )
}

function PoolRow({
  characterId,
  entry,
  readOnly,
  onAdd,
  onDelete
}: {
  characterId: string
  entry: PoolEntry
  readOnly: boolean
  onAdd: () => void
  onDelete: () => void
}) {
  return (
    <li
      className="flist-images-pool-item"
      draggable={!readOnly}
      onDragStart={(e) => {
        if (readOnly) return
        e.dataTransfer.setData(DRAG_MIME_POOL_TO_PROFILE, entry.image_id)
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      <PoolThumb characterId={characterId} entry={entry} onClick={onAdd} />
      <div className="flist-images-pool-item__meta">
        <span
          className="flist-images-pool-item__source"
          title={
            entry.image_id.startsWith('local-')
              ? 'Local upload — not yet on F-list'
              : 'F-list image id ' + entry.image_id
          }
        >
          {entry.image_id.startsWith('local-')
            ? `Local · ${entry.image_id.slice(6)}`
            : `id ${entry.image_id}`}
        </span>
        {!readOnly && (
          <>
            <button
              type="button"
              className="flist-images-pool-item__btn flist-images-pool-item__btn--add"
              onClick={onAdd}
              title="Add to profile"
            >
              → Add to profile
            </button>
            <button
              type="button"
              className="flist-images-pool-item__btn"
              onClick={onDelete}
              title="Delete permanently"
            >
              ×
            </button>
          </>
        )}
      </div>
    </li>
  )
}

function DeleteConfirmModal({
  entry,
  characterId,
  onCancel,
  onConfirm
}: {
  entry: PoolEntry
  characterId: string
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
    dialogRef.current?.querySelector<HTMLButtonElement>(
      'button[data-autofocus]'
    )?.focus()
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  return (
    <div
      className="flist-images-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="flist-images-delete-title"
    >
      <div
        ref={dialogRef}
        className="flist-images-modal"
        data-testid="flist-images-delete-confirm"
      >
        <h3 id="flist-images-delete-title" className="flist-images-modal__title">
          Delete this image permanently?
        </h3>
        <div className="flist-images-modal__body">
          <CharacterImageThumb
            characterId={characterId}
            imageId={entry.image_id}
          />
          <p>
            You’re about to permanently delete this picture. The bytes are
            removed from disk — there’s no other copy. Are you sure?
          </p>
        </div>
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
            className="flist-images-modal__btn flist-images-modal__btn--danger"
            onClick={onConfirm}
            data-testid="flist-images-delete-confirm-btn"
          >
            Delete permanently
          </button>
        </div>
      </div>
    </div>
  )
}

function PoolThumb({
  characterId,
  entry,
  onClick
}: {
  characterId: string
  entry: PoolEntry
  onClick?: () => void
}) {
  const url = api.flistImageUrl(
    characterId,
    `${entry.image_id}.${entry.extension}`
  )
  return (
    <button
      type="button"
      className="flist-images-thumb flist-images-thumb-hover"
      onClick={onClick}
      title={`${entry.image_id} (${entry.extension})`}
    >
      <img src={url} alt="" loading="lazy" />
      <span className="flist-images-thumb-hover__zoom" aria-hidden>
        <img src={url} alt="" />
      </span>
    </button>
  )
}

function CharacterImageThumb({
  characterId,
  imageId
}: {
  characterId: string
  imageId: string
}) {
  // Extension-blind URL — the sidecar probes png/jpg/gif on disk so the
  // gallery renders even without knowing the extension up front.
  const url = api.flistImageByIdUrl(characterId, imageId)
  return (
    <div className="flist-images-gallery-item__thumb flist-images-thumb-hover">
      <img src={url} alt="" loading="lazy" />
      <div className="flist-images-thumb-hover__zoom" aria-hidden>
        <img src={url} alt="" />
      </div>
    </div>
  )
}
