import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useStore } from '../../state'
import { api, type Label, type LogMessage } from '../../lib/api'
import { displayPartner } from '../../lib/partnerName'
import { exportMessages, type ExportFormat } from '../../lib/sceneExport'

type LabelMenuState = { x: number; y: number; msg: LogMessage } | null

// Three semantic chips for resolved IC/OOC/Unlabeled + one for the
// F-Chat "System" type bucket (ads/rolls/warns/events) which is
// independent of IC/OOC and useful to silence separately.
type Filter = { ic: boolean; ooc: boolean; unlabeled: boolean; system: boolean }
const DEFAULT_FILTER: Filter = { ic: true, ooc: true, unlabeled: true, system: true }

// A message's effective label for filtering. System-type messages
// (ad/roll/warn/event) get bucketed as "System" regardless of label
// — they're never roleplay content.
function effectiveBucket(m: LogMessage): 'ic' | 'ooc' | 'unlabeled' | 'system' {
  if (m.kind === 'system') return 'system'
  if (m.label === 'IC') return 'ic'
  if (m.label === 'OOC') return 'ooc'
  // Missing label (shouldn't happen with new sidecar, but defensive) or
  // explicit Unlabeled — both bucket as unlabeled.
  return 'unlabeled'
}

function partnerKey(char: string | null, partner: string | null): string | null {
  return char && partner ? `${char}::${partner}` : null
}

// toLocaleDateString is shockingly expensive (~100 µs/call on V8) so
// for 80k-message logs we cache by local-day bucket. The bucket key is
// the YYYY-MM-DD string derived from the local-time epoch, which is
// stable and cheap to compute without going through the locale layer.
const DAY_LABEL_CACHE = new Map<string, string>()

function dayBucket(ts: number): string {
  const d = new Date(ts * 1000)
  // Local year-month-day, padded.
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const day = d.getDate()
  return `${y}-${m < 10 ? '0' : ''}${m}-${day < 10 ? '0' : ''}${day}`
}

function dayLabel(ts: number): string {
  const key = dayBucket(ts)
  const cached = DAY_LABEL_CACHE.get(key)
  if (cached !== undefined) return cached
  const label = new Date(ts * 1000).toLocaleDateString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  })
  DAY_LABEL_CACHE.set(key, label)
  return label
}

function timeLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

