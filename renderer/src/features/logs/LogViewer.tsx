import { useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useStore } from '../../state'
import type { LogMessage } from '../../lib/api'
import { displayPartner } from '../../lib/partnerName'
import { exportMessages, type ExportFormat } from '../../lib/sceneExport'

type Filter = { ic: boolean; ooc: boolean; system: boolean }
const DEFAULT_FILTER: Filter = { ic: true, ooc: true, system: true }

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
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  const markSeen = useStore((s) => s.markCharacterSeen)

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
  }, [key])

  const filtered = useMemo<LogMessage[]>(() => {
    if (!messages) return []
    const byKind = messages.filter((m) => filter[m.kind])
    if (!search) return byKind
    const q = search.toLowerCase()
    return byKind.filter((m) => m.text.toLowerCase().includes(q))
  }, [messages, filter, search])

  const stats = useMemo(() => {
    if (!messages) return { total: 0, ic: 0, ooc: 0, system: 0, from: '', to: '' }
    // Single pass instead of three filters over 80k+ items.
    let ic = 0
    let ooc = 0
    let system = 0
    for (const m of messages) {
      if (m.kind === 'ic') ic++
      else if (m.kind === 'ooc') ooc++
      else if (m.kind === 'system') system++
    }
    const from = messages.length ? dayLabel(messages[0].ts) : ''
    const to = messages.length ? dayLabel(messages[messages.length - 1].ts) : ''
    return { total: messages.length, ic, ooc, system, from, to }
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

  // IC/OOC/SYSTEM here reflects F-Chat's `type` field on each message,
  // not what a roleplayer might call IC vs OOC. Channel messages get
  // type=MSG and surface as IC even if the channel is conceptually OOC
  // (e.g. `#german ooc` reading "IC 14k · OOC 0"). The tooltip below
  // explains this so users don't think the parser dropped data.
  const kindTooltip =
    'IC/OOC/SYSTEM mirror F-Chat\'s message type field. ' +
    'Channel messages are stored as IC even in channels named "ooc".'

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
          title={kindTooltip}
        />
        <FilterButton
          label="OOC"
          count={stats.ooc}
          on={filter.ooc}
          onClick={() => setFilter((f) => ({ ...f, ooc: !f.ooc }))}
          title={kindTooltip}
        />
        <FilterButton
          label="System"
          count={stats.system}
          on={filter.system}
          onClick={() => setFilter((f) => ({ ...f, system: !f.system }))}
          title={kindTooltip}
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
                  onSelectClick={(shift) => {
                    if (sourceIdx !== -1) handleRowClick(sourceIdx, shift)
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

function MessageRow({
  msg,
  search,
  hitsBefore,
  activeHit,
  isOwn,
  selectMode,
  selected,
  onSelectClick
}: {
  msg: LogMessage
  search: string
  hitsBefore: number
  activeHit: number
  isOwn: boolean
  selectMode: boolean
  selected: boolean
  onSelectClick: (shift: boolean) => void
}) {
  // Lazy: only escape/highlight at render time for rows actually
  // visible to the user. This is what keeps an 80k-message channel
  // feeling instant.
  const html = useMemo(
    () => highlight(msg.text, search, hitsBefore, activeHit).html,
    [msg.text, search, hitsBefore, activeHit]
  )
  const klass = [
    'log-msg',
    `log-msg-${msg.kind}`,
    isOwn ? 'log-msg-own' : 'log-msg-other',
    selectMode ? 'log-msg-selectable' : '',
    selected ? 'log-msg-selected' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div
      className={klass}
      onClick={
        selectMode
          ? (e) => {
              onSelectClick(e.shiftKey)
            }
          : undefined
      }
    >
      <span className="log-ts" title={msg.iso}>
        {timeLabel(msg.ts)}
      </span>
      <span className="log-speaker">{msg.speaker}</span>
      <span className={`log-label log-label-${msg.kind}`}>{msg.kind.toUpperCase()}</span>
      <span className="log-text" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
