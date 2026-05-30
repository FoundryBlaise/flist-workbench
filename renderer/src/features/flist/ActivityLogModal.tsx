import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'

type Snapshot = Awaited<ReturnType<typeof api.flistActivity>>

function relativeTime(epoch: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - epoch)
  if (seconds < 60) return `${Math.floor(seconds)}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function absoluteTime(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString()
}

function eventLabel(kind: string): string {
  switch (kind) {
    case 'sign-in':
      return 'Signed in'
    case 'sign-in-failed':
      return 'Sign-in failed'
    case 'sign-out':
      return 'Signed out'
    case 'ticket-refresh':
      return 'Auto-refreshed session ticket'
    case 'pull-start':
      return 'Pull started'
    case 'pull-done':
      return 'Pull done'
    case 'pull-error':
      return 'Pull error'
    case 'password-idle-clear':
      return 'Cleared cached password (idle timeout)'
    default:
      return kind
  }
}

function eventDetail(event: Record<string, unknown>): string {
  const parts: string[] = []
  const skip = new Set(['t', 'kind'])
  for (const [k, v] of Object.entries(event)) {
    if (skip.has(k)) continue
    if (v === null || v === undefined || v === '') continue
    parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
  }
  return parts.join(' · ')
}

function eventTone(kind: string): string {
  if (kind.endsWith('-error') || kind.endsWith('-failed')) return 'error'
  if (kind === 'password-idle-clear' || kind === 'sign-out') return 'notable'
  if (kind === 'sign-in' || kind === 'pull-done') return 'success'
  return 'normal'
}

export function ActivityLogModal({ onClose }: { onClose: () => void }) {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    try {
      setLoading(true)
      const data = await api.flistActivity()
      setSnap(data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const events = snap?.events ? [...snap.events].reverse() : []

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      data-testid="flist-activity-modal"
    >
      <div className="modal flist-activity-modal">
        <header className="modal-head">
          <div>
            <h2 className="modal-title">F-list activity</h2>
            <p className="modal-subtitle">
              Everything Workbench did on the F-list APIs since the sidecar
              started. In-memory only, kept here for your audit — nothing is
              written to disk or sent anywhere.
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
        <div className="modal-body flist-activity-body">
          {loading && events.length === 0 && (
            <div className="flist-activity-empty">Loading…</div>
          )}
          {error && (
            <div className="flist-activity-error" role="alert">
              Couldn't load activity: {error}
            </div>
          )}
          {!loading && snap && events.length === 0 && (
            <EmptyState
              variant="modal"
              testId="flist-activity-empty"
              body={
                <p>
                  No F-list activity recorded yet. Sign in and pull a character
                  to start the log.
                </p>
              }
            />
          )}
          {events.length > 0 && (
            <ul className="flist-activity-list" data-testid="flist-activity-list">
              {events.map((event, idx) => {
                const detail = eventDetail(event)
                const tone = eventTone(event.kind)
                return (
                  <li
                    key={`${event.t}-${idx}`}
                    className={`flist-activity-row flist-activity-row-${tone}`}
                  >
                    <span
                      className="flist-activity-time"
                      title={new Date(event.t * 1000).toLocaleString()}
                    >
                      {absoluteTime(event.t)}
                      <span className="flist-activity-rel">
                        {relativeTime(event.t)}
                      </span>
                    </span>
                    <span className="flist-activity-kind">
                      {eventLabel(event.kind)}
                    </span>
                    {detail && (
                      <span className="flist-activity-detail">{detail}</span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <footer className="modal-foot">
          {snap && (
            <span className="flist-activity-stats">
              {snap.event_count} event{snap.event_count === 1 ? '' : 's'}{' '}
              · capacity {snap.max_events} · sidecar up since{' '}
              {new Date(snap.started_at * 1000).toLocaleString()}
            </span>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void refresh()}
          >
            Refresh
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onClose}
            data-testid="flist-activity-close"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}
