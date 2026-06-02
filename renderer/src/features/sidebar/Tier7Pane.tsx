import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../state'
import { AccordionPane, AccordionSection } from './AccordionPane'
import { BackupsSection } from './BackupsSection'
import { ConfirmModal } from './ConfirmModal'
import { MakeBackupModal, type MakeBackupSource } from './MakeBackupModal'
import { SnippetList, useEnsureSnippetsLoaded } from './SnippetList'
import { WorkingSetsSection } from './WorkingSetsSection'
import type {
  BackupListing as Tier7Backup,
  NewSetSeed,
  SetMeta as Tier7SetMeta,
  SnapshotMeta as Tier7SnapshotMeta
} from './tier7Types'

type DeletePrompt =
  | { kind: 'set'; setId: string; name: string; snapshotCount: number }
  | { kind: 'snapshot'; setId: string; snapshotId: string; name: string }
  | { kind: 'backup'; filename: string }
  | { kind: 'revert'; setId: string; snapshotId: string; snapshotName: string }
  | null

function nextActiveSetId(
  sets: Tier7SetMeta[],
  removedSetId: string,
  currentActiveId: string | null
): string | undefined {
  if (currentActiveId !== removedSetId) return undefined
  const remaining = sets.filter((s) => s.id !== removedSetId)
  return remaining[0]?.id
}

