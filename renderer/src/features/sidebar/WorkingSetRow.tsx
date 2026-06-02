import { useEffect, useRef, useState } from 'react'
import type { SetMeta, SnapshotMeta } from './tier7Types'

function relativeTime(epoch: number): string {
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

export interface WorkingSetRowProps {
  set: SetMeta
  isActive: boolean
  expanded: boolean
  snapshots: SnapshotMeta[]
  snapshotsLoaded: boolean
  renaming: boolean
  renameInitial: string
  onToggleExpand: () => void
  onActivate: () => void
  onCommitRename: (next: string) => void
  onCancelRename: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onSnapshotContextMenu: (snap: SnapshotMeta, e: React.MouseEvent) => void
  onTakeSnapshot: () => void
  onRevertSnapshot: (snap: SnapshotMeta) => void
}

export function WorkingSetRow({
  set,
  isActive,
  expanded,
  snapshots,
  snapshotsLoaded,
  renaming,
  renameInitial,
  onToggleExpand,
  onActivate,
  onCommitRename,
  onCancelRename,
  onContextMenu,
  onSnapshotContextMenu,
  onTakeSnapshot,
  onRevertSnapshot
}: WorkingSetRowProps) {
  const [value, setValue] = useState(renameInitial)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) {
      setValue(renameInitial)
      const id = requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
      return () => cancelAnimationFrame(id)
    }
  }, [renaming, renameInitial])

  const chev = expanded ? '▾' : '▸'
  const status = isActive ? '✱' : '·'

  return (
    <li
      className={`t7-set-row${isActive ? ' is-active' : ''}${expanded ? ' is-expanded' : ''}`}
      data-testid={`t7-set-row-${set.id}`}
    >
      <div
        className="t7-set-head"
        onContextMenu={(e) => {
          e.preventDefault()
          onContextMenu(e)
        }}
      >
        <button
          type="button"
          className="t7-set-chev"
          onClick={onToggleExpand}
          aria-label={expanded ? 'Collapse set' : 'Expand set'}
        >
          {chev}
        </button>
        <span className="t7-set-marker" aria-hidden="true">
          {status}
        </span>
        {renaming ? (
          <input
            ref={inputRef}
            className="t7-set-rename-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCommitRename(value.trim())
              else if (e.key === 'Escape') onCancelRename()
            }}
            onBlur={() => onCommitRename(value.trim())}
            data-testid={`t7-set-rename-input-${set.id}`}
          />
        ) : (
          <button
            type="button"
            className="t7-set-name"
            onClick={isActive ? onToggleExpand : onActivate}
            title={isActive ? 'Click to expand/collapse' : 'Click to activate this set'}
            data-testid={`t7-set-activate-${set.id}`}
          >
            <span className="t7-set-label">{set.name}</span>
            <span className="t7-set-meta">{relativeTime(set.updatedAt)}</span>
          </button>
        )}
      </div>
      {expanded && (
        <div className="t7-snapshots">
          <div className="t7-snapshots-h">
            Snapshots ({set.snapshotCount})
          </div>
          {snapshotsLoaded ? (
            snapshots.length === 0 ? (
              <div className="t7-snapshots-empty">No snapshots yet.</div>
            ) : (
              <ul className="t7-snapshot-list">
                {snapshots.map((snap) => (
                  <li
                    key={snap.id}
                    className="t7-snapshot-row"
                    onContextMenu={(e) => {
                      e.preventDefault()
                      onSnapshotContextMenu(snap, e)
                    }}
                    data-testid={`t7-snapshot-row-${snap.id}`}
                  >
                    <span className="t7-snapshot-marker" aria-hidden="true">·</span>
                    <span className="t7-snapshot-name" title={snap.name}>
                      {snap.name}
                    </span>
                    <span className="t7-snapshot-meta">
                      {new Date(snap.createdAt * 1000).toLocaleDateString()}
                    </span>
                    <button
                      type="button"
                      className="t7-snapshot-revert"
                      onClick={() => onRevertSnapshot(snap)}
                      title="Revert this set to the snapshot"
                      data-testid={`t7-snapshot-revert-${snap.id}`}
                    >
                      ↺
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <div className="t7-snapshots-empty">Loading…</div>
          )}
          <button
            type="button"
            className="t7-take-snapshot"
            onClick={onTakeSnapshot}
            data-testid={`t7-take-snapshot-${set.id}`}
          >
            + Take snapshot
          </button>
        </div>
      )}
    </li>
  )
}
