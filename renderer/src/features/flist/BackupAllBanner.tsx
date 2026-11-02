import { useStore } from '../../state'

/** Live banner for Tools → "Back up all characters". Renders a single
 *  status line, with Cancel, while the sweep's job runs, then a summary
 *  line for 6s after it finished or was cancelled (the store
 *  auto-clears to idle). Hidden during idle so it doesn't take up
 *  space. */
export function BackupAllBanner() {
  const status = useStore((s) => s.flistBackupAllStatus)
  const cancel = useStore((s) => s.flistCancelBackupAll)
  if (status.phase === 'idle') return null
  if (status.phase === 'error') {
    return (
      <div
        className="backup-all-banner backup-all-banner-error"
        role="alert"
        data-testid="backup-all-banner"
      >
        <span>
          <strong>Back up all:</strong>{' '}
          {status.errorMessage ?? 'something went wrong'}
        </span>
      </div>
    )
  }
  if (status.phase === 'running') {
    const headline = status.currentName
      ? `Backing up ${status.currentName}…`
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
        <span className="backup-all-banner-tally">
          {status.saved} saved · {status.unchanged} unchanged
          {status.failed > 0 ? ` · ${status.failed} failed` : ''}
        </span>
        {status.jobId && (
          <button
            type="button"
            className="backup-all-banner-cancel"
            onClick={() => void cancel()}
            data-testid="backup-all-cancel"
            title="Stop Back up all. The Backups it already wrote stay."
          >
            Cancel
          </button>
        )}
      </div>
    )
  }
  if (status.phase === 'cancelled') {
    return (
      <div
        className="backup-all-banner backup-all-banner-done"
        role="status"
        data-testid="backup-all-banner"
      >
        <span>
          <strong>Back up all cancelled.</strong>{' '}
          Wrote {status.saved} {status.saved === 1 ? 'backup' : 'backups'} before it stopped.
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
        <strong>Back up all complete.</strong>{' '}
        Wrote {status.saved} {noun}, {status.unchanged} unchanged
        {status.failed > 0 ? `, ${status.failed} failed` : ''}.
      </span>
    </div>
  )
}
