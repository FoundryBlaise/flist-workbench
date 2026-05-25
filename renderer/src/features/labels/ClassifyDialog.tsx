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

// Parent renders this with a key derived from the scope so re-opening
// with a different scope remounts the component. That sidesteps the
// useEffect-deps trap where the start request only fires once per
// mount even if the scope prop changed.
export function ClassifyDialog({ scope, scopeLabel, onClose }: ClassifyDialogProps) {
  // Two phases: 'configuring' shows the overwrite checkbox + Start;
  // anything past that is the running/terminal job. Splitting them
  // lets the user opt into "Re-classify already-labeled messages"
  // before the LLM fires, matching the IngestDialog pre-flight.
  const [phase, setPhase] = useState<'configuring' | 'running'>('configuring')
  const [overwrite, setOverwrite] = useState(false)
  const [job, setJob] = useState<ClassifyJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pulseCancel, setPulseCancel] = useState(false)
  const pollTimer = useRef<number | null>(null)
  const jobIdRef = useRef<string | null>(null)
  const pulseTimer = useRef<number | null>(null)
  const activeChar = useStore((s) => s.activeCharacter)
  const activePartner = useStore((s) => s.activePartner)
  const reloadMessages = useStore((s) => s.loadMessages)
  const invalidateMessages = useStore((s) => s.invalidateMessages)

  useEffect(() => {
    return () => {
      if (pollTimer.current !== null) {
        window.clearInterval(pollTimer.current)
      }
      if (pulseTimer.current !== null) {
        window.clearTimeout(pulseTimer.current)
      }
    }
  }, [])

  const startJob = () => {
    if (phase === 'running') return
    setPhase('running')
    setError(null)
    api
      .labelsClassifyStart(scope, { overwrite })
      .then((j) => {
        setJob(j)
        jobIdRef.current = j.id
        startPolling(j.id)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  // Refresh the open conversation if the just-finished job's scope
  // touched it. For per-conversation jobs that's the obvious case. For
  // "all partners for character X" and "all characters" jobs we may
  // have updated the labels of whatever the user has open — invalidate
  // the cache and force a reload.
  const refreshOpenConversationIfTouched = () => {
    if (!activeChar || !activePartner) return
    const scopedChar = scope.character ?? null
    const scopedPartner = scope.partner ?? null
    const touchesOpen =
      (scopedChar === null && scopedPartner === null) ||
      (scopedChar === activeChar && scopedPartner === null) ||
      (scopedChar === activeChar && scopedPartner === activePartner)
    if (!touchesOpen) return
    invalidateMessages(activeChar, activePartner)
    void reloadMessages(activeChar, activePartner, { force: true })
  }

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
            refreshOpenConversationIfTouched()
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
  // The dialog is freely dismissable in the pre-flight configuring
  // phase (no job exists yet) and also when the job reached a terminal
  // state or
  // when the start request itself failed (no job ever existed).
  const canClose = phase === 'configuring' || isDone || (!!error && !job)
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
    // Only the backdrop itself, not anything inside the modal.
    if (e.target !== e.currentTarget) return
    if (canClose) {
      onClose()
      return
    }
    // While the job is running, backdrop is a no-op for the dismiss
    // intent — but the user clearly tried to close. Flash the Cancel
    // button so they see the recovery path.
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
            title={!canClose ? 'Cancel the running job first' : 'Close'}
          >
            ✕
          </button>
        </header>
        <div className="modal-body">
          {error && <p className="settings-error">{error}</p>}
          {phase === 'configuring' && !error && (
            <>
              <p className="settings-help">
                Sends every Unlabeled chat/action message in scope to
                the LLM. Short messages and <code>((…</code> openers
                stay rule-OOC without a model call.
              </p>
              <label
                className="settings-checkbox-row"
                data-testid="classify-overwrite-row"
              >
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(e) => setOverwrite(e.target.checked)}
                  data-testid="classify-overwrite-input"
                />
                <span>
                  <strong>Re-classify already-labeled messages</strong>
                  <span className="settings-meta">
                    Skips the "skip existing" guard and overwrites
                    every prior LLM/manual label in scope. Useful
                    after a prompt or model change. Manual overrides
                    are replaced; the previous label is preserved as a
                    one-step undo.
                  </span>
                </span>
              </label>
            </>
          )}
          {phase === 'running' && !job && !error && (
            <p className="settings-help">Starting job…</p>
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
                    <strong>Scanning conversations…</strong>{' '}
                    <StatePill state={job.state} />
                  </>
                ) : (
                  <>
                    <strong>{job.classified.toLocaleString()}</strong> /{' '}
                    {job.total.toLocaleString()} ({pct}%) ·{' '}
                    <StatePill state={job.state} />
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
          {phase === 'configuring' && !error && (
            <>
              <button
                type="button"
                className="settings-clear"
                onClick={onClose}
                data-testid="classify-preflight-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className="settings-save"
                onClick={startJob}
                data-testid="classify-preflight-start"
                autoFocus
              >
                {overwrite ? 'Re-classify' : 'Start'}
              </button>
            </>
          )}
          {phase === 'running' && job && !isDone && (
            <button
              type="button"
              className={`settings-clear${pulseCancel ? ' classify-cancel-pulse' : ''}`}
              onClick={() => void cancel()}
              data-testid="classify-cancel"
            >
              Cancel
            </button>
          )}
          {(isDone || (error && phase === 'running')) && (
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

// Small glyph + label per state so the pill doesn't carry meaning by
// colour alone. Glyphs are unicode so no asset pipeline needed.
function StatePill({ state }: { state: ClassifyJob['state'] }) {
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
