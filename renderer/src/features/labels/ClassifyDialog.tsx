import React, { useEffect, useRef, useState } from 'react'
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
  // The dialog is dismissable when the job reached a terminal state or
  // when the start request itself failed (no job ever existed).
  const canClose = isDone || (!!error && !job)
  // The very first poll(s) of an "all characters" run report
  // `total=0` while enumeration is still walking the filesystem. Drop
  // the progress bar / counter and show an indeterminate state so the
  // dialog doesn't look frozen at 0 / 0.
  const isEnumerating = job?.state === 'running' && job.total === 0

  // ESC + backdrop close. Both are no-ops while the job is still
  // running so the user has to make an explicit Cancel decision (no
  // accidentally clicking outside and losing the job handle).
  useEffect(() => {
    if (!canClose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [canClose, onClose])

  const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canClose) return
    // Only the backdrop itself, not anything inside the modal.
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={onBackdropClick}
    >
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
            disabled={!canClose}
            title={!canClose ? 'Cancel the job first' : 'Close'}
          >
            ✕
          </button>
        </header>
        <div className="modal-body">
          {error && <p className="settings-error">{error}</p>}
          {!job && !error && <p className="settings-help">Starting job…</p>}
          {job && (
            <>
              <div
                className={`classify-progress-bar${isEnumerating ? ' classify-progress-bar-indeterminate' : ''}`}
                aria-label="progress"
              >
                <div
                  className={`classify-progress-fill classify-state-${job.state}`}
                  style={{ width: isEnumerating ? '100%' : `${pct}%` }}
                />
              </div>
              <p className="classify-progress-text">
                {isEnumerating ? (
                  <>
                    <strong>Scanning conversations…</strong>{' '}
                    <span className={`classify-state classify-state-${job.state}`}>
                      {job.state}
                    </span>
                  </>
                ) : (
                  <>
                    <strong>{job.classified.toLocaleString()}</strong> /{' '}
                    {job.total.toLocaleString()} ({pct}%) ·{' '}
                    <span className={`classify-state classify-state-${job.state}`}>
                      {job.state}
                    </span>
                    {job.failed > 0 && (
                      <span className="classify-fail"> · {job.failed} failed</span>
                    )}
                  </>
                )}
              </p>
              {job.current_partner && job.state === 'running' && !isEnumerating && (
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
              {isDone && (
                <p className="classify-summary" data-testid="classify-summary">
                  <strong>Classified {job.classified.toLocaleString()}</strong> ·{' '}
                  {job.failed.toLocaleString()} failed ·{' '}
                  {(job.skipped_existing + job.skipped_rule).toLocaleString()} skipped
                  {job.state === 'cancelled' && ' (cancelled)'}
                </p>
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
              autoFocus
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
