import { useState } from 'react'
import { BackupRow } from './BackupRow'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import type { BackupListing } from './tier7Types'

interface CtxAnchor {
  filename: string
  x: number
  y: number
}

export interface BackupsSectionProps {
  backups: BackupListing[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  onMakeBackup: () => void
  onRevealBackup: (filename: string) => void
  onCopyBackupPath: (filename: string) => void
  onExportBackup: (filename: string) => void
  onDeleteBackup: (filename: string) => void
}

export function BackupsSection({
  backups,
  status,
  onMakeBackup,
  onRevealBackup,
  onCopyBackupPath,
  onExportBackup,
  onDeleteBackup
}: BackupsSectionProps) {
  const [ctx, setCtx] = useState<CtxAnchor | null>(null)

  const items = (b: BackupListing): ContextMenuItem[] => {
    const legacy = b.source === 'legacy-json'
    return [
      { label: 'Reveal in folder', onSelect: () => onRevealBackup(b.filename) },
      { label: 'Copy path', onSelect: () => onCopyBackupPath(b.filename) },
      {
        label: 'Export ZIP to…',
        onSelect: () => onExportBackup(b.filename),
        disabled: legacy,
        hint: legacy ? 'Legacy JSON snapshots — no images, export disabled' : undefined
      },
      {
        label: 'Restore as new set',
        onSelect: () => {},
        disabled: true,
        hint: 'Import-as-set lands later'
      },
      {
        label: 'Delete…',
        onSelect: () => onDeleteBackup(b.filename),
        danger: true,
        disabled: legacy,
        hint: legacy ? 'Remove legacy *.json from disk manually' : undefined
      }
    ]
  }

  return (
    <div className="t7-backups" data-testid="t7-backups">
      <div className="t7-backups-actions">
        <button
          type="button"
          className="t7-backups-make"
          onClick={onMakeBackup}
          data-testid="t7-backups-make"
        >
          + Make backup…
        </button>
        <button
          type="button"
          className="t7-help"
          aria-label="About backups"
          title={
            'Backups are self-contained ZIP archives (including image bytes) ' +
            'that you can hand to the flistcharexporter userscript to restore ' +
            'this character on F-list. Every pull writes an auto-backup; you ' +
            'can also create manual backups from any set or snapshot.'
          }
        >
          (?)
        </button>
      </div>
      {status === 'loading' && backups.length === 0 ? (
        <div className="t7-backups-empty">Loading…</div>
      ) : backups.length === 0 ? (
        <div className="t7-backups-empty">
          No backups yet. Pull the character — one is created automatically.
        </div>
      ) : (
        <ul className="t7-backup-list">
          {backups.map((b) => (
            <BackupRow
              key={b.filename}
              backup={b}
              onContextMenu={(e) =>
                setCtx({ filename: b.filename, x: e.clientX, y: e.clientY })
              }
            />
          ))}
        </ul>
      )}
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={items(backups.find((b) => b.filename === ctx.filename)!)}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  )
}