function highlight(
  text: string,
  q: string,
  hitsBefore: number,
  activeHit: number
): { html: string; count: number } {
  if (!q) return { html: escapeHtml(text), count: 0 }
  const escapedQuery = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(escapedQuery, 'gi')
  let count = 0
  const html = escapeHtml(text).replace(re, (m) => {
    const globalIdx = hitsBefore + count
    count += 1
    const cls = globalIdx === activeHit ? 'log-hit log-hit-active' : 'log-hit'
    return `<mark class="${cls}">${escapeHtml(m)}</mark>`
  })
  return { html, count }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function LogViewer() {
  const activeChar = useStore((s) => s.activeCharacter)
  const partner = useStore((s) => s.activePartner)
  const loadMessages = useStore((s) => s.loadMessages)
  const key = partnerKey(activeChar, partner)
  const status = useStore((s) => (key ? s.messagesStatus[key] : undefined))
  const messages = useStore((s) => (key ? s.messagesByPartner[key] : undefined))
  const error = useStore((s) => (key ? s.messagesError[key] : null))

  const [filter, setFilter] = useState<Filter>(DEFAULT_FILTER)
  const [search, setSearch] = useState('')
  const [activeHit, setActiveHit] = useState(0)
  // Scene-export selection: when on, clicking a row marks one end of
  // the range. The next click marks the other end (or extends if
  // shift-clicked). The range is inclusive of both endpoints.
  const [selectMode, setSelectMode] = useState(false)
  const [selRange, setSelRange] = useState<[number, number] | null>(null)
  const [labelMenu, setLabelMenu] = useState<LabelMenuState>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  const markSeen = useStore((s) => s.markCharacterSeen)
  const applyLabelOverride = useStore((s) => s.applyLabelOverride)

  useEffect(() => {
    if (activeChar && partner) {
      void loadMessages(activeChar, partner)
      // Opening a conversation = the user has "seen" this character's
      // current log state. Used to drive the recently-active dot in
      // the character picker — see CharacterPicker.tsx.
      markSeen(activeChar)
    }
  }, [activeChar, partner, loadMessages, markSeen])

  // Reset filter / search / selection when the partner switches.
  useEffect(() => {
    setSearch('')
    setActiveHit(0)
    setSelRange(null)
    setSelectMode(false)
    setLabelMenu(null)
  }, [key])

  // Close the label menu on Escape or any non-menu click — same
  // affordance users expect from native context menus.
  useEffect(() => {
    if (!labelMenu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLabelMenu(null)
    }
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('.log-label-menu')) return
      setLabelMenu(null)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [labelMenu])

  const submitOverride = async (msg: LogMessage, label: 'IC' | 'OOC' | null) => {
    if (!activeChar || !partner) return
    setLabelMenu(null)
    // Optimistic — patch the local state, then call the API. If the
    // request fails we reload the conversation to get authoritative
    // state back from the sidecar.
    if (label === null) {
      applyLabelOverride(activeChar, partner, msg.hash, null)
    } else {
      applyLabelOverride(activeChar, partner, msg.hash, {
        label,
        label_source: 'manual',
        label_confidence: 1.0
      })
    }
    try {
      await api.labelsOverride({
        character: activeChar,
        partner,
        hash: msg.hash,
        ts: msg.ts,
        speaker: msg.speaker,
        label
      })
    } catch (err) {
      console.error('[labels] override failed', err)
      // Soft-reset by refetching — cheap for a paged conversation.
      void useStore.getState().loadMessages(activeChar, partner)
    }
  }

  const filtered = useMemo<LogMessage[]>(() => {
    if (!messages) return []
    const byBucket = messages.filter((m) => filter[effectiveBucket(m)])
    if (!search) return byBucket
    const q = search.toLowerCase()
    return byBucket.filter((m) => m.text.toLowerCase().includes(q))
  }, [messages, filter, search])

  const stats = useMemo(() => {
    if (!messages) return { total: 0, ic: 0, ooc: 0, unlabeled: 0, system: 0, from: '', to: '' }
    // Single pass instead of three filters over 80k+ items.
    let ic = 0
    let ooc = 0
    let unlabeled = 0
    let system = 0
    for (const m of messages) {
      const b = effectiveBucket(m)
      if (b === 'ic') ic++
      else if (b === 'ooc') ooc++
      else if (b === 'unlabeled') unlabeled++
      else system++
    }
    const from = messages.length ? dayLabel(messages[0].ts) : ''
    const to = messages.length ? dayLabel(messages[messages.length - 1].ts) : ''
    return { total: messages.length, ic, ooc, unlabeled, system, from, to }
  }, [messages])

  type Item =
    | { kind: 'day'; key: string; label: string }
    | { kind: 'msg'; key: string; msg: LogMessage; hitsBefore: number; hits: number }

  // Build the day-sep + message list. We deliberately do NOT call
  // escapeHtml / highlight here — those are done lazily inside the
  // MessageRow render so big channels (82k+ messages) don't spend a
  // second of string work on rows the user never sees. Hit counts are
  // cheap to compute and still need to be precomputed for the jump
  // counter ("3 / 14") and for scroll-to-next.
  const rendered = useMemo(() => {
    let lastDay = ''
    let hitTotal = 0
    const items: Item[] = []
    const escRe = search
      ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      : null
    for (const m of filtered) {
      // Compare on the cheap bucket key, only format the label when we
      // actually emit a separator. Saves an order of magnitude over
      // running toLocaleDateString on every row.
      const bucket = dayBucket(m.ts)
      if (bucket !== lastDay) {
        items.push({ kind: 'day', key: `day-${bucket}-${m.ts}`, label: dayLabel(m.ts) })
        lastDay = bucket
      }
      let count = 0
      if (escRe) {
        escRe.lastIndex = 0
        while (escRe.exec(m.text) !== null) count += 1
      }
      items.push({
        kind: 'msg',
        key: `m-${m.ts}-${m.speaker}-${items.length}`,
        msg: m,
        hitsBefore: hitTotal,
        hits: count
      })
      hitTotal += count
    }
    return { items, hitTotal }
  }, [filtered, search])

  // With virtualisation we can't grab mark.log-hit-active from the DOM
  // (it may not be mounted yet). Look up the index of the message that
  // owns the active hit and ask Virtuoso to scroll it into view.
  useEffect(() => {
    if (!search || rendered.hitTotal === 0) return
    let idx = -1
    for (let i = 0; i < rendered.items.length; i++) {
      const it = rendered.items[i]
      if (it.kind === 'msg' && activeHit >= it.hitsBefore && activeHit < it.hitsBefore + it.hits) {
        idx = i
        break
      }
    }
    if (idx >= 0) {
      virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center', behavior: 'auto' })
    }
  }, [search, activeHit, rendered])

  if (!partner) {
    return (
      <section className="pane" data-testid="log-viewer">
        <header className="pane-head">Pick a partner</header>
        <div className="pane-body pane-body-placeholder">Choose a partner from the sidebar.</div>
      </section>
    )
  }
  if (status === 'loading' || !messages) {
    return (
      <section className="pane" data-testid="log-viewer">
        <header className="pane-head">{displayPartner(partner)}</header>
        <div className="pane-body pane-body-placeholder">Loading log…</div>
      </section>
    )
  }
  if (status === 'error') {
    return (
      <section className="pane" data-testid="log-viewer">
        <header className="pane-head">{displayPartner(partner)}</header>
        <div className="pane-body pane-body-placeholder">Couldn't load: {error}</div>
      </section>
    )
  }

  // Chip tooltips. IC/OOC/Unlabeled come from the resolver (rule + LLM
  // + manual). System is F-Chat's ad/roll/warn/event bucket — kept as
  // a separate filter because it's neither IC nor OOC and the user
  // might want to silence it independently.
  const labelTooltip =
    'IC / OOC / Unlabeled come from the classifier. ' +
    'Short text (<200 chars by default) and "((…" are auto-OOC; ' +
    'everything else is Unlabeled until you run Classify on this conversation.'
  const systemTooltip =
    'Ads, dice rolls, warnings and channel events. Not roleplay content.'

  // Map the currently-visible filtered list back into the underlying
  // `messages` array via its own array index. This is what `selRange`
  // points at, so toggling filters mid-selection doesn't accidentally
  // move the bounds.
  const handleRowClick = (idx: number, shiftKey: boolean) => {
    if (!selectMode) return
    setSelRange((prev) => {
      if (!prev || !shiftKey) return [idx, idx]
      // Shift-click extends the range from whichever bound is closer
      // — feels like a normal multi-select.
      const [a, b] = prev
      const distA = Math.abs(idx - a)
      const distB = Math.abs(idx - b)
      return distA <= distB ? [idx, b] : [a, idx]
    })
  }

  const exportRange = (format: ExportFormat) => {
    if (!messages || !partner || !activeChar) return
    const slice =
      selRange === null
        ? filtered
        : messages.slice(
            Math.min(selRange[0], selRange[1]),
            Math.max(selRange[0], selRange[1]) + 1
          )
    if (slice.length === 0) return
    const text = exportMessages(slice, displayPartner(partner), activeChar, format)
    // Clipboard is the integration surface per project policy — paste
    // it wherever the user wants the scene to land.
    void navigator.clipboard.writeText(text).then(() => {
      // Surface a quiet status; the alert would be intrusive for a
      // multi-select export so just log to console.
      console.info(`[log-export] copied ${slice.length} message(s) as ${format}`)
    })
  }

  const selBounds =
    selRange === null
      ? null
      : ([Math.min(selRange[0], selRange[1]), Math.max(selRange[0], selRange[1])] as [number, number])
  const selectionCount = selBounds ? selBounds[1] - selBounds[0] + 1 : 0
  const isInSelection = (idx: number): boolean =>
    selBounds !== null && idx >= selBounds[0] && idx <= selBounds[1]

  const unlabeledCount = stats.unlabeled

  return (
    <section className="pane log-pane" data-testid="log-viewer">
      <header className="pane-head log-head">
        <span className="partner">{displayPartner(partner)}</span>
        <span className="log-meta">
          {stats.total.toLocaleString()} messages · {stats.from === stats.to ? stats.from : `${stats.from} → ${stats.to}`}
        </span>
        {search && rendered.hitTotal > 0 && (
          <span className="log-pill log-pill-hit">
            {Math.min(activeHit + 1, rendered.hitTotal)} / {rendered.hitTotal}
          </span>
        )}
        {unlabeledCount > 0 && (
          <span
            className="log-unlabeled-hint"
            data-testid="log-unlabeled-hint"
            title="Open the Logs menu → Classify Current Conversation to send these to the LLM."
          >
            {unlabeledCount.toLocaleString()} unlabeled · Logs menu → Classify
          </span>
        )}
      </header>
      <div className="log-filters">
        <input
          className="log-search"
          placeholder="Search this conversation…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setActiveHit(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && rendered.hitTotal > 0) {
              setActiveHit((i) => (i + 1) % rendered.hitTotal)
            }
          }}
          data-testid="log-search"
        />
        <FilterButton
          label="IC"
          count={stats.ic}
          on={filter.ic}
          onClick={() => setFilter((f) => ({ ...f, ic: !f.ic }))}
          title={labelTooltip}
        />
        <FilterButton
          label="OOC"
          count={stats.ooc}
          on={filter.ooc}
          onClick={() => setFilter((f) => ({ ...f, ooc: !f.ooc }))}
          title={labelTooltip}
        />
        <FilterButton
          label="Unlabeled"
          count={stats.unlabeled}
          on={filter.unlabeled}
          onClick={() => setFilter((f) => ({ ...f, unlabeled: !f.unlabeled }))}
          title={labelTooltip}
        />
        <FilterButton
          label="System"
          count={stats.system}
          on={filter.system}
          onClick={() => setFilter((f) => ({ ...f, system: !f.system }))}
          title={systemTooltip}
        />
        {search && rendered.hitTotal > 0 && (
          <button
            type="button"
            className="log-jump"
            onClick={() => setActiveHit((i) => (i + 1) % rendered.hitTotal)}
            title="Jump to next match (Enter in search)"
          >
            jump ↓
          </button>
        )}
        <button
          type="button"
          className={`log-export-toggle ${selectMode ? 'on' : 'off'}`}
          onClick={() => {
            setSelectMode((v) => {
              if (v) setSelRange(null)
              return !v
            })
          }}
          title="Toggle scene selection — click a row to start, shift-click to extend, then Export."
          data-testid="log-export-toggle"
          aria-pressed={selectMode}
        >
          {selectMode ? 'Cancel select' : 'Select for export'}
        </button>
      </div>
      {selectMode && (
        <div className="log-export-bar" data-testid="log-export-bar">
          <span className="log-export-status">
            {selBounds
              ? `${selectionCount.toLocaleString()} message${selectionCount === 1 ? '' : 's'} selected`
              : 'Click a row to begin · shift-click to extend'}
          </span>
          <button
            type="button"
            onClick={() => exportRange('markdown')}
            disabled={selBounds === null}
            title="Copy the selection as Markdown to the clipboard"
          >
            Copy Markdown
          </button>
          <button
            type="button"
            onClick={() => exportRange('text')}
            disabled={selBounds === null}
            title="Copy the selection as plain text to the clipboard"
          >
            Copy Text
          </button>
          {selBounds !== null && (
            <button
              type="button"
              className="log-export-clear"
              onClick={() => setSelRange(null)}
              title="Clear selection"
            >
              clear
            </button>
          )}
        </div>
      )}
      {labelMenu && (
        <LabelContextMenu
          x={labelMenu.x}
          y={labelMenu.y}
          msg={labelMenu.msg}
          onChoose={(label) => void submitOverride(labelMenu.msg, label)}
        />
      )}
      <div className="pane-body log-body" data-testid="log-body">
        {filtered.length === 0 ? (
          <div className="pane-body-placeholder">
            {search
              ? `No messages match "${search}".`
              : 'No messages match the current filter.'}
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={rendered.items}
            increaseViewportBy={{ top: 600, bottom: 600 }}
            computeItemKey={(_, item) => item.key}
            itemContent={(_, item) => {
              if (item.kind === 'day') return <div className="day-sep">{item.label}</div>
              // Resolve the underlying messages-array index for this
              // row so selection survives filter/search toggles.
              const sourceIdx = messages ? messages.indexOf(item.msg) : -1
              return (
                <MessageRow
                  msg={item.msg}
                  search={search}
                  hitsBefore={item.hitsBefore}
                  activeHit={activeHit}
                  isOwn={item.msg.speaker === activeChar}
                  selectMode={selectMode}
                  selected={sourceIdx !== -1 && isInSelection(sourceIdx)}
                  isMenuTarget={labelMenu?.msg.hash === item.msg.hash}
                  onSelectClick={(shift) => {
                    if (sourceIdx !== -1) handleRowClick(sourceIdx, shift)
                  }}
                  onContextMenu={(e) => {
                    if (selectMode) return
                    // No override for System-typed rows — the bucket
                    // is hard-pinned in effectiveBucket() so a manual
                    // IC/OOC label would persist to DB but never
                    // change the visible badge. Silent no-op was the
                    // worst possible UX; offer no menu at all instead.
                    if (item.msg.kind === 'system') return
                    e.preventDefault()
                    setLabelMenu({ x: e.clientX, y: e.clientY, msg: item.msg })
                  }}
                  onLabelKeyboardOpen={(anchor) => {
                    if (selectMode) return
                    if (item.msg.kind === 'system') return
                    const r = anchor.getBoundingClientRect()
                    setLabelMenu({ x: r.left + 16, y: r.bottom, msg: item.msg })
                  }}
                />
              )
            }}
          />
        )}
      </div>
    </section>
  )
}

