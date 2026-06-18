import { useEffect, useMemo, useState } from 'react'
import { selectWorkingSlot, useStore } from '../../state'
import type { SetMeta } from '../../state/flist'
import { ContextMenu } from './working-sets/ContextMenu'
import { ConfirmModal } from './working-sets/ConfirmModal'
import { CrossCharacterImportModal } from './working-sets/CrossCharacterImportModal'
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
  const exportSet = useStore((s) => s.flistExportSet)
  const importSet = useStore((s) => s.flistImportSet)
  const backupCharacter = useStore((s) => s.flistBackupCharacter)
  const confirmCrossCharacterImport = useStore(
    (s) => s.flistConfirmCrossCharacterImport
  )
  const cancelPendingImport = useStore((s) => s.flistCancelPendingImport)

  // TODO(working-sets v2): the three actions below were the inline-button
  // surfaces removed from area 2 (Export for restore, Save snapshot, Open
  // backup). The store actions are kept while we decide whether to bring
  // them back in a later round.
  void useStore.getState().flistOpenExportRestore
  void useStore.getState().flistSaveSnapshot
  void useStore.getState().flistOpenBackup

  useEffect(() => {
    if (!activeId) return
    if (setsStatus === 'idle') void loadSets(activeId)
  }, [activeId, setsStatus, loadSets])

  const [createOpen, setCreateOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [ctx, setCtx] = useState<CtxAnchor | null>(null)
  const [fromFlistCtx, setFromFlistCtx] = useState<{
    x: number
    y: number
  } | null>(null)
  const [crossCharImport, setCrossCharImport] = useState<{
    characterName: string
    setName: string
  } | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importMessage, setImportMessage] = useState<{
    kind: 'success' | 'error'
    text: string
  } | null>(null)
  // Drop any in-flight import state when the active character switches
  // — the modal and the module-scope handshake state are both keyed to
  // the previous character and would materialise under the wrong one.
  useEffect(() => {
    setCrossCharImport(null)
    setImportMessage(null)
    cancelPendingImport()
  }, [activeId, cancelPendingImport])
  // Auto-clear import banners after 6s so they don't accumulate.
  useEffect(() => {
    if (!importMessage) return
    const t = setTimeout(() => setImportMessage(null), 6000)
    return () => clearTimeout(t)
  }, [importMessage])

  const defaultName = useMemo(() => defaultNewSetName(sets), [sets])

  if (!session.active || !activeId) return null

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
  // F-list's character-data.php response carries `updated_at` (unix
  // epoch of the last profile edit). We round-trip it inside live.json,
  // so the renderer can surface "F-list edited Xd ago" without a
  // dedicated state field. `updatedAt` is a defensive fallback in case
  // a future F-list API version switches casing.
  const flistUpdatedAt =
    live && typeof live === 'object'
      ? (((live as Record<string, unknown>).updated_at as number | undefined)
        ?? ((live as Record<string, unknown>).updatedAt as number | undefined)
        ?? null)
      : null

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
      {
        label: 'Export as ZIP…',
        onSelect: () => {
          void exportSet(activeId, s.id)
        }
      },
      {
        // Backups are per-character (one ZIP per character covers
        // every set's source-of-truth Live + images), so this fires
        // the same flistBackupCharacter that the character-row
        // right-click does. Surfacing it on the set row is just a
        // closer-to-hand affordance — the user said they often think
        // about "this set" when they want to snapshot, not "this
        // character" (2026-06-17 brief).
        label: 'Back up now',
        onSelect: () => {
          void backupCharacter(name)
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

  const handleImport = async (): Promise<void> => {
    if (importBusy) return
    setImportBusy(true)
    setImportMessage(null)
    try {
      const outcome = await importSet(activeId)
      if (outcome.status === 'requires_confirmation') {
        setCrossCharImport({
          characterName: outcome.source.characterName,
          setName: outcome.source.setName
        })
      } else if (outcome.status === 'imported') {
        const { added, skipped } = outcome.imageStats
        setImportMessage({
          kind: 'success',
          text:
            added === 0 && skipped === 0
              ? `Imported "${outcome.set.name}".`
              : `Imported "${outcome.set.name}" — ${added} new image${added === 1 ? '' : 's'}, ${skipped} already on disk.`
        })
      } else if (outcome.status === 'error') {
        setImportMessage({ kind: 'error', text: outcome.message })
      } else if (outcome.status === 'unavailable') {
        setImportMessage({
          kind: 'error',
          text: 'Import is unavailable — file dialogs require the desktop build.'
        })
      }
      // 'cancelled' is the OS dialog dismiss; deliberately silent.
    } finally {
      setImportBusy(false)
    }
  }

  const handleCrossCharConfirm = async (): Promise<void> => {
    setCrossCharImport(null)
    setImportBusy(true)
    try {
      const outcome = await confirmCrossCharacterImport()
      if (outcome.status === 'imported') {
        const { added, skipped } = outcome.imageStats
        setImportMessage({
          kind: 'success',
          text: `Imported "${outcome.set.name}" — ${added} new image${added === 1 ? '' : 's'}, ${skipped} already on disk.`
        })
      } else if (outcome.status === 'error') {
        setImportMessage({ kind: 'error', text: outcome.message })
      }
    } finally {
      setImportBusy(false)
    }
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

      <div className="flist-zone-setactions">
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
        <button
          type="button"
          className="flist-zone-import"
          onClick={() => {
            void handleImport()
          }}
          disabled={importBusy}
          title="Import a Workbench-native working set bundle (.zip)"
          data-testid="flist-zone-import"
        >
          {importBusy ? 'Importing…' : 'Import…'}
        </button>
      </div>
      {importMessage && (
        <div
          className={
            importMessage.kind === 'success'
              ? 'flist-zone-import-msg flist-zone-import-msg-success'
              : 'flist-zone-import-msg flist-zone-import-msg-error'
          }
          role={importMessage.kind === 'error' ? 'alert' : 'status'}
          data-testid="flist-zone-import-msg"
        >
          {importMessage.text}
        </div>
      )}

      <ul className="flist-zone-sets" data-testid="flist-zone-sets">
        <li
          className={`flist-zone-setrow flist-zone-from-flist${
            viewingFlist ? ' is-active' : ''
          }${hasLive ? '' : ' is-empty'}`}
          onClick={() => {
            if (!hasLive) return
            void activateFromFlist(activeId)
          }}
          onContextMenu={(e) => {
            // Same right-click affordance the working-set rows have,
            // restricted to actions that make sense for the live view
            // (Back up now). Rename / Delete / Create copy are
            // working-set-only — the live row isn't a stored set.
            if (!hasLive) return
            e.preventDefault()
            setFromFlistCtx({ x: e.clientX, y: e.clientY })
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
              {hasLive && flistUpdatedAt ? (
                <>
                  {' · '}
                  <span title="F-list profile last edited (from the API)">
                    F-list edited {relativeTime(flistUpdatedAt)}
                  </span>
                </>
              ) : null}
            </span>
          </div>
        </li>

        {sets.length > 0 && <li className="flist-zone-sep" aria-hidden="true" />}

        {sets.map((s) => {
          const isActive = activeSetId === s.id
          const showDirty = isActive && workingSlot?.unsavedDirty
          const meta = showDirty
            ? 'unsaved'
            : `last changed ${relativeTime(s.updatedAt)}`
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
      {fromFlistCtx && (
        <ContextMenu
          x={fromFlistCtx.x}
          y={fromFlistCtx.y}
          items={[
            {
              label: 'Back up now',
              onSelect: () => {
                void backupCharacter(name)
              }
            }
          ]}
          onClose={() => setFromFlistCtx(null)}
        />
      )}
      {crossCharImport && (
        <CrossCharacterImportModal
          source={crossCharImport}
          targetCharacterName={name}
          onCancel={() => {
            setCrossCharImport(null)
            cancelPendingImport()
          }}
          onConfirm={() => {
            void handleCrossCharConfirm()
          }}
        />
      )}
    </div>
  )
}
