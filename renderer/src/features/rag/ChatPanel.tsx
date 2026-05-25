import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type RagCitation, type RagQueryScope } from '../../lib/api'
import { useStore } from '../../state'
import { displayCharacter as displayName, displayPartner } from '../../lib/partnerName'

type Turn =
  | {
      kind: 'user'
      id: string
      text: string
      scope: RagQueryScope | null
      scopeLabel: string
    }
  | {
      kind: 'assistant'
      id: string
      // Streaming text; updated in place as tokens arrive.
      text: string
      citations: RagCitation[]
      status: 'streaming' | 'done' | 'error' | 'cancelled'
      error?: string
    }
  | {
      kind: 'system'
      id: string
      text: string
    }

type ScopeMode = 'all' | 'partner' | 'character'

// Slim per-request overrides. Slash commands set these; saved settings
// fill the gap on the sidecar side. Local-only so /top 8 doesn't bleed
// into the user's persisted preferences.
type Overrides = {
  topK?: number
  neighbors?: number
}

const HELP_TEXT = [
  'Slash commands:',
  '  /scope all            ask across every character × partner',
  '  /scope partner        only the current conversation',
  '  /scope character      every partner for the current character',
  '  /top <N>              per-request override for top-K (1..50)',
  '  /neighbors <N>        per-request override for ±N expansion (0..5)',
  '  /clear                clear chat history',
  '  /help                 this message'
].join('\n')

