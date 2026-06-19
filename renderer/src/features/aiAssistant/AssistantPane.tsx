import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent
} from 'react'
import { useStore } from '../../state'
import { DraftReview } from './DraftReview'
import './AssistantPane.css'

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
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const { content: lastUserMessage, index: lastUserIndex } =
    useLastUserMessage(transcript)

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

  return (
    <section
      className="assistant-pane"
      data-testid="assistant-pane"
      aria-label="AI Assistant"
    >
      <header className="assistant-pane-header">
        <span className="assistant-pane-title">AI Assistant</span>
        <span className="assistant-pane-meta">
          {pendingCount} pending
          {staleCount > 0 ? ` · ${staleCount} stale` : ''}
        </span>
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
      <div className="assistant-pane-body">
        <Transcript transcript={transcript} streaming={streaming} />
        {activeId ? (
          <DraftReview
            characterId={activeId}
            draft={draft}
            onDiscard={async () => {
              await discardDraft(activeId)
            }}
          />
        ) : (
          <aside className="assistant-draft" aria-label="Pending edits">
            <header className="assistant-draft-header">
              <span>Pending edits</span>
            </header>
            <div className="assistant-draft-empty">
              Select an active character to start a conversation.
            </div>
          </aside>
        )}
      </div>
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

function Transcript({
  transcript,
  streaming
}: {
  transcript: Array<{ role: string; content?: string | null; tool_calls?: unknown[] }>
  streaming: boolean
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
        <TranscriptRow key={idx} role={msg.role} content={msg.content ?? ''} />
      ))}
      {streaming && (
        <div className="assistant-typing" aria-live="polite">
          …thinking
        </div>
      )}
    </div>
  )
}

function TranscriptRow({ role, content }: { role: string; content: string }) {
  if (role === 'tool' || role === 'system') return null
  // An assistant turn that only emitted tool calls (no surrounding
  // text) lands here with empty content. Show a small chip so the
  // transcript doesn't go dead between the user's prompt and the
  // draft cards appearing in the right column.
  if (role === 'assistant' && !content) {
    return (
      <div className="assistant-msg assistant-msg-assistant">
        <span className="assistant-msg-role">Assistant</span>
        <span className="assistant-msg-tool-only">
          Proposed edits — see the review column on the right.
        </span>
      </div>
    )
  }
  return (
    <div className={`assistant-msg assistant-msg-${role}`}>
      <span className="assistant-msg-role">{role === 'user' ? 'You' : 'Assistant'}</span>
      <pre className="assistant-msg-body">{content}</pre>
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
