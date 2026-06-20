import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent
} from 'react'
import { useStore } from '../../state'
import { ProposalCard } from './ProposalCard'
import './AssistantPane.css'

const ASSISTANT_PANE_HEIGHT_KEY = 'workbench.aiAssistantPaneHeight'
const ASSISTANT_PANE_MIN_HEIGHT = 200
const ASSISTANT_PANE_DEFAULT_HEIGHT = 320

function clampPaneHeight(raw: number, max?: number): number {
  const ceiling =
    max ?? Math.floor((typeof window !== 'undefined' ? window.innerHeight : 800) * 0.6)
  return Math.max(ASSISTANT_PANE_MIN_HEIGHT, Math.min(ceiling, Math.round(raw)))
}

function readSavedHeight(): number {
  try {
    const raw = localStorage.getItem(ASSISTANT_PANE_HEIGHT_KEY)
    if (raw === null) return ASSISTANT_PANE_DEFAULT_HEIGHT
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return ASSISTANT_PANE_DEFAULT_HEIGHT
    return clampPaneHeight(n)
  } catch {
    return ASSISTANT_PANE_DEFAULT_HEIGHT
  }
}

/** Bottom-dock chat row. Wide+short geometry: transcript on the left,
 *  collapsible draft-review panel on the right. The pane only mounts
 *  when the master opt-in toggle is on AND the user has opened it via
 *  Tools → Character Assistant.
 */
