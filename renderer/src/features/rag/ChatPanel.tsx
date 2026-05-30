import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type RagCitation, type RagQueryScope } from '../../lib/api'
import { useStore } from '../../state'
import { displayCharacter as displayName, displayPartner } from '../../lib/partnerName'
import { categoriseEndpoint } from '../../lib/endpoint'

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
      // Retrieval trace surfaced under the answer so the user can see
      // which retrievers fired and how many variants the multi-query
      // expansion produced.
      retrieval?: RetrievalMeta
    }
  | {
      kind: 'system'
      id: string
      text: string
    }

type ScopeMode = 'all' | 'partner' | 'character'

// "question" = grounded RAG via /rag/query (citations, scope, retrieval
// trace). "talk" = free-form chat via /rag/talk with no retrieval, no
// citations — the model just gets the running conversation. Persisted
// in localStorage so the user's preference survives panel close.
type ChatMode = 'question' | 'talk'
const CHAT_MODE_KEY = 'workbench.chatMode'

type RetrievalMeta = {
  hitCount: number
  hybridApplied: boolean
  hybridLexicalHits: number
  // Number of EXTRA variants the multi-query expansion produced
  // (the original question is not counted). 0 if expansion was off.
  expandedVariants: number
}

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
  // Surfaced near the input so a user about to send their RP to a
  // remote LLM sees the host they're about to send to. Fetched once on
  // mount; if the user changes endpoints via Settings while the panel
  // stays open, the badge can be stale until next remount — acceptable.
  const [chatEndpointHost, setChatEndpointHost] = useState<string | null>(null)
  // Total indexed chunks — when zero, the empty-state explains why
  // "no matches" is not the model's fault. Re-fetched on mount only;
  // an ingest that completes while the panel is open won't update the
  // count until next remount, but the first turn after ingest will
  // produce a non-empty answer naturally, so the empty-state will be
  // dismissed by the user's own progress.
  const [indexedChunks, setIndexedChunks] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    void Promise.all([api.settingsGet(), api.ragStatus()])
      .then(([s, rag]) => {
        if (cancelled) return
        const ep = s.rag.chat_endpoint
        if (categoriseEndpoint(ep) === 'remote') {
          try {
            setChatEndpointHost(new URL(ep).host)
          } catch {
            setChatEndpointHost(ep)
          }
        }
        setIndexedChunks(rag.chunk_count)
      })
      .catch(() => {
        // sidecar unreachable — silently skip; health card surfaces it
      })
    return () => {
      cancelled = true
    }
  }, [])
  const openIngest = useStore((s) => s.openIngest)
  const openAiSetup = useStore((s) => s.openAiSetup)
  // Default scope mode: 'partner' if a partner is selected, else
  // 'character' if a character is selected, else 'all'.
  const initialMode: ScopeMode = activePartner
    ? 'partner'
    : activeChar
      ? 'character'
      : 'all'
  const [scopeMode, setScopeMode] = useState<ScopeMode>(initialMode)
  const [overrides, setOverrides] = useState<Overrides>({})
  const [chatMode, setChatModeState] = useState<ChatMode>(() => {
    try {
      const v = localStorage.getItem(CHAT_MODE_KEY)
      return v === 'talk' ? 'talk' : 'question'
    } catch {
      return 'question'
    }
  })
  const setChatMode = (next: ChatMode) => {
    setChatModeState(next)
    try {
      localStorage.setItem(CHAT_MODE_KEY, next)
    } catch {
      // localStorage unavailable — toggle still works in-session.
    }
  }
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
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const chatFocusNonce = useStore((s) => s.chatFocusNonce)

  useEffect(() => {
    // Auto-scroll to the bottom whenever the last turn changes.
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns])

  // Land the cursor in the input whenever something external (a
  // "Chat with this log" click, the Tools menu) raises the focus
  // nonce. Also on first mount via the initial nonce value.
  useEffect(() => {
    inputRef.current?.focus()
  }, [chatFocusNonce])

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

    // In Talk mode the scope chip / retrieval trace don't apply, so we
    // stamp the user turn with a mode-flavoured label instead.
    const userTurn: Turn = {
      kind: 'user',
      id: makeId(),
      text,
      scope: chatMode === 'talk' ? null : currentScope,
      scopeLabel: chatMode === 'talk' ? 'talk · free chat' : scopeLabel
    }
    const assistantId = makeId()
    const assistantTurn: Turn = {
      kind: 'assistant',
      id: assistantId,
      text: '',
      citations: [],
      status: 'streaming'
    }
    // Capture the history BEFORE we append the new turns so the Talk
    // request body matches what the user actually said up to now.
    const priorHistory = turns
    setTurns((prev) => [...prev, userTurn, assistantTurn])
    setInput('')
    setStreaming(true)

    const controller = new AbortController()
    abortRef.current = controller
    try {
      if (chatMode === 'talk') {
        const messages = buildTalkHistory(priorHistory, text)
        await api.ragTalk(
          { messages },
          {
            onToken: (content) =>
              setTurns((prev) =>
                prev.map((t) =>
                  t.kind === 'assistant' && t.id === assistantId
                    ? { ...t, text: t.text + content }
                    : t
                )
              ),
            onDone: () =>
              setTurns((prev) =>
                prev.map((t) =>
                  t.kind === 'assistant' && t.id === assistantId
                    ? { ...t, status: 'done' }
                    : t
                )
              ),
            onError: ({ stage, message }) =>
              setTurns((prev) =>
                prev.map((t) =>
                  t.kind === 'assistant' && t.id === assistantId
                    ? { ...t, status: 'error', error: `${stage}: ${message}` }
                    : t
                )
              )
          },
          { signal: controller.signal }
        )
      } else {
      await api.ragQuery(
        {
          question: text,
          scope: currentScope,
          top_k: overrides.topK,
          neighbors: overrides.neighbors
        },
        {
          onExpanded: ({ variants }) =>
            setTurns((prev) =>
              prev.map((t) => {
                if (t.kind !== 'assistant' || t.id !== assistantId) return t
                const cur = t.retrieval ?? emptyRetrieval()
                return { ...t, retrieval: { ...cur, expandedVariants: variants.length } }
              })
            ),
          onRetrieved: (info) =>
            setTurns((prev) =>
              prev.map((t) => {
                if (t.kind !== 'assistant' || t.id !== assistantId) return t
                const cur = t.retrieval ?? emptyRetrieval()
                return {
                  ...t,
                  retrieval: {
                    ...cur,
                    hitCount: info.hit_count,
                    hybridApplied: info.hybrid_applied ?? false,
                    hybridLexicalHits: info.hybrid_lexical_hits ?? 0
                  }
                }
              })
            ),
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
      }
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
        <div className="chat-mode-toggle" role="tablist" aria-label="Chat mode">
          <button
            type="button"
            role="tab"
            aria-selected={chatMode === 'question'}
            className={`chat-mode-btn${chatMode === 'question' ? ' on' : ''}`}
            onClick={() => setChatMode('question')}
            disabled={streaming}
            title="Question — grounded answer with citations from your indexed logs"
            data-testid="chat-mode-question"
          >
            Question
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={chatMode === 'talk'}
            className={`chat-mode-btn${chatMode === 'talk' ? ' on' : ''}`}
            onClick={() => setChatMode('talk')}
            disabled={streaming}
            title="Talk — free-form chat with the LLM (no retrieval, no citations)"
            data-testid="chat-mode-talk"
          >
            Talk
          </button>
        </div>
        {chatMode === 'question' ? (
          <span className="chat-scope-chip" data-testid="chat-scope">
            {scopeLabel}
          </span>
        ) : (
          <span
            className="chat-scope-chip chat-scope-chip-talk"
            data-testid="chat-scope"
            title="Talk mode is conversational — no retrieval, no scope filter."
          >
            free chat
          </span>
        )}
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
          chatMode === 'question' && indexedChunks === 0 ? (
            <div
              className="chat-empty chat-empty-no-index"
              data-testid="chat-empty-no-index"
            >
              <p className="chat-empty-headline">
                <strong>No indexed logs yet.</strong>
              </p>
              <p>
                Question mode searches a local vector index of your saved
                F-Chat logs. The index is empty — questions here would just
                come back as "I can't find that in the logs."
              </p>
              <div className="chat-empty-ctas">
                <button
                  type="button"
                  className="chat-empty-cta chat-empty-cta-primary"
                  onClick={() => openIngest({}, 'All characters, all partners')}
                  data-testid="chat-empty-ingest"
                >
                  Ingest your logs now
                </button>
                <button
                  type="button"
                  className="chat-empty-cta"
                  onClick={openAiSetup}
                  data-testid="chat-empty-ai-setup"
                >
                  Run AI Setup
                </button>
              </div>
              <p className="chat-empty-foot">
                Already configured your LLM? Open <strong>Tools → Ingest</strong>{' '}
                to populate the index, then come back here.
              </p>
            </div>
          ) : (
            <div className="chat-empty">
              {chatMode === 'question' ? (
                <p>
                  Ask a question about your saved logs. The answer cites the
                  source chunks — click a citation to jump to that conversation.
                </p>
              ) : (
                <p>
                  Free-form chat with your configured LLM. No retrieval, no
                  citations — useful for brainstorming, drafting, or chatting
                  without the logs in the prompt.
                </p>
              )}
              <p>Type <code>/help</code> for slash commands.</p>
            </div>
          )
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
              {t.retrieval && (t.status === 'done' || t.status === 'cancelled') && (
                <RetrievalLine meta={t.retrieval} />
              )}
              {t.citations.length > 0 && (
                <Citations citations={t.citations} onClick={onCitationClick} />
              )}
            </div>
          )
        )}
      </div>
      <footer className="chat-input">
        {chatEndpointHost && (
          <div
            className="chat-endpoint-warning"
            role="status"
            data-testid="chat-endpoint-warning"
          >
            ⚠ External endpoint — messages and retrieved log chunks will be
            sent to <strong>{chatEndpointHost}</strong>
          </div>
        )}
        <textarea
          ref={inputRef}
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

