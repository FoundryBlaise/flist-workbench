import { useEffect, useMemo, useState } from 'react'
import { selectWorkingSlot, useStore } from '../../state'
import type { SetMeta } from '../../state/flist'
import { ContextMenu } from './working-sets/ContextMenu'
import { ConfirmModal } from './working-sets/ConfirmModal'
import { NameDialog } from './working-sets/NameDialog'

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

function defaultNewSetName(existing: SetMeta[]): string {
  const used = new Set(existing.map((s) => s.name))
  let n = 1
  while (used.has(`Working set ${n}`)) n++
  return `Working set ${n}`
}

function copyNameOf(base: string, existing: SetMeta[]): string {
  const used = new Set(existing.map((s) => s.name))
  let candidate = `${base} (copy)`
  let n = 2
  while (used.has(candidate)) {
    candidate = `${base} (copy ${n})`
    n++
  }
  return candidate
}

type RenameTarget = { id: string; name: string }
type DeleteTarget = { id: string; name: string }
type CtxAnchor = { setId: string; x: number; y: number }

// Stable empty reference — returning a fresh `[]` from a Zustand
// selector triggers a re-render every time because the new reference
// never compares equal to the previous one, which puts this component
// into a tight render loop (React #185).
const EMPTY_SETS: readonly never[] = []

