import { useEffect } from 'react'

export type UpdaterStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseNotes?: string | null }
  | {
      kind: 'downloading'
      percent: number
      bytesPerSecond: number
      transferred: number
      total: number
    }
  | { kind: 'downloaded'; version: string }
  | { kind: 'not-available' }
  | { kind: 'error'; message: string }

/**
 * Floating card pinned to the bottom-left. Doesn't take document
 * flow — sits on top of whatever's underneath. Compact: one line of
 * status + the relevant button + a close ✕.
 *
 * Auto-discovered updates (background launch check) and manual
 * checks (Help → Check for Updates) both use the same card. Manual
 * checks opt into the "checking" / "up to date" / "error" states by
 * passing `manualCheck`; the "up to date" line self-dismisses after
 * a few seconds.
 */
export function UpdateAvailableModal({
  status,
  manualCheck = false,
  onDismiss
}: {
  status: UpdaterStatus
  manualCheck?: boolean
  onDismiss: () => void
}) {
  const updater = window.workbench?.updater
  const currentVersion = window.workbench?.appVersion ?? ''

  useEffect(() => {
    if (status.kind === 'not-available' && manualCheck) {
      const t = setTimeout(onDismiss, 4000)
      return () => clearTimeout(t)
    }
    return
  }, [status.kind, manualCheck, onDismiss])

  const handleDownload = () => {
    if (!updater) return
    void updater.download()
  }
  const handleInstall = () => updater?.install()

  let tone: 'info' | 'progress' | 'ready' | 'error' = 'info'
  let line: React.ReactNode = null
  let primary: { label: string; onClick: () => void } | null = null
  let percent: number | null = null

  if (status.kind === 'checking' && manualCheck) {
    line = <span>Checking for updates…</span>
  } else if (status.kind === 'not-available' && manualCheck) {
    line = (
      <span>
        You're on the latest version{currentVersion ? ` (${currentVersion})` : ''}.
      </span>
    )
  } else if (status.kind === 'available') {
    line = (
      <span>
        New version:{' '}
        <strong>
          {currentVersion || '?'} → {status.version}
        </strong>
      </span>
    )
    primary = { label: 'Update', onClick: handleDownload }
  } else if (status.kind === 'downloading') {
    tone = 'progress'
    percent = Math.max(0, Math.min(100, status.percent))
    line = <span>Downloading update… {percent.toFixed(0)}%</span>
  } else if (status.kind === 'downloaded') {
    tone = 'ready'
    line = (
      <span>
        Update ready{status.version ? `: ${status.version}` : ''}.
      </span>
    )
    primary = { label: 'Restart', onClick: handleInstall }
  } else if (status.kind === 'error' && manualCheck) {
    tone = 'error'
    line = <span>Update check failed: {status.message}</span>
  }

  if (line === null) return null

  return (
    <div className={`updater-toast updater-toast-${tone}`} role="status">
      <div className="updater-toast-line">{line}</div>
      <div className="updater-toast-actions">
        {primary ? (
          <button
            type="button"
            className="updater-toast-primary"
            onClick={primary.onClick}
          >
            {primary.label}
          </button>
        ) : null}
        <button
          type="button"
          className="updater-toast-close"
          onClick={onDismiss}
          aria-label="Dismiss"
          title="Dismiss"
        >
          ✕
        </button>
      </div>
      {percent !== null ? (
        <div
          className="updater-toast-progress"
          style={{ width: `${percent}%` }}
          aria-hidden
        />
      ) : null}
    </div>
  )
}
