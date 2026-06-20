import { useEffect, useState } from 'react'

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

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function UpdateAvailableModal({
  status,
  manualCheck = false,
  onDismiss
}: {
  status: UpdaterStatus
  manualCheck?: boolean
  onDismiss: () => void
}) {
  // Don't block dismiss while downloading — the download continues in
  // main; we just hide the modal. The user can re-open via the next
  // launch's prompt, or via a future menu entry.
  const installing = status.kind === 'downloaded'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onDismiss])

  const updater = window.workbench?.updater
  const [downloadStarting, setDownloadStarting] = useState(false)

  const handleDownload = () => {
    if (!updater) return
    setDownloadStarting(true)
    void updater.download().finally(() => setDownloadStarting(false))
  }

  const handleInstall = () => {
    updater?.install()
  }

  let title = 'Update available'
  let version: string | null = null
  let body: React.ReactNode = null
  let primary: { label: string; onClick: () => void; disabled?: boolean } | null = null
  let secondaryLabel = 'Later'

  if (status.kind === 'checking') {
    title = 'Checking for updates…'
    body = (
      <p>Asking GitHub if a newer version of F-list Workbench is available.</p>
    )
    primary = null
    secondaryLabel = 'Close'
  } else if (status.kind === 'not-available' && manualCheck) {
    title = "You're up to date"
    body = (
      <p>
        No newer version is available right now. Workbench checks again at
        each launch.
      </p>
    )
    primary = null
    secondaryLabel = 'Close'
  } else if (status.kind === 'available') {
    version = status.version
    body = (
      <>
        <p>
          A new version of F-list Workbench is available. Update now and
          we'll download it in the background — you can keep working.
        </p>
        {status.releaseNotes ? (
          <pre className="updater-modal-notes">{status.releaseNotes}</pre>
        ) : null}
      </>
    )
    primary = {
      label: downloadStarting ? 'Starting…' : 'Update now',
      onClick: handleDownload,
      disabled: downloadStarting
    }
  } else if (status.kind === 'downloading') {
    title = 'Downloading update'
    body = (
      <>
        <p>
          {formatBytes(status.transferred)} of {formatBytes(status.total)}
          {status.bytesPerSecond > 0
            ? ` · ${formatBytes(status.bytesPerSecond)}/s`
            : null}
        </p>
        <div className="updater-modal-progress">
          <div
            className="updater-modal-progress-bar"
            style={{ width: `${Math.max(0, Math.min(100, status.percent)).toFixed(1)}%` }}
          />
        </div>
        <p className="updater-modal-hint">
          You can close this dialog — the download will continue.
        </p>
      </>
    )
    primary = null
  } else if (installing && status.kind === 'downloaded') {
    title = 'Update ready'
    version = status.version
    body = (
      <p>
        Version {status.version} is ready to install. Workbench will close,
        install the update, and reopen.
      </p>
    )
    primary = { label: 'Restart and install', onClick: handleInstall }
  } else if (status.kind === 'error') {
    title = 'Update failed'
    body = (
      <p className="updater-modal-error">
        Couldn't fetch the update: {status.message}. You can retry later, or
        download the new version from the GitHub releases page manually.
      </p>
    )
    primary = null
    secondaryLabel = 'Close'
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal updater-modal">
        <header className="modal-head">
          <div>
            <h2 className="modal-title">{title}</h2>
            {version ? (
              <p className="modal-subtitle">Version {version}</p>
            ) : null}
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onDismiss}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="modal-body updater-modal-body">{body}</div>
        <footer className="modal-foot updater-modal-foot">
          <button
            type="button"
            className="updater-modal-secondary"
            onClick={onDismiss}
          >
            {secondaryLabel}
          </button>
          {primary ? (
            <button
              type="button"
              className="updater-modal-primary"
              onClick={primary.onClick}
              disabled={primary.disabled}
            >
              {primary.label}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  )
}
