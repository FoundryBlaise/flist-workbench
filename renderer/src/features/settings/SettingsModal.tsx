import { useEffect, useRef, useState } from 'react'
import { api, type LabelsSettings, type RagSettings, type RagStatus } from '../../lib/api'
import { useStore } from '../../state'

type SettingsState = Awaited<ReturnType<typeof api.settingsGet>>

const ENDPOINT_PRESETS = [
  { label: 'LM Studio', url: 'http://localhost:1234/v1' },
  { label: 'Ollama', url: 'http://localhost:11434/v1' },
  { label: 'OpenAI', url: 'https://api.openai.com/v1' }
]

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const loadCharacters = useStore((s) => s.loadCharacters)
  const [state, setState] = useState<SettingsState | null>(null)
  const [dirInput, setDirInput] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'saving' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    api
      .settingsGet()
      .then((s) => {
        if (cancelled) return
        setState(s)
        setDirInput(s.fchat_data_dir ?? '')
        setStatus('idle')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  const pick = async () => {
    const picker = window.workbench?.selectDirectory
    if (!picker) {
      setError("Folder picker isn't available in this build.")
      return
    }
    const chosen = await picker({
      title: 'Pick your F-Chat data directory',
      defaultPath: dirInput || state?.fchat_data_dir_effective
    })
    if (chosen) setDirInput(chosen)
  }

  const save = async (nextValue: string | null) => {
    setStatus('saving')
    setError(null)
    try {
      const updated = await api.settingsUpdate({ fchat_data_dir: nextValue })
      setState(updated)
      setDirInput(updated.fchat_data_dir ?? '')
      setStatus('idle')
      // Reload characters so the sidebar reflects the new directory
      // immediately rather than waiting for a refresh.
      await loadCharacters()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  const envLocked = state?.fchat_data_dir_env_locked ?? false

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2 className="modal-title">Settings</h2>
            <p className="modal-subtitle">F-Chat data location and label classifier.</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body settings-body">
          <section className="settings-section">
            <h3 className="settings-section-title">F-Chat data directory</h3>
            <label className="settings-label" htmlFor="fchat-data-dir-input">
              Path
            </label>
            <p className="settings-help">
              F-Chat 3.0 writes each character's logs under{' '}
              <code>&lt;data&gt;/&lt;character&gt;/logs</code>. Point this at the parent of those
              character folders.
            </p>
            <div className="settings-row">
              <input
                id="fchat-data-dir-input"
                ref={inputRef}
                type="text"
                className="settings-input"
                placeholder="/path/to/F-Chat/data"
                value={dirInput}
                onChange={(e) => setDirInput(e.target.value)}
                disabled={envLocked || status === 'saving'}
                data-testid="settings-fchat-dir-input"
              />
              <button
                type="button"
                className="settings-pick"
                onClick={() => void pick()}
                disabled={envLocked || status === 'saving' || !window.workbench?.selectDirectory}
                data-testid="settings-fchat-dir-pick"
              >
                Browse…
              </button>
            </div>
            {state && (
              <p className="settings-meta">
                Currently reading from: <code>{state.fchat_data_dir_effective}</code>
              </p>
            )}
            {envLocked && (
              <p className="settings-note">
                <b>FCHAT_DATA_DIR</b> is set in the environment and overrides this setting. Unset
                it to control the path from here.
              </p>
            )}
            {error && <p className="settings-error">{error}</p>}
            <div className="settings-actions">
              <button
                type="button"
                className="settings-save"
                onClick={() => void save(dirInput.trim() || null)}
                disabled={envLocked || status === 'saving'}
                data-testid="settings-save"
              >
                {status === 'saving' ? 'Saving…' : 'Save'}
              </button>
              {state?.fchat_data_dir && !envLocked && (
                <button
                  type="button"
                  className="settings-clear"
                  onClick={() => void save(null)}
                  disabled={status === 'saving'}
                  title="Clear the override and fall back to the default directory"
                >
                  Reset
                </button>
              )}
            </div>
          </section>

          {state?.labels && (
            <LabelsSection
              labels={state.labels}
              onSaved={(next) => setState((prev) => (prev ? { ...prev, labels: next } : prev))}
            />
          )}

          {state?.rag && (
            <RagSection
              rag={state.rag}
              onSaved={(next) => setState((prev) => (prev ? { ...prev, rag: next } : prev))}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function LabelsSection({
  labels,
  onSaved
}: {
  labels: LabelsSettings
  onSaved: (next: LabelsSettings) => void
}) {
  // Each field has its own local input so users can edit without losing
  // unsaved changes on a re-render. Save sends only the deltas vs. the
  // currently-persisted values to keep the API tight.
  const [threshold, setThreshold] = useState(String(labels.threshold_chars))
  const [endpoint, setEndpoint] = useState(labels.llm_endpoint)
  const [model, setModel] = useState(labels.llm_model)
  const [apiKey, setApiKey] = useState(labels.llm_api_key)
  const [prompt, setPrompt] = useState(labels.system_prompt)
  const [contextBefore, setContextBefore] = useState(String(labels.context_before))
  const [contextAfter, setContextAfter] = useState(String(labels.context_after))
  const [showKey, setShowKey] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  // Test-connection state stays separate from save status so the
  // user can re-test without re-saving.
  const [testStatus, setTestStatus] = useState<'idle' | 'running' | 'ok' | 'fail'>('idle')
  const [testResult, setTestResult] = useState<{
    ok: boolean
    elapsed_ms: number
    error?: string | null
    raw?: string
    parsed?: { label: string; reason: string } | null
  } | null>(null)

  // Keep local form in sync when parent reloads settings (e.g. after save).
  useEffect(() => {
    setThreshold(String(labels.threshold_chars))
    setEndpoint(labels.llm_endpoint)
    setModel(labels.llm_model)
    setApiKey(labels.llm_api_key)
    setPrompt(labels.system_prompt)
    setContextBefore(String(labels.context_before))
    setContextAfter(String(labels.context_after))
  }, [labels])

  const save = async () => {
    setStatus('saving')
    setError(null)
    const parsedThreshold = Number(threshold)
    if (!Number.isFinite(parsedThreshold) || parsedThreshold < 1) {
      setError('Threshold must be a positive integer.')
      setStatus('error')
      return
    }
    // Same clamp as the sidecar so the UI doesn't accept impossible
    // values silently; 0..10 mirrors labels.load_settings.
    const parsedBefore = Math.max(0, Math.min(10, Math.floor(Number(contextBefore) || 0)))
    const parsedAfter = Math.max(0, Math.min(10, Math.floor(Number(contextAfter) || 0)))
    try {
      const updated = await api.settingsUpdate({
        labels: {
          threshold_chars: Math.floor(parsedThreshold),
          llm_endpoint: endpoint,
          llm_model: model,
          llm_api_key: apiKey,
          // Empty prompt is interpreted as "reset to default" server-side.
          system_prompt: prompt,
          context_before: parsedBefore,
          context_after: parsedAfter
        }
      })
      onSaved(updated.labels)
      setStatus('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  const resetPrompt = () => setPrompt(labels.defaults.system_prompt)
  const resetEndpoint = () => setEndpoint(labels.defaults.llm_endpoint)
  const resetModel = () => setModel(labels.defaults.llm_model)
  const resetThreshold = () => setThreshold(String(labels.defaults.threshold_chars))

  const runTest = async () => {
    setTestStatus('running')
    setTestResult(null)
    try {
      const result = await api.labelsTestConnection({
        llm_endpoint: endpoint,
        llm_model: model,
        llm_api_key: apiKey,
        system_prompt: prompt
      })
      setTestResult(result)
      setTestStatus(result.ok ? 'ok' : 'fail')
    } catch (err) {
      setTestResult({
        ok: false,
        elapsed_ms: 0,
        error: err instanceof Error ? err.message : String(err)
      })
      setTestStatus('fail')
    }
  }

  const isPromptDefault = prompt === labels.defaults.system_prompt

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">Labels (IC / OOC classifier)</h3>
      <p className="settings-help">
        Settings for the on-demand IC/OOC classifier. Short messages and{' '}
        <code>((…</code> auto-OOC by rule; everything else stays Unlabeled until you run Classify on a
        conversation.
      </p>

      <div className="settings-field">
        <label className="settings-label" htmlFor="labels-threshold">
          OOC threshold (chars)
        </label>
        <p className="settings-help">
          Chat messages shorter than this many characters are auto-classified as OOC without
          asking the LLM.
        </p>
        <div className="settings-row">
          <input
            id="labels-threshold"
            type="number"
            min={1}
            className="settings-input settings-input-narrow"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            data-testid="labels-threshold-input"
          />
          <button type="button" className="settings-clear" onClick={resetThreshold}>
            Default ({labels.defaults.threshold_chars})
          </button>
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-label">Context window (surrounding messages)</label>
        <p className="settings-help">
          How many messages before and after the target are attached as <code>KONTEXT</code> to each
          classify call. Higher helps disambiguation but eats the model's context budget — drop to{' '}
          <code>1 / 1</code> or <code>0 / 0</code> on small-VRAM cards (≤ 8 GB) if you hit context-limit
          errors. Range 0–10 each.
        </p>
        <div className="settings-row">
          <label
            htmlFor="labels-ctx-before"
            className="settings-meta"
            style={{ alignSelf: 'center' }}
          >
            Before
          </label>
          <input
            id="labels-ctx-before"
            type="number"
            min={0}
            max={10}
            className="settings-input settings-input-narrow"
            value={contextBefore}
            onChange={(e) => setContextBefore(e.target.value)}
            data-testid="labels-context-before-input"
          />
          <label
            htmlFor="labels-ctx-after"
            className="settings-meta"
            style={{ alignSelf: 'center' }}
          >
            After
          </label>
          <input
            id="labels-ctx-after"
            type="number"
            min={0}
            max={10}
            className="settings-input settings-input-narrow"
            value={contextAfter}
            onChange={(e) => setContextAfter(e.target.value)}
            data-testid="labels-context-after-input"
          />
          <button
            type="button"
            className="settings-clear"
            onClick={() => {
              setContextBefore(String(labels.defaults.context_before))
              setContextAfter(String(labels.defaults.context_after))
            }}
          >
            Default ({labels.defaults.context_before} / {labels.defaults.context_after})
          </button>
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-label" htmlFor="labels-endpoint">
          LLM endpoint (OpenAI-compatible)
        </label>
        <p className="settings-help">
          Pick a preset or type a custom URL. The classifier posts to{' '}
          <code>&lt;endpoint&gt;/chat/completions</code>. Ollama, LM Studio and OpenAI all expose
          this shape.
        </p>
        <div className="settings-row">
          {ENDPOINT_PRESETS.map((p) => (
            <button
              key={p.url}
              type="button"
              className={`settings-preset ${endpoint === p.url ? 'on' : ''}`}
              onClick={() => setEndpoint(p.url)}
            >
              {p.label}
            </button>
          ))}
          <button type="button" className="settings-clear" onClick={resetEndpoint}>
            Default
          </button>
        </div>
        <input
          id="labels-endpoint"
          type="text"
          className="settings-input"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          data-testid="labels-endpoint-input"
        />
      </div>

      <div className="settings-field">
        <label className="settings-label" htmlFor="labels-model">
          Model name
        </label>
        <div className="settings-row">
          <input
            id="labels-model"
            type="text"
            className="settings-input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            data-testid="labels-model-input"
          />
          <button type="button" className="settings-clear" onClick={resetModel}>
            Default
          </button>
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-label" htmlFor="labels-api-key">
          API key (leave blank for local LM Studio / Ollama)
        </label>
        <div className="settings-row">
          <input
            id="labels-api-key"
            type={showKey ? 'text' : 'password'}
            className="settings-input"
            value={apiKey}
            placeholder="sk-…"
            autoComplete="off"
            onChange={(e) => setApiKey(e.target.value)}
            data-testid="labels-api-key-input"
          />
          <button
            type="button"
            className="settings-clear"
            onClick={() => setShowKey((v) => !v)}
            title={showKey ? 'Hide key' : 'Show key'}
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-label" htmlFor="labels-prompt">
          Classifier system prompt
        </label>
        <p className="settings-help">
          Sent as the system message before each target message + its 3-message context window.
        </p>
        <textarea
          id="labels-prompt"
          className="settings-textarea"
          rows={14}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          data-testid="labels-prompt-input"
        />
        <div className="settings-actions">
          <button
            type="button"
            className="settings-clear"
            onClick={resetPrompt}
            disabled={isPromptDefault}
          >
            Reset to default prompt
          </button>
          <span className="settings-meta">{prompt.length.toLocaleString()} chars</span>
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-label">Test connection</label>
        <p className="settings-help">
          One canned classification roundtrip against the endpoint + model + prompt above. Useful before kicking off a long classify job.
        </p>
        <div className="settings-actions">
          <button
            type="button"
            className="settings-pick"
            onClick={() => void runTest()}
            disabled={testStatus === 'running'}
            data-testid="labels-test-connection"
          >
            {testStatus === 'running' ? 'Testing…' : 'Test connection'}
          </button>
          {testResult && (
            <span
              className={`settings-meta labels-test-result labels-test-${testStatus}`}
              data-testid="labels-test-result"
            >
              {testStatus === 'ok' ? '✓ ' : testStatus === 'fail' ? '✕ ' : ''}
              {testResult.ok
                ? `OK · ${testResult.elapsed_ms} ms · ${testResult.parsed?.label}`
                : `${testResult.error ?? 'failed'} · ${testResult.elapsed_ms} ms`}
            </span>
          )}
        </div>
        {testResult && testResult.raw && !testResult.ok && (
          <p className="settings-meta classify-last-error">
            Raw response: <code>{testResult.raw}</code>
          </p>
        )}
      </div>

      {error && <p className="settings-error">{error}</p>}
      <div className="settings-actions settings-footer-actions">
        <button
          type="button"
          className="settings-save"
          onClick={() => void save()}
          disabled={status === 'saving'}
          data-testid="labels-save"
        >
          {status === 'saving' ? 'Saving…' : 'Save labels settings'}
        </button>
      </div>
    </section>
  )
}

// nomic-* models require these task-specific prefixes; everything else
// (BGE, e5, voyage, gemini, sentence-transformers/*-mpnet, etc) ignores
// them. The toggle below sets both prefixes in one click so users don't
// have to remember the magic strings.
const NOMIC_QUERY_PREFIX = 'search_query: '
const NOMIC_DOCUMENT_PREFIX = 'search_document: '

// Reranker dropdown options. List matches what fastembed's
// TextCrossEncoder.list_supported_models() returns plus the
// "disabled" sentinel the sidecar honours. Sizes are rough on-disk
// download sizes so users can pick something their machine fits.
const RERANK_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  {
    value: 'jinaai/jina-reranker-v2-base-multilingual',
    label: 'Jina v2 multilingual (1.1 GB) — default'
  },
  { value: 'BAAI/bge-reranker-base', label: 'BGE reranker base (1.0 GB)' },
  {
    value: 'Xenova/ms-marco-MiniLM-L-12-v2',
    label: 'MiniLM L-12 (English, 0.12 GB)'
  },
  {
    value: 'Xenova/ms-marco-MiniLM-L-6-v2',
    label: 'MiniLM L-6 (English, 0.08 GB)'
  },
  { value: 'jinaai/jina-reranker-v1-tiny-en', label: 'Jina v1 tiny (English, 0.13 GB)' },
  { value: 'disabled', label: 'Disabled — skip reranking' }
]

function RagSection({
  rag,
  onSaved
}: {
  rag: RagSettings
  onSaved: (next: RagSettings) => void
}) {
  const [endpoint, setEndpoint] = useState(rag.embed_endpoint)
  const [model, setModel] = useState(rag.embed_model)
  const [apiKey, setApiKey] = useState(rag.embed_api_key)
  const [queryPrefix, setQueryPrefix] = useState(rag.embed_query_prefix)
  const [docPrefix, setDocPrefix] = useState(rag.embed_document_prefix)
  const [showKey, setShowKey] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [testStatus, setTestStatus] = useState<'idle' | 'running' | 'ok' | 'fail'>('idle')
  const [testResult, setTestResult] = useState<{
    ok: boolean
    elapsed_ms: number
    dimension: number | null
    model: string
    error: string | null
  } | null>(null)
  const [indexStatus, setIndexStatus] = useState<RagStatus | null>(null)

  // Chat-side form state.
  const [chatEndpoint, setChatEndpoint] = useState(rag.chat_endpoint)
  const [chatModel, setChatModel] = useState(rag.chat_model)
  const [chatApiKey, setChatApiKey] = useState(rag.chat_api_key)
  const [chatPrompt, setChatPrompt] = useState(rag.chat_system_prompt)
  const [showChatKey, setShowChatKey] = useState(false)

  // Retrieval tunables — strings so the inputs stay editable while the
  // user is typing (an empty string parses as NaN and the inputs would
  // otherwise refuse to clear).
  const [topK, setTopK] = useState(String(rag.top_k))
  const [rerankCandidates, setRerankCandidates] = useState(String(rag.rerank_candidates))
  const [neighbors, setNeighbors] = useState(String(rag.neighbors))
  const [rerankModel, setRerankModel] = useState(rag.rerank_model)

  // Chunking tunables — same string-state pattern as the retrieval
  // section so the user can clear them mid-edit.
  const [chunkMax, setChunkMax] = useState(String(rag.chunk_max_chars))
  const [chunkSoft, setChunkSoft] = useState(String(rag.chunk_soft_split_chars))
  const [chunkOverlap, setChunkOverlap] = useState(String(rag.chunk_overlap_msgs))

  useEffect(() => {
    setEndpoint(rag.embed_endpoint)
    setModel(rag.embed_model)
    setApiKey(rag.embed_api_key)
    setQueryPrefix(rag.embed_query_prefix)
    setDocPrefix(rag.embed_document_prefix)
    setChatEndpoint(rag.chat_endpoint)
    setChatModel(rag.chat_model)
    setChatApiKey(rag.chat_api_key)
    setChatPrompt(rag.chat_system_prompt)
    setTopK(String(rag.top_k))
    setRerankCandidates(String(rag.rerank_candidates))
    setNeighbors(String(rag.neighbors))
    setRerankModel(rag.rerank_model)
    setChunkMax(String(rag.chunk_max_chars))
    setChunkSoft(String(rag.chunk_soft_split_chars))
    setChunkOverlap(String(rag.chunk_overlap_msgs))
  }, [rag])

  const openIngest = useStore((s) => s.openIngest)
  const [wipeStatus, setWipeStatus] = useState<'idle' | 'wiping' | 'wiped' | 'error'>(
    'idle'
  )
  const [wipeError, setWipeError] = useState<string | null>(null)
  const triggerWipe = async () => {
    if (wipeStatus === 'wiping') return
    const confirmed = window.confirm(
      'Wipe the local vector index?\n\n' +
        'This deletes every embedded chunk and clears the manifest. ' +
        'It does NOT touch your labels or your F-Chat logs. The next ' +
        'time you run Ingest the index will rebuild from scratch.'
    )
    if (!confirmed) return
    setWipeStatus('wiping')
    setWipeError(null)
    try {
      await api.ragWipe()
      setWipeStatus('wiped')
      // Refresh the indexed-coverage line above so it reads zero.
      try {
        const s = await api.ragStatus()
        setIndexStatus(s)
      } catch {
        // Best-effort; the wipe itself succeeded.
      }
    } catch (err) {
      setWipeStatus('error')
      setWipeError(err instanceof Error ? err.message : String(err))
    }
  }
  const triggerReingestAll = () => {
    const confirmed = window.confirm(
      'Re-ingest all logs?\n\n' +
        'This wipes the existing vector index and rebuilds it for every ' +
        'character × partner using the current chunking + embedding ' +
        'settings. Existing chunks of incompatible shape (different ' +
        'embedding dimension or chunk size) will be removed first. The ' +
        'operation runs in the background and you can cancel mid-way.'
    )
    if (!confirmed) return
    openIngest({}, 'All characters, all partners (re-ingest)', { forceRewipe: true })
  }

  useEffect(() => {
    let cancelled = false
    api
      .ragStatus()
      .then((s) => {
        if (!cancelled) setIndexStatus(s)
      })
      .catch(() => {
        // Status is best-effort context — failure shouldn't block the form.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const usesNomicPrefixes =
    queryPrefix === NOMIC_QUERY_PREFIX && docPrefix === NOMIC_DOCUMENT_PREFIX

  const applyNomicPrefixes = () => {
    setQueryPrefix(NOMIC_QUERY_PREFIX)
    setDocPrefix(NOMIC_DOCUMENT_PREFIX)
  }
  const clearPrefixes = () => {
    setQueryPrefix('')
    setDocPrefix('')
  }

  const save = async () => {
    setStatus('saving')
    setError(null)
    // Coerce + clamp numeric strings here so a typo doesn't get to the
    // sidecar as NaN. Bounds mirror the loader's clamp; out-of-range
    // values are clamped silently rather than rejected.
    const clampInt = (s: string, lo: number, hi: number, fallback: number): number => {
      const n = Math.floor(Number(s))
      if (!Number.isFinite(n)) return fallback
      return Math.max(lo, Math.min(hi, n))
    }
    const nextTopK = clampInt(topK, 1, 50, rag.top_k)
    const nextRC = clampInt(rerankCandidates, 1, 200, rag.rerank_candidates)
    const nextNeighbors = clampInt(neighbors, 0, 5, rag.neighbors)
    const nextChunkMax = clampInt(chunkMax, 500, 20000, rag.chunk_max_chars)
    const nextChunkSoft = clampInt(
      chunkSoft,
      400,
      Math.max(500, nextChunkMax - 100),
      rag.chunk_soft_split_chars
    )
    const nextChunkOverlap = clampInt(chunkOverlap, 0, 5, rag.chunk_overlap_msgs)
    try {
      const updated = await api.settingsUpdate({
        rag: {
          embed_endpoint: endpoint,
          embed_model: model,
          embed_api_key: apiKey,
          embed_query_prefix: queryPrefix,
          embed_document_prefix: docPrefix,
          chat_endpoint: chatEndpoint,
          chat_model: chatModel,
          chat_api_key: chatApiKey,
          chat_system_prompt: chatPrompt,
          rerank_model: rerankModel,
          rerank_candidates: nextRC,
          top_k: nextTopK,
          neighbors: nextNeighbors,
          chunk_max_chars: nextChunkMax,
          chunk_soft_split_chars: nextChunkSoft,
          chunk_overlap_msgs: nextChunkOverlap
        }
      })
      onSaved(updated.rag)
      setStatus('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  const runTest = async () => {
    setTestStatus('running')
    setTestResult(null)
    try {
      const result = await api.ragTestEmbedding({
        embed_endpoint: endpoint,
        embed_model: model,
        embed_api_key: apiKey,
        embed_query_prefix: queryPrefix,
        embed_document_prefix: docPrefix
      })
      setTestResult(result)
      setTestStatus(result.ok ? 'ok' : 'fail')
    } catch (err) {
      setTestResult({
        ok: false,
        elapsed_ms: 0,
        dimension: null,
        model,
        error: err instanceof Error ? err.message : String(err)
      })
      setTestStatus('fail')
    }
  }

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">RAG (chat over your logs)</h3>
      <p className="settings-help">
        Settings for the local embedding model used to index conversations for
        retrieval. Load an embedding model in LM Studio (or your inference
        server of choice) alongside the chat model, then point this here.{' '}
        <code>&lt;endpoint&gt;/embeddings</code> is hit per request — same
        OpenAI-compatible shape as the labels classifier.
      </p>

      {indexStatus !== null && (
        <p className="settings-meta" data-testid="rag-index-status">
          {indexStatus.chunk_count > 0 ? (
            <>
              Index: <strong>{indexStatus.chunk_count.toLocaleString()}</strong>{' '}
              chunks · model <code>{indexStatus.embed_model}</code> (dim{' '}
              {indexStatus.embed_dimension})
            </>
          ) : (
            <>
              No chunks indexed yet. Use{' '}
              <strong>Logs → Ingest All Characters (RAG)…</strong> to build the
              vector index.
            </>
          )}
        </p>
      )}

      <div className="settings-field">
        <label className="settings-label" htmlFor="rag-endpoint">
          Embedding endpoint
        </label>
        <p className="settings-help">
          Usually the same URL as the labels classifier — LM Studio can host a
          chat model and an embedding model at the same port.
        </p>
        <div className="settings-row">
          {ENDPOINT_PRESETS.map((p) => (
            <button
              key={p.url}
              type="button"
              className={`settings-preset ${endpoint === p.url ? 'on' : ''}`}
              onClick={() => setEndpoint(p.url)}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            className="settings-clear"
            onClick={() => setEndpoint(rag.defaults.embed_endpoint)}
          >
            Default
          </button>
        </div>
        <input
          id="rag-endpoint"
          type="text"
          className="settings-input"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          data-testid="rag-endpoint-input"
        />
      </div>

      <div className="settings-field">
        <label className="settings-label" htmlFor="rag-model">
          Embedding model
        </label>
        <p className="settings-help">
          The model identifier the server expects. For LM Studio that's the
          name shown in the model loader — e.g.{' '}
          <code>nomic-ai/nomic-embed-text-v1.5</code>,{' '}
          <code>BAAI/bge-m3</code>, or whatever you have loaded.
        </p>
        <div className="settings-row">
          <input
            id="rag-model"
            type="text"
            className="settings-input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            data-testid="rag-model-input"
          />
          <button
            type="button"
            className="settings-clear"
            onClick={() => setModel(rag.defaults.embed_model)}
          >
            Default
          </button>
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-label" htmlFor="rag-api-key">
          API key (blank for local LM Studio / Ollama)
        </label>
        <div className="settings-row">
          <input
            id="rag-api-key"
            type={showKey ? 'text' : 'password'}
            className="settings-input"
            value={apiKey}
            placeholder="sk-…"
            autoComplete="off"
            onChange={(e) => setApiKey(e.target.value)}
            data-testid="rag-api-key-input"
          />
          <button
            type="button"
            className="settings-clear"
            onClick={() => setShowKey((v) => !v)}
            title={showKey ? 'Hide key' : 'Show key'}
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-label">Task-specific prefixes</label>
        <p className="settings-help">
          Only the <code>nomic-embed-text-*</code> family requires these — they
          drop recall ~30% without them. BGE, e5, Voyage, Gemini and most other
          models ignore prefixes; leave them blank.
        </p>
        <div className="settings-row">
          <button
            type="button"
            className={`settings-preset ${usesNomicPrefixes ? 'on' : ''}`}
            onClick={applyNomicPrefixes}
            data-testid="rag-prefix-nomic"
          >
            Use nomic prefixes
          </button>
          <button
            type="button"
            className="settings-clear"
            onClick={clearPrefixes}
            data-testid="rag-prefix-clear"
          >
            Clear
          </button>
        </div>
        <div className="settings-row">
          <label
            htmlFor="rag-query-prefix"
            className="settings-meta"
            style={{ alignSelf: 'center', minWidth: '4.5rem' }}
          >
            Query
          </label>
          <input
            id="rag-query-prefix"
            type="text"
            className="settings-input"
            value={queryPrefix}
            placeholder="(none)"
            onChange={(e) => setQueryPrefix(e.target.value)}
            data-testid="rag-query-prefix-input"
          />
        </div>
        <div className="settings-row">
          <label
            htmlFor="rag-doc-prefix"
            className="settings-meta"
            style={{ alignSelf: 'center', minWidth: '4.5rem' }}
          >
            Document
          </label>
          <input
            id="rag-doc-prefix"
            type="text"
            className="settings-input"
            value={docPrefix}
            placeholder="(none)"
            onChange={(e) => setDocPrefix(e.target.value)}
            data-testid="rag-doc-prefix-input"
          />
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-label">Test connection</label>
        <p className="settings-help">
          One canned embedding roundtrip. Validates the endpoint, that the
          model is loaded, and reports the vector dimension so you can confirm
          you picked the model you intended.
        </p>
        <div className="settings-actions">
          <button
            type="button"
            className="settings-pick"
            onClick={() => void runTest()}
            disabled={testStatus === 'running'}
            data-testid="rag-test-embedding"
          >
            {testStatus === 'running' ? 'Testing…' : 'Test connection'}
          </button>
          {testResult && (
            <span
              className={`settings-meta labels-test-result labels-test-${testStatus}`}
              data-testid="rag-test-result"
            >
              {testStatus === 'ok' ? '✓ ' : testStatus === 'fail' ? '✕ ' : ''}
              {testResult.ok
                ? `OK · ${testResult.elapsed_ms} ms · dim ${testResult.dimension} · ${testResult.model}`
                : `${testResult.error ?? 'failed'} · ${testResult.elapsed_ms} ms`}
            </span>
          )}
        </div>
      </div>

      <hr className="settings-divider" />
      <h4 className="settings-subheading">Chat</h4>
      <p className="settings-help">
        LLM that answers questions over the retrieved chunks. Defaults
        to the labels endpoint — point this at a larger / different
        model if you prefer a separate chat brain.
      </p>

      <div className="settings-field">
        <label className="settings-label" htmlFor="rag-chat-endpoint">
          Chat endpoint
        </label>
        <div className="settings-row">
          {ENDPOINT_PRESETS.map((p) => (
            <button
              key={`chat-${p.url}`}
              type="button"
              className={`settings-preset ${chatEndpoint === p.url ? 'on' : ''}`}
              onClick={() => setChatEndpoint(p.url)}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            className="settings-clear"
            onClick={() => setChatEndpoint(rag.defaults.chat_endpoint)}
          >
            Default
          </button>
        </div>
        <input
          id="rag-chat-endpoint"
          type="text"
          className="settings-input"
          value={chatEndpoint}
          onChange={(e) => setChatEndpoint(e.target.value)}
          data-testid="rag-chat-endpoint-input"
        />
      </div>

      <div className="settings-field">
        <label className="settings-label" htmlFor="rag-chat-model">
          Chat model
        </label>
        <div className="settings-row">
          <input
            id="rag-chat-model"
            type="text"
            className="settings-input"
            value={chatModel}
            onChange={(e) => setChatModel(e.target.value)}
            data-testid="rag-chat-model-input"
          />
          <button
            type="button"
            className="settings-clear"
            onClick={() => setChatModel(rag.defaults.chat_model)}
          >
            Default
          </button>
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-label" htmlFor="rag-chat-api-key">
          API key (blank for local LM Studio / Ollama)
        </label>
        <div className="settings-row">
          <input
            id="rag-chat-api-key"
            type={showChatKey ? 'text' : 'password'}
            className="settings-input"
            value={chatApiKey}
            placeholder="sk-…"
            autoComplete="off"
            onChange={(e) => setChatApiKey(e.target.value)}
            data-testid="rag-chat-api-key-input"
          />
          <button
            type="button"
            className="settings-clear"
            onClick={() => setShowChatKey((v) => !v)}
            title={showChatKey ? 'Hide key' : 'Show key'}
          >
            {showChatKey ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-label" htmlFor="rag-chat-prompt">
          Chat system prompt
        </label>
        <p className="settings-help">
          Prepended as the system message before each retrieval call.
          Empty resets to the bundled English default that asks the
          model to ground answers in the cited chunks.
        </p>
        <textarea
          id="rag-chat-prompt"
          className="settings-textarea"
          rows={10}
          value={chatPrompt}
          onChange={(e) => setChatPrompt(e.target.value)}
          data-testid="rag-chat-prompt-input"
        />
        <div className="settings-actions">
          <button
            type="button"
            className="settings-clear"
            onClick={() => setChatPrompt(rag.defaults.chat_system_prompt)}
            disabled={chatPrompt === rag.defaults.chat_system_prompt}
          >
            Reset to default prompt
          </button>
          <span className="settings-meta">{chatPrompt.length.toLocaleString()} chars</span>
        </div>
      </div>

      <hr className="settings-divider" />
      <h4 className="settings-subheading">Retrieval</h4>
      <p className="settings-help">
        How many chunks fetch / rerank / send to the LLM per question.
        These tunables don't require a re-ingest — changes take effect
        on the next chat message.
      </p>

      <div className="settings-field">
        <label className="settings-label">Top-K, rerank candidates, neighbors</label>
        <p className="settings-help">
          <code>top-K</code> goes to the LLM; <code>rerank candidates</code> is
          how many we pull from Qdrant before reranking down to top-K;{' '}
          <code>neighbors</code> expands each hit by ±N adjacent chunks for
          extra context (0 disables expansion).
        </p>
        <div className="settings-row">
          <label className="settings-meta" style={{ alignSelf: 'center', minWidth: '5.5rem' }}>
            Top-K
          </label>
          <input
            type="number"
            min={1}
            max={50}
            className="settings-input settings-input-narrow"
            value={topK}
            onChange={(e) => setTopK(e.target.value)}
            data-testid="rag-top-k-input"
          />
        </div>
        <div className="settings-row">
          <label className="settings-meta" style={{ alignSelf: 'center', minWidth: '5.5rem' }}>
            Candidates
          </label>
          <input
            type="number"
            min={1}
            max={200}
            className="settings-input settings-input-narrow"
            value={rerankCandidates}
            onChange={(e) => setRerankCandidates(e.target.value)}
            data-testid="rag-rerank-candidates-input"
          />
        </div>
        <div className="settings-row">
          <label className="settings-meta" style={{ alignSelf: 'center', minWidth: '5.5rem' }}>
            Neighbors
          </label>
          <input
            type="number"
            min={0}
            max={5}
            className="settings-input settings-input-narrow"
            value={neighbors}
            onChange={(e) => setNeighbors(e.target.value)}
            data-testid="rag-neighbors-input"
          />
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-label" htmlFor="rag-rerank-model">
          Reranker model
        </label>
        <p className="settings-help">
          Cross-encoder that re-scores Qdrant candidates against the
          query. Downloads on first use to{' '}
          <code>~/Documents/flist-workbench/models/</code>. Bigger
          multilingual models cost more disk + memory but recover
          recall on non-English corpora.
        </p>
        <div className="settings-row">
          <select
            id="rag-rerank-model"
            className="settings-input"
            value={rerankModel}
            onChange={(e) => setRerankModel(e.target.value)}
            data-testid="rag-rerank-model-input"
          >
            {RERANK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="settings-clear"
            onClick={() => setRerankModel(rag.defaults.rerank_model)}
          >
            Default
          </button>
        </div>
      </div>

      <hr className="settings-divider" />
      <h4 className="settings-subheading">Chunking</h4>
      <p className="settings-help">
        How parsed messages get grouped into retrieval chunks. Smaller
        chunks improve "find the exact moment" queries at the cost of
        more vectors to embed; more overlap reduces meaning getting cut
        mid-exchange. <strong>Changing any of these requires a
        re-ingest</strong> for existing data to use the new shape — use
        the button below.
      </p>

      <div className="settings-field">
        <label className="settings-label">Max / soft-split / overlap</label>
        <div className="settings-row">
          <label className="settings-meta" style={{ alignSelf: 'center', minWidth: '6.5rem' }}>
            Max chars
          </label>
          <input
            type="number"
            min={500}
            max={20000}
            step={100}
            className="settings-input settings-input-narrow"
            value={chunkMax}
            onChange={(e) => setChunkMax(e.target.value)}
            data-testid="rag-chunk-max-input"
          />
          <button
            type="button"
            className="settings-clear"
            onClick={() => setChunkMax(String(rag.defaults.chunk_max_chars))}
          >
            Default ({rag.defaults.chunk_max_chars})
          </button>
        </div>
        <div className="settings-row">
          <label className="settings-meta" style={{ alignSelf: 'center', minWidth: '6.5rem' }}>
            Soft split
          </label>
          <input
            type="number"
            min={400}
            max={20000}
            step={100}
            className="settings-input settings-input-narrow"
            value={chunkSoft}
            onChange={(e) => setChunkSoft(e.target.value)}
            data-testid="rag-chunk-soft-input"
          />
          <button
            type="button"
            className="settings-clear"
            onClick={() => setChunkSoft(String(rag.defaults.chunk_soft_split_chars))}
          >
            Default ({rag.defaults.chunk_soft_split_chars})
          </button>
        </div>
        <div className="settings-row">
          <label className="settings-meta" style={{ alignSelf: 'center', minWidth: '6.5rem' }}>
            Overlap msgs
          </label>
          <input
            type="number"
            min={0}
            max={5}
            className="settings-input settings-input-narrow"
            value={chunkOverlap}
            onChange={(e) => setChunkOverlap(e.target.value)}
            data-testid="rag-chunk-overlap-input"
          />
          <button
            type="button"
            className="settings-clear"
            onClick={() => setChunkOverlap(String(rag.defaults.chunk_overlap_msgs))}
          >
            Default ({rag.defaults.chunk_overlap_msgs})
          </button>
        </div>
      </div>

      <hr className="settings-divider" />
      <h4 className="settings-subheading">Index maintenance</h4>
      <p className="settings-help">
        <strong>Wipe index</strong> drops the local Qdrant collection
        and clears the manifest — pure delete, no re-ingest. Useful if
        you want to free disk now and re-embed later, or if you want
        a known-clean slate before changing chunking / embedding
        settings.
      </p>
      <p className="settings-help">
        <strong>Re-ingest all</strong> wipes <em>and</em> rebuilds
        every conversation in one step using the current settings. Use
        this after switching embedding model or adjusting chunk size;
        otherwise old chunks of an incompatible shape can linger
        alongside new ones.
      </p>
      <div className="settings-actions">
        <button
          type="button"
          className="settings-clear"
          onClick={() => void triggerWipe()}
          disabled={wipeStatus === 'wiping'}
          data-testid="rag-wipe"
        >
          {wipeStatus === 'wiping' ? 'Wiping…' : 'Wipe index'}
        </button>
        <button
          type="button"
          className="settings-clear"
          onClick={triggerReingestAll}
          data-testid="rag-reingest-all"
        >
          Re-ingest all (wipe + rebuild)…
        </button>
        {wipeStatus === 'wiped' && (
          <span className="settings-meta">Index wiped.</span>
        )}
        {wipeStatus === 'error' && wipeError && (
          <span className="settings-meta classify-last-error">
            Wipe failed: {wipeError}
          </span>
        )}
      </div>

      {error && <p className="settings-error">{error}</p>}
      <div className="settings-actions settings-footer-actions">
        <button
          type="button"
          className="settings-save"
          onClick={() => void save()}
          disabled={status === 'saving'}
          data-testid="rag-save"
        >
          {status === 'saving' ? 'Saving…' : 'Save RAG settings'}
        </button>
      </div>
    </section>
  )
}
