import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useStore } from '../../state'
import { api, type Label, type LabelSource, type LogMessage } from '../../lib/api'
import { displayPartner } from '../../lib/partnerName'
import { exportMessages, type ExportFormat } from '../../lib/sceneExport'

// `bulk`: opened on a row that is part of a multi-selection, so the
// choice applies to every selected message rather than just this one.
type LabelMenuState = { x: number; y: number; msg: LogMessage; bulk: boolean } | null

// Semantic chips for resolved IC / OOC / Unlabeled / Failed + one for
// the F-Chat "System" type bucket (ads/rolls/warns/events) which is
// independent of IC/OOC and useful to silence separately. "Failed" is
// a sidecar-tracked state for messages whose classify call errored;
// the user fixes them via the per-message Mark IC / Mark OOC menu.
type Filter = {
  ic: boolean
  ooc: boolean
  unlabeled: boolean
  system: boolean
}
const DEFAULT_FILTER: Filter = {
  ic: true,
  ooc: true,
  unlabeled: true,
  system: true,
}

type Bucket = 'ic' | 'ooc' | 'unlabeled' | 'system'

// A message's effective label for filtering. System-type messages
// (ad/roll/warn/event) get bucketed as "System" regardless of label
// — they're never roleplay content.
function effectiveBucket(m: LogMessage): Bucket {
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
  // Multi-select, for labelling or exporting several messages at once.
  // Held as message hashes rather than a range, so a selection can
  // skip rows and survives filter / search toggles. A click ticks or
  // unticks one row; a shift-click adds every shown row between the
  // anchor (the last row clicked) and this one.
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const anchorRef = useRef<string | null>(null)
  const clearSelection = () => {
    setSelected(new Set())
    anchorRef.current = null
  }
  const [labelMenu, setLabelMenu] = useState<LabelMenuState>(null)
  // Per-action undo affordance for manual label changes — a single
  // override or a batch one. Auto-clears after 5 seconds; replacing the
  // toast (e.g. user makes a second override quickly) cancels the
  // previous countdown.
  const [undoToast, setUndoToast] = useState<{
    text: string
    undo: () => void
  } | null>(null)
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showUndoToast = (text: string, undo: () => void) => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    setUndoToast({ text, undo })
    undoTimerRef.current = setTimeout(() => setUndoToast(null), 5000)
  }
  useEffect(
    () => () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    },
    []
  )
  // Separate menu for conversation-level actions (Classify whole
  // conversation, …) — right-click on the pane header. Distinct from
  // labelMenu which is per-message.
  const [convMenu, setConvMenu] = useState<{ x: number; y: number } | null>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  const markSeen = useStore((s) => s.markCharacterSeen)
  const applyLabelOverride = useStore((s) => s.applyLabelOverride)
  const openIngest = useStore((s) => s.openIngest)

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
    clearSelection()
    setSelectMode(false)
    setLabelMenu(null)
    setConvMenu(null)
  }, [key])

  // Close the conversation menu on Escape or any non-menu click.
  useEffect(() => {
    if (!convMenu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConvMenu(null)
    }
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('.log-conv-menu')) return
      setConvMenu(null)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [convMenu])

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
    // Snapshot the pre-override state so the toast's Undo button can
    // restore exactly what was there before — IC label from a previous
    // manual override, an LLM verdict, or no row at all (Unlabeled).
    const priorLabel: 'IC' | 'OOC' | null =
      msg.label === 'IC' || msg.label === 'OOC' ? msg.label : null
    // Optimistic — patch the local state, then call the API. If the
    // request fails we reload the conversation to get authoritative
    // state back from the sidecar.
    if (label === null) {
      applyLabelOverride(activeChar, partner, msg.hash, null)
    } else {
      applyLabelOverride(activeChar, partner, msg.hash, {
        label,
        label_source: 'manual'
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
      // Only show the Undo toast on success — otherwise the soft-reset
      // fetch below races the user's click.
      showUndoToast(
        label === null ? 'Label reset' : `Set ${label}`,
        () => void submitOverride(msg, priorLabel)
      )
    } catch (err) {
      console.error('[labels] override failed', err)
      reloadConversation()
    }
  }

  // Get the sidecar's view back after a failed write. loadMessages on
  // its own returns early for a conversation that is already loaded.
  const reloadConversation = () => {
    if (!activeChar || !partner) return
    useStore.getState().invalidateMessages(activeChar, partner)
    void useStore.getState().loadMessages(activeChar, partner, { force: true })
  }

  const filtered = useMemo<LogMessage[]>(() => {
    if (!messages) return []
    const byBucket = messages.filter((m) => filter[effectiveBucket(m)])
    if (!search) return byBucket
    const q = search.toLowerCase()
    return byBucket.filter((m) => m.text.toLowerCase().includes(q))
  }, [messages, filter, search])

  // The selection in log order: what labelling and export act on.
  const selectedMessages = useMemo<LogMessage[]>(
    () => (messages && selected.size ? messages.filter((m) => selected.has(m.hash)) : []),
    [messages, selected]
  )

  const stats = useMemo(() => {
    if (!messages)
      return {
        total: 0, ic: 0, ooc: 0, unlabeled: 0, system: 0,
        labeled: 0, from: '', to: '',
      }
    let ic = 0
    let ooc = 0
    let unlabeled = 0
    let system = 0
    // Messages with a stored verdict — i.e. rows in labels.db that
    // "Reset all labels" would clear. Rule-decided messages have no
    // row and don't count.
    let labeled = 0
    for (const m of messages) {
      const b = effectiveBucket(m)
      if (b === 'ic') ic++
      else if (b === 'ooc') ooc++
      else if (b === 'unlabeled') unlabeled++
      else system++
      if (m.label_source) labeled++
    }
    const from = messages.length ? dayLabel(messages[0].ts) : ''
    const to = messages.length ? dayLabel(messages[messages.length - 1].ts) : ''
    return {
      total: messages.length, ic, ooc, unlabeled, system,
      labeled, from, to,
    }
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
        <div className="pane-body pane-body-placeholder">
          Choose a partner from the sidebar.
          <LabelsFirstRunHint />
        </div>
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
  // + manual). Failed messages had a classify call that errored — fix
  // them via right-click → Mark IC/OOC, or re-run Classify. System is
  // F-Chat's ad/roll/warn/event bucket — kept as a separate filter
  // because it's neither IC nor OOC and the user might want to silence
  // it independently.
  const labelTooltip =
    'Short text (<200 chars by default) and "((…" are auto-OOC. ' +
    'Everything else stays Unlabeled until a connected model judges it ' +
    'or you set a label yourself by right-clicking a message.'
  const systemTooltip =
    'Ads, dice rolls, warnings and channel events. Not roleplay content.'

  const handleRowClick = (hash: string, shiftKey: boolean) => {
    if (!selectMode) return
    const anchor = anchorRef.current
    if (shiftKey && anchor !== null && anchor !== hash) {
      // The range runs over the rows on screen, not the whole log: with
      // OOC filtered out, shift-clicking across a scene picks its IC
      // lines and leaves the hidden OOC chatter between them alone.
      const shown = filtered.map((m) => m.hash)
      const a = shown.indexOf(anchor)
      const b = shown.indexOf(hash)
      if (a !== -1 && b !== -1) {
        setSelected((prev) => {
          const next = new Set(prev)
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(shown[i])
          return next
        })
        return
      }
    }
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(hash)) next.delete(hash)
      else next.add(hash)
      return next
    })
    anchorRef.current = hash
  }

  const selectAllShown = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const m of filtered) next.add(m.hash)
      return next
    })
  }

  const exportRange = (format: ExportFormat) => {
    if (!messages || !partner || !activeChar) return
    const slice = selectedMessages
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

  // Apply a manual label (or reset) to every selected message, in one
  // request. Targets only chat/action rows: system / ad / roll / warn
  // lines aren't part of the IC/OOC scope, and a label on them would
  // never show.
  const overrideSelection = async (label: 'IC' | 'OOC' | null) => {
    setLabelMenu(null)
    if (!partner || !activeChar) return
    const targets = selectedMessages.filter((m) => m.kind === 'ic' || m.kind === 'ooc')
    if (targets.length === 0) return
    const item = (m: LogMessage) => ({ hash: m.hash, ts: m.ts, speaker: m.speaker })
    // Undo puts back what each row had: a stored verdict is written
    // again, anything else (rule-decided or Unlabeled) is reset.
    const undoGroups = new Map<'IC' | 'OOC' | null, LogMessage[]>()
    for (const m of targets) {
      const prior: 'IC' | 'OOC' | null =
        m.label_source && (m.label === 'IC' || m.label === 'OOC') ? m.label : null
      undoGroups.set(prior, [...(undoGroups.get(prior) ?? []), m])
    }
    applyLabelOverride(
      activeChar,
      partner,
      new Set(targets.map((m) => m.hash)),
      label === null ? null : { label, label_source: 'manual' }
    )
    try {
      await api.labelsOverrideMany({
        character: activeChar,
        partner,
        items: targets.map(item),
        label
      })
    } catch (err) {
      console.error('[labels] batch override failed', err)
      reloadConversation()
      return
    }
    // Done with these: the next batch starts from a clean slate, and
    // Undo is there for a slip.
    clearSelection()
    const n = targets.length.toLocaleString()
    const plural = targets.length === 1 ? '' : 's'
    showUndoToast(
      label === null ? `Reset ${n} label${plural}` : `${n} message${plural} → ${label}`,
      () => {
        void (async () => {
          try {
            for (const [prior, group] of undoGroups) {
              applyLabelOverride(
                activeChar,
                partner,
                new Set(group.map((m) => m.hash)),
                prior === null ? null : { label: prior, label_source: 'manual' }
              )
              await api.labelsOverrideMany({
                character: activeChar,
                partner,
                items: group.map(item),
                label: prior
              })
            }
          } catch (err) {
            console.error('[labels] undo failed', err)
            reloadConversation()
          }
        })()
      }
    )
  }

  // Give every still-unlabeled message in this conversation the same
  // verdict. For the chats the user already knows the answer about —
  // some are IC from the first line to the last, and walking two
  // thousand messages past a model one batch at a time to hear that
  // back is a waste of their evening.
  //
  // Narrow on purpose: existing verdicts are kept and the rules keep
  // deciding what they decide, so this can only add. The sidecar
  // reports the hashes it wrote, which is what Undo removes — unlike
  // "Remove all IC/OOC labels", it cannot take a model's work with it.
  const fillUnlabeled = async (label: 'IC' | 'OOC') => {
    if (!activeChar || !partner) return
    const partnerName = displayPartner(partner)
    const confirmed = window.confirm(
      `Mark all ${unlabeledCount.toLocaleString()} unlabeled message(s) in ` +
        `${partnerName} with ${activeChar} as ${label}?

` +
        `Only do this if you know the whole conversation is ${label}. ` +
        `Messages that already have a verdict keep it, and short ` +
        `messages / "((" lines stay with the rules.`
    )
    if (!confirmed) return
    try {
      const res = await api.labelsFillUnlabeled({
        character: activeChar,
        partner,
        label
      })
      useStore.getState().invalidateMessages(activeChar, partner)
      await useStore
        .getState()
        .loadMessages(activeChar, partner, { force: true })
      if (res.labeled === 0) return
      showUndoToast(
        `${res.labeled.toLocaleString()} message${res.labeled === 1 ? '' : 's'} → ${label}`,
        () => {
          void (async () => {
            try {
              await api.labelsDeleteHashes({
                character: activeChar,
                partner,
                hashes: res.hashes
              })
              useStore.getState().invalidateMessages(activeChar, partner)
              void useStore
                .getState()
                .loadMessages(activeChar, partner, { force: true })
            } catch (err) {
              console.error('[labels] undo bulk fill failed', err)
            }
          })()
        }
      )
    } catch (err) {
      console.error('[labels] bulk fill failed', err)
      window.alert(
        `Couldn't label the conversation: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  const selectionCount = selectedMessages.length
  const labelableCount = selectedMessages.filter(
    (m) => m.kind === 'ic' || m.kind === 'ooc'
  ).length
  const selectionHasVerdict = selectedMessages.some((m) => m.label_source)

  // Right-click on a ticked row labels the whole selection; on any
  // other row, just that row. System rows have no menu of their own:
  // their bucket is pinned, so a label would never show.
  const openLabelMenu = (x: number, y: number, msg: LogMessage): boolean => {
    const bulk = selectMode && selected.has(msg.hash) && selectionCount > 1
    if (!bulk && msg.kind === 'system') return false
    if (bulk && labelableCount === 0) return false
    setLabelMenu({ x, y, msg, bulk })
    return true
  }

  const unlabeledCount = stats.unlabeled

  const openConvMenu = (x: number, y: number) => {
    if (!activeChar) return
    setConvMenu({ x, y })
  }

  return (
    <section
      className="pane log-pane"
      data-testid="log-viewer"
      onContextMenu={(e) => {
        // Right-click on a message row already opens the per-message
        // label menu (Set IC / Set OOC / Reset). Skip the
        // conversation menu in that case — the row handler runs
        // independently. Same for select-mode (cursor is intent on
        // export selection, not labels).
        const target = e.target as HTMLElement | null
        if (target?.closest('.log-msg')) return
        if (target?.closest('.log-label-menu')) return
        if (selectMode) return
        e.preventDefault()
        openConvMenu(e.clientX, e.clientY)
      }}
    >
      <header
        className="pane-head log-head"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            openConvMenu(r.left + 16, r.bottom)
          }
        }}
        data-testid="log-head"
      >
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
            title="Right-click this header (or open the Logs menu) to Classify these messages."
          >
            {unlabeledCount.toLocaleString()} unlabeled · right-click to Classify
          </span>
        )}
      </header>
      {convMenu && activeChar && (
        <ConversationContextMenu
          x={convMenu.x}
          y={convMenu.y}
          partnerLabel={displayPartner(partner)}
          characterLabel={activeChar}
          unlabeledCount={unlabeledCount}
          labeledCount={stats.labeled}
          onFillUnlabeled={(label) => {
            setConvMenu(null)
            void fillUnlabeled(label)
          }}
          onIngest={() => {
            setConvMenu(null)
            openIngest(
              { character: activeChar, partner },
              `${displayPartner(partner)} with ${activeChar}`
            )
          }}
          onResetAll={async () => {
            setConvMenu(null)
            const partnerName = displayPartner(partner)
            const confirmed = window.confirm(
              `Remove all IC/OOC labels for ${partnerName} with ${activeChar}?\n\n` +
                `${stats.labeled.toLocaleString()} message(s) will revert to Unlabeled. ` +
                `Rule-based hints (short messages, "((", etc.) keep firing as OOC. ` +
                `This cannot be undone.`
            )
            if (!confirmed) return
            try {
              await api.labelsClear({ character: activeChar, partner })
              // Reload messages so the badges reflect rule-only state.
              useStore.getState().invalidateMessages(activeChar, partner)
              void useStore
                .getState()
                .loadMessages(activeChar, partner, { force: true })
            } catch (err) {
              console.error('[labels] clear failed', err)
              window.alert(
                `Couldn't reset labels: ${err instanceof Error ? err.message : String(err)}`
              )
            }
          }}
        />
      )}
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
            if (selectMode) clearSelection()
            setSelectMode(!selectMode)
          }}
          title="Pick several messages to label or export: click to tick, shift-click to add a range."
          data-testid="log-export-toggle"
          aria-pressed={selectMode}
        >
          {selectMode ? 'Done' : 'Multiselect'}
        </button>
      </div>
      {selectMode && (
        <div className="log-export-bar" data-testid="log-export-bar">
          <span className="log-export-status" data-testid="log-export-status">
            {selectionCount > 0
              ? `${selectionCount.toLocaleString()} selected`
              : 'Click to tick · shift-click adds a range'}
          </span>
          <button
            type="button"
            onClick={() => void overrideSelection('IC')}
            disabled={labelableCount === 0}
            title="Label every selected chat/action message IC"
            data-testid="log-export-set-ic"
          >
            Set IC
          </button>
          <button
            type="button"
            onClick={() => void overrideSelection('OOC')}
            disabled={labelableCount === 0}
            title="Label every selected chat/action message OOC"
            data-testid="log-export-set-ooc"
          >
            Set OOC
          </button>
          <button
            type="button"
            onClick={() => void overrideSelection(null)}
            disabled={!selectionHasVerdict}
            title="Remove your or the model's labels from the selection; the rules and Unlabeled take over again"
            data-testid="log-export-reset"
          >
            Reset
          </button>
          <span className="log-export-divider" aria-hidden />
          <button
            type="button"
            onClick={() => exportRange('markdown')}
            disabled={selectionCount === 0}
            title="Copy the selection as Markdown to the clipboard"
          >
            Copy Markdown
          </button>
          <button
            type="button"
            onClick={() => exportRange('text')}
            disabled={selectionCount === 0}
            title="Copy the selection as plain text to the clipboard"
          >
            Copy Text
          </button>
          <span className="log-export-divider" aria-hidden />
          <button
            type="button"
            onClick={selectAllShown}
            disabled={filtered.length === 0}
            title="Tick every message the current filter and search show"
            data-testid="log-export-select-all"
          >
            All shown
          </button>
          {selectionCount > 0 && (
            <button
              type="button"
              className="log-export-clear"
              onClick={clearSelection}
              title="Untick everything"
              data-testid="log-export-clear"
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
          count={labelMenu.bulk ? labelableCount : 1}
          canReset={labelMenu.bulk ? selectionHasVerdict : labelMenu.msg.label_source !== undefined}
          onChoose={(label) =>
            void (labelMenu.bulk
              ? overrideSelection(label)
              : submitOverride(labelMenu.msg, label))
          }
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
              return (
                <MessageRow
                  msg={item.msg}
                  search={search}
                  hitsBefore={item.hitsBefore}
                  activeHit={activeHit}
                  isOwn={item.msg.speaker === activeChar}
                  selectMode={selectMode}
                  selected={selected.has(item.msg.hash)}
                  isMenuTarget={
                    labelMenu !== null &&
                    (labelMenu.bulk
                      ? selected.has(item.msg.hash)
                      : labelMenu.msg.hash === item.msg.hash)
                  }
                  onSelectClick={(shift) => handleRowClick(item.msg.hash, shift)}
                  onContextMenu={(e) => {
                    if (openLabelMenu(e.clientX, e.clientY, item.msg)) e.preventDefault()
                  }}
                  onLabelKeyboardOpen={(anchor) => {
                    const r = anchor.getBoundingClientRect()
                    openLabelMenu(r.left + 16, r.bottom, item.msg)
                  }}
                />
              )
            }}
          />
        )}
      </div>
      {undoToast && (
        <div className="log-undo-toast" role="status" data-testid="log-undo-toast">
          <span>{undoToast.text}</span>
          <button
            type="button"
            className="log-undo-action"
            onClick={() => {
              undoToast.undo()
              if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
              setUndoToast(null)
            }}
            data-testid="log-undo-action"
          >
            Undo
          </button>
        </div>
      )}
    </section>
  )
}

