import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../state'
import type { FlistZipBackupEntry } from '../../lib/api'

/** Per-character Backups list in the sidebar. Reads from
 *  `flistArchive[activeId].zipBackups` (populated by
 *  `flistLoadArchive`). Right-click on a row → Browse / Download.
 *
 *  Grouped into three always-shown default folders by `kind`:
 *    - "Manual backups"     — manual_single + manual_bulk
 *    - "Automatic backups"  — import-triggered
 *    - "Scheduled backups"  — timer-driven (future)
 *  Any "unknown"-kind backups (created before the metadata write or
 *  hand-dropped into the folder) land in "Other backups" below. The
 *  three core sections are visible even when empty so the user can
 *  see the taxonomy at a glance.
 *
 *  Date label: backups are saved with UTC ISO-basic filenames
 *  (`YYYY-MM-DDTHHMMSSZ.zip`); `created_at` is the unix-seconds form
 *  parsed server-side. Rendered in the user's local timezone as
 *  "Today HH:MM" / "Yesterday HH:MM" / "YYYY-MM-DD HH:MM".
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
  const [deleteTarget, setDeleteTarget] = useState<FlistZipBackupEntry | null>(
    null
  )
  const [renameTarget, setRenameTarget] = useState<FlistZipBackupEntry | null>(
    null
  )
  const menuRef = useRef<HTMLDivElement | null>(null)

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

  const backups = archive?.zipBackups ?? []
  const status = archive?.zipBackupsStatus ?? 'idle'
  const error = archive?.zipBackupsError ?? null

  const groups = useMemo(() => groupByKind(backups), [backups])

  if (!activeId) {
    return (
      <>
        <div className="sb-section-h">Backups</div>
        <div className="sb-empty">Select a character to see backups.</div>
      </>
    )
  }

  return (
    <>
      <div className="sb-section-h">Backups</div>
      {status === 'loading' && backups.length === 0 ? (
        <div className="sb-empty sb-empty-inline">Loading…</div>
      ) : status === 'error' ? (
        <div className="sb-empty sb-empty-inline" title={error ?? undefined}>
          Couldn't load backups.
        </div>
      ) : (
        <div className="sb-backups-folders" data-testid="sb-backups-folders">
          {groups.map((g) => (
            <BackupsFolder
              key={g.id}
              label={g.label}
              entries={g.entries}
              hideWhenEmpty={g.hideWhenEmpty}
              activeId={activeId}
              browseBackup={browseBackup}
              onContextMenu={(x, y, b) => setMenu({ x, y, backup: b })}
            />
          ))}
          {backups.length === 0 && (
            <div className="sb-empty sb-empty-inline">
              No backups yet. Right-click your character above → Back up now.
            </div>
          )}
        </div>
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
          <button
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              const cid = activeId
              const fname = menu.backup.filename
              setMenu(null)
              void useStore.getState().flistCreateSetFromBackup(cid, fname)
            }}
          >
            Create working set from backup
          </button>
          <button
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              const b = menu.backup
              setMenu(null)
              setRenameTarget(b)
            }}
          >
            Rename…
          </button>
          <button
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              const cid = activeId
              const fname = menu.backup.filename
              setMenu(null)
              void useStore.getState().flistDownloadZipBackup(cid, fname)
            }}
          >
            Download ZIP…
          </button>
          <div className="ctx-menu-divider" role="separator" />
          <button
            className="ctx-menu-item ctx-menu-item-danger"
            role="menuitem"
            onClick={() => {
              const b = menu.backup
              setMenu(null)
              setDeleteTarget(b)
            }}
          >
            Delete backup…
          </button>
        </div>
      )}
      {deleteTarget && (
        <DeleteBackupConfirm
          backup={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget
            setDeleteTarget(null)
            void useStore
              .getState()
              .flistDeleteZipBackup(activeId, target.filename)
          }}
        />
      )}
      {renameTarget && (
        <RenameBackupDialog
          backup={renameTarget}
          onCancel={() => setRenameTarget(null)}
          onConfirm={(picked) => {
            const target = renameTarget
            setRenameTarget(null)
            void useStore
              .getState()
              .flistRenameZipBackup(activeId, target.filename, picked)
          }}
        />
      )}
    </>
  )
}

function RenameBackupDialog({
  backup,
  onCancel,
  onConfirm
}: {
  backup: FlistZipBackupEntry
  onCancel: () => void
  onConfirm: (name: string) => void
}) {
  const [value, setValue] = useState(backup.name ?? '')
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  return (
    <div className="modal-backdrop" data-testid="rename-backup-dialog">
      <div className="modal" role="dialog" aria-modal="true">
        <h3 className="modal-title">Rename backup</h3>
        <p>
          <small>{backup.filename}</small>
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onConfirm(value)
          }}
        >
          <input
            className="rename-backup-input"
            type="text"
            placeholder="(leave empty to use the timestamp)"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            maxLength={120}
          />
          <div className="modal-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit">Save</button>
          </div>
        </form>
      </div>
    </div>
  )
}

function DeleteBackupConfirm({
  backup,
  onCancel,
  onConfirm
}: {
  backup: FlistZipBackupEntry
  onCancel: () => void
  onConfirm: () => void
}) {
  // Backdrop-click dismiss is deliberately not wired — per
  // feedback_no_backdrop_dismiss the Workbench convention is to
  // require an explicit Cancel / Delete / Esc.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  return (
    <div className="modal-backdrop" data-testid="delete-backup-confirm">
      <div className="modal modal-confirm" role="dialog" aria-modal="true">
        <h3 className="modal-title">Delete this backup?</h3>
        <p>
          <strong>{backup.filename}</strong>
        </p>
        <p>
          The ZIP and every byte it carries will be removed from disk.
          This can't be undone.
        </p>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-danger"
            onClick={onConfirm}
            autoFocus
          >
            Delete backup
          </button>
        </div>
      </div>
    </div>
  )
}

type BackupGroup = {
  id: string
  label: string
  entries: FlistZipBackupEntry[]
  /** "Other backups" hides when empty so the sidebar isn't littered
   *  with a section that almost never has anything. The three core
   *  folders stay visible to signal the taxonomy. */
  hideWhenEmpty: boolean
}