export function FlistCharacterZone() {
  const session = useStore((s) => s.flistSession)
  const activeId = useStore((s) => s.flistActiveCharacterId)
  const archive = useStore((s) => s.flistArchive)
  const roster = useStore((s) => s.flistRoster)
  const pull = useStore((s) => s.flistPullCharacter)

  // Working sets v2 wiring.
  const sets = useStore(
    (s) =>
      (activeId && s.flistSets[activeId]) ||
      (EMPTY_SETS as unknown as SetMeta[])
  )
  const activeSetId = useStore((s) =>
    activeId ? (s.flistActiveSetId[activeId] ?? null) : null
  )
  const setsStatus = useStore((s) =>
    activeId ? (s.flistSetsStatus[activeId] ?? 'idle') : 'idle'
  )
  const workingSlot = useStore((s) =>
    activeId ? selectWorkingSlot(s, activeId) : undefined
  )
  const loadSets = useStore((s) => s.flistLoadSets)
  const createSet = useStore((s) => s.flistCreateSet)
  const renameSetAction = useStore((s) => s.flistRenameSet)
  const duplicateSet = useStore((s) => s.flistDuplicateSet)
  const deleteSet = useStore((s) => s.flistDeleteSet)
  const activateSet = useStore((s) => s.flistActivateSet)
  const activateFromFlist = useStore((s) => s.flistActivateFromFlist)

  // TODO(working-sets v2): the four actions below were the inline-button
  // surfaces removed from area 2 (Export for restore, Copy as new draft,
  // Save snapshot, Open backup). The store actions are kept while we
  // decide whether to bring them back in a later round.
  void useStore.getState().flistOpenExportRestore
  void useStore.getState().flistCopyLiveToNewDoc
  void useStore.getState().flistSaveBackup
  void useStore.getState().flistOpenBackup

  useEffect(() => {
    if (!activeId) return
    if (setsStatus === 'idle') void loadSets(activeId)
  }, [activeId, setsStatus, loadSets])

  const [createOpen, setCreateOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [ctx, setCtx] = useState<CtxAnchor | null>(null)

  const defaultName = useMemo(() => defaultNewSetName(sets), [sets])

  if (!activeId) return null
  void session

  const entry = roster.find((r) => String(r.id ?? '') === activeId)
  const name = entry?.name ?? 'Selected character'
  const slot = archive[activeId]
  const live = slot?.live
  const lastPulledAt = slot?.lastPullAt
  const pullStatus = slot?.pullStatus ?? 'idle'
  const pullStage = slot?.pullStage
  const pullProgress = slot?.pullProgress
  const pullError = slot?.pullError
  const integrity = slot?.integrity

  const inFlight = pullStatus === 'queued' || pullStatus === 'running'
  const incomplete =
    integrity
    && (integrity.status === 'partial' || integrity.status === 'interrupted')
    && integrity.missing > 0
  const hasLive = Boolean(live)
  const viewingFlist = activeSetId === null

  const ctxItems = (setId: string) => {
    const s = sets.find((x) => x.id === setId)
    if (!s) return []
    return [
      {
        label: 'Rename…',
        onSelect: () => setRenameTarget({ id: s.id, name: s.name })
      },
      {
        label: 'Create a copy',
        onSelect: () => {
          void duplicateSet(activeId, s.id, copyNameOf(s.name, sets))
        }
      },
      { label: '', onSelect: () => {}, divider: true },
      {
        label: 'Delete…',
        danger: true,
        onSelect: () => setDeleteTarget({ id: s.id, name: s.name })
      }
    ]
  }

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
            title="Refresh from F-list"
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
      {!inFlight && incomplete && entry?.on_account && (
        <div
          className="flist-zone-incomplete"
          role="status"
          data-testid="flist-zone-incomplete"
        >
          <span className="flist-zone-incomplete-msg">
            ⚠ Last pull incomplete — {integrity!.missing} image
            {integrity!.missing === 1 ? '' : 's'} missing
            {integrity!.status === 'interrupted' ? ' (pull was interrupted)' : ''}
          </span>
          <button
            type="button"
            className="flist-zone-incomplete-resume"
            onClick={() => void pull(name, activeId)}
            data-testid="flist-zone-incomplete-resume"
            title="Re-runs the pull — already-downloaded images are skipped"
          >
            ↻ Resume pull
          </button>
        </div>
      )}

      <button
        type="button"
        className="flist-zone-newset"
        onClick={() => setCreateOpen(true)}
        disabled={!hasLive}
        title={hasLive ? undefined : 'Pull this character first'}
        data-testid="flist-zone-newset"
      >
        + New working set
      </button>

      <ul className="flist-zone-sets" data-testid="flist-zone-sets">
        <li
          className={`flist-zone-setrow flist-zone-from-flist${
            viewingFlist ? ' is-active' : ''
          }${hasLive ? '' : ' is-empty'}`}
          onClick={() => {
            if (!hasLive) return
            void activateFromFlist(activeId)
          }}
          data-testid="flist-zone-from-flist"
        >
          <span className="flist-zone-setrow-marker" aria-hidden="true">
            {viewingFlist ? '✱' : '●'}
          </span>
          <div className="flist-zone-setrow-label">
            <span className="flist-zone-setrow-name">From F-list</span>
            <span className="flist-zone-setrow-meta">
              {hasLive ? `pulled ${relativeTime(lastPulledAt)}` : 'never pulled'}
            </span>
          </div>
        </li>

        {sets.length > 0 && <li className="flist-zone-sep" aria-hidden="true" />}

        {sets.map((s) => {
          const isActive = activeSetId === s.id
          const showDirty = isActive && workingSlot?.unsavedDirty
          const meta = showDirty
            ? 'unsaved'
            : `saved ${relativeTime(s.updatedAt)}`
          return (
            <li
              key={s.id}
              className={`flist-zone-setrow${isActive ? ' is-active' : ''}`}
              onClick={() => {
                if (isActive) return
                void activateSet(activeId, s.id)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setCtx({ setId: s.id, x: e.clientX, y: e.clientY })
              }}
              data-testid={`flist-zone-setrow-${s.id}`}
            >
              <span className="flist-zone-setrow-marker" aria-hidden="true">
                {isActive ? '✱' : '·'}
              </span>
              <div className="flist-zone-setrow-label">
                <span className="flist-zone-setrow-name">{s.name}</span>
                <span className="flist-zone-setrow-meta">{meta}</span>
              </div>
            </li>
          )
        })}
      </ul>

      {sets.length === 0 && hasLive && (
        <div className="flist-zone-empty-hint">
          No working sets yet. Click <strong>+ New working set</strong> to
          create one from the latest F-list pull.
        </div>
      )}

      {createOpen && (
        <NameDialog
          title="Create working set"
          hint="Seeded from the current F-list pull."
          initialName={defaultName}
          confirmLabel="Create"
          onCancel={() => setCreateOpen(false)}
          onConfirm={(picked) => {
            void createSet(activeId, picked)
            setCreateOpen(false)
          }}
        />
      )}
      {renameTarget && (
        <NameDialog
          title="Rename working set"
          initialName={renameTarget.name}
          confirmLabel="Save"
          onCancel={() => setRenameTarget(null)}
          onConfirm={(picked) => {
            void renameSetAction(activeId, renameTarget.id, picked)
            setRenameTarget(null)
          }}
        />
      )}
      {deleteTarget && (
        <ConfirmModal
          title={`Delete "${deleteTarget.name}"?`}
          body="The working set and its edits will be removed permanently. This cannot be undone."
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            void deleteSet(activeId, deleteTarget.id)
            setDeleteTarget(null)
          }}
        />
      )}
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={ctxItems(ctx.setId)}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  )
}
