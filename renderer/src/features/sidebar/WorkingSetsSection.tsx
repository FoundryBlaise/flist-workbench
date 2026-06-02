import { useState } from 'react'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { NewSetMenu } from './NewSetMenu'
import { UndoRedoStrip } from './UndoRedoStrip'
import { WorkingSetRow } from './WorkingSetRow'
import type { NewSetSeed, SetMeta, SnapshotMeta } from './tier7Types'

type CtxAnchor =
  | { kind: 'set'; setId: string; x: number; y: number }
  | { kind: 'snapshot'; setId: string; snapshotId: string; x: number; y: number }
  | null

export interface WorkingSetsSectionProps {
  sets: SetMeta[]
  activeSetId: string | null
  snapshotsBySetId: Record<string, SnapshotMeta[]>
  snapshotsLoadedSetIds: Set<string>
  hasLive: boolean

  undoCount: number
  redoCount: number
  undoHint?: string
  redoHint?: string

  onUndo: () => void
  onRedo: () => void

  onCreateSet: (seed: NewSetSeed) => void
  onActivateSet: (setId: string) => void
  onRenameSet: (setId: string, next: string) => void
  onDuplicateSet: (setId: string) => void
  onDeleteSet: (setId: string) => void

  onTakeSnapshot: (setId: string) => void
  onRevertSnapshot: (setId: string, snapshotId: string) => void
  onRenameSnapshot: (setId: string, snapshotId: string) => void
  onDeleteSnapshot: (setId: string, snapshotId: string) => void

  onCreateBackupFromSet: (setId: string) => void
  onCreateBackupFromSnapshot: (setId: string, snapshotId: string) => void

  onLoadSnapshots: (setId: string) => void
}

export function WorkingSetsSection({
  sets,
  activeSetId,
  snapshotsBySetId,
  snapshotsLoadedSetIds,
  hasLive,
  undoCount,
  redoCount,
  undoHint,
  redoHint,
  onUndo,
  onRedo,
  onCreateSet,
  onActivateSet,
  onRenameSet,
  onDuplicateSet,
  onDeleteSet,
  onTakeSnapshot,
  onRevertSnapshot,
  onRenameSnapshot,
  onDeleteSnapshot,
  onCreateBackupFromSet,
  onCreateBackupFromSnapshot,
  onLoadSnapshots
}: WorkingSetsSectionProps) {
  const [ctx, setCtx] = useState<CtxAnchor>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [expandedSetIds, setExpandedSetIds] = useState<Record<string, boolean>>(
    () => (activeSetId ? { [activeSetId]: true } : {})
  )

  const isExpanded = (id: string) =>
    Boolean(expandedSetIds[id] ?? id === activeSetId)

  const toggleExpand = (id: string) => {
    setExpandedSetIds((m) => {
      const next = !(m[id] ?? id === activeSetId)
      return { ...m, [id]: next }
    })
    if (!snapshotsLoadedSetIds.has(id)) onLoadSnapshots(id)
  }

  const setItems = (set: SetMeta): ContextMenuItem[] => [
    {
      label: 'Activate',
      onSelect: () => onActivateSet(set.id),
      disabled: set.id === activeSetId
    },
    {
      label: 'Rename…',
      onSelect: () => setRenamingId(set.id)
    },
    {
      label: 'Duplicate…',
      onSelect: () => onDuplicateSet(set.id)
    },
    {
      label: 'Take snapshot',
      onSelect: () => onTakeSnapshot(set.id)
    },
    {
      label: 'Create backup from this set',
      onSelect: () => onCreateBackupFromSet(set.id)
    },
    {
      label: 'Delete…',
      onSelect: () => onDeleteSet(set.id),
      danger: true,
      disabled: sets.length <= 1,
      hint: sets.length <= 1 ? "Can't delete the only set" : undefined
    }
  ]

  const snapshotItems = (setId: string, snapshotId: string): ContextMenuItem[] => [
    {
      label: 'Rename…',
      onSelect: () => onRenameSnapshot(setId, snapshotId)
    },
    {
      label: 'Revert this set to snapshot…',
      onSelect: () => onRevertSnapshot(setId, snapshotId)
    },
    {
      label: 'Create backup from this',
      onSelect: () => onCreateBackupFromSnapshot(setId, snapshotId)
    },
    {
      label: 'Delete…',
      onSelect: () => onDeleteSnapshot(setId, snapshotId),
      danger: true
    }
  ]

  return (
    <div className="t7-sets" data-testid="t7-sets">
      <div className="t7-sets-actions">
        <NewSetMenu sets={sets} hasLive={hasLive} onCreate={onCreateSet} />
        <button
          type="button"
          className="t7-help"
          aria-label="What is a working set?"
          title={
            'A working set is one editable variant of a character. ' +
            'Create multiple to experiment in parallel — every change is undoable.'
          }
        >
          (?)
        </button>
      </div>
      <UndoRedoStrip
        canUndo={undoCount > 0}
        canRedo={redoCount > 0}
        undoCount={undoCount}
        redoCount={redoCount}
        undoHint={undoHint}
        redoHint={redoHint}
        onUndo={onUndo}
        onRedo={onRedo}
      />
      {sets.length === 0 ? (
        <div className="t7-sets-empty">No working sets yet.</div>
      ) : (
        <ul className="t7-set-list">
          {sets.map((s) => (
            <WorkingSetRow
              key={s.id}
              set={s}
              isActive={s.id === activeSetId}
              expanded={isExpanded(s.id)}
              snapshots={snapshotsBySetId[s.id] ?? []}
              snapshotsLoaded={snapshotsLoadedSetIds.has(s.id)}
              renaming={renamingId === s.id}
              renameInitial={s.name}
              onToggleExpand={() => toggleExpand(s.id)}
              onActivate={() => onActivateSet(s.id)}
              onCommitRename={(next) => {
                if (next && next !== s.name) onRenameSet(s.id, next)
                setRenamingId(null)
              }}
              onCancelRename={() => setRenamingId(null)}
              onContextMenu={(e) =>
                setCtx({ kind: 'set', setId: s.id, x: e.clientX, y: e.clientY })
              }
              onSnapshotContextMenu={(snap, e) =>
                setCtx({
                  kind: 'snapshot',
                  setId: s.id,
                  snapshotId: snap.id,
                  x: e.clientX,
                  y: e.clientY
                })
              }
              onTakeSnapshot={() => onTakeSnapshot(s.id)}
              onRevertSnapshot={(snap) => onRevertSnapshot(s.id, snap.id)}
            />
          ))}
        </ul>
      )}
      {ctx?.kind === 'set' && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={setItems(sets.find((s) => s.id === ctx.setId)!)}
          onClose={() => setCtx(null)}
        />
      )}
      {ctx?.kind === 'snapshot' && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={snapshotItems(ctx.setId, ctx.snapshotId)}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  )
}
