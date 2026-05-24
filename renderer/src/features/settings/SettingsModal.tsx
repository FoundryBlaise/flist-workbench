import { useEffect, useRef, useState } from 'react'
import { api, type LabelsSettings } from '../../lib/api'
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
    parsed?: { label: string; confidence: number; reason: string } | null
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
                ? `OK · ${testResult.elapsed_ms} ms · ${testResult.parsed?.label} (${(
                    (testResult.parsed?.confidence ?? 0) * 100
                  ).toFixed(0)}%)`
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
