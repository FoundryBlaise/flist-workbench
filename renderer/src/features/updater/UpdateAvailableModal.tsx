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
 * Slim banner pinned at the top of the app — replaces the earlier
 * full-screen modal. One line, current → new version, two buttons.
 *
 * Background launches that find no update never render this. Manual
 * checks (Help → Check for Updates) opt into the "checking" /
 * "up to date" / "error" states by passing `manualCheck`; the
 * "up to date" line self-dismisses after a few seconds.
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

  // Self-dismiss the manual "you're up to date" line after a beat so
  // it doesn't sit there forever once the user has seen it.
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
    tone = 'info'
    line = <span>Checking for updates…</span>
  } else if (status.kind === 'not-available' && manualCheck) {
    tone = 'info'
    line = (
      <span>
        You're on the latest version{currentVersion ? ` (${currentVersion})` : ''}.
      </span>
    )
  } else if (status.kind === 'available') {
    tone = 'info'
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
    <div className={`updater-banner updater-banner-${tone}`} role="status">
      {percent !== null ? (
        <div
          className="updater-banner-progress"
          style={{ width: `${percent}%` }}
          aria-hidden
        />
      ) : null}
      <div className="updater-banner-line">{line}</div>
      <div className="updater-banner-actions">
        {primary ? (
          <button
            type="button"
            className="updater-banner-primary"
            onClick={primary.onClick}
          >
            {primary.label}
          </button>
        ) : null}
        <button
          type="button"
          className="updater-banner-close"
          onClick={onDismiss}
          aria-label="Dismiss"
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