// Convert the in-panel Turn[] history into the OpenAI chat shape the
// /rag/talk endpoint expects. System / scope-flavour turns are dropped
// (they're UI-only). The latest user message is passed in separately
// so the caller doesn't have to mutate `turns` before sending.
function buildTalkHistory(
  prior: Turn[],
  latestUserText: string
): { role: 'user' | 'assistant'; content: string }[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = []
  for (const t of prior) {
    if (t.kind === 'user') {
      out.push({ role: 'user', content: t.text })
    } else if (t.kind === 'assistant') {
      // Skip empty / errored / cancelled assistant turns — they'd
      // confuse the model. Streaming turns shouldn't appear here since
      // we capture the history before the new turn pair is pushed.
      if (t.status === 'done' && t.text.trim()) {
        out.push({ role: 'assistant', content: t.text })
      }
    }
    // 'system' kind is local UI feedback (slash-command output etc.)
    // — never sent to the LLM.
  }
  out.push({ role: 'user', content: latestUserText })
  return out
}

function emptyRetrieval(): RetrievalMeta {
  return {
    hitCount: 0,
    hybridApplied: false,
    hybridLexicalHits: 0,
    expandedVariants: 0
  }
}

function RetrievalLine({ meta }: { meta: RetrievalMeta }) {
  const parts: string[] = []
  // Lead with which retrievers ran so the user understands which
  // retrieval mode produced this answer, even when nothing exotic
  // fired. "vector only · 12 chunks" is more informative than silence.
  if (meta.hybridApplied) {
    parts.push(
      meta.hybridLexicalHits > 0
        ? `hybrid (+${meta.hybridLexicalHits} BM25)`
        : 'hybrid'
    )
  } else {
    parts.push('vector only')
  }
  if (meta.expandedVariants > 0) {
    // +1 for the original question; that's what the user is reading
    // when they see "3 variants".
    parts.push(`MQ ${meta.expandedVariants + 1}`)
  }
  parts.push(`${meta.hitCount} chunk${meta.hitCount === 1 ? '' : 's'}`)
  return (
    <div
      className="chat-turn-retrieval"
      data-testid="chat-retrieval-meta"
      title={
        `retrieval: ${parts.join(' · ')}`
        + (meta.expandedVariants > 0
          ? ` — multi-query expansion produced ${meta.expandedVariants} extra question variants`
          : '')
      }
    >
      {parts.join(' · ')}
    </div>
  )
}

