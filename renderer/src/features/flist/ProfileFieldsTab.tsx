import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, selectWorkingSlot } from '../../state'
import { pathLookup } from '../../state/flist'
import {
  resolveInfotagDescriptors,
  type InfotagDescriptor,
  type InfotagGroupResolved
} from './infotagsResolver'
import { ListField, NumberField, TextField, UnknownField } from './infotagFields/TextField'
import { MappingListStaleness } from './MappingListStaleness'

const COLLAPSE_KEY_PREFIX = 'flist-workbench:profile-fields-group-collapsed:'

function readCollapsed(): Record<string, boolean> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY_PREFIX + 'all')
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function writeCollapsed(map: Record<string, boolean>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(COLLAPSE_KEY_PREFIX + 'all', JSON.stringify(map))
  } catch {
    // ignore
  }
}

export function ProfileFieldsTab({ characterId }: { characterId: string }) {
  const slot = useStore((s) => selectWorkingSlot(s, characterId))
  const live = useStore((s) => s.flistArchive[characterId]?.live ?? null)
  const mapping = useStore((s) => s.flistMapping)
  const mappingStatus = useStore((s) => s.flistMapping.status)
  const driftBanner = useStore((s) => s.flistDriftBanners[characterId])
  const resetUndo = useStore((s) =>
    s.flistResetUndo && s.flistResetUndo.characterId === characterId
      ? s.flistResetUndo
      : null
  )
  const setField = useStore((s) => s.flistSetWorkingField)
  const resetField = useStore((s) => s.flistResetWorkingField)
  const resetToLive = useStore((s) => s.flistResetWorkingToLive)
  const undoReset = useStore((s) => s.flistUndoResetWorking)
  const loadMapping = useStore((s) => s.flistLoadMapping)
  const dismissDrift = useStore((s) => s.flistDismissDriftBanner)
  const roster = useStore((s) => s.flistRoster)
  const accountEntry = roster.find((r) => String(r.id ?? '') === characterId)
  const offAccount = accountEntry && !accountEntry.on_account && accountEntry.has_archive
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => readCollapsed())
  const [filter, setFilter] = useState('')
  const [resetConfirm, setResetConfirm] = useState(false)
  const [undoCountdown, setUndoCountdown] = useState<number | null>(null)
  const [driftAnnounced, setDriftAnnounced] = useState(false)
  const [offAccountDismissed, setOffAccountDismissed] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const modalCancelRef = useRef<HTMLButtonElement | null>(null)

  // Flip `driftAnnounced` once the banner has been mounted so re-renders
  // don't re-trigger the SR alert (UX P3-16). Reset when the banner is
  // dismissed/cleared so a new drift event still announces.
  useEffect(() => {
    if (!driftBanner || driftBanner.paths.length === 0) {
      setDriftAnnounced(false)
      return
    }
    if (!driftAnnounced) {
      const t = setTimeout(() => setDriftAnnounced(true), 200)
      return () => clearTimeout(t)
    }
  }, [driftBanner, driftAnnounced])

  // Live countdown for the reset-undo banner (UX P1-5).
  useEffect(() => {
    if (!resetUndo) {
      setUndoCountdown(null)
      return
    }
    const update = () => {
      const remaining = Math.max(0, Math.ceil((resetUndo.expiresAt - Date.now()) / 1000))
      setUndoCountdown(remaining)
    }
    update()
    const interval = setInterval(update, 250)
    return () => clearInterval(interval)
  }, [resetUndo])

  // Esc closes the reset-confirm modal + autofocus the safe-default Cancel
  // button (UX P1-4). Per CLAUDE.md backdrop-click is intentionally NOT
  // dismiss; explicit Esc / Cancel / ✕ only.
  useEffect(() => {
    if (!resetConfirm) return
    modalCancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setResetConfirm(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [resetConfirm])

  // Drift banner click-to-scroll (UX P1-3): jump to the first changed
  // row so the user can see what F-list updated.
  const scrollToDriftPath = (path: string) => {
    if (!containerRef.current) return
    const id = path.startsWith('infotags.')
      ? `infotag-field-${path.slice('infotags.'.length)}`
      : null
    if (id) {
      const node = containerRef.current.querySelector(`[data-testid="${id}"]`)
      ;(node as HTMLElement | null)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }

  useEffect(() => {
    if (mappingStatus === 'idle') {
      void loadMapping()
    }
  }, [mappingStatus, loadMapping])

  const model = useMemo(() => {
    const infotagsPayload =
      slot?.payload && typeof slot.payload === 'object'
        ? ((slot.payload.infotags as Record<string, unknown>) ?? {})
        : {}
    return resolveInfotagDescriptors(mapping.payload, {
      overlay: slot?.overlay ?? [],
      infotagsPayload
    })
  }, [mapping.payload, slot?.overlay, slot?.payload])

  if (!slot) {
    return (
      <div className="profile-fields-tab" data-testid="profile-fields-tab">
        <p className="profile-fields-loading">Loading working copy…</p>
      </div>
    )
  }

  const overlay = new Set(slot.overlay)
  const infotagsPayload =
    (slot.payload.infotags as Record<string, unknown> | undefined) ?? {}
  const character = (slot.payload.character as Record<string, unknown> | undefined) ?? {}
  const liveCharacter =
    (live && typeof live === 'object' && (live as { character?: unknown }).character) ||
    (live as Record<string, unknown> | null)

  const visibleGroups = model.groups.filter((g) => g.descriptors.length > 0)
  const driftCount = driftBanner?.paths.length ?? 0

  const filterLower = filter.trim().toLowerCase()
  const matchesFilter = (d: InfotagDescriptor) =>
    !filterLower || d.label.toLowerCase().includes(filterLower)

  return (
    <div
      className="profile-fields-tab"
      data-testid="profile-fields-tab"
      ref={containerRef}
    >
      <div className="profile-fields-controls">
        <div className="profile-fields-controls-row">
          <input
            type="search"
            className="profile-fields-search"
            placeholder="Filter fields…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-testid="profile-fields-search"
          />
          <span className="profile-fields-controls-spacer" />
          <button
            type="button"
            className="profile-fields-expand-all"
            onClick={() => {
              const next: Record<string, boolean> = {}
              for (const g of model.groups) next[g.id] = false
              next[model.unknownGroup.id] = false
              next.character = false
              setCollapsed(next)
              writeCollapsed(next)
            }}
          >
            Expand all
          </button>
          <button
            type="button"
            className="profile-fields-collapse-all"
            onClick={() => {
              const next: Record<string, boolean> = {}
              for (const g of model.groups) next[g.id] = true
              next[model.unknownGroup.id] = true
              next.character = true
              setCollapsed(next)
              writeCollapsed(next)
            }}
          >
            Collapse all
          </button>
          <button
            type="button"
            className="profile-fields-reset"
            data-testid="profile-fields-reset"
            disabled={slot.overlay.length === 0}
            onClick={() => setResetConfirm(true)}
          >
            Reset to Live
          </button>
        </div>
      </div>

      {offAccount && !offAccountDismissed && (
        <div className="profile-fields-banner profile-fields-banner-warning" role="status">
          <span>
            This character is no longer on your F-list account — edits won't be
            exportable until it's re-created.
          </span>
          <button
            type="button"
            className="profile-fields-banner-dismiss"
            aria-label="Dismiss for this session"
            onClick={() => setOffAccountDismissed(true)}
          >
            ✕
          </button>
        </div>
      )}

      {driftCount > 0 && (
        <div
          className="profile-fields-banner profile-fields-banner-drift"
          role={driftAnnounced ? 'status' : 'alert'}
          aria-live={driftAnnounced ? 'polite' : 'assertive'}
          data-testid="profile-fields-drift-banner"
        >
          <span>
            F-list updated {driftCount} field{driftCount === 1 ? '' : 's'} since you started editing — your edits are safe.
          </span>
          <button
            type="button"
            className="profile-fields-banner-action"
            onClick={() => {
              const firstPath = driftBanner?.paths[0]
              if (firstPath) scrollToDriftPath(firstPath)
            }}
          >
            Jump to first
          </button>
          <button
            type="button"
            className="profile-fields-banner-dismiss"
            onClick={() => dismissDrift(characterId)}
            aria-label="Dismiss drift banner"
          >
            ✕
          </button>
        </div>
      )}

      {resetUndo && (
        <div
          className="profile-fields-banner profile-fields-banner-undo"
          role="alert"
          aria-live="assertive"
          data-testid="profile-fields-reset-undo"
        >
          Working copy reset to Live.
          <button type="button" onClick={() => void undoReset()}>
            Undo{undoCountdown != null ? ` (${undoCountdown}s)` : ''}
          </button>
        </div>
      )}

      {/* Custom title row, top of the tab per §4.5 */}
      <InfotagSection
        groupId="character"
        label="Character"
        collapsed={!!collapsed.character}
        onToggle={() => {
          const next = { ...collapsed, character: !collapsed.character }
          setCollapsed(next)
          writeCollapsed(next)
        }}
      >
        <CustomTitleField
          characterId={characterId}
          value={
            typeof character.custom_title === 'string'
              ? (character.custom_title as string)
              : ''
          }
          overlaid={overlay.has('character.custom_title')}
          liveValue={
            liveCharacter && typeof liveCharacter === 'object'
              ? typeof (liveCharacter as Record<string, unknown>).custom_title === 'string'
                ? ((liveCharacter as Record<string, unknown>).custom_title as string)
                : null
              : null
          }
          onCommit={(next) => setField(characterId, 'character.custom_title', next)}
          onReset={() => resetField(characterId, 'character.custom_title')}
        />
      </InfotagSection>

      {visibleGroups.map((group) => (
        <InfotagSection
          key={group.id}
          groupId={group.id}
          label={group.label}
          collapsed={!!collapsed[group.id]}
          onToggle={() => {
            const next = { ...collapsed, [group.id]: !collapsed[group.id] }
            setCollapsed(next)
            writeCollapsed(next)
          }}
        >
          {group.descriptors.filter(matchesFilter).map((descriptor) => (
            <InfotagFieldFor
              key={descriptor.id}
              descriptor={descriptor}
              value={readInfotagValue(infotagsPayload, descriptor.id)}
              overlaid={overlay.has(`infotags.${descriptor.id}`)}
              liveValue={readInfotagLive(live, descriptor.id)}
              readOnly={false}
              onCommit={(next) =>
                setField(characterId, `infotags.${descriptor.id}`, next)
              }
              onReset={() => resetField(characterId, `infotags.${descriptor.id}`)}
              onForceRefreshMapping={() => void loadMapping({ force: true })}
            />
          ))}
        </InfotagSection>
      ))}

      {model.unknownGroup.descriptors.length > 0 && (
        <InfotagSection
          groupId={model.unknownGroup.id}
          label={model.unknownGroup.label}
          collapsed={collapsed[model.unknownGroup.id] !== false}
          onToggle={() => {
            const next = {
              ...collapsed,
              [model.unknownGroup.id]: !collapsed[model.unknownGroup.id]
            }
            setCollapsed(next)
            writeCollapsed(next)
          }}
        >
          {model.unknownGroup.descriptors.filter(matchesFilter).map((descriptor) => (
            <UnknownField
              key={descriptor.id}
              descriptor={descriptor}
              value={readInfotagValue(infotagsPayload, descriptor.id)}
              overlaid={overlay.has(`infotags.${descriptor.id}`)}
              onForceRefreshMapping={() => void loadMapping({ force: true })}
            />
          ))}
        </InfotagSection>
      )}

      <MappingListStaleness context="inline" />

      {resetConfirm && (
        <div
          className="profile-fields-modal-shroud"
          role="dialog"
          aria-modal="true"
          aria-labelledby="profile-fields-reset-title"
          data-testid="profile-fields-reset-confirm"
        >
          <div className="profile-fields-modal">
            <div className="profile-fields-modal-header">
              <span id="profile-fields-reset-title">Reset working copy</span>
              <button
                type="button"
                className="profile-fields-modal-close"
                aria-label="Close"
                onClick={() => setResetConfirm(false)}
              >
                ✕
              </button>
            </div>
            <p>
              Discards {slot.overlay.length} change
              {slot.overlay.length === 1 ? '' : 's'}. Continue?
            </p>
            <div className="profile-fields-modal-buttons">
              <button
                type="button"
                ref={modalCancelRef}
                onClick={() => setResetConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="profile-fields-modal-confirm"
                onClick={() => {
                  setResetConfirm(false)
                  void resetToLive(characterId)
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

function InfotagSection({
  groupId,
  label,
  collapsed,
  onToggle,
  children
}: {
  groupId: string
  label: string
  collapsed: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <section className="profile-fields-section" data-group-id={groupId}>
      <button
        type="button"
        className="profile-fields-section-toggle"
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        {collapsed ? '▸' : '▾'} {label}
      </button>
      {!collapsed && <div className="profile-fields-section-body">{children}</div>}
    </section>
  )
}

function InfotagFieldFor(props: {
  descriptor: InfotagDescriptor
  value: string
  overlaid: boolean
  liveValue: string | null
  readOnly: boolean
  onCommit: (next: string) => void
  onReset: () => void
  onForceRefreshMapping: () => void
}) {
  const { descriptor } = props
  if (descriptor.type === 'list') return <ListField {...props} />
  if (descriptor.type === 'number') return <NumberField {...props} />
  if (descriptor.type === 'text') return <TextField {...props} />
  return (
    <UnknownField
      descriptor={descriptor}
      value={props.value}
      overlaid={props.overlaid}
      onForceRefreshMapping={props.onForceRefreshMapping}
    />
  )
}

function CustomTitleField({
  characterId: _characterId,
  value,
  overlaid,
  liveValue,
  onCommit,
  onReset
}: {
  characterId: string
  value: string
  overlaid: boolean
  liveValue: string | null
  onCommit: (next: string) => void
  onReset: () => void
}) {
  const [local, setLocal] = useState(value)
  useEffect(() => {
    setLocal(value)
  }, [value])
  return (
    <div
      className={`infotag-field${overlaid ? ' infotag-field-overlaid' : ''}`}
      data-testid="character-custom-title"
    >
      <label className="infotag-field-label">
        <span className="infotag-field-name">Custom title</span>
        {overlaid && (
          <button
            type="button"
            className="infotag-field-reset"
            onClick={onReset}
            title="Reset to F-list value"
            aria-label="Reset Custom title to F-list value"
          >
            ↺ reset
          </button>
        )}
      </label>
      <div className="infotag-field-control">
        <input
          type="text"
          className="infotag-field-input"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => {
            if (local !== value) onCommit(local)
          }}
          placeholder="—"
        />
      </div>
      {overlaid && (
        <p className="infotag-field-meta">
          <span className="infotag-field-meta-live">F-list: {liveValue ?? '—'}</span>
        </p>
      )}
    </div>
  )
}

function readInfotagValue(
  infotags: Record<string, unknown>,
  id: string
): string {
  const v = infotags[id]
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : String(v)
}

function readInfotagLive(
  live: Record<string, unknown> | null,
  id: string
): string | null {
  if (!live) return null
  const infotags = (live.infotags as Record<string, unknown> | undefined) ?? {}
  const v = infotags[id]
  if (v === null || v === undefined) return null
  return typeof v === 'string' ? v : String(v)
}
// Reference pathLookup so the import doesn't become unused later if the
// helper migrates inline. Cheap no-op.
void pathLookup
