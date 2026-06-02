import type { BackupListing } from './tier7Types'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTimestamp(epoch: number): string {
  const d = new Date(epoch * 1000)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${min}`
}

function sourceBadge(b: BackupListing): { ic: string; cls: string; label: string } {
  switch (b.source) {
    case 'auto-pull':
      return { ic: '🟢', cls: 'is-auto', label: 'Auto pull' }
    case 'manual-set':
      return {
        ic: '🔵',
        cls: 'is-manual-set',
        label: `Set: ${b.sourceName ?? '—'}`
      }
    case 'manual-snapshot':
      return {
        ic: '🔵',
        cls: 'is-manual-snap',
        label: `Snapshot: ${b.sourceName ?? '—'}`
      }
    case 'legacy-json':
      return { ic: '⚠', cls: 'is-legacy', label: 'Legacy (JSON only)' }
  }
}

export interface BackupRowProps {
  backup: BackupListing
  onContextMenu: (e: React.MouseEvent) => void
  onClick?: () => void
}

export function BackupRow({ backup, onContextMenu, onClick }: BackupRowProps) {
  const badge = sourceBadge(backup)
  return (
    <li
      className={`t7-backup-row ${badge.cls}`}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(e)
      }}
      onClick={onClick}
      title={backup.filename}
      data-testid={`t7-backup-row-${backup.filename}`}
    >
      <div className="t7-backup-line t7-backup-l1">
        <span className="t7-backup-time">{formatTimestamp(backup.createdAt)}</span>
        <span className="t7-backup-size">{formatBytes(backup.size)}</span>
      </div>
      <div className="t7-backup-line t7-backup-l2">
        <span className="t7-backup-badge-ic" aria-hidden="true">
          {badge.ic}
        </span>
        <span className="t7-backup-badge-label">{badge.label}</span>
      </div>
    </li>
  )
}