export function Tier7Pane() {
  const activeId = useStore((s) => s.flistActiveCharacterId)
  const session = useStore((s) => s.flistSession)
  const documents = useStore((s) => s.documents)
  const archive = useStore((s) => s.flistArchive)

  const setsByCharacter = useStore((s) => s.flistSets)
  const activeSetIdByCharacter = useStore((s) => s.flistActiveSetId)
  const snapshotsBySet = useStore((s) => s.flistSetSnapshots)
  const backupsByCharacter = useStore((s) => s.flistBackupsList)
  const backupsStatus = useStore((s) => s.flistBackupsStatus)
  const undoStackByCharacter = useStore((s) => s.flistSetUndoStack)
  const redoStackByCharacter = useStore((s) => s.flistSetRedoStack)
  const accordionByCharacter = useStore((s) => s.flistAccordion)

  const flistLoadSets = useStore((s) => s.flistLoadSets)
  const flistLoadBackups = useStore((s) => s.flistLoadBackups)
  const flistLoadSnapshots = useStore((s) => s.flistLoadSnapshots)
  const flistCreateSet = useStore((s) => s.flistCreateSet)
  const flistActivateSet = useStore((s) => s.flistActivateSet)
  const flistRenameSet = useStore((s) => s.flistRenameSet)
  const flistDeleteSet = useStore((s) => s.flistDeleteSet)
  const flistTakeSnapshot = useStore((s) => s.flistTakeSnapshot)
  const flistRevertToSnapshot = useStore((s) => s.flistRevertToSnapshot)
  const flistDeleteSnapshot = useStore((s) => s.flistDeleteSnapshot)
  const flistCreateBackup = useStore((s) => s.flistCreateBackup)
  const flistDeleteBackup = useStore((s) => s.flistDeleteBackup)
  const flistUndo = useStore((s) => s.flistUndo)
  const flistRedo = useStore((s) => s.flistRedo)
  const flistSetAccordion = useStore((s) => s.flistSetAccordion)

  useEnsureSnippetsLoaded()

  useEffect(() => {
    if (!activeId) return
    void flistLoadSets(activeId)
    void flistLoadBackups(activeId)
  }, [activeId, flistLoadSets, flistLoadBackups])

  const activeSetIdForLoad = activeId
    ? activeSetIdByCharacter[activeId] ?? null
    : null
  useEffect(() => {
    if (!activeId || !activeSetIdForLoad) return
    void flistLoadSnapshots(activeId, activeSetIdForLoad)
  }, [activeId, activeSetIdForLoad, flistLoadSnapshots])

  // Working sets / backups are per-character on disk; they exist for any
  // selected character (sign-in is only required to *pull* from F-list).
  const hasCharacter = Boolean(activeId)
  void session
  const sets = (activeId && setsByCharacter[activeId]) || []
  const activeSetId = activeId ? activeSetIdByCharacter[activeId] ?? null : null
  const backups = (activeId && backupsByCharacter[activeId]) || []
  const status = ((activeId && backupsStatus[activeId]) || 'idle') as
    | 'idle'
    | 'loading'
    | 'ready'
    | 'error'
  const undoCount = activeSetId
    ? undoStackByCharacter[activeSetId]?.length ?? 0
    : 0
  const redoCount = activeSetId
    ? redoStackByCharacter[activeSetId]?.length ?? 0
    : 0

  const snapshotsLoadedSetIds = useMemo(
    () =>
      new Set(
        Object.keys(snapshotsBySet).filter((k) =>
          (snapshotsBySet[k] || []).length >= 0
        )
      ),
    [snapshotsBySet]
  )

  const activeSet =
    activeSetId ? sets.find((s) => s.id === activeSetId) ?? null : null
  const activeSetSnapshots = activeSetId
    ? snapshotsBySet[activeSetId] ?? []
    : []
  const slot = activeId ? archive[activeId] : undefined
  const hasLive = Boolean(slot?.live)

  const paneState =
    (activeId && accordionByCharacter[activeId]) || {
      snippets: !hasCharacter,
      sets: hasCharacter,
      backups: hasCharacter
    }

  const togglePane = (key: 'snippets' | 'sets' | 'backups') => {
    if (!activeId) return
    flistSetAccordion(activeId, key, !paneState[key])
  }

  const [makeBackupOpen, setMakeBackupOpen] = useState(false)
  const [deletePrompt, setDeletePrompt] = useState<DeletePrompt>(null)

  const onCreateSet = async (seed: NewSetSeed) => {
    if (!activeId) return
    let name: string
    let seedBody:
      | 'live'
      | 'empty'
      | { fork: string }
    if (seed.kind === 'live') {
      name = 'From F-list'
      seedBody = 'live'
    } else if (seed.kind === 'empty') {
      name = 'New set'
      seedBody = 'empty'
    } else {
      const source = sets.find((s) => s.id === seed.setId)
      name = source ? `${source.name} (copy)` : 'New set (copy)'
      seedBody = { fork: seed.setId }
    }
    await flistCreateSet(activeId, { name, seed: seedBody })
  }

  const onConfirmDelete = async () => {
    if (!deletePrompt || !activeId) {
      setDeletePrompt(null)
      return
    }
    switch (deletePrompt.kind) {
      case 'set':
        await flistDeleteSet(
          activeId,
          deletePrompt.setId,
          nextActiveSetId(sets, deletePrompt.setId, activeSetId)
        )
        break
      case 'snapshot':
        await flistDeleteSnapshot(
          activeId,
          deletePrompt.setId,
          deletePrompt.snapshotId
        )
        break
      case 'backup':
        await flistDeleteBackup(activeId, deletePrompt.filename)
        break
      case 'revert':
        await flistRevertToSnapshot(
          activeId,
          deletePrompt.setId,
          deletePrompt.snapshotId
        )
        break
    }
    setDeletePrompt(null)
  }

  const onConfirmMakeBackup = async (source: MakeBackupSource) => {
    if (!activeId) {
      setMakeBackupOpen(false)
      return
    }
    if (source.kind === 'set') {
      await flistCreateBackup(activeId, { from: 'set', setId: source.setId })
    } else {
      await flistCreateBackup(activeId, {
        from: 'snapshot',
        setId: source.setId,
        snapshotId: source.snapshotId
      })
    }
    setMakeBackupOpen(false)
  }

  // Snapshots: the store's SnapshotMeta uses createdAt; component types
  // are the same shape. Pass-through is safe.
  const snapshotsBySetIdView: Record<string, Tier7SnapshotMeta[]> = snapshotsBySet
  const setsView: Tier7SetMeta[] = sets
  const backupsView: Tier7Backup[] = backups

  return (
    <AccordionPane>
      <AccordionSection
        id="snippets"
        title="Snippets"
        count={documents.length}
        expanded={paneState.snippets}
        onToggle={() => togglePane('snippets')}
      >
        <SnippetList />
      </AccordionSection>

      <AccordionSection
        id="sets"
        title={hasCharacter ? 'Working sets' : 'Working sets'}
        count={hasCharacter ? sets.length : null}
        expanded={paneState.sets && hasCharacter}
        disabled={!hasCharacter}
        disabledHint="sign in"
        onToggle={() => togglePane('sets')}
      >
        <WorkingSetsSection
          sets={setsView}
          activeSetId={activeSetId}
          snapshotsBySetId={snapshotsBySetIdView}
          snapshotsLoadedSetIds={snapshotsLoadedSetIds}
          hasLive={hasLive}
          undoCount={undoCount}
          redoCount={redoCount}
          onUndo={() => activeId && flistUndo(activeId)}
          onRedo={() => activeId && flistRedo(activeId)}
          onCreateSet={onCreateSet}
          onActivateSet={(setId) => activeId && void flistActivateSet(activeId, setId)}
          onRenameSet={(setId, next) =>
            activeId && void flistRenameSet(activeId, setId, next)
          }
          onDuplicateSet={(setId) =>
            void onCreateSet({ kind: 'fork', setId })
          }
          onDeleteSet={(setId) => {
            const set = sets.find((s) => s.id === setId)
            if (!set) return
            setDeletePrompt({
              kind: 'set',
              setId,
              name: set.name,
              snapshotCount: set.snapshotCount
            })
          }}
          onTakeSnapshot={(setId) => {
            if (!activeId) return
            const stamp = new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit'
            })
            void flistTakeSnapshot(activeId, setId, `Snapshot @ ${stamp}`)
          }}
          onRevertSnapshot={(setId, snapshotId) => {
            const snap = snapshotsBySet[setId]?.find((s) => s.id === snapshotId)
            if (!snap) return
            setDeletePrompt({
              kind: 'revert',
              setId,
              snapshotId,
              snapshotName: snap.name
            })
          }}
          onRenameSnapshot={(setId, snapshotId) => {
            // TODO(Tier 7 Step 10): inline rename for snapshots
            void setId
            void snapshotId
          }}
          onDeleteSnapshot={(setId, snapshotId) => {
            const snap = snapshotsBySet[setId]?.find((s) => s.id === snapshotId)
            if (!snap) return
            setDeletePrompt({
              kind: 'snapshot',
              setId,
              snapshotId,
              name: snap.name
            })
          }}
          onCreateBackupFromSet={(setId) =>
            activeId && void flistCreateBackup(activeId, { from: 'set', setId })
          }
          onCreateBackupFromSnapshot={(setId, snapshotId) =>
            activeId &&
            void flistCreateBackup(activeId, {
              from: 'snapshot',
              setId,
              snapshotId
            })
          }
          onLoadSnapshots={(setId) =>
            activeId && void flistLoadSnapshots(activeId, setId)
          }
        />
      </AccordionSection>

      <AccordionSection
        id="backups"
        title="Backups"
        count={hasCharacter ? backups.length : null}
        expanded={paneState.backups && hasCharacter}
        disabled={!hasCharacter}
        disabledHint="sign in"
        onToggle={() => togglePane('backups')}
      >
        <BackupsSection
          backups={backupsView}
          status={status}
          onMakeBackup={() => setMakeBackupOpen(true)}
          onRevealBackup={() => {
            // TODO(Tier 7 Step 12): wire to shell.showItemInFolder via IPC
          }}
          onCopyBackupPath={() => {
            // TODO(Tier 7 Step 12): wire to clipboard write via IPC
          }}
          onExportBackup={() => {
            // TODO(Tier 7 Step 12): wire to save-file dialog via IPC
          }}
          onDeleteBackup={(filename) =>
            setDeletePrompt({ kind: 'backup', filename })
          }
        />
      </AccordionSection>

      {makeBackupOpen && (
        <MakeBackupModal
          activeSet={activeSet}
          snapshotsForActiveSet={activeSetSnapshots}
          onCancel={() => setMakeBackupOpen(false)}
          onConfirm={onConfirmMakeBackup}
        />
      )}
      {deletePrompt && (
        <ConfirmModal
          title={
            deletePrompt.kind === 'set'
              ? `Discard set "${deletePrompt.name}"?`
              : deletePrompt.kind === 'snapshot'
                ? `Discard snapshot "${deletePrompt.name}"?`
                : deletePrompt.kind === 'backup'
                  ? 'Permanently delete backup?'
                  : `Revert set to "${deletePrompt.snapshotName}"?`
          }
          body={
            deletePrompt.kind === 'set'
              ? `This removes the set${
                  deletePrompt.snapshotCount > 0
                    ? ` and its ${deletePrompt.snapshotCount} snapshot${
                        deletePrompt.snapshotCount === 1 ? '' : 's'
                      }`
                    : ''
                }. Backups taken from it stay in the Backups list.`
              : deletePrompt.kind === 'snapshot'
                ? 'The snapshot metadata is removed; the set itself is untouched.'
                : deletePrompt.kind === 'backup'
                  ? 'The ZIP file is removed from disk. Self-contained backups are gone for good once deleted.'
                  : 'A safety snapshot of the current state is taken first, so you can undo this revert.'
          }
          confirmLabel={deletePrompt.kind === 'revert' ? 'Revert' : 'Delete'}
          danger={deletePrompt.kind !== 'revert'}
          onConfirm={() => void onConfirmDelete()}
          onCancel={() => setDeletePrompt(null)}
        />
      )}
    </AccordionPane>
  )
}
