import { useEffect, useMemo } from 'react'
import { api } from '../../lib/api'
import { selectWorkingSlot, useStore } from '../../state'

function galleryFromSlot(payload: unknown): { image_id: string; description: string }[] {
  if (!payload || typeof payload !== 'object') return []
  const raw = (payload as { images?: unknown }).images
  if (!Array.isArray(raw)) return []
  const out: { image_id: string; description: string }[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as { image_id?: unknown; description?: unknown }
    if (typeof e.image_id !== 'string') continue
    out.push({
      image_id: e.image_id,
      description: typeof e.description === 'string' ? e.description : ''
    })
  }
  return out
}

function liveGalleryImageIds(live: unknown): Set<string> {
  const out = new Set<string>()
  if (!live || typeof live !== 'object') return out
  const raw = (live as { images?: unknown }).images
  if (!Array.isArray(raw)) return out
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const iid = (entry as { image_id?: unknown; id?: unknown }).image_id
      ?? (entry as { image_id?: unknown; id?: unknown }).id
    if (typeof iid === 'string') out.add(iid)
    else if (typeof iid === 'number') out.add(String(iid))
  }
  return out
}

export function ExportRestoreModal({
  characterId,
  onClose,
  onShowUserscriptHelp
}: {
  characterId: string
  onClose: () => void
  onShowUserscriptHelp: () => void
}) {
  const slot = useStore((s) => selectWorkingSlot(s, characterId))
  const live = useStore((s) => s.flistArchive[characterId]?.live ?? null)
  const roster = useStore((s) => s.flistRoster)
  const characterName = useMemo(() => {
    const entry = roster.find((r) => String(r.id ?? '') === characterId)
    if (entry?.name) return entry.name
    const char = slot?.payload && (slot.payload as { character?: unknown }).character
    if (char && typeof char === 'object') {
      const n = (char as { name?: unknown }).name
      if (typeof n === 'string') return n
    }
    return 'Character'
  }, [roster, characterId, slot])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const gallery = galleryFromSlot(slot?.payload)
  const liveIds = liveGalleryImageIds(live)
  // local-<sha8> ids are always new-on-restore (synthetic). F-list-shaped
  // ids that match Live are skipped by the userscript (already uploaded).
  const newOnRestore = gallery.filter(
    (e) => e.image_id.startsWith('local-') || !liveIds.has(e.image_id)
  )
  const reusedOnRestore = gallery.filter(
    (e) => !e.image_id.startsWith('local-') && liveIds.has(e.image_id)
  )
  const onLiveNotInSet = [...liveIds].filter(
    (iid) => !gallery.some((e) => e.image_id === iid)
  )

  const customKinkCount = (() => {
    const ck = slot?.payload && (slot.payload as { custom_kinks?: unknown }).custom_kinks
    if (!ck || typeof ck !== 'object') return 0
    return Object.values(ck as Record<string, unknown>).filter(
      (v) => v && typeof v === 'object' && !(v as { _deleted?: unknown })._deleted
    ).length
  })()
  const infotagCount = (() => {
    const tags = slot?.payload && (slot.payload as { infotags?: unknown }).infotags
    if (!tags || typeof tags !== 'object') return 0
    return Object.keys(tags as Record<string, unknown>).length
  })()

  const downloadUrl = api.flistExportZipUrl(characterId)

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal flist-export-restore-modal">
        <header className="modal-head">
          <div>
            <h2 className="modal-title">Export for restore</h2>
            <p className="modal-subtitle">
              Review what will be in the ZIP before downloading. The ZIP
              is consumed by the flistcharexporter userscript — it can
              only upload, never delete from F-list.
            </p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="modal-body flist-export-restore-body">
          <dl className="flist-export-restore-summary">
            <div>
              <dt>Character</dt>
              <dd>{characterName}</dd>
            </div>
            <div>
              <dt>Gallery images</dt>
              <dd>
                {gallery.length} total
                {newOnRestore.length > 0 && (
                  <span className="flist-export-restore-detail">
                    {' '}
                    · {newOnRestore.length} new upload
                    {newOnRestore.length === 1 ? '' : 's'}
                  </span>
                )}
                {reusedOnRestore.length > 0 && (
                  <span className="flist-export-restore-detail">
                    {' '}
                    · {reusedOnRestore.length} retained from F-list
                    {' '}(captions / order may still differ)
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt>Custom kinks</dt>
              <dd>{customKinkCount}</dd>
            </div>
            <div>
              <dt>Infotag overrides</dt>
              <dd>{infotagCount}</dd>
            </div>
            {onLiveNotInSet.length > 0 && (
              <div className="flist-export-restore-warn">
                <dt>On Live but not in this set</dt>
                <dd>
                  {onLiveNotInSet.length} image
                  {onLiveNotInSet.length === 1 ? '' : 's'} — the userscript
                  cannot remove these; delete them on the F-list site
                  manually if you want them gone.
                </dd>
              </div>
            )}
          </dl>
          <div className="flist-export-restore-hint">
            New to this? Workbench produces the ZIP; a browser userscript
            uploads it. <button
              type="button"
              className="flist-export-restore-link"
              onClick={onShowUserscriptHelp}
            >
              How to install and use the restore userscript →
            </button>
          </div>
        </div>
        <footer className="modal-foot">
          <button
            type="button"
            className="flist-export-restore-cancel"
            onClick={onClose}
          >
            Cancel
          </button>
          <a
            className="flist-export-restore-download"
            href={downloadUrl}
            download
            onClick={() => onClose()}
            data-testid="flist-export-restore-download"
          >
            ⬇ Download ZIP
          </a>
        </footer>
      </div>
    </div>
  )
}