// Citations come back from /rag/query in chronological order after
// neighbor expansion — fine for "in-context reading" but not what the
// user wants to scan first. Re-sort by best-available score (rerank if
// present, otherwise the raw vector score), show the top N, and hide
// the rest behind a one-click "show more". 10+ chips strung across the
// turn looked spammy; the tail is mostly neighbor-expanded chunks that
// are useful as LLM context but rarely worth clicking.
const CITATIONS_VISIBLE_BY_DEFAULT = 3

function Citations({
  citations,
  onClick
}: {
  citations: RagCitation[]
  onClick: (c: RagCitation) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const sorted = useMemo(() => {
    const score = (c: RagCitation) => c.rerank_score ?? c.score
    return [...citations].sort((a, b) => score(b) - score(a))
  }, [citations])
  const visible = expanded ? sorted : sorted.slice(0, CITATIONS_VISIBLE_BY_DEFAULT)
  const hidden = sorted.length - visible.length
  return (
    <div className="chat-citations" data-testid="chat-citations">
      {visible.map((c, i) => (
        <button
          key={c.chunk_id ?? `cite-${i}`}
          type="button"
          className="chat-citation"
          onClick={() => onClick(c)}
          title={`${c.char_owner} × ${c.partner} · ${c.date} · ${c.label}${c.expanded ? ' (context-expanded)' : ''}`}
        >
          [{i + 1}] {c.partner ? displayPartner(c.partner) : '—'} · {c.date}
          {c.expanded ? ' +' : ''}
        </button>
      ))}
      {hidden > 0 && !expanded && (
        <button
          type="button"
          className="chat-citation chat-citation-more"
          onClick={() => setExpanded(true)}
          data-testid="chat-citations-more"
        >
          + {hidden} more
        </button>
      )}
      {expanded && sorted.length > CITATIONS_VISIBLE_BY_DEFAULT && (
        <button
          type="button"
          className="chat-citation chat-citation-more"
          onClick={() => setExpanded(false)}
          data-testid="chat-citations-less"
        >
          show less
        </button>
      )}
    </div>
  )
}