function FilterButton({
  label,
  count,
  on,
  onClick,
  title
}: {
  label: string
  count: number
  on: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      className={`log-filter ${on ? 'on' : 'off'}`}
      onClick={onClick}
      aria-pressed={on}
      title={title}
    >
      {label} <span className="log-filter-count">({count.toLocaleString()})</span>
    </button>
  )
}

// Confidence ≥ this gets a "trusted" visual; below it we hint visually
// that the LLM wasn't sure. Manual labels are always 1.0 and trusted.
const CONFIDENT_LABEL = 0.7

function MessageRow({
  msg,
  search,
  hitsBefore,
  activeHit,
  isOwn,
  selectMode,
  selected,
  isMenuTarget,
  onSelectClick,
  onContextMenu,
  onLabelKeyboardOpen
}: {
  msg: LogMessage
  search: string
  hitsBefore: number
  activeHit: number
  isOwn: boolean
  selectMode: boolean
  selected: boolean
  isMenuTarget: boolean
  onSelectClick: (shift: boolean) => void
  onContextMenu: (e: ReactMouseEvent<HTMLDivElement>) => void
  onLabelKeyboardOpen: (anchor: HTMLElement) => void
}) {
  // Lazy: only escape/highlight at render time for rows actually
  // visible to the user. This is what keeps an 80k-message channel
  // feeling instant.
  const html = useMemo(
    () => highlight(msg.text, search, hitsBefore, activeHit).html,
    [msg.text, search, hitsBefore, activeHit]
  )
  const bucket = effectiveBucket(msg)
  const klass = [
    'log-msg',
    `log-msg-${bucket}`,
    isOwn ? 'log-msg-own' : 'log-msg-other',
    msg.label_source === 'manual' ? 'log-msg-manual' : '',
    selectMode ? 'log-msg-selectable' : '',
    selected ? 'log-msg-selected' : '',
    isMenuTarget ? 'log-msg-menu-target' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div
      className={klass}
      tabIndex={selectMode ? -1 : 0}
      onClick={
        selectMode
          ? (e) => {
              onSelectClick(e.shiftKey)
            }
          : undefined
      }
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        // Keyboard equivalent of right-click: Shift+F10 or the
        // ContextMenu key open the label menu anchored at the row.
        if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
          e.preventDefault()
          onLabelKeyboardOpen(e.currentTarget)
        }
      }}
    >
      <span className="log-ts" title={msg.iso}>
        {timeLabel(msg.ts)}
      </span>
      <span className="log-speaker">{msg.speaker}</span>
      <LabelBadge
        bucket={bucket}
        label={msg.label}
        source={msg.label_source}
        confidence={msg.label_confidence}
        priorLabel={msg.prior_label}
        priorSource={msg.prior_source}
      />
      <span className="log-text" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

