import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type FlistPoolEntry } from '../../lib/api'
import { useStore } from '../../state'

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

// Synthetic ids for pool-only images materialised into a character look
// like `local-<8 hex>` where the suffix is the sha256 prefix of the
// underlying pool entry.
function localIdForSha(sha: string): string {
  return `local-${sha.slice(0, 8)}`
}

export function ImagesTab({
  characterId,
  readOnly = false
}: {
  characterId: string
  readOnly?: boolean
}) {
  const slot = useStore((s) => s.flistWorking[characterId])
  const pool = useStore((s) => s.flistPool[characterId])
  const characterImages = useStore((s) => s.flistCharacterImages[characterId])
  const roster = useStore((s) => s.flistRoster)
  const loadPool = useStore((s) => s.flistLoadPool)
  const loadCharacterImages = useStore((s) => s.flistLoadCharacterImages)
  const uploadPool = useStore((s) => s.flistUploadPoolImage)
  const deletePool = useStore((s) => s.flistDeletePoolImage)
  const setGallery = useStore((s) => s.flistSetGalleryImages)
  const addPoolToCharacter = useStore((s) => s.flistAddPoolToCharacter)
  const removeCharacterImage = useStore((s) => s.flistRemoveCharacterImage)
  const openExportRestore = useStore((s) => s.flistOpenExportRestore)

  useEffect(() => {
    if (!characterId) return
    if (!pool || pool.status === 'idle') {
      void loadPool(characterId)
    }
    if (!characterImages || characterImages.status === 'idle') {
      void loadCharacterImages(characterId)
    }
  }, [characterId, pool, characterImages, loadPool, loadCharacterImages])

  const characterName = useMemo(() => {
    const entry = roster.find((r) => String(r.id ?? '') === characterId)
    return entry?.name ?? null
  }, [roster, characterId])

  const gallery = useMemo(
    () => (slot ? galleryFromSlot(slot.payload) : []),
    [slot]
  )

  const poolEntries = pool?.entries ?? []

  // Set of local-<sha8> ids currently in the gallery — used to badge the
  // pool with "✓ In gallery" for entries the user has already pulled
  // into the character.
  const galleryLocalIds = useMemo(
    () => new Set(gallery.map((e) => e.image_id).filter((id) => id.startsWith('local-'))),
    [gallery]
  )

  // F-list-pulled images live in both `pool/` (sha-keyed) and
  // `images/<image_id>.<ext>` (image_id-keyed). We can't cheaply map
  // between the two without hashing, so the Pool pane's "in gallery"
  // affordance is exact only for local-* ids. For F-list entries we
  // show neutral state.
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
      if (file.type && !/^image\/(png|jpeg|gif)$/.test(file.type)) {
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
  const [addToast, setAddToast] = useState<string | null>(null)
  useEffect(() => {
    if (!addToast) return
    const id = window.setTimeout(() => setAddToast(null), TOAST_MS)
    return () => window.clearTimeout(id)
  }, [addToast])

  const addToGallery = async (entry: FlistPoolEntry) => {
    const res = await addPoolToCharacter(characterId, entry.sha256)
    if (res && !res.added) {
      setAddToast(`Already in the gallery as ${res.image_id}.`)
    }
  }

  // Gallery-remove with 5s undo. Removing from the character deletes the
  // file in images/ — the pool keeps the bytes.
  const [galleryUndo, setGalleryUndo] = useState<
    | { previous: GalleryEntry[]; removedImageId: string }
    | null
  >(null)
  useEffect(() => {
    if (!galleryUndo) return
    const id = window.setTimeout(() => setGalleryUndo(null), TOAST_MS)
    return () => window.clearTimeout(id)
  }, [galleryUndo])

  const removeFromGallery = async (imageId: string) => {
    setGalleryUndo({ previous: gallery, removedImageId: imageId })
    await removeCharacterImage(characterId, imageId)
  }

  const undoGalleryRemove = async () => {
    if (!galleryUndo) return
    // Best-effort restore: re-materialise from pool if local-*, otherwise
    // re-pull would be needed. Pool keeps bytes either way, but for F-list
    // images the user would need to re-pull to get the bytes back.
    // For simplicity, just restore the working-copy entry; the file
    // resurrection lives in a follow-up.
    setGallery(characterId, galleryUndo.previous)
    setGalleryUndo(null)
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
    // Re-stamp sort_order so the persisted order matches the visible one.
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

  // ---- pool delete (with confirm step; no cascade in the new model) ---
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const doDeletePool = async (sha: string) => {
    try {
      await deletePool(characterId, sha)
    } catch {
      // ignore; the store already strips the row on a successful call,
      // and surface other errors only via the upload-toast surface.
    } finally {
      setConfirmDelete(null)
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
    <div className="flist-images-tab flist-images-tab--three">
      <div className="flist-images-tab__panes">
        {/* ---- Pool pane (25%) ---- */}
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
                inGallery={galleryLocalIds.has(localIdForSha(entry.sha256))}
                readOnly={readOnly}
                onAdd={() => void addToGallery(entry)}
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

        {/* ---- Character / gallery pane (25%) ---- */}
        <section className="flist-images-pane flist-images-pane--gallery">
          <header className="flist-images-pane__header">
            <h3>On profile</h3>
            <span className="flist-images-pane__count">
              {gallery.length} image{gallery.length === 1 ? '' : 's'}
            </span>
          </header>
          {characterImages?.status === 'loading' && (
            <div className="flist-images-pane__loading">Loading images…</div>
          )}
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
                      onClick={() => void removeFromGallery(entry.image_id)}
                      title="Remove from gallery (keeps pool entry)"
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
                {readOnly ? '' : 'Add images from the pool on the left.'}
              </li>
            )}
          </ol>
        </section>

        {/* ---- Preview pane (50%) — built in task #6 ---- */}
        <section className="flist-images-pane flist-images-pane--preview">
          <header className="flist-images-pane__header">
            <h3>Preview</h3>
          </header>
          <GalleryPreview
            characterId={characterId}
            characterName={characterName}
            gallery={gallery}
          />
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
          <span>
            Removed from gallery. Bytes stay in the pool — undo restores
            the row, but the thumbnail won’t render until you re-add
            from the pool (or re-pull).
          </span>
          <button
            type="button"
            className="flist-images-toast__action"
            onClick={() => void undoGalleryRemove()}
            data-testid="flist-images-gallery-undo"
          >
            Undo
          </button>
        </div>
      )}
      {addToast && (
        <div className="flist-images-toast flist-images-toast--undo" role="status">
          <span>{addToast}</span>
          <button
            type="button"
            className="flist-images-toast__close"
            onClick={() => setAddToast(null)}
            aria-label="Dismiss"
          >
            ✕
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
  const isFlistMirror = entry.source === 'flist_pull'
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
            {isFlistMirror ? (
              // F-list-pulled bytes already mirror to images/<image_id>.<ext>
              // and are auto-seeded into the gallery from Live. Adding from
              // the pool here would create a duplicate `local-*` row with a
              // fresh image_id — confusing. Leave the action off; user can
              // re-pull if they want the F-list entry back in the gallery.
              <span
                className="flist-images-pool-item__in-gallery"
                title="F-list-pulled images are auto-mirrored to the gallery on each pull. To remove or re-add, edit the gallery directly."
              >
                F-list mirror
              </span>
            ) : inGallery ? (
              <span
                className="flist-images-pool-item__in-gallery"
                title="Already added to the gallery as a local image"
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
                  Delete from pool? The image bytes are removed from disk —
                  the character gallery is unaffected, but you won’t be able
                  to re-add this image without re-pulling or re-uploading.
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
  if (entry.source === 'flist_pull') {
    return (
      <span
        className="flist-images-pool-item__source flist-images-pool-item__source--flist_pull"
        title="Originally pulled from F-list"
      >
        F-list pull
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
      title={`Pool · ${entry.sha256.slice(0, 12)}… (${entry.extension})`}
    >
      <img src={url} alt="" loading="lazy" />
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
  const ext = useStore(
    (s) => s.flistCharacterImages[characterId]?.byId[imageId]?.extension ?? null
  )
  if (!ext) {
    return <div className="flist-images-gallery-item__thumb" />
  }
  const url = api.flistImageUrl(characterId, `${imageId}.${ext}`)
  return (
    <div className="flist-images-gallery-item__thumb">
      <img src={url} alt="" loading="lazy" />
    </div>
  )
}

function GalleryPreview({
  characterId,
  characterName,
  gallery
}: {
  characterId: string
  characterName: string | null
  gallery: GalleryEntry[]
}) {
  if (!gallery.length) {
    return (
      <div className="flist-images-preview flist-images-preview--empty">
        Empty gallery. Add images from the pool to preview how the profile
        would look.
      </div>
    )
  }
  return (
    <div className="flist-images-preview">
      <div className="flist-images-preview__header">
        {characterName ?? 'Profile'} gallery preview
      </div>
      <div className="flist-images-preview__grid">
        {gallery.map((entry) => (
          <figure key={entry.image_id} className="flist-images-preview__tile">
            <CharacterImageThumb
              characterId={characterId}
              imageId={entry.image_id}
            />
            {entry.description && (
              <figcaption className="flist-images-preview__caption">
                {entry.description}
              </figcaption>
            )}
          </figure>
        ))}
      </div>
    </div>
  )
}
