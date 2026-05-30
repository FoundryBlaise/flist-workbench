import { useState } from 'react'
import { useStore } from '../../state'

function relativeTime(epoch: number | null | undefined): string {
  if (!epoch) return 'never'
  const seconds = Math.max(0, Date.now() / 1000 - epoch)
  if (seconds < 60) return 'just now'
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(epoch * 1000).toLocaleDateString()
}

export function FlistCharacterZone() {
  const session = useStore((s) => s.flistSession)
  const activeId = useStore((s) => s.flistActiveCharacterId)
  const archive = useStore((s) => s.flistArchive)
  const roster = useStore((s) => s.flistRoster)
  const pull = useStore((s) => s.flistPullCharacter)
  const saveBackup = useStore((s) => s.flistSaveBackup)
  const openLive = useStore((s) => s.flistOpenLive)
  const openBackup = useStore((s) => s.flistOpenBackup)
  const [backupsOpen, setBackupsOpen] = useState(true)

  if (!session.active || !activeId) return null
  const entry = roster.find((r) => String(r.id ?? '') === activeId)
  const name = entry?.name ?? 'Selected character'
  const slot = archive[activeId]
  const live = slot?.live
  const lastPulledAt = slot?.lastPullAt
  const backups = slot?.backups ?? []
  const pullStatus = slot?.pullStatus ?? 'idle'
  const pullStage = slot?.pullStage
  const pullProgress = slot?.pullProgress
  const pullError = slot?.pullError

  const inFlight = pullStatus === 'queued' || pullStatus === 'running'

  return (
    <div className="flist-zone" data-testid="flist-zone">
      <div className="flist-zone-header">
        <span className="flist-zone-name">{name}</span>
        {entry?.on_account && (
          <button
            type="button"
            className="flist-zone-pull"
            onClick={() => void pull(name, activeId)}
            disabled={inFlight}
            title="Refresh Live from F-list"
          >
            {inFlight
              ? pullProgress
                ? `${pullStage ?? '…'} ${pullProgress.done}/${pullProgress.total}`
                : (pullStage ?? '…')
              : '↻ Refresh'}
          </button>
        )}
      </div>
      {pullError && (
        <div className="flist-zone-error" role="alert" data-testid="flist-zone-error">
          {pullError}
        </div>
      )}
      <ul className="sb-list flist-zone-list">
        <li className="flist-zone-row flist-zone-working" title="Working copy editor lands in Tier 2">
          <span className="flist-zone-row-ic">✎</span>
          <span className="flist-zone-row-label">
            Working
            <span className="flist-zone-row-meta">(Tier 2 — coming soon)</span>
          </span>
        </li>
        <li
          className={`flist-zone-row flist-zone-live${live ? '' : ' is-empty'}`}
        >
          <button
            type="button"
            className="flist-zone-row-pick"
            onClick={() => {
              if (!live) return
              void openLive(activeId)
            }}
            disabled={!live}
          >
            <span className="flist-zone-row-ic">●</span>
            <span className="flist-zone-row-label">
              Live
              <span className="flist-zone-row-meta">
                {live ? `pulled ${relativeTime(lastPulledAt)}` : 'never pulled'}
              </span>
            </span>
          </button>
          {live && (
            <button
              type="button"
              className="flist-zone-save-backup"
              onClick={() => void saveBackup(activeId)}
              title="Snapshot the current Live into Backups"
            >
              💾 Save backup
            </button>
          )}
        </li>
      </ul>
      <div className="flist-zone-backups">
        <button
          type="button"
          className="flist-zone-backups-toggle"
          onClick={() => setBackupsOpen((v) => !v)}
          aria-expanded={backupsOpen}
        >
          {backupsOpen ? '▾' : '▸'} Backups ({backups.length})
        </button>
        {backupsOpen && backups.length > 0 && (
          <ul className="sb-list flist-zone-backup-list">
            {backups.map((b) => (
              <li key={b.filename} className="flist-zone-backup-row">
                <button
                  type="button"
                  className="flist-zone-row-pick"
                  onClick={() => void openBackup(activeId, b.filename)}
                  title={`${b.size.toLocaleString()} bytes`}
                >
                  <span className="flist-zone-row-ic">●</span>
                  <span className="flist-zone-row-label">
                    {new Date(b.created_at * 1000).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {backupsOpen && backups.length === 0 && (
          <div className="flist-zone-empty">No backups yet.</div>
        )}
      </div>
    </div>
  )
}
