import { useStore } from '../../state'

/** Live banner for Tools → "Back up all characters". Renders a single
 *  status line while the SSE stream is open, then a summary line for
 *  6s after completion (the store auto-clears to idle). Hidden during
 *  idle so it doesn't take up space. */
export function BackupAllBanner() {
  const status = useStore((s) => s.flistBackupAllStatus)
  if (status.phase === 'idle') return null
  const isScheduled = status.kind === 'scheduled'
  if (status.phase === 'error') {
    return (
      <div
        className="backup-all-banner backup-all-banner-error"
        role="alert"
        data-testid="backup-all-banner"
      >
        <span>
          <strong>
            {isScheduled ? 'Scheduled backup:' : 'Back up all:'}
          </strong>{' '}
          {status.errorMessage ?? 'something went wrong'}
        </span>
      </div>
    )
  }
  if (status.phase === 'running') {
    // Scheduled gets a one-sentence explainer so a user who didn't
    // press anything understands why their characters are getting
    // pulled. Manual bulk doesn't — they clicked the button.
    const headline = status.currentName
      ? isScheduled
        ? `Scheduled backup · pulling ${status.currentName}…`
        : `Backing up ${status.currentName}…`
      : isScheduled
        ? 'Scheduled backup running…'
        : 'Backing up…'
    return (
      <div
        className="backup-all-banner backup-all-banner-running"
        role="status"
        data-testid="backup-all-banner"
      >
        <span>
          <strong>{headline}</strong>{' '}
          {status.total > 0
            ? `(${status.done}/${status.total})`
            : null}
        </span>
        {isScheduled && (
          <span className="backup-all-banner-sub">
            Pulling latest data and snapshotting characters whose
            content has changed since the last backup. Safe to keep
            working — this runs in the background.
          </span>
        )}
        <span className="backup-all-banner-tally">
          {status.saved} saved · {status.unchanged} unchanged
          {status.failed > 0 ? ` · ${status.failed} failed` : ''}
        </span>
      </div>
    )
  }
  // phase === 'done'
  const noun = status.saved === 1 ? 'backup' : 'backups'
  return (
    <div
      className="backup-all-banner backup-all-banner-done"
      role="status"
      data-testid="backup-all-banner"
    >
      <span>
        <strong>
          {isScheduled
            ? 'Scheduled backup complete.'
            : 'Back up all complete.'}
        </strong>{' '}
        Wrote {status.saved} {noun}, {status.unchanged} unchanged
        {status.failed > 0 ? `, ${status.failed} failed` : ''}.
      </span>
    </div>
  )
}
