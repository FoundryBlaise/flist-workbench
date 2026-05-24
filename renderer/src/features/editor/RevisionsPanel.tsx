import { useEffect, useState } from 'react'
import { useStore } from '../../state'
import { api, type Revision } from '../../lib/api'

function relativeTime(epoch: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - epoch)
  if (seconds < 60) return `${Math.floor(seconds)}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(epoch * 1000).toLocaleDateString()
}

function fullTime(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString()
}

export function RevisionsPanel({ docId, onClose }: { docId: number; onClose: () => void }) {
  const revisions = useStore((s) => s.revisionsByDoc[docId])
  const status = useStore((s) => s.revisionsStatus[docId])
  const loadRevisions = useStore((s) => s.loadRevisions)
  const restoreRevision = useStore((s) => s.restoreRevision)
  const [preview, setPreview] = useState<Revision | null>(null)
  const [previewing, setPreviewing] = useState<number | null>(null)

  useEffect(() => {
    if (status === undefined) void loadRevisions(docId)
  }, [docId, status, loadRevisions])

  useEffect(() => {
    setPreview(null)
    setPreviewing(null)
  }, [docId])

  const openPreview = async (revId: number) => {
    setPreviewing(revId)
    try {
      const rev = await api.revisionGet(docId, revId)
      setPreview(rev)
    } finally {
      setPreviewing(null)
    }
  }

  const restore = (revId: number) => {
    const ok = window.confirm(
      'Restore this revision? A new revision will be added at the top with this content — your current version stays in history.'
    )
    if (!ok) return
    void restoreRevision(revId).then(() => {
      setPreview(null)
      onClose()
    })
  }

  return (
    <aside className="revisions-panel" data-testid="revisions-panel">
      <header className="revisions-head">
        <span>Revision history</span>
        <button type="button" className="revisions-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      {status === 'loading' && <div className="revisions-empty">Loading…</div>}
      {status === 'error' && <div className="revisions-empty">Couldn't load history.</div>}
      {revisions && revisions.length === 0 && (
        <div className="revisions-empty">No revisions yet.</div>
      )}
      {revisions && revisions.length > 0 && (
        <ul className="revisions-list">
          {revisions.map((r, idx) => {
            const next = revisions[idx + 1]
            const delta = next ? r.char_count - next.char_count : null
            const deltaLabel =
              delta === null ? 'first' : delta === 0 ? '±0' : delta > 0 ? `+${delta}` : `${delta}`
            return (
              <li key={r.id} className="revisions-row">
                <button
                  type="button"
                  className={`revisions-button ${preview?.id === r.id ? 'active' : ''}`}
                  onClick={() => openPreview(r.id)}
                  title={fullTime(r.created_at)}
                >
                  <span className="revisions-time">{relativeTime(r.created_at)}</span>
                  <span className="revisions-meta">
                    {r.char_count.toLocaleString()} chars
                    <span className={`revisions-delta delta-${delta === null ? 'none' : delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'zero'}`}>
                      {deltaLabel}
                    </span>
                  </span>
                </button>
                {previewing === r.id && <span className="revisions-loading">…</span>}
              </li>
            )
          })}
        </ul>
      )}
      {preview && (
        <div className="revisions-preview" data-testid="revisions-preview">
          <header>
            <span>Preview · {fullTime(preview.created_at)}</span>
            <button type="button" onClick={() => restore(preview.id)} className="revisions-restore">
              Restore this version
            </button>
          </header>
          <pre>{preview.bbcode}</pre>
        </div>
      )}
    </aside>
  )
}