function LabelContextMenu({
  x,
  y,
  msg,
  onChoose
}: {
  x: number
  y: number
  msg: LogMessage
  onChoose: (label: 'IC' | 'OOC' | null) => void
}) {
  // Nudge the menu so it stays inside the viewport on right-clicks
  // near the bottom/right edges. 180×120 is the menu's nominal size.
  const W = 200
  const H = 140
  const left = Math.min(x, window.innerWidth - W - 8)
  const top = Math.min(y, window.innerHeight - H - 8)
  const currentLabel = msg.label
  const currentSource = msg.label_source
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    // Open on the first enabled item so keyboard users land on a
    // sensible default and arrow keys do something immediately.
    const first = itemRefs.current.find((b) => b && !b.disabled)
    first?.focus()
  }, [])

  const moveFocus = (from: number, dir: 1 | -1) => {
    const items = itemRefs.current
    const len = items.length
    if (len === 0) return
    let idx = from
    for (let step = 0; step < len; step++) {
      idx = (idx + dir + len) % len
      const btn = items[idx]
      if (btn && !btn.disabled) {
        btn.focus()
        return
      }
    }
  }

  const onItemKeyDown = (idx: number) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveFocus(idx, 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveFocus(idx, -1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      moveFocus(-1, 1)
    } else if (e.key === 'End') {
      e.preventDefault()
      moveFocus(itemRefs.current.length, -1)
    }
  }

  return (
    <div
      className="log-label-menu"
      style={{ left, top }}
      data-testid="log-label-menu"
      role="menu"
      aria-label="Label this message"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="log-label-menu-head">
        Label this message
        {currentSource && (
          <span className="log-label-menu-current">
            {currentLabel} · {currentSource}
          </span>
        )}
      </div>
      <button
        ref={(el) => {
          itemRefs.current[0] = el
        }}
        type="button"
        role="menuitem"
        className="log-label-menu-item"
        onClick={() => onChoose('IC')}
        onKeyDown={onItemKeyDown(0)}
        data-testid="log-label-menu-ic"
      >
        Set <strong>IC</strong>
      </button>
      <button
        ref={(el) => {
          itemRefs.current[1] = el
        }}
        type="button"
        role="menuitem"
        className="log-label-menu-item"
        onClick={() => onChoose('OOC')}
        onKeyDown={onItemKeyDown(1)}
        data-testid="log-label-menu-ooc"
      >
        Set <strong>OOC</strong>
      </button>
      <button
        ref={(el) => {
          itemRefs.current[2] = el
        }}
        type="button"
        role="menuitem"
        className="log-label-menu-item log-label-menu-reset"
        onClick={() => onChoose(null)}
        onKeyDown={onItemKeyDown(2)}
        disabled={currentSource === undefined}
        title={
          currentSource === undefined
            ? 'No manual or LLM label to reset'
            : 'Remove the manual/LLM label and fall back to the rules / Unlabeled'
        }
        data-testid="log-label-menu-reset"
      >
        Reset to rule / Unlabeled
      </button>
    </div>
  )
}

