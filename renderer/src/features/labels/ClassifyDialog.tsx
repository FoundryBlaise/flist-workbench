import { useEffect, useRef, useState } from 'react'
import { api, type ClassifyJob, type ClassifyJobScope } from '../../lib/api'
import { useStore } from '../../state'

const POLL_MS = 500

export type ClassifyDialogProps = {
  scope: ClassifyJobScope
  // Human-readable label like "Lunii", "All partners for Auldren Nazr",
  // "All characters". Shown in the dialog header.
  scopeLabel: string
  onClose: () => void
}

export function ClassifyDialog({ scope, scopeLabel, onClose }: ClassifyDialogProps) {
  const [job, setJob] = useState<ClassifyJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollTimer = useRef<number | null>(null)
  const jobIdRef = useRef<string | null>(null)
  const refreshMessages = useStore((s) => s.loadMessages)

  useEffect(() => {
    let cancelled = false
    api
      .labelsClassifyStart(scope)
      .then((j) => {
        if (cancelled) return
        setJob(j)
        jobIdRef.current = j.id
        startPolling(j.id)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
      if (pollTimer.current !== null) {
        window.clearInterval(pollTimer.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startPolling = (id: string) => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current)
    }
    pollTimer.current = window.setInterval(() => {
      api
        .labelsJobGet(id)
        .then((next) => {
          setJob(next)
          if (next.state === 'done' || next.state === 'cancelled' || next.state === 'failed') {
            if (pollTimer.current !== null) {
              window.clearInterval(pollTimer.current)
              pollTimer.current = null
            }
            // Refresh the open conversation so newly-set labels appear.
            if (scope.character && scope.partner) {
              void refreshMessages(scope.character, scope.partner)
            }
          }
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err))
        })
    }, POLL_MS)
  }

  const cancel = async () => {
    const id = jobIdRef.current
    if (!id || !job || isTerminal(job.state)) return
    try {
      await api.labelsJobCancel(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const pct = job && job.total > 0 ? Math.round((job.classified / job.total) * 100) : 0
  const isDone = job ? isTerminal(job.state) : false

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal classify-modal" data-testid="classify-dialog">
        <header className="modal-head">
          <div>
            <h2 className="modal-title">Classify labels</h2>
            <p className="modal-subtitle">{scopeLabel}</p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
            disabled={!isDone && !error}
            title={!isDone && !error ? 'Cancel the job first' : 'Close'}
          >
            ✕
          </button>
        </header>
        <div className="modal-body">
          {error && <p className="settings-error">{error}</p>}
          {!job && !error && <p className="settings-help">Starting job…</p>}
          {job && (
            <>
              <div className="classify-progress-bar" aria-label="progress">
                <div
                  className={`classify-progress-fill classify-state-${job.state}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="classify-progress-text">
                <strong>{job.classified.toLocaleString()}</strong> /{' '}
                {job.total.toLocaleString()} ({pct}%) ·{' '}
                <span className={`classify-state classify-state-${job.state}`}>{job.state}</span>
                {job.failed > 0 && <span className="classify-fail"> · {job.failed} failed</span>}
              </p>
              {job.current_partner && (
                <p className="classify-current">
                  Working on: <code>{job.current_partner}</code>
                </p>
              )}
              {(job.skipped_existing > 0 || job.skipped_rule > 0) && (
                <p className="settings-meta">
                  Skipped {job.skipped_existing.toLocaleString()} already-labeled and{' '}
                  {job.skipped_rule.toLocaleString()} caught by rules — only{' '}
                  {job.total.toLocaleString()} sent to the LLM.
                </p>
              )}
              {job.last_label && job.state === 'running' && (
                <p className="settings-meta">Last result: {job.last_label}</p>
              )}
              {job.last_error && (
                <p className="settings-meta classify-last-error">
                  Last error: {job.last_error}
                </p>
              )}
              {job.state === 'failed' && job.error && (
                <p className="settings-error">Job failed: {job.error}</p>
              )}
            </>
          )}
        </div>
        <div className="modal-actions">
          {job && !isDone && (
            <button
              type="button"
              className="settings-clear"
              onClick={() => void cancel()}
              data-testid="classify-cancel"
            >
              Cancel
            </button>
          )}
          {(isDone || error) && (
            <button
              type="button"
              className="settings-save"
              onClick={onClose}
              data-testid="classify-close"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function isTerminal(state: ClassifyJob['state']): boolean {
  return state === 'done' || state === 'cancelled' || state === 'failed'
}