// Dismissible first-run hint that surfaces the existence of the IC/OOC
// classifier — by the time users sit on an empty Log Viewer pane they
// have a character selected but haven't necessarily noticed the labels
// machinery yet. Dismissed state persists in localStorage so the card
// doesn't return after the first time the user clicks it away.
const LABELS_HINT_KEY = 'workbench.labelsHintDismissed'

function LabelsFirstRunHint() {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LABELS_HINT_KEY) === '1'
    } catch {
      return false
    }
  })
  if (dismissed) return null
  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(LABELS_HINT_KEY, '1')
    } catch {
      // Storage may be unavailable in private mode; toggle stays in-session.
    }
  }
  return (
    <div className="labels-hint-card" data-testid="labels-first-run-hint">
      <div className="labels-hint-body">
        <strong>Tip:</strong> Messages are auto-labelled IC / OOC by rule —
        short messages, <code>((…))</code> brackets and the like. Configure
        an LLM in{' '}
        <strong>Settings → Labels</strong> (the bundled prompt is German;
        switch to English / minimal there if needed) and run{' '}
        <strong>Classify</strong> on a conversation to label the rest.
      </div>
      <button
        type="button"
        className="labels-hint-dismiss"
        onClick={dismiss}
        aria-label="Dismiss hint"
        data-testid="labels-first-run-hint-dismiss"
      >
        ✕
      </button>
    </div>
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
  // Chip dims when the bucket is empty — keeps the affordance visible
  // for discovery (especially for "Failed", which we render even at 0)
  // without making the eye fight a count of zero for attention.
  const empty = count === 0
  return (
    <button
      type="button"
      className={`log-filter ${on ? 'on' : 'off'}${empty ? ' log-filter-empty' : ''}`}
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
    isMenuTarget ? 'log-msg-menu-target' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div
      className={klass}
      tabIndex={selectMode ? -1 : 0}
      onMouseDown={
        // Keep shift-click from also dragging a text selection across
        // the rows it spans.
        selectMode
          ? (e) => {
              if (e.shiftKey) e.preventDefault()
            }
          : undefined
      }
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
      {selectMode && (
        // The row's click handler does the toggling; the box only shows
        // the state, and clicks on it bubble up to the row.
        <input
          type="checkbox"
          className="log-msg-check"
          checked={selected}
          readOnly
          tabIndex={-1}
          aria-label="Select message"
          data-testid="log-msg-check"
        />
      )}
      <span className="log-ts" title={msg.iso}>
        {timeLabel(msg.ts)}
      </span>
      <span className="log-speaker">{msg.speaker}</span>
      <LabelBadge
        bucket={bucket}
        label={msg.label}
        source={msg.label_source}
        reason={msg.label_reason}
        priorLabel={msg.prior_label}
        priorSource={msg.prior_source}
      />
      <span className="log-text" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

function ConversationContextMenu({
  x,
  y,
  partnerLabel,
  characterLabel,
  unlabeledCount,
  labeledCount,
  onFillUnlabeled,
  onIngest,
  onResetAll
}: {
  x: number
  y: number
  partnerLabel: string
  characterLabel: string
  unlabeledCount: number
  labeledCount: number
  onFillUnlabeled: (label: 'IC' | 'OOC') => void
  onIngest: () => void
  onResetAll: () => void
}) {
  const W = 280
  // 4 menu items (Ingest, all-IC, all-OOC, Reset); H sized so the
  // viewport-edge clamp keeps the whole menu on-screen when
  // right-clicking near the bottom of a tall pane.
  const H = 300
  const left = Math.min(x, window.innerWidth - W - 8)
  const top = Math.min(y, window.innerHeight - H - 8)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  useEffect(() => {
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
    }
  }
  const resetDisabled = labeledCount === 0
  return (
    <div
      className="log-label-menu log-conv-menu"
      role="menu"
      aria-label="Conversation actions"
      style={{ left, top }}
      data-testid="log-conv-menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="log-label-menu-head">
        {partnerLabel}
        <span className="log-label-menu-current">{characterLabel}</span>
      </div>
      <button
        ref={(el) => {
          itemRefs.current[0] = el
        }}
        type="button"
        role="menuitem"
        className="log-label-menu-item"
        onClick={onIngest}
        onKeyDown={onItemKeyDown(0)}
        title={
          unlabeledCount > 0
            ? `Embed this conversation into the search index. ` +
              `${unlabeledCount.toLocaleString()} message(s) have no IC/OOC ` +
              `verdict yet and will be skipped — ask a connected model to ` +
              `label them first.`
            : "Embed this conversation's chunks into the local search index."
        }
        data-testid="log-conv-menu-ingest"
      >
        Ingest this chat (RAG)
        {unlabeledCount > 0 && (
          <span className="log-label-menu-current">
            {unlabeledCount.toLocaleString()} unlabeled
          </span>
        )}
      </button>
      {(['IC', 'OOC'] as const).map((label, i) => (
        <button
          key={label}
          ref={(el) => {
            itemRefs.current[1 + i] = el
          }}
          type="button"
          role="menuitem"
          className="log-label-menu-item"
          onClick={() => onFillUnlabeled(label)}
          onKeyDown={onItemKeyDown(1 + i)}
          disabled={unlabeledCount === 0}
          title={
            unlabeledCount === 0
              ? 'Nothing is unlabeled in this conversation.'
              : `Write ${label} to all ${unlabeledCount.toLocaleString()} ` +
                `unlabeled message(s) at once. For a conversation you know ` +
                `is ${label} throughout — existing verdicts are kept, and ` +
                `short messages / "((" lines stay with the rules. Undoable.`
          }
          data-testid={`log-conv-menu-fill-${label.toLowerCase()}`}
        >
          Mark all Unlabeled as {label}
          <span className="log-label-menu-current">
            {unlabeledCount === 0
              ? 'nothing unlabeled'
              : `${unlabeledCount.toLocaleString()} → ${label}`}
          </span>
        </button>
      ))}
      <button
        ref={(el) => {
          itemRefs.current[3] = el
        }}
        type="button"
        role="menuitem"
        className="log-label-menu-item log-label-menu-reset"
        onClick={onResetAll}
        onKeyDown={onItemKeyDown(3)}
        disabled={resetDisabled}
        title={
          resetDisabled
            ? 'No stored labels to clear.'
            : `Delete ${labeledCount.toLocaleString()} stored verdicts and fall back to rules.`
        }
        data-testid="log-conv-menu-reset-all"
      >
        Remove all IC/OOC labels
        <span className="log-label-menu-current">
          {resetDisabled
            ? 'nothing to remove'
            : `${labeledCount.toLocaleString()} → Unlabeled`}
        </span>
      </button>
    </div>
  )
}

function LabelContextMenu({
  x,
  y,
  msg,
  count,
  canReset,
  onChoose
}: {
  x: number
  y: number
  msg: LogMessage
  /** How many messages the choice applies to; above 1 the menu is
   *  acting for a multi-selection. */
  count: number
  canReset: boolean
  onChoose: (label: 'IC' | 'OOC' | null) => void
}) {
  // Nudge the menu so it stays inside the viewport on right-clicks
  // near the bottom/right edges. 180×120 is the menu's nominal size.
  const W = 200
  const H = 140
  const left = Math.min(x, window.innerWidth - W - 8)
  const top = Math.min(y, window.innerHeight - H - 8)
  const bulk = count > 1
  const currentLabel = msg.label
  const currentSource = bulk ? undefined : msg.label_source
  const heading = bulk ? `Label ${count.toLocaleString()} messages` : 'Label this message'
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
      aria-label={heading}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="log-label-menu-head" data-testid="log-label-menu-head">
        {heading}
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
        disabled={!canReset}
        title={
          !canReset
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

/** How a stored verdict's source reads in a tooltip. */
const SOURCE_LABELS: Record<LabelSource, string> = {
  mcp: 'model',
  manual: 'you',
  llm: 'model (legacy)'
}

function LabelBadge({
  bucket,
  label,
  source,
  reason,
  priorLabel,
  priorSource
}: {
  bucket: Bucket
  label?: Label
  source?: LabelSource
  reason?: string
  // Sidecar only ever sets prior_label when the user manually
  // overrode an IC or OOC label, so the wire shape is just IC|OOC.
  priorLabel?: 'IC' | 'OOC'
  priorSource?: LabelSource
}) {
  // IC / OOC get a visible word; Unlabeled and System show an em-dash
  // because the chip strip already names them and a tiny "UNL"/"SYS"
  // badge was both jargon-y and a contrast hazard.
  const text =
    bucket === 'system'
      ? '—'
      : bucket === 'unlabeled'
        ? '—'
        : bucket === 'ic'
          ? 'IC'
          : 'OOC'
  const klass = [
    'log-label',
    `log-label-${bucket}`,
    source ? `log-label-src-${source}` : ''
  ]
    .filter(Boolean)
    .join(' ')
  // Tooltip: who decided, their reason if any, and the prior-label
  // trail on manual overrides.
  const lines: string[] = []
  if (source) {
    lines.push(`${label} · ${SOURCE_LABELS[source] ?? source}`)
  } else if (bucket === 'system') {
    lines.push('F-Chat system message')
  } else if (bucket === 'unlabeled') {
    lines.push('No IC/OOC verdict yet — a connected model can decide, or right-click to set one')
  } else {
    lines.push(`${label} · rule`)
  }
  if (reason) lines.push(reason)
  if (source === 'manual' && priorLabel) {
    lines.push(`was ${priorLabel} (${priorSource ? SOURCE_LABELS[priorSource] : 'auto'})`)
  }
  return (
    <span
      className={klass}
      title={lines.join('\n')}
      aria-label={
        source === 'manual' ? `${label}, manually labeled` : undefined
      }
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
