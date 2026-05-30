import { useStore } from '../../state'
import type { FlistBackupEntry } from '../../lib/api'

// Stable fallback — see DiffPane for the same identity guard.
const DEFAULT_RIGHT_SOURCE = { kind: 'live' } as const

function relTime(unixSec: number | null | undefined): string {
  if (!unixSec) return 'never'
  const secs = Math.max(0, Date.now() / 1000 - unixSec)
  if (secs < 60) return 'just now'
  const m = Math.floor(secs / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return isoDate(unixSec)
}

/** ISO-flavoured timestamp, locale-neutral (UX P3-8). */
function isoDate(unixSec: number): string {
  return new Date(unixSec * 1000)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ')
}

export function BackupPicker({ characterId }: { characterId: string }) {
  const source = useStore(
    (s) => s.flistDiffRightSource[characterId] ?? DEFAULT_RIGHT_SOURCE
  )
  const setSource = useStore((s) => s.flistDiffSetRightSource)
  const loadBackup = useStore((s) => s.flistDiffLoadBackup)
  const archive = useStore((s) => s.flistArchive[characterId])
  const lastPullAt = archive?.lastPullAt
  // Backup picker sort: newest first; Live always pinned at top.
  const backups: FlistBackupEntry[] = archive?.backups ?? []
  const value = source.kind === 'live' ? '__live__' : `b:${source.filename}`
  return (
    <label className="diff-backup-picker">
      <span className="diff-backup-picker-label">Compare Working against</span>
      <select
        className="diff-backup-picker-select"
        value={value}
        data-testid="diff-backup-picker"
        title={
          lastPullAt
            ? `Live pulled at ${isoDate(lastPullAt)} UTC`
            : 'Live not pulled yet'
        }
        onChange={(e) => {
          const v = e.target.value
          if (v === '__live__') {
            setSource(characterId, { kind: 'live' })
            return
          }
          if (v.startsWith('b:')) {
            const filename = v.slice(2)
            void loadBackup(characterId, filename)
            setSource(characterId, { kind: 'backup', filename })
          }
        }}
      >
        <option value="__live__">Live (pulled {relTime(lastPullAt)})</option>
        {backups.map((b) => (
          <option key={b.filename} value={`b:${b.filename}`}>
            Backup · {isoDate(b.created_at)}
          </option>
        ))}
      </select>
    </label>
  )
}
