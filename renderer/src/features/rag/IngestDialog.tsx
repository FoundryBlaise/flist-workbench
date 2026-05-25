import React, { useEffect, useRef, useState } from 'react'
import { api, type IngestJob, type IngestJobScope } from '../../lib/api'

const POLL_MS = 500

export type IngestDialogProps = {
  scope: IngestJobScope
  // Human-readable label like "Lunii", "All partners for Auldren Nazr",
  // "All characters". Shown in the dialog header.
  scopeLabel: string
  // When true the very first ingest call asks the sidecar to wipe the
  // Qdrant collection before re-indexing. Used by Settings →
  // "Re-ingest all". Default false. The model-swap-confirmation path
  // also re-fires the job with this on, regardless of the prop.
  forceRewipe?: boolean
  onClose: () => void
}

// Parent renders this with a key derived from the scope so re-opening
// with a different scope remounts the component — same pattern as
// ClassifyDialog. The job is kicked off in the mount effect.
export function IngestDialog({
  scope,
  scopeLabel,
  forceRewipe = false,
  onClose
}: IngestDialogProps) {
  // 'configuring' shows the overwrite checkbox + Start; 'running' is
  // the live job. Settings → Re-ingest All passes forceRewipe=true and
  // we skip straight to 'running' so the user doesn't have to click
  // Start twice for the same intent (they already confirmed in
  // Settings).
  const [phase, setPhase] = useState<'configuring' | 'running'>(
    forceRewipe ? 'running' : 'configuring'
  )
  const [overwrite, setOverwrite] = useState<boolean>(forceRewipe)
  const [job, setJob] = useState<IngestJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pulseCancel, setPulseCancel] = useState(false)
  // When the sidecar detects a model swap it bounces us with state=failed
  // and model_swap=true; track whether we've already asked the user to
  // confirm the wipe so the dialog doesn't loop.
  const [wipeOffered, setWipeOffered] = useState(false)
  const pollTimer = useRef<number | null>(null)
  const jobIdRef = useRef<string | null>(null)
  const pulseTimer = useRef<number | null>(null)

  useEffect(() => {
    if (forceRewipe) {
      startJob({ force_rewipe: true })
    }
    return () => {
      if (pollTimer.current !== null) window.clearInterval(pollTimer.current)
      if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startJob = ({ force_rewipe }: { force_rewipe: boolean }) => {
    setPhase('running')
    setError(null)
    setJob(null)
    api
      .ragIngestStart(scope, { force_rewipe })
      .then((j) => {
        setJob(j)
        jobIdRef.current = j.id
        startPolling(j.id)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  const startPolling = (id: string) => {
    if (pollTimer.current !== null) window.clearInterval(pollTimer.current)
    pollTimer.current = window.setInterval(() => {
      api
        .ragJobGet(id)
        .then((next) => {
          setJob(next)
          if (isTerminal(next.state)) {
            if (pollTimer.current !== null) {
              window.clearInterval(pollTimer.current)
              pollTimer.current = null
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
      await api.ragJobCancel(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const confirmRewipe = () => {
    setWipeOffered(true)
    startJob({ force_rewipe: true })
  }

  const isDone = job ? isTerminal(job.state) : false
  const canClose = phase === 'configuring' || isDone || (!!error && !job)
  const showModelSwapPrompt =
    !!job && job.state === 'failed' && job.model_swap && !wipeOffered
  // Total stays at 0 during the partner-enumeration phase of an
  // "all characters" run; show an indeterminate bar so the user
  // doesn't think it's stuck.
  const isEnumerating =
    job?.state === 'running' && job.total_chunks === 0 && job.upserted === 0
  const denom = job?.total_chunks ?? 0
  const num = job?.upserted ?? 0
  const pct = denom > 0 ? Math.min(100, Math.round((num / denom) * 100)) : 0

  useEffect(() => {
    if (!canClose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [canClose, onClose])

  const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (canClose) {
      onClose()
      return
    }
    setPulseCancel(true)
    if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current)
    pulseTimer.current = window.setTimeout(() => setPulseCancel(false), 700)
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={onBackdropClick}
    >
      <div className="modal classify-modal" data-testid="ingest-dialog">
        <header className="modal-head">
          <div>
            <h2 className="modal-title">Ingest into RAG index</h2>
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
          {phase === 'configuring' && !error && (
            <>
              <p className="settings-help">
                Walks every IC chunk in scope through the embedding
                model and upserts to the local vector index. Re-runs
                are cheap by default — chunks already in the index get
                skipped via deterministic IDs.
              </p>
              <label
                className="settings-checkbox-row"
                data-testid="ingest-overwrite-row"
              >
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(e) => setOverwrite(e.target.checked)}
                  data-testid="ingest-overwrite-input"
                />
                <span>
                  <strong>Wipe &amp; re-embed already-indexed chunks</strong>
                  <span className="settings-meta">
                    Drops every chunk in this scope first, then
                    re-embeds from scratch. Use after changing chunk
                    settings, the classifier prompt, or linking an
                    alias — the deterministic-ID skip won't notice
                    those changes on its own.
                  </span>
                </span>
              </label>
            </>
          )}
          {phase === 'running' && !job && !error && (
            <p className="settings-help">Starting ingest…</p>
          )}
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
                    <strong>Chunking conversations…</strong>{' '}
                    <StatePill state={job.state} />
                  </>
                ) : (
                  <>
                    <strong>{num.toLocaleString()}</strong> /{' '}
                    {denom.toLocaleString()} ({pct}%) embedded ·{' '}
                    <StatePill state={job.state} />
                    {job.failed > 0 && (
                      <span className="classify-fail"> · {job.failed} failed</span>
                    )}
                  </>
                )}
              </p>
              {job.current_partner && job.state === 'running' && (
                <p className="classify-current">
                  Working on: <code>{job.current_partner}</code>
                </p>
              )}
              {job.skipped_existing > 0 && (
                <p className="settings-meta">
                  Skipped {job.skipped_existing.toLocaleString()} already-indexed
                  chunks — re-runs are cheap.
                </p>
              )}
              {job.embed_model && job.embed_dimension && (
                <p className="settings-meta">
                  Embedding model: <code>{job.embed_model}</code> (dim{' '}
                  {job.embed_dimension})
                </p>
              )}
              {job.last_error && (
                <p className="settings-meta classify-last-error">
                  Last error: {job.last_error}
                </p>
              )}
              {showModelSwapPrompt && (
                <p className="settings-error">
                  {job.error}
                </p>
              )}
              {job.state === 'failed' && !job.model_swap && job.error && (
                <p className="settings-error">Job failed: {job.error}</p>
              )}
              {isDone && !job.model_swap && (
                <p className="classify-summary" data-testid="ingest-summary">
                  <strong>Indexed {job.upserted.toLocaleString()}</strong> new
                  chunks · {job.failed.toLocaleString()} failed ·{' '}
                  {job.skipped_existing.toLocaleString()} skipped
                  {job.state === 'cancelled' && ' (cancelled)'}
                </p>
              )}
            </>
          )}
        </div>
        <div className="modal-actions">
          {phase === 'configuring' && !error && (
            <>
              <button
                type="button"
                className="settings-clear"
                onClick={onClose}
                data-testid="ingest-preflight-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className="settings-save"
                onClick={() => startJob({ force_rewipe: overwrite })}
                data-testid="ingest-preflight-start"
                autoFocus
              >
                {overwrite ? 'Wipe & re-ingest' : 'Start ingest'}
              </button>
            </>
          )}
          {phase === 'running' && job && !isDone && (
            <button
              type="button"
              className={`settings-clear${pulseCancel ? ' classify-cancel-pulse' : ''}`}
              onClick={() => void cancel()}
              data-testid="ingest-cancel"
            >
              Cancel
            </button>
          )}
          {showModelSwapPrompt && (
            <button
              type="button"
              className="settings-save"
              onClick={confirmRewipe}
              data-testid="ingest-confirm-wipe"
              autoFocus
            >
              Wipe + re-ingest
            </button>
          )}
          {(isDone || (error && phase === 'running')) && !showModelSwapPrompt && (
            <button
              type="button"
              className="settings-save"
              onClick={onClose}
              data-testid="ingest-close"
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

function isTerminal(state: IngestJob['state']): boolean {
  return state === 'done' || state === 'cancelled' || state === 'failed'
}

function StatePill({ state }: { state: IngestJob['state'] }) {
  const glyph =
    state === 'running'
      ? '◌'
      : state === 'done'
        ? '✓'
        : state === 'failed'
          ? '✕'
          : state === 'cancelled'
            ? '⏹'
            : '·'
  return (
    <span className={`classify-state classify-state-${state}`}>
      <span className="classify-state-glyph" aria-hidden>
        {glyph}
      </span>
      {state}
    </span>
  )
}