export function ChatPanel() {
  const activeChar = useStore((s) => s.activeCharacter)
  const activePartner = useStore((s) => s.activePartner)
  const closePanel = () => useStore.getState().toggleChatPanel(false)
  const requestLogJump = useStore((s) => s.requestLogJump)

  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  // Default scope mode: 'partner' if a partner is selected, else
  // 'character' if a character is selected, else 'all'.
  const initialMode: ScopeMode = activePartner
    ? 'partner'
    : activeChar
      ? 'character'
      : 'all'
  const [scopeMode, setScopeMode] = useState<ScopeMode>(initialMode)
  const [overrides, setOverrides] = useState<Overrides>({})
  // Re-sync scope mode when selection changes — but only if user hasn't
  // explicitly broadened to 'all', because then they were intentional.
  useEffect(() => {
    setScopeMode((cur) => {
      if (cur === 'all') return cur
      if (activePartner) return 'partner'
      if (activeChar) return 'character'
      return 'all'
    })
  }, [activeChar, activePartner])

  // AbortController for the in-flight stream so /clear or panel close
  // can break a long generation cleanly.
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // Auto-scroll to the bottom whenever the last turn changes.
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns])

  // Stop any in-flight request when the panel unmounts (toggle off).
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const currentScope: RagQueryScope | null = useMemo(() => {
    if (scopeMode === 'all') return null
    if (scopeMode === 'partner' && activeChar && activePartner) {
      return { character: activeChar, partner: activePartner }
    }
    if (scopeMode === 'character' && activeChar) {
      return { character: activeChar }
    }
    return null
  }, [scopeMode, activeChar, activePartner])

  const scopeLabel = useMemo(() => formatScope(scopeMode, activeChar, activePartner), [
    scopeMode,
    activeChar,
    activePartner
  ])

  const submit = async () => {
    const text = input.trim()
    if (!text || streaming) return

    // Slash commands short-circuit before the network call.
    if (text.startsWith('/')) {
      handleSlash(text)
      setInput('')
      return
    }

    const userTurn: Turn = {
      kind: 'user',
      id: makeId(),
      text,
      scope: currentScope,
      scopeLabel
    }
    const assistantId = makeId()
    const assistantTurn: Turn = {
      kind: 'assistant',
      id: assistantId,
      text: '',
      citations: [],
      status: 'streaming'
    }
    setTurns((prev) => [...prev, userTurn, assistantTurn])
    setInput('')
    setStreaming(true)

    const controller = new AbortController()
    abortRef.current = controller
    try {
      await api.ragQuery(
        {
          question: text,
          scope: currentScope,
          top_k: overrides.topK,
          neighbors: overrides.neighbors
        },
        {
          onToken: (content) =>
            setTurns((prev) =>
              prev.map((t) =>
                t.kind === 'assistant' && t.id === assistantId
                  ? { ...t, text: t.text + content }
                  : t
              )
            ),
          onDone: (citations) =>
            setTurns((prev) =>
              prev.map((t) =>
                t.kind === 'assistant' && t.id === assistantId
                  ? { ...t, citations, status: 'done' }
                  : t
              )
            ),
          onError: ({ stage, message }) =>
            setTurns((prev) =>
              prev.map((t) =>
                t.kind === 'assistant' && t.id === assistantId
                  ? {
                      ...t,
                      status: 'error',
                      error: `${stage}: ${message}`
                    }
                  : t
              )
            )
        },
        { signal: controller.signal }
      )
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      setTurns((prev) =>
        prev.map((t) =>
          t.kind === 'assistant' && t.id === assistantId
            ? {
                ...t,
                status: aborted ? 'cancelled' : 'error',
                error: aborted ? undefined : err instanceof Error ? err.message : String(err)
              }
            : t
        )
      )
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  const handleSlash = (raw: string) => {
    const parts = raw.trim().split(/\s+/)
    const cmd = parts[0].toLowerCase()
    if (cmd === '/help' || cmd === '/?') {
      pushSystem(HELP_TEXT)
      return
    }
    if (cmd === '/clear') {
      setTurns([])
      return
    }
    if (cmd === '/scope') {
      const arg = (parts[1] ?? '').toLowerCase()
      if (arg === 'all') setScopeMode('all')
      else if (arg === 'partner') setScopeMode('partner')
      else if (arg === 'character' || arg === 'char') setScopeMode('character')
      else {
        pushSystem('usage: /scope (all | partner | character)')
        return
      }
      pushSystem(`scope → ${formatScope(arg as ScopeMode, activeChar, activePartner)}`)
      return
    }
    if (cmd === '/top') {
      const n = Number(parts[1])
      if (!Number.isFinite(n) || n < 1 || n > 50) {
        pushSystem('usage: /top <N>  (1..50)')
        return
      }
      setOverrides((o) => ({ ...o, topK: Math.floor(n) }))
      pushSystem(`top-K → ${Math.floor(n)}`)
      return
    }
    if (cmd === '/neighbors') {
      const n = Number(parts[1])
      if (!Number.isFinite(n) || n < 0 || n > 5) {
        pushSystem('usage: /neighbors <N>  (0..5)')
        return
      }
      setOverrides((o) => ({ ...o, neighbors: Math.floor(n) }))
      pushSystem(`neighbors → ±${Math.floor(n)}`)
      return
    }
    pushSystem(`unknown command: ${cmd} — /help for options`)
  }

  const pushSystem = (text: string) => {
    setTurns((prev) => [...prev, { kind: 'system', id: makeId(), text }])
  }

  const onCitationClick = (c: RagCitation) => {
    if (!c.char_owner || !c.partner || c.ts_start === null || c.ts_end === null) return
    requestLogJump(c.char_owner, c.partner, c.ts_start, c.ts_end)
  }

  return (
    <aside className="chat-pane" data-testid="chat-pane">
      <header className="chat-head">
        <span className="chat-title">Chat</span>
        <span className="chat-scope-chip" data-testid="chat-scope">
          {scopeLabel}
        </span>
        <span className="chat-flex" />
        <button
          type="button"
          className="chat-close"
          onClick={closePanel}
          aria-label="Close chat panel"
          title="Close (Ctrl+J to reopen)"
        >
          ✕
        </button>
      </header>
      <div className="chat-body" ref={listRef} data-testid="chat-body">
        {turns.length === 0 && (
          <div className="chat-empty">
            <p>
              Ask a question about your saved logs. The answer cites the
              source chunks — click a citation to jump to that conversation.
            </p>
            <p>Type <code>/help</code> for slash commands.</p>
          </div>
        )}
        {turns.map((t) =>
          t.kind === 'user' ? (
            <div key={t.id} className="chat-turn chat-turn-user">
              <div className="chat-turn-head">
                <span className="chat-role">You</span>
                <span className="chat-scope-meta">{t.scopeLabel}</span>
              </div>
              <div className="chat-turn-body">{t.text}</div>
            </div>
          ) : t.kind === 'system' ? (
            <div key={t.id} className="chat-turn chat-turn-system">
              <div className="chat-turn-body">{t.text}</div>
            </div>
          ) : (
            <div key={t.id} className="chat-turn chat-turn-assistant">
              <div className="chat-turn-head">
                <span className="chat-role">Assistant</span>
                {t.status === 'streaming' && (
                  <span className="chat-streaming" aria-label="streaming">◌</span>
                )}
                {t.status === 'cancelled' && (
                  <span className="chat-streaming">cancelled</span>
                )}
              </div>
              <div className="chat-turn-body">
                {t.text || (t.status === 'streaming' ? '…' : '')}
              </div>
              {t.status === 'error' && t.error && (
                <div className="chat-turn-error">⚠ {t.error}</div>
              )}
              {t.citations.length > 0 && (
                <div className="chat-citations" data-testid="chat-citations">
                  {t.citations.map((c, i) => (
                    <button
                      key={c.chunk_id ?? `cite-${i}`}
                      type="button"
                      className="chat-citation"
                      onClick={() => onCitationClick(c)}
                      title={`${c.char_owner} × ${c.partner} · ${c.date} · ${c.label}${c.expanded ? ' (expanded)' : ''}`}
                    >
                      [{i + 1}] {c.partner ? displayPartner(c.partner) : '—'} ·{' '}
                      {c.date}
                      {c.expanded ? ' +' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        )}
      </div>
      <footer className="chat-input">
        <textarea
          className="chat-textarea"
          placeholder="Ask the logs… (Enter to send, Shift+Enter for newline)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          rows={3}
          data-testid="chat-input"
        />
        <div className="chat-input-actions">
          <span className="chat-input-hint">
            {overrides.topK !== undefined && (
              <span className="chat-meta-pill">top-{overrides.topK}</span>
            )}
            {overrides.neighbors !== undefined && (
              <span className="chat-meta-pill">±{overrides.neighbors}</span>
            )}
          </span>
          {streaming && (
            <button
              type="button"
              className="chat-stop"
              onClick={() => abortRef.current?.abort()}
              data-testid="chat-stop"
            >
              Stop
            </button>
          )}
          <button
            type="button"
            className="chat-send"
            onClick={() => void submit()}
            disabled={streaming || !input.trim()}
            data-testid="chat-send"
          >
            Send
          </button>
        </div>
      </footer>
    </aside>
  )
}

function formatScope(
  mode: ScopeMode,
  character: string | null,
  partner: string | null
): string {
  if (mode === 'all') return 'all RPs'
  if (mode === 'partner') {
    if (character && partner) return `${displayPartner(partner)} × ${displayName(character)}`
    return 'no partner selected'
  }
  // character
  if (character) return `all partners × ${displayName(character)}`
  return 'no character selected'
}

let _idCounter = 0
function makeId(): string {
  _idCounter += 1
  return `t${Date.now()}-${_idCounter}`
}