export function AssistantPane() {
  const enabled = useStore((s) => s.aiAssistantEnabled)
  const open = useStore((s) => s.aiAssistantPaneOpen)
  const transcript = useStore((s) => s.aiAssistantTranscript)
  const streaming = useStore((s) => s.aiAssistantStreaming)
  const lastError = useStore((s) => s.aiAssistantLastError)
  const activeId = useStore((s) => s.flistActiveCharacterId)
  const draft = useStore((s) =>
    activeId ? s.aiAssistantDrafts[activeId] ?? null : null
  )
  const toggle = useStore((s) => s.toggleAiAssistantPane)
  const sendTurn = useStore((s) => s.sendAiAssistantTurn)
  const loadDraft = useStore((s) => s.loadAiAssistantDraft)
  const discardDraft = useStore((s) => s.discardAiAssistantDraft)
  const toolEventsByIndex = useStore((s) => s.aiAssistantToolEvents)
  const resetTranscript = useStore((s) => s.resetAiAssistantTranscript)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const paneRef = useRef<HTMLElement | null>(null)
  const { content: lastUserMessage, index: lastUserIndex } =
    useLastUserMessage(transcript)
  const [paneHeight, setPaneHeight] = useState<number>(() => readSavedHeight())

  // Load any persisted draft when the pane opens or active char changes.
  useEffect(() => {
    if (!enabled || !open || !activeId) return
    void loadDraft(activeId)
  }, [enabled, open, activeId, loadDraft])

  // Focus the input the moment the pane mounts, and again on every
  // open transition. The keyboard shortcut implies a chat-first
  // interaction; landing focus in the editor would be disorienting.
  useEffect(() => {
    if (!enabled || !open) return
    const t = window.setTimeout(() => inputRef.current?.focus(), 50)
    return () => window.clearTimeout(t)
  }, [enabled, open])

  if (!enabled || !open) return null

  const pendingCount = draft?.edits.filter((e) => e.status === 'pending').length ?? 0
  const staleCount = draft?.edits.filter((e) => e.status === 'stale').length ?? 0

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = paneRef.current?.getBoundingClientRect().height ?? paneHeight
    const target = e.currentTarget
    try {
      target.setPointerCapture(e.pointerId)
    } catch {
      // Pointer capture is best-effort; not all environments support it.
    }
    const onMove = (ev: PointerEvent) => {
      // Bottom dock: drag UP = grow height. Compute delta from startY.
      const delta = startY - ev.clientY
      const max = Math.floor(window.innerHeight * 0.6)
      const next = clampPaneHeight(startHeight + delta, max)
      setPaneHeight(next)
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      try {
        target.releasePointerCapture(ev.pointerId)
      } catch {
        // ignore
      }
      try {
        const final = paneRef.current?.getBoundingClientRect().height
        if (typeof final === 'number') {
          localStorage.setItem(
            ASSISTANT_PANE_HEIGHT_KEY,
            String(Math.round(final))
          )
        }
      } catch {
        // localStorage may be unavailable; silent degrade.
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return (
    <section
      ref={paneRef}
      className="assistant-pane"
      data-testid="assistant-pane"
      aria-label="AI Assistant"
      style={{ height: `${paneHeight}px` }}
    >
      <div
        className="assistant-pane-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize AI Assistant pane"
        title="Drag to resize"
        onPointerDown={startResize}
      />
      <header className="assistant-pane-header">
        <span className="assistant-pane-title">AI Assistant</span>
        <span className="assistant-pane-meta">
          {pendingCount} pending
          {staleCount > 0 ? ` · ${staleCount} stale` : ''}
        </span>
        <button
          type="button"
          className="assistant-pane-close-secondary"
          onClick={() => {
            if (transcript.length === 0) return
            resetTranscript()
          }}
          disabled={transcript.length === 0}
          title="Clear conversation"
          aria-label="Clear conversation"
          data-testid="assistant-pane-clear"
        >
          ↻
        </button>
        <button
          type="button"
          className="assistant-pane-close"
          onClick={() => toggle(false)}
          aria-label="Close AI Assistant"
          title="Close (Ctrl+Shift+J)"
        >
          ✕
        </button>
      </header>
      {activeId && draft && draft.edits.length > 0 && (
        <DraftActionBar characterId={activeId} draft={draft} onDiscard={() => discardDraft(activeId)} />
      )}
      <div className="assistant-pane-body">
        <Transcript
          characterId={activeId}
          transcript={transcript}
          streaming={streaming}
          toolEventsByIndex={toolEventsByIndex}
          draft={draft}
        />
        <DoneHistory characterId={activeId} />
      </div>
      <PromptSwitcher />
      {lastError && (
        <div className="assistant-pane-error" role="alert" data-testid="assistant-pane-error">
          <span className="assistant-pane-error-text">{lastError}</span>
          {lastUserMessage && lastUserIndex >= 0 && (
            <button
              type="button"
              className="assistant-pane-error-action"
              onClick={() => {
                // Snip the failed turn (last user msg + whatever
                // partial assistant rows followed it) and replay
                // that user message. Earlier behaviour
                // reset the entire transcript, collapsing
                // multi-turn context to one round on every Retry.
                useStore.setState((curr) => ({
                  aiAssistantTranscript: curr.aiAssistantTranscript.slice(
                    0,
                    lastUserIndex
                  ),
                  aiAssistantLastError: null
                }))
                void sendTurn(lastUserMessage)
              }}
              title="Resend the last user message; prior turns are preserved"
            >
              Retry
            </button>
          )}
          <button
            type="button"
            className="assistant-pane-error-action"
            onClick={() => useStore.setState({ aiAssistantLastError: null })}
            aria-label="Dismiss error"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      <InputBar
        ref={inputRef}
        disabled={streaming || !activeId}
        onSend={sendTurn}
      />
    </section>
  )
}

/** Bulk-action bar at the top of the pane when a draft has pending
 *  edits. Shows the count + Accept-all + Discard-draft buttons so the
 *  user can bulk-resolve without scrolling to each card. */
function DraftActionBar({
  characterId,
  draft,
  onDiscard
}: {
  characterId: string
  draft: import('../../lib/api').AiDraft
  onDiscard: () => void | Promise<void>
}) {
  const accept = useStore((s) => s.acceptAiAssistantEdits)
  const pendingIds = draft.edits
    .filter((e) => e.status === 'pending')
    .map((e) => e.id)
  return (
    <div className="assistant-draft-actionbar">
      <span className="assistant-draft-actionbar-count">
        {draft.edits.length} pending edit{draft.edits.length === 1 ? '' : 's'}
      </span>
      <button
        type="button"
        className="proposal-accept"
        onClick={() => void accept(characterId, pendingIds)}
        disabled={pendingIds.length === 0}
      >
        Accept all
      </button>
      <button
        type="button"
        className="proposal-reject"
        onClick={() => void onDiscard()}
      >
        Discard draft
      </button>
    </div>
  )
}

/** Right-side "Done" history. Replaces the old per-turn pending list —
 *  shows every edit the user has already accepted or rejected as a
 *  compact card with an outcome stamp, newest first. Stays empty
 *  until the user has resolved at least one proposal. */
function DoneHistory({ characterId }: { characterId: string | null }) {
  const history = useStore((s) =>
    characterId ? s.aiAssistantEditHistory[characterId] ?? [] : []
  )
  if (!characterId) {
    return (
      <aside className="assistant-done" aria-label="Resolved edits">
        <header className="assistant-done-header">Done</header>
        <div className="assistant-done-empty">
          Select an active character to start.
        </div>
      </aside>
    )
  }
  if (history.length === 0) {
    return (
      <aside className="assistant-done" aria-label="Resolved edits">
        <header className="assistant-done-header">Done</header>
        <div className="assistant-done-empty">
          Edits you accept or reject will appear here.
        </div>
      </aside>
    )
  }
  // Newest first.
  const ordered = [...history].reverse()
  return (
    <aside className="assistant-done" aria-label="Resolved edits">
      <header className="assistant-done-header">
        Done <span className="assistant-done-count">{history.length}</span>
      </header>
      <div className="assistant-done-list">
        {ordered.map((entry, idx) => (
          <DoneCard key={`${entry.edit.id}-${idx}`} entry={entry} />
        ))}
      </div>
    </aside>
  )
}

function DoneCard({
  entry
}: {
  entry: {
    edit: import('../../lib/api').AiDraftEdit
    outcome: 'accepted' | 'rejected'
    timestamp: number
  }
}) {
  const { edit, outcome } = entry
  return (
    <div
      className={`assistant-done-card assistant-done-card-${outcome}`}
      data-testid={`done-card-${edit.id}`}
    >
      <header className="assistant-done-card-head">
        <code className="proposal-card-tool">{edit.tool}</code>
        <span
          className={`assistant-done-stamp assistant-done-stamp-${outcome}`}
        >
          {outcome === 'accepted' ? '✓ Accepted' : '✗ Rejected'}
        </span>
      </header>
      {edit.rationale && (
        <p className="assistant-done-rationale">{edit.rationale}</p>
      )}
    </div>
  )
}

function Transcript({
  characterId,
  transcript,
  streaming,
  toolEventsByIndex,
  draft
}: {
  characterId: string | null
  transcript: Array<{
    role: string
    content?: string | null
    tool_calls?: unknown[]
    _from_reasoning?: boolean
  }>
  streaming: boolean
  toolEventsByIndex: Record<number, Array<{
    callId: string
    tool: string
    args: Record<string, unknown>
    ok: boolean
    error?: string
    resultSummary?: string
    acceptedEditIds?: string[]
  }>>
  draft: import('../../lib/api').AiDraft | null
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Auto-scroll to the latest message; debounced via the rAF tick so
  // back-to-back appends don't jitter.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [transcript, streaming])

  return (
    <div className="assistant-transcript" ref={scrollRef} role="log" aria-live="off">
      {transcript.length === 0 && !streaming && (
        <div className="assistant-empty">
          Ask the assistant to refine your character. It can fix grammar,
          rewrite paragraphs, change profile fields, or copy kinks from
          another archived character. Edits land as proposals you accept
          or reject below.
          <p className="assistant-empty-examples">
            Try: <em>"fix typos in my description"</em>{' '}
            · <em>"change language preference to English"</em>{' '}
            · <em>"copy my kinks from Lady Amber Blaise"</em>
          </p>
        </div>
      )}
      {transcript.map((msg, idx) => (
        <TranscriptRow
          key={idx}
          characterId={characterId}
          role={msg.role}
          content={msg.content ?? ''}
          fromReasoning={msg._from_reasoning}
          toolEvents={toolEventsByIndex[idx]}
          draft={draft}
        />
      ))}
      {streaming && (
        <div className="assistant-typing" aria-live="polite">
          …thinking
        </div>
      )}
    </div>
  )
}

function TranscriptRow({
  characterId,
  role,
  content,
  fromReasoning,
  toolEvents,
  draft
}: {
  characterId: string | null
  role: string
  content: string
  fromReasoning?: boolean
  toolEvents?: Array<{
    callId: string
    tool: string
    args: Record<string, unknown>
    ok: boolean
    error?: string
    resultSummary?: string
    acceptedEditIds?: string[]
  }>
  draft: import('../../lib/api').AiDraft | null
}) {
  if (role === 'tool' || role === 'system') return null
  const events = toolEvents ?? []

  // Gather the edits this turn created, in tool-call order. We look
  // them up by the acceptedEditIds the sidecar handed back per tool
  // call. Edits that have since been resolved (accepted or rejected)
  // disappear from the draft and so don't render again here — they
  // moved to the Done panel.
  const draftEditsById = new Map(draft?.edits.map((e) => [e.id, e]) ?? [])
  const turnEdits = events
    .flatMap((e) => e.acceptedEditIds ?? [])
    .map((id) => draftEditsById.get(id))
    .filter((e): e is import('../../lib/api').AiDraftEdit => Boolean(e))

  // Group consecutive edits sharing the same composite_id so a
  // copy_standard_kinks_from(...) call renders as one card instead of
  // 38 individual rows.
  const grouped = groupConsecutiveByComposite(turnEdits)

  // An assistant turn that only emitted tool calls (no surrounding
  // text) lands here with empty content. Show a small chip below
  // the role so the transcript doesn't go dead.
  const showToolOnlyStub =
    role === 'assistant' && !content && events.length === 0
  return (
    <div className={`assistant-msg assistant-msg-${role}`}>
      <span className="assistant-msg-role">
        {role === 'user' ? 'You' : 'Assistant'}
      </span>
      {events.length > 0 && (
        <div className="assistant-tool-events" aria-label="Tool activity">
          {events.map((event) => (
            <ToolEventChip key={event.callId} event={event} />
          ))}
        </div>
      )}
      {showToolOnlyStub && (
        <span className="assistant-msg-tool-only">
          Proposed edits below — review and accept or reject each.
        </span>
      )}
      {content && fromReasoning && (
        <div className="assistant-msg-reasoning-warning">
          ⚠ Model exhausted its token budget thinking and never wrote a
          final answer. Showing the reasoning trace below. Try a model
          with reasoning disabled (LM Studio per-model toggle), or
          raise <code>max_tokens</code> if your endpoint supports it.
        </div>
      )}
      {content && (
        <pre
          className={`assistant-msg-body${fromReasoning ? ' assistant-msg-body-reasoning' : ''}`}
        >
          {content}
        </pre>
      )}
      {characterId && grouped.length > 0 && (
        <div className="assistant-msg-proposals">
          {grouped.map((edits, gIdx) => (
            <ProposalCard
              key={edits[0]?.id ?? gIdx}
              edits={edits}
              characterId={characterId}
              onAccept={(ids) =>
                void useStore.getState().acceptAiAssistantEdits(characterId, ids)
              }
              onReject={(ids) =>
                void useStore.getState().rejectAiAssistantEdits(characterId, ids)
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

function groupConsecutiveByComposite(
  edits: Array<import('../../lib/api').AiDraftEdit>
): Array<Array<import('../../lib/api').AiDraftEdit>> {
  const groups: Array<Array<import('../../lib/api').AiDraftEdit>> = []
  for (const edit of edits) {
    const last = groups[groups.length - 1]
    const lastKey = last && last[0].composite_id
    const key = edit.composite_id
    if (last && key !== null && key === lastKey) {
      last.push(edit)
    } else {
      groups.push([edit])
    }
  }
  return groups
}

function ToolEventChip({
  event
}: {
  event: {
    tool: string
    args: Record<string, unknown>
    ok: boolean
    error?: string
    resultSummary?: string
  }
}) {
  // Summarise args compactly — show the most-identifying field for the
  // tool so the user can see what was being targeted at a glance. For
  // unknown tools just show the key list.
  const summary = describeToolArgs(event.tool, event.args)
  return (
    <span
      className={`assistant-tool-chip ${
        event.ok ? 'assistant-tool-chip-ok' : 'assistant-tool-chip-fail'
      }`}
      data-tool={event.tool}
      title={
        event.ok
          ? event.resultSummary ?? 'succeeded'
          : `rejected: ${event.error ?? 'unknown error'}`
      }
    >
      <span className="assistant-tool-chip-icon">
        {event.ok ? '✓' : '✗'}
      </span>
      <code className="assistant-tool-chip-name">{event.tool}</code>
      {summary && <span className="assistant-tool-chip-args">{summary}</span>}
      {!event.ok && (
        <span className="assistant-tool-chip-error">
          {event.error ?? 'rejected'}
        </span>
      )}
      {event.ok && event.resultSummary && (
        <span className="assistant-tool-chip-summary">
          {event.resultSummary}
        </span>
      )}
    </span>
  )
}

function describeToolArgs(tool: string, args: Record<string, unknown>): string {
  // One-liner per tool that picks the field the user most cares about.
  // Falls back to a generic key list so unknown tools still get *some*
  // signal.
  const get = (k: string) => {
    const v = args[k]
    return typeof v === 'string' ? v : v === undefined ? '' : String(v)
  }
  switch (tool) {
    case 'set_infotag':
      return `${get('infotag_id')} = ${get('value')}`
    case 'clear_infotag':
      return get('infotag_id')
    case 'replace_description':
      return 'whole body'
    case 'patch_description': {
      const old = get('old_excerpt')
      const truncated = old.length > 40 ? old.slice(0, 37) + '…' : old
      return `"${truncated}"`
    }
    case 'set_standard_kink':
      return `${get('kink_id')} → ${get('choice')}`
    case 'set_custom_kink':
      return `${get('custom_kink_id')}.${get('attr')} = ${get('new_value')}`
    case 'add_custom_kink':
      return get('name')
    case 'remove_custom_kink':
      return get('custom_kink_id')
    case 'set_character_setting':
      return `${get('key')} = ${get('value')}`
    case 'add_image_to_gallery':
    case 'remove_image_from_gallery':
      return get('image_id')
    case 'get_other_character':
      return get('character_id')
    case 'copy_standard_kinks_from':
    case 'copy_custom_kinks_from':
    case 'copy_infotags_from':
      return `from ${get('other_character_id')}`
    default:
      return Object.keys(args).slice(0, 3).join(', ')
  }
}

function PromptSwitcher() {
  const presets = useStore((s) => s.aiAssistantPromptPresets)
  const currentBody = useStore((s) => s.aiAssistantSystemPrompt)
  const setPromptBody = useStore((s) => s.setAiAssistantPromptBody)
  const streaming = useStore((s) => s.aiAssistantStreaming)

  if (presets.length === 0) return null

  // Match by exact body so "(custom — edited)" appears whenever the
  // user has typed into the Settings textarea.
  const matched = presets.find((p) => p.body === currentBody)
  const selectedId = matched?.id ?? ''

  return (
    <div className="assistant-prompt-switcher" data-testid="assistant-prompt-switcher">
      <label htmlFor="assistant-prompt-quick" className="assistant-prompt-switcher-label">
        Prompt
      </label>
      <select
        id="assistant-prompt-quick"
        className="assistant-prompt-switcher-select"
        value={selectedId}
        disabled={streaming}
        onChange={(e) => {
          const id = e.target.value
          const next = presets.find((p) => p.id === id)
          if (next) void setPromptBody(next.body)
        }}
      >
        {!matched && (
          <option value="" disabled>
            (custom — edited in Settings)
          </option>
        )}
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label} · {p.language}
          </option>
        ))}
      </select>
      <span className="assistant-prompt-switcher-help" title={matched?.description ?? ''}>
        Changes apply to the next message you send.
      </span>
    </div>
  )
}

function useLastUserMessage(
  transcript: Array<{ role: string; content?: string | null }>
): { content: string | null; index: number } {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i]
    if (m.role === 'user' && m.content) {
      return { content: m.content, index: i }
    }
  }
  return { content: null, index: -1 }
}

// forwardRef so the parent can focus the textarea on pane-open.
// Earlier the wrapper was unused — the parent now passes inputRef
// through so Ctrl+Shift+J lands focus in the input.
const InputBar = forwardRef<
  HTMLTextAreaElement,
  {
    disabled: boolean
    onSend: (message: string) => Promise<void> | void
  }
>(function InputBar({ disabled, onSend }, ref) {
  const [value, setValue] = useState('')
  const send = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    void onSend(trimmed)
    setValue('')
  }, [value, disabled, onSend])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Shift+Enter inserts a newline; plain Enter sends. Same
      // convention as ChatGPT and the existing RAG ChatPanel.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        send()
      }
    },
    [send]
  )

  return (
    <div className="assistant-input">
      <textarea
        ref={ref}
        className="assistant-input-textarea"
        placeholder={
          disabled
            ? 'Streaming…'
            : 'Ask the assistant to refine this character.'
        }
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        disabled={disabled}
      />
      <button
        type="button"
        className="assistant-input-send"
        onClick={send}
        disabled={disabled || value.trim().length === 0}
      >
        Send
      </button>
    </div>
  )
})