function groupByKind(backups: FlistZipBackupEntry[]): BackupGroup[] {
  const manual: FlistZipBackupEntry[] = []
  const automatic: FlistZipBackupEntry[] = []
  const scheduled: FlistZipBackupEntry[] = []
  const other: FlistZipBackupEntry[] = []
  for (const b of backups) {
    switch (b.kind) {
      case 'manual_single':
      case 'manual_bulk':
        manual.push(b)
        break
      case 'import':
        automatic.push(b)
        break
      case 'scheduled':
        scheduled.push(b)
        break
      default:
        other.push(b)
    }
  }
  return [
    { id: 'manual', label: 'Manual backups', entries: manual, hideWhenEmpty: false },
    { id: 'automatic', label: 'Automatic backups', entries: automatic, hideWhenEmpty: false },
    { id: 'scheduled', label: 'Scheduled backups', entries: scheduled, hideWhenEmpty: false },
    { id: 'other', label: 'Other backups', entries: other, hideWhenEmpty: true }
  ]
}

function BackupsFolder({
  label,
  entries,
  hideWhenEmpty,
  activeId,
  browseBackup,
  onContextMenu
}: {
  label: string
  entries: FlistZipBackupEntry[]
  hideWhenEmpty: boolean
  activeId: string
  browseBackup: ReturnType<typeof useStore.getState>['flistBrowseBackup']
  onContextMenu: (x: number, y: number, b: FlistZipBackupEntry) => void
}) {
  if (hideWhenEmpty && entries.length === 0) return null
  return (
    <div className="sb-backup-folder">
      <div className="sb-backup-folder-h">
        <span className="sb-backup-folder-title">{label}</span>
        <span className="sb-backup-folder-count">{entries.length}</span>
      </div>
      {entries.length === 0 ? (
        <div className="sb-backup-folder-empty">—</div>
      ) : (
        <ul className="sb-backups">
          {entries.map((b) => {
            const isBrowsing =
              browseBackup?.characterId === activeId &&
              browseBackup?.filename === b.filename
            return (
              <li
                key={b.filename}
                className={
                  'sb-backup-row' +
                  (isBrowsing ? ' sb-backup-row-active' : '')
                }
                onContextMenu={(e) => {
                  e.preventDefault()
                  onContextMenu(e.clientX, e.clientY, b)
                }}
                onDoubleClick={() => {
                  void useStore
                    .getState()
                    .flistOpenBrowseBackup(activeId, b.filename)
                }}
                title={`Right-click for options · ${b.filename}`}
              >
                <div className="sb-backup-row-text">
                  {b.name ? (
                    <>
                      <span className="sb-backup-name">{b.name}</span>
                      <span className="sb-backup-date sb-backup-date-sub">
                        {formatBackupDate(b.created_at)}
                      </span>
                    </>
                  ) : (
                    <span className="sb-backup-date">
                      {formatBackupDate(b.created_at)}
                    </span>
                  )}
                </div>
                <span className="sb-backup-size">{formatSize(b.size)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
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

