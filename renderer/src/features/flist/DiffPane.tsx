import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../state'
import { resolveInfotagDescriptors } from './infotagsResolver'
import {
  computeDiff,
  type DiffCategory,
  type DiffKinkCatalogueEntry,
  type DiffRow as DiffRowModel
} from './diff/diffEngine'
import { DiffRow } from './DiffRow'
import { DescriptionDiffView } from './DescriptionDiffView'
import { BackupPicker } from './BackupPicker'

// Module-level singleton — Zustand selectors are identity-compared,
// so a `?? { kind: 'live' }` fallback inline would allocate a fresh
// object every render and trigger an infinite re-render loop.
const DEFAULT_RIGHT_SOURCE = { kind: 'live' } as const

const CATEGORY_LABEL: Record<DiffCategory, string> = {
  character: 'Character',
  settings: 'Settings',
  infotag: 'Profile fields',
  custom_kink: 'Custom kinks',
  standard_kink: 'Standard kinks',
  image: 'Images'
}

const CATEGORY_ORDER: DiffCategory[] = [
  'character',
  'settings',
  'infotag',
  'custom_kink',
  'standard_kink',
  'image'
]

export function DiffPane({ characterId }: { characterId: string }) {
  const slot = useStore((s) => s.flistWorking[characterId])
  const archive = useStore((s) => s.flistArchive[characterId])
  const mapping = useStore((s) => s.flistMapping.payload)
  const mappingStatus = useStore((s) => s.flistMapping.status)
  const loadMapping = useStore((s) => s.flistLoadMapping)
  const source = useStore(
    (s) => s.flistDiffRightSource[characterId] ?? DEFAULT_RIGHT_SOURCE
  )
  const backupCache = useStore((s) => s.flistDiffBackupCache)
  const backupStatus = useStore((s) => s.flistDiffBackupStatus)
  const loadBackup = useStore((s) => s.flistDiffLoadBackup)
  const setSource = useStore((s) => s.flistDiffSetRightSource)
  const resetField = useStore((s) => s.flistResetWorkingField)
  const resetCustomKink = useStore((s) => s.flistCustomKinksResetField)
  const resetToLive = useStore((s) => s.flistResetWorkingToLive)
  const resetToBackup = useStore((s) => s.flistResetWorkingToBackup)

  const [showUnchanged, setShowUnchanged] = useState(false)
  const [activeCategories, setActiveCategories] = useState<Set<DiffCategory>>(
    () => new Set(CATEGORY_ORDER)
  )
  const [resetAllConfirm, setResetAllConfirm] = useState(false)
  const confirmCancelRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (mappingStatus === 'idle') void loadMapping()
  }, [mappingStatus, loadMapping])

  // Reset-all confirm modal — Esc handler + autofocus Cancel (parity
  // with ProfileFieldsTab reset modal). CLAUDE.md: no backdrop dismiss.
  useEffect(() => {
    if (!resetAllConfirm) return
    confirmCancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setResetAllConfirm(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [resetAllConfirm])

  // Lazy-load the chosen backup payload.
  useEffect(() => {
    if (source.kind === 'backup') {
      void loadBackup(characterId, source.filename)
    }
  }, [source, characterId, loadBackup])

  const right: Record<string, unknown> | null = useMemo(() => {
    if (source.kind === 'live') {
      const live = archive?.live
      return live ? (live as Record<string, unknown>) : null
    }
    return backupCache[`${characterId}:${source.filename}`] ?? null
  }, [source, archive, backupCache, characterId])

  const resolver = useMemo(() => {
    return resolveInfotagDescriptors(mapping ?? null, {
      overlay: slot?.overlay,
      infotagsPayload: (slot?.payload?.infotags as Record<string, unknown> | undefined) ?? {}
    })
  }, [mapping, slot?.overlay, slot?.payload])

  const kinkCatalogue: DiffKinkCatalogueEntry[] = useMemo(() => {
    const raw = mapping?.kinks
    if (!Array.isArray(raw)) return []
    const out: DiffKinkCatalogueEntry[] = []
    for (const entry of raw as unknown[]) {
      if (entry && typeof entry === 'object') {
        const e = entry as { id?: unknown; name?: unknown }
        if (e.id != null) {
          out.push({
            id: String(e.id),
            name: typeof e.name === 'string' ? (e.name as string) : `kink#${e.id}`
          })
        }
      }
    }
    return out
  }, [mapping])

  const model = useMemo(() => {
    return computeDiff(slot?.payload ?? null, right, resolver, kinkCatalogue)
  }, [slot?.payload, right, resolver, kinkCatalogue])

  if (!slot) {
    return (
      <div className="diff-pane diff-pane-loading">Loading working copy…</div>
    )
  }
  if (!right && source.kind === 'live') {
    return (
      <div className="diff-pane diff-pane-empty" data-testid="diff-pane-empty">
        <p>
          Pull a Live snapshot first: open the <strong>F-list</strong> sidebar
          and click <strong>↻ Refresh</strong> on this character.
        </p>
        <BackupPicker characterId={characterId} />
      </div>
    )
  }
  if (!right && source.kind === 'backup') {
    const cacheKey = `${characterId}:${source.filename}`
    const status = backupStatus[cacheKey] ?? 'loading'
    return (
      <div className="diff-pane diff-pane-empty" data-testid="diff-pane-empty">
        {status === 'error' ? (
          <p>
            Backup not found — the file may have been deleted from disk.
            Pick another or switch back to Live.
          </p>
        ) : (
          <p>Loading backup…</p>
        )}
        <BackupPicker characterId={characterId} />
        <button
          type="button"
          onClick={() => setSource(characterId, { kind: 'live' })}
        >
          Switch back to Live
        </button>
      </div>
    )
  }

  const rightLabel =
    source.kind === 'live'
      ? 'Live'
      : `Backup · ${formatBackupDate(archive?.backups ?? [], source.filename)}`

  const descriptionRow = model.rows.find(
    (r) => r.path === 'character.description'
  )
  const otherRows = model.rows.filter(
    (r) => r.path !== 'character.description'
  )
  const visibleRows = otherRows.filter(
    (r) =>
      activeCategories.has(r.category) &&
      (showUnchanged || r.kind !== 'unchanged')
  )

  const rowsByCategory = new Map<DiffCategory, DiffRowModel[]>()
  for (const r of visibleRows) {
    const arr = rowsByCategory.get(r.category) ?? []
    arr.push(r)
    rowsByCategory.set(r.category, arr)
  }

  const onRowReset = (row: DiffRowModel) => () => {
    // Reset only routes when source is Live — backup-side reset would
    // need a per-row store action; out of Tier 4 scope (see backlog).
    if (source.kind !== 'live') return
    if (row.path.startsWith('custom_kinks.')) {
      const [, id, field] = row.path.split('.')
      if (field === 'name' || field === 'description' || field === 'choice') {
        resetCustomKink(characterId, id, field)
        return
      }
    }
    resetField(characterId, row.path)
  }

  return (
    <div className="diff-pane" data-testid="diff-pane">
      {/* UX P2-1: BackupPicker on its own row above the legend so the
          source choice reads as the primary control. */}
      <div className="diff-pane-source-row">
        <BackupPicker characterId={characterId} />
      </div>
      <div className="diff-pane-controls">
        <div className="diff-pane-legend">
          <span className="diff-badge diff-badge-added">+</span>
          {model.counts.added} added
          <span className="diff-badge diff-badge-removed">−</span>
          {model.counts.removed} removed
          <span className="diff-badge diff-badge-modified">●</span>
          {model.counts.modified} modified
          <label className="diff-pane-show-unchanged">
            <input
              type="checkbox"
              checked={showUnchanged}
              onChange={(e) => setShowUnchanged(e.target.checked)}
            />
            Show unchanged ({model.counts.unchanged})
          </label>
        </div>
        {/* UX P1-1: also disable when no rows differ. Even with edits in
            overlay, a Reset-all that wouldn't change disk bytes is
            misleading. */}
        <button
          type="button"
          className="diff-pane-reset-all"
          data-testid="diff-pane-reset-all"
          disabled={
            slot.overlay.length === 0 || model.changedRowCount === 0
          }
          onClick={() => setResetAllConfirm(true)}
        >
          Discard all changes vs {rightLabel}
        </button>
      </div>

      <div
        className="diff-pane-category-filter"
        role="group"
        aria-label="Filter by category"
      >
        {CATEGORY_ORDER.map((cat) => {
          const active = activeCategories.has(cat)
          const changed = model.changedCategories.has(cat)
          return (
            <button
              key={cat}
              type="button"
              className={`diff-pane-cat-pill${active ? ' diff-pane-cat-pill-active' : ' diff-pane-cat-pill-hidden'}${
                changed ? ' diff-pane-cat-pill-changed' : ''
              }`}
              title={`${active ? 'Hide' : 'Show'} ${CATEGORY_LABEL[cat]} rows`}
              onClick={() => {
                setActiveCategories((prev) => {
                  const next = new Set(prev)
                  if (next.has(cat)) next.delete(cat)
                  else next.add(cat)
                  return next
                })
              }}
              aria-pressed={active}
            >
              {CATEGORY_LABEL[cat]}
            </button>
          )
        })}
      </div>

      {descriptionRow && activeCategories.has('character') && (
        <DescriptionDiffView
          workingValue={String(descriptionRow.workingValue ?? '')}
          rightValue={String(descriptionRow.rightValue ?? '')}
          rightLabel={rightLabel}
        />
      )}

      {visibleRows.length === 0 ? (
        <p className="diff-pane-empty-text">
          {showUnchanged
            ? 'No matching rows. Try toggling category pills above.'
            : `Working copy matches ${rightLabel}.`}
        </p>
      ) : (
        <div className="diff-pane-table-wrap">
          {CATEGORY_ORDER.map((cat) => {
            const rows = rowsByCategory.get(cat)
            if (!rows || rows.length === 0) return null
            return (
              <section key={cat} className="diff-pane-section">
                <h3 className="diff-pane-section-h">
                  {CATEGORY_LABEL[cat]} ({rows.length})
                </h3>
                <table className="diff-pane-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>Field</th>
                      <th>Working</th>
                      <th>{rightLabel}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <DiffRow
                        key={row.path}
                        row={row}
                        characterId={characterId}
                        rightLabel={rightLabel}
                        onReset={source.kind === 'live' ? onRowReset(row) : null}
                        backupResetDisabled={source.kind === 'backup'}
                      />
                    ))}
                  </tbody>
                </table>
              </section>
            )
          })}
        </div>
      )}

      {resetAllConfirm && (
        <div
          className="profile-fields-modal-shroud"
          role="dialog"
          aria-modal="true"
          data-testid="diff-pane-reset-confirm"
        >
          <div className="profile-fields-modal">
            <div className="profile-fields-modal-header">
              <span>Reset working copy to {rightLabel}</span>
              <button
                type="button"
                className="profile-fields-modal-close"
                aria-label="Close"
                onClick={() => setResetAllConfirm(false)}
              >
                ✕
              </button>
            </div>
            <p>
              Discard {slot.overlay.length} change
              {slot.overlay.length === 1 ? '' : 's'} and replace Working copy
              with {rightLabel}? You'll have 5 seconds to undo.
            </p>
            {source.kind === 'backup' && (
              <p className="profile-fields-modal-warn">
                Anything F-list has changed since this backup will also be
                overwritten until you Refresh.
              </p>
            )}
            <div className="profile-fields-modal-buttons">
              <button
                type="button"
                ref={confirmCancelRef}
                onClick={() => setResetAllConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="profile-fields-modal-confirm"
                onClick={() => {
                  setResetAllConfirm(false)
                  if (source.kind === 'live') {
                    void resetToLive(characterId)
                  } else {
                    void resetToBackup(characterId, source.filename)
                  }
                }}
              >
                Discard changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function formatBackupDate(
  backups: { filename: string; created_at: number }[],
  filename: string
): string {
  const match = backups.find((b) => b.filename === filename)
  if (!match) return filename
  return new Date(match.created_at * 1000)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ')
}

/** Diff tab badge count. EditorPane reads this without re-running
 *  the full diff engine. The badge is intentionally fuzzy: it counts
 *  the overlay (paths the user has authored) only when there are
 *  unsaved edits *and* the badge will be smaller than the real diff —
 *  showing zero is safer than over-promising. Live-side drift on
 *  untouched paths is *not* counted; the Diff tab itself surfaces it
 *  on open. UX P1-2 / QA P2-3. */
export function countDiffChanges(
  slot:
    | {
        payload: Record<string, unknown>
        overlay?: string[]
        unsavedDirty?: boolean
      }
    | undefined
): number {
  if (!slot) return 0
  if (!slot.unsavedDirty) return 0
  return slot.overlay?.length ?? 0
}