function LabelBadge({
  bucket,
  label,
  source,
  confidence,
  priorLabel,
  priorSource
}: {
  bucket: 'ic' | 'ooc' | 'unlabeled' | 'system'
  label?: Label
  source?: 'llm' | 'manual'
  confidence?: number
  // Sidecar only ever sets prior_label when the user manually
  // overrode an IC or OOC label, so the wire shape is just IC|OOC.
  priorLabel?: 'IC' | 'OOC'
  priorSource?: 'llm' | 'manual'
}) {
  // IC / OOC keep their full word — short, semantically loaded, and
  // the chip strip uses the same spelling. Unlabeled and System show
  // a single em-dash because the chip strip already names them and a
  // tiny "UNL"/"SYS" badge was both jargon-y and a contrast hazard.
  const text =
    bucket === 'system'
      ? '—'
      : bucket === 'unlabeled'
        ? '—'
        : bucket === 'ic'
          ? 'IC'
          : 'OOC'
  const lowConfidence = source === 'llm' && typeof confidence === 'number' && confidence < CONFIDENT_LABEL
  const klass = [
    'log-label',
    `log-label-${bucket}`,
    source ? `log-label-src-${source}` : '',
    lowConfidence ? 'log-label-lowconf' : ''
  ]
    .filter(Boolean)
    .join(' ')
  // Title surfaces source, confidence, and prior snapshot on hover —
  // a manual override carries "you changed this from IC (llm) to
  // OOC" so the user can audit their own choices.
  const baseTip = source
    ? `${label} · ${source}${typeof confidence === 'number' ? ` · ${(confidence * 100).toFixed(0)}%` : ''}`
    : bucket === 'system'
      ? 'F-Chat system message'
      : bucket === 'unlabeled'
        ? 'Not classified — Classify on demand'
        : `${label} · rule`
  const priorTip =
    source === 'manual' && priorLabel
      ? `  ·  was ${priorLabel} (${priorSource ?? 'auto'})`
      : ''
  return (
    <span
      className={klass}
      title={`${baseTip}${priorTip}`}
      aria-label={source === 'manual' ? `${label}, manually labeled` : undefined}
    >
      {text}
      {source === 'manual' && (
        <span className="log-label-manual-glyph" aria-hidden>
          ✎
        </span>
      )}
    </span>
  )
}
