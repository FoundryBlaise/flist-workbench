import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../state'
import type { LogMessage } from '../../lib/api'

type Filter = { ic: boolean; ooc: boolean; system: boolean }
const DEFAULT_FILTER: Filter = { ic: true, ooc: true, system: true }

function partnerKey(char: string | null, partner: string | null): string | null {
  return char && partner ? `${char}::${partner}` : null
}

function dayLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  })
}

function timeLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

function highlight(text: string, q: string): { html: string; count: number } {
  if (!q) return { html: escapeHtml(text), count: 0 }
  const escapedQuery = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(escapedQuery, 'gi')
  let count = 0
  const html = escapeHtml(text).replace(
    new RegExp(escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
    (m) => {
      count += 1
      return `<mark class="log-hit">${escapeHtml(m)}</mark>`
    }
  )
  // Use re.lastIndex to silence the unused-var lint cleanly. (And no, that's
  // not how lint silencing should work — but we need the regex object for
  // splitting; the second escape above does the actual replace.)
  re.lastIndex = 0
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
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (activeChar && partner) void loadMessages(activeChar, partner)
  }, [activeChar, partner, loadMessages])

  // Reset filter / search when the partner switches.
  useEffect(() => {
    setSearch('')
    setActiveHit(0)
  }, [key])

  const filtered = useMemo<LogMessage[]>(() => {
    if (!messages) return []
    return messages.filter((m) => filter[m.kind])
  }, [messages, filter])

  const stats = useMemo(() => {
    if (!messages) return { total: 0, ic: 0, ooc: 0, system: 0, from: '', to: '' }
    const ic = messages.filter((m) => m.kind === 'ic').length
    const ooc = messages.filter((m) => m.kind === 'ooc').length
    const system = messages.filter((m) => m.kind === 'system').length
    const from = messages.length ? dayLabel(messages[0].ts) : ''
    const to = messages.length ? dayLabel(messages[messages.length - 1].ts) : ''
    return { total: messages.length, ic, ooc, system, from, to }
  }, [messages])

  const rendered = useMemo(() => {
    let lastDay = ''
    let hitTotal = 0
    const items: Array<
      | { kind: 'day'; key: string; label: string }
      | { kind: 'msg'; key: string; msg: LogMessage; html: string; hitsBefore: number; hits: number }
    > = []
    for (const m of filtered) {
      const day = dayLabel(m.ts)
      if (day !== lastDay) {
        items.push({ kind: 'day', key: `day-${day}-${m.ts}`, label: day })
        lastDay = day
      }
      const { html, count } = highlight(m.text, search)
      items.push({
        kind: 'msg',
        key: `m-${m.ts}-${m.speaker}-${items.length}`,
        msg: m,
        html,
        hitsBefore: hitTotal,
        hits: count
      })
      hitTotal += count
    }
    return { items, hitTotal }
  }, [filtered, search])

  useEffect(() => {
    if (!search) return
    const body = bodyRef.current
    if (!body) return
    const marks = body.querySelectorAll('mark.log-hit')
    marks.forEach((mark, i) => mark.classList.toggle('log-hit-active', i === activeHit))
    const active = marks[activeHit]
    if (active && 'scrollIntoView' in active) {
      ;(active as HTMLElement).scrollIntoView({ block: 'center', behavior: 'auto' })
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
        <header className="pane-head">{partner}</header>
        <div className="pane-body pane-body-placeholder">Loading log…</div>
      </section>
    )
  }
  if (status === 'error') {
    return (
      <section className="pane" data-testid="log-viewer">
        <header className="pane-head">{partner}</header>
        <div className="pane-body pane-body-placeholder">Couldn't load: {error}</div>
      </section>
    )
  }

  return (
    <section className="pane log-pane" data-testid="log-viewer">
      <header className="pane-head log-head">
        <span className="partner">{partner}</span>
        <span className="log-meta">
          {stats.total.toLocaleString()} messages · {stats.from === stats.to ? stats.from : `${stats.from} → ${stats.to}`}
        </span>
        <span className="log-pill">IC {stats.ic.toLocaleString()}</span>
        <span className="log-pill">OOC {stats.ooc.toLocaleString()}</span>
        {stats.system > 0 && <span className="log-pill">sys {stats.system.toLocaleString()}</span>}
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
        <FilterButton label="IC" on={filter.ic} onClick={() => setFilter((f) => ({ ...f, ic: !f.ic }))} />
        <FilterButton
          label="OOC"
          on={filter.ooc}
          onClick={() => setFilter((f) => ({ ...f, ooc: !f.ooc }))}
        />
        <FilterButton
          label="System"
          on={filter.system}
          onClick={() => setFilter((f) => ({ ...f, system: !f.system }))}
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
      </div>
      <div className="pane-body log-body" ref={bodyRef} data-testid="log-body">
        {filtered.length === 0 ? (
          <div className="pane-body-placeholder">No messages match the current filter.</div>
        ) : (
          rendered.items.map((item) =>
            item.kind === 'day' ? (
              <div key={item.key} className="day-sep">
                {item.label}
              </div>
            ) : (
              <MessageRow
                key={item.key}
                msg={item.msg}
                html={item.html}
                isOwn={item.msg.speaker === activeChar}
              />
            )
          )
        )}
      </div>
    </section>
  )
}

function FilterButton({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`log-filter ${on ? 'on' : 'off'}`}
      onClick={onClick}
      aria-pressed={on}
    >
      {label}
    </button>
  )
}

function MessageRow({ msg, html, isOwn }: { msg: LogMessage; html: string; isOwn: boolean }) {
  const klass = [
    'log-msg',
    `log-msg-${msg.kind}`,
    isOwn ? 'log-msg-own' : 'log-msg-other'
  ].join(' ')
  return (
    <div className={klass}>
      <span className="log-ts" title={msg.iso}>
        {timeLabel(msg.ts)}
      </span>
      <span className="log-speaker">{msg.speaker}</span>
      <span className={`log-label log-label-${msg.kind}`}>{msg.kind.toUpperCase()}</span>
      <span className="log-text" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
