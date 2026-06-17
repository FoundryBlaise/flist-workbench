import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../state'
import type { FlistZipBackupEntry } from '../../lib/api'

/** Per-character Backups list in the sidebar. Reads from
 *  `flistArchive[activeId].zipBackups` (populated by
 *  `flistLoadArchive`). Right-click on a row → "Browse backup" opens
 *  the editor in read-only browse mode for that backup.
 *
 *  Empty states:
 *  - No active character → "Select a character to see backups."
 *  - Active character with no pulls yet → loading dots fade to
 *    "No backups yet. Use Back up now from the character menu."
 *  - Active character with empty `zipBackups: []` after load → same
 *    "No backups yet" copy.
 *
 *  Date formatting: backups are saved with UTC ISO-basic filenames
 *  (`YYYY-MM-DDTHHMMSSZ.zip`); `created_at` on each entry is the
 *  unix-seconds form of that timestamp parsed server-side. We render
 *  in the user's local timezone for readability ("Today 14:32", "Yesterday 09:11",
 *  "Mar 4 18:00", "2025-12-30 23:45" for older entries).
 */
export function BackupsList() {
  const activeId = useStore((s) => s.flistActiveCharacterId)
  const archive = useStore((s) =>
    activeId ? (s.flistArchive[activeId] ?? null) : null
  )
  const browseBackup = useStore((s) => s.flistBrowseBackup)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    backup: FlistZipBackupEntry
  } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Dismiss the context menu on outside click / Esc.
  useEffect(() => {
    if (!menu) return
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  if (!activeId) {
    return (
      <>
        <div className="sb-section-h">Backups</div>
        <div className="sb-empty">Select a character to see backups.</div>
      </>
    )
  }

  const backups = archive?.zipBackups ?? []
  const status = archive?.zipBackupsStatus ?? 'idle'
  const error = archive?.zipBackupsError ?? null

  return (
    <>
      <div className="sb-section-h">Backups</div>
      {status === 'loading' && backups.length === 0 ? (
        <div className="sb-empty sb-empty-inline">Loading…</div>
      ) : status === 'error' ? (
        <div className="sb-empty sb-empty-inline" title={error ?? undefined}>
          Couldn't load backups.
        </div>
      ) : backups.length === 0 ? (
        <div className="sb-empty">
          No backups yet. Right-click your character above → Back up now.
        </div>
      ) : (
        <ul className="sb-backups">
          {backups.map((b) => {
            const isBrowsing =
              browseBackup?.characterId === activeId &&
              browseBackup?.filename === b.filename
            return (
              <li
                key={b.filename}
                className={
                  'sb-backup-row' + (isBrowsing ? ' sb-backup-row-active' : '')
                }
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ x: e.clientX, y: e.clientY, backup: b })
                }}
                onDoubleClick={() => {
                  void useStore
                    .getState()
                    .flistOpenBrowseBackup(activeId, b.filename)
                }}
                title={`Right-click for options · ${b.filename}`}
              >
                <span className="sb-backup-date">{formatBackupDate(b.created_at)}</span>
                <span className="sb-backup-size">{formatSize(b.size)}</span>
              </li>
            )
          })}
        </ul>
      )}
      {menu && (
        <div
          ref={menuRef}
          className="ctx-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              const cid = activeId
              const fname = menu.backup.filename
              setMenu(null)
              void useStore.getState().flistOpenBrowseBackup(cid, fname)
            }}
          >
            Browse backup
          </button>
        </div>
      )}
    </>
  )
}

function formatBackupDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  if (isNaN(d.getTime())) return '—'
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) return `Today ${hhmm(d)}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const sameAsYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  if (sameAsYesterday) return `Yesterday ${hhmm(d)}`
  // Older entries: ISO date so sort is obvious at a glance.
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm(d)}`
}

function hhmm(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
