import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type OllamaPullProgress } from '../../lib/api'
import { useStore } from '../../state'

type Page = 'ollama' | 'gpu' | 'env' | 'embed' | 'download' | 'done'

const PAGE_ORDER: ReadonlyArray<{ id: Page; label: string }> = [
  { id: 'ollama', label: 'Ollama' },
  { id: 'gpu', label: 'Chat model' },
  { id: 'env', label: 'Tuning' },
  { id: 'embed', label: 'Embedding' },
  { id: 'download', label: 'Download' },
  { id: 'done', label: 'Done' }
]

// Model recommendations are baked into the wizard so a stale settings
// snapshot in `defaults` can't drift the suggestion. The user can
// still override via the disclosure-triangle free-text input.
const CHAT_MODEL_12GB =
  'hf.co/bartowski/mlabonne_gemma-3-12b-it-abliterated-GGUF:Q4_K_M'
const CHAT_MODEL_24GB =
  'hf.co/bartowski/huihui-ai_Mistral-Small-24B-Instruct-2501-abliterated-GGUF:Q4_K_M'
const EMBED_MODEL_DEFAULT = 'nomic-embed-text:latest'
const NOMIC_QUERY_PREFIX = 'search_query: '
const NOMIC_DOCUMENT_PREFIX = 'search_document: '

// Endpoint we'll write into settings. Always localhost — Ollama runs
// on the user's machine. CLAUDE.md's host.docker.internal applies only
// to the dev sandbox; release builds run native and reach localhost.
const OLLAMA_OPENAI_ENDPOINT = 'http://localhost:11434/v1'

// Env vars we recommend. Tuple is [name, value, caption].
const ENV_VARS: ReadonlyArray<[string, string, string]> = [
  [
    'OLLAMA_FLASH_ATTENTION',
    '1',
    'Enables flash attention — roughly 10–20% faster prompt processing.'
  ],
  [
    'OLLAMA_KV_CACHE_TYPE',
    'q8_0',
    'Quantises the KV cache to 8-bit — halves long-context VRAM use.'
  ]
]

type OllamaStatus = Awaited<ReturnType<typeof api.systemOllamaStatus>>

// Per-model download row state. `bytes/total` come from Ollama; `rate`
// and `eta_sec` are derived locally from a rolling sample window.
type DownloadState = {
  status:
    | 'queued'
    | 'pulling-manifest'
    | 'downloading'
    | 'verifying'
    | 'writing'
    | 'success'
    | 'already-present'
    | 'cancelled'
    | 'error'
  phase: string // verbatim from Ollama
  bytes: number | null
  total: number | null
  rate: number | null
  eta_sec: number | null
  error: string | null
}

const initialDownload = (): DownloadState => ({
  status: 'queued',
  phase: '',
  bytes: null,
  total: null,
  rate: null,
  eta_sec: null,
  error: null
})

type Choice = '12gb' | '24gb' | 'custom'

export function AISetupWizard({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState<Page>('ollama')
  // Persisted across pages so Back doesn't lose them.
  const [choice, setChoice] = useState<Choice>('12gb')
  const [customChatModel, setCustomChatModel] = useState('')
  const [envApplied, setEnvApplied] = useState(false)
  const [envSkipped, setEnvSkipped] = useState(false)
  const [embedModel, setEmbedModel] = useState(EMBED_MODEL_DEFAULT)
  const [applyNomicPrefixes, setApplyNomicPrefixes] = useState(true)
  const [chatModelOverride, setChatModelOverride] = useState(false)
  const [embedModelOverride, setEmbedModelOverride] = useState(false)
  // Lifted from OllamaPage so the footer's Continue button can gate on
  // detection success. We let the user click Continue themselves rather
  // than auto-advancing — testers found the timed jump disorienting.
  const [ollamaOk, setOllamaOk] = useState(false)

  const chatModel = useMemo(() => {
    if (chatModelOverride && customChatModel.trim()) return customChatModel.trim()
    return choice === '24gb' ? CHAT_MODEL_24GB : CHAT_MODEL_12GB
  }, [choice, chatModelOverride, customChatModel])

  // ESC closes (with confirmation if we're mid-pull). Backdrop is
  // inert across all modals per project convention.
  const [chatDownload, setChatDownload] = useState<DownloadState>(initialDownload)
  const [embedDownload, setEmbedDownload] = useState<DownloadState>(initialDownload)
  const activeAbortRef = useRef<AbortController | null>(null)
  const isPulling =
    chatDownload.status === 'pulling-manifest' ||
    chatDownload.status === 'downloading' ||
    chatDownload.status === 'verifying' ||
    chatDownload.status === 'writing' ||
    embedDownload.status === 'pulling-manifest' ||
    embedDownload.status === 'downloading' ||
    embedDownload.status === 'verifying' ||
    embedDownload.status === 'writing'

  const tryClose = () => {
    if (isPulling) {
      window.alert(
        'Cancel the download first — closing while pulling would leave the model in an inconsistent state.'
      )
      return
    }
    if (page !== 'ollama' && page !== 'done') {
      const ok = window.confirm('Discard setup progress?')
      if (!ok) return
    }
    onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') tryClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPulling, page])

  const goNext = () => {
    const idx = PAGE_ORDER.findIndex((p) => p.id === page)
    if (idx < PAGE_ORDER.length - 1) setPage(PAGE_ORDER[idx + 1].id)
  }
  const goBack = () => {
    const idx = PAGE_ORDER.findIndex((p) => p.id === page)
    if (idx > 0) setPage(PAGE_ORDER[idx - 1].id)
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal wizard-modal" data-testid="ai-setup-modal">
        <header className="modal-head">
          <div>
            <h2 className="modal-title">AI Setup</h2>
            <p className="modal-subtitle">
              One-time setup for Ollama + the F-list Workbench chat models.
            </p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={tryClose}
            aria-label="Close"
            data-testid="ai-setup-close"
          >
            ✕
          </button>
        </header>
        <Stepper current={page} />
        <div className="wizard-body">
          {page === 'ollama' && <OllamaPage onStatusChange={setOllamaOk} />}
          {page === 'gpu' && (
            <GpuPage
              choice={choice}
              setChoice={setChoice}
              chatModelOverride={chatModelOverride}
              setChatModelOverride={setChatModelOverride}
              customChatModel={customChatModel}
              setCustomChatModel={setCustomChatModel}
              currentChat={chatModel}
            />
          )}
          {page === 'env' && (
            <EnvPage
              applied={envApplied}
              skipped={envSkipped}
              onApplied={() => {
                setEnvApplied(true)
                setEnvSkipped(false)
              }}
              onSkipped={() => {
                setEnvSkipped(true)
                setEnvApplied(false)
              }}
            />
          )}
          {page === 'embed' && (
            <EmbedPage
              embedModel={embedModel}
              setEmbedModel={setEmbedModel}
              applyNomicPrefixes={applyNomicPrefixes}
              setApplyNomicPrefixes={setApplyNomicPrefixes}
              override={embedModelOverride}
              setOverride={setEmbedModelOverride}
            />
          )}
          {page === 'download' && (
            <DownloadPage
              chatModel={chatModel}
              embedModel={embedModel}
              chatState={chatDownload}
              setChatState={setChatDownload}
              embedState={embedDownload}
              setEmbedState={setEmbedDownload}
              abortRef={activeAbortRef}
            />
          )}
          {page === 'done' && (
            <DonePage
              chatModel={chatModel}
              embedModel={embedModel}
              envApplied={envApplied}
              applyNomicPrefixes={applyNomicPrefixes}
              chatState={chatDownload}
              embedState={embedDownload}
              onClose={onClose}
            />
          )}
        </div>
        <footer className="wizard-footer">
          <button
            type="button"
            className="settings-clear"
            onClick={goBack}
            disabled={page === 'ollama' || page === 'done' || isPulling}
            data-testid="ai-setup-back"
          >
            ← Back
          </button>
          <span className="settings-footer-spacer" />
          {page === 'env' && !envApplied && !envSkipped && (
            <button
              type="button"
              className="settings-clear"
              onClick={() => {
                setEnvSkipped(true)
                goNext()
              }}
              data-testid="ai-setup-skip"
            >
              Skip — I'll do this later
            </button>
          )}
          {page !== 'done' && page !== 'download' && (
            <WizardNextButton
              page={page}
              choice={choice}
              chatModel={chatModel}
              embedModel={embedModel}
              envApplied={envApplied}
              envSkipped={envSkipped}
              ollamaOk={ollamaOk}
              onNext={goNext}
            />
          )}
          {page === 'download' && (
            <WizardDownloadNextButton
              chatState={chatDownload}
              embedState={embedDownload}
              onNext={goNext}
            />
          )}
          {page === 'done' && (
            <button
              type="button"
              className="settings-save"
              onClick={onClose}
              data-testid="ai-setup-finish-close"
            >
              Close
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

// ---- Stepper -----------------------------------------------------------

function Stepper({ current }: { current: Page }) {
  const idx = PAGE_ORDER.findIndex((p) => p.id === current)
  return (
    <ol className="wizard-stepper" data-testid="ai-setup-stepper">
      {PAGE_ORDER.map((p, i) => {
        const state = i < idx ? 'done' : i === idx ? 'current' : 'todo'
        return (
          <li
            key={p.id}
            className={`wizard-step wizard-step-${state}`}
            data-testid={`ai-setup-stepper-${p.id}`}
            aria-current={i === idx ? 'step' : undefined}
          >
            <span className="wizard-step-n">{i + 1}</span>
            <span className="wizard-step-label">{p.label}</span>
          </li>
        )
      })}
    </ol>
  )
}

// ---- Page 1: Ollama detection ------------------------------------------

function OllamaPage({
  onStatusChange
}: {
  onStatusChange: (ok: boolean) => void
}) {
  const [status, setStatus] = useState<'detecting' | 'ok' | 'fail'>('detecting')
  const [info, setInfo] = useState<OllamaStatus | null>(null)
  // Mirror status into the parent so the footer's Continue button can
  // gate on it. Wrapped in a ref so the probe closure stays stable.
  const onStatusChangeRef = useRef(onStatusChange)
  onStatusChangeRef.current = onStatusChange

  const probe = async () => {
    setStatus('detecting')
    onStatusChangeRef.current(false)
    try {
      const res = await api.systemOllamaStatus()
      setInfo(res)
      const ok = res.running
      setStatus(ok ? 'ok' : 'fail')
      onStatusChangeRef.current(ok)
    } catch (err) {
      setInfo({
        running: false,
        installed: false,
        version: null,
        models: null,
        error: err instanceof Error ? err.message : String(err)
      })
      setStatus('fail')
      onStatusChangeRef.current(false)
    }
  }

  useEffect(() => {
    void probe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <WizardPaneHeader
        title="Looking for Ollama"
        subtitle="F-list Workbench uses Ollama to run a local language model on your machine. Nothing leaves this PC."
      />
      <div
        className={`wizard-status-card wizard-status-${status}`}
        data-testid="ai-setup-ollama-status"
      >
        {status === 'detecting' && (
          <>
            <span className="classify-state-glyph" aria-hidden>
              ◌
            </span>
            <span>Checking <code>http://localhost:11434</code>…</span>
          </>
        )}
        {status === 'ok' && info && (
          <>
            <span className="classify-state-glyph" aria-hidden>
              ✓
            </span>
            <span>
              Ollama detected{info.version ? ` · v${info.version}` : ''}.{' '}
              {info.models && info.models.length > 0
                ? `${info.models.length} model${info.models.length === 1 ? '' : 's'} already pulled.`
                : 'No models pulled yet.'}
            </span>
            <span
              className="settings-meta"
              data-testid="ai-setup-ollama-version"
            >
              Press Continue when ready.
            </span>
          </>
        )}
        {status === 'fail' && info && (
          <OllamaMissing info={info} onRecheck={() => void probe()} />
        )}
      </div>
    </>
  )
}

function OllamaMissing({
  info,
  onRecheck
}: {
  info: OllamaStatus
  onRecheck: () => void
}) {
  const wingetCmd = 'winget install --id=Ollama.Ollama -e'
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text)
  }
  return (
    <div className="wizard-missing">
      <p className="settings-error">{info.error ?? "Ollama isn't responding."}</p>
      {info.installed ? (
        <p className="settings-help">
          Ollama is installed but isn't running. Launch it from the Start
          menu — the tray icon should appear within a few seconds.
        </p>
      ) : (
        <div className="wizard-install-grid">
          <div className="wizard-install-option">
            <h4 className="settings-section-title">Option A · winget</h4>
            <p className="settings-help">
              Paste this into PowerShell or Windows Terminal.{' '}
              <em>
                We can't run this for you — Windows requires you to accept
                the install prompt yourself.
              </em>
            </p>
            <div className="settings-row">
              <code className="wizard-codeblock">{wingetCmd}</code>
              <button
                type="button"
                className="settings-clear"
                onClick={() => void copy(wingetCmd)}
                data-testid="ai-setup-ollama-winget-copy"
              >
                Copy
              </button>
            </div>
          </div>
          <div className="wizard-install-option">
            <h4 className="settings-section-title">Option B · Download page</h4>
            <p className="settings-help">
              Use this if you don't have winget.
            </p>
            <button
              type="button"
              className="settings-pick"
              onClick={() =>
                window.workbench?.openExternal?.('https://ollama.com/download')
              }
              data-testid="ai-setup-ollama-download-link"
            >
              Open ollama.com/download
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        className="settings-save"
        onClick={onRecheck}
        data-testid="ai-setup-ollama-recheck"
      >
        I've installed/started Ollama — check again
      </button>
    </div>
  )
}

// ---- Page 2: GPU + chat model -----------------------------------------

function GpuPage({
  choice,
  setChoice,
  chatModelOverride,
  setChatModelOverride,
  customChatModel,
  setCustomChatModel,
  currentChat
}: {
  choice: Choice
  setChoice: (c: Choice) => void
  chatModelOverride: boolean
  setChatModelOverride: (v: boolean) => void
  customChatModel: string
  setCustomChatModel: (v: string) => void
  currentChat: string
}) {
  return (
    <>
      <WizardPaneHeader
        title="Choose a chat model for your GPU"
        subtitle="Pick the option that matches your video card. You can change this in Settings later."
      />
      <div className="wizard-cards">
        <RadioCard
          on={choice === '12gb' && !chatModelOverride}
          onClick={() => {
            setChoice('12gb')
            setChatModelOverride(false)
          }}
          testId="ai-setup-gpu-12gb"
          title="12 GB VRAM"
          model={CHAT_MODEL_12GB}
          subtitle="Gemma 3 12B abliterated · ~7 GB download · runs comfortably at Q4_K_M"
        />
        <RadioCard
          on={choice === '24gb' && !chatModelOverride}
          onClick={() => {
            setChoice('24gb')
            setChatModelOverride(false)
          }}
          testId="ai-setup-gpu-24gb"
          title="24 GB+ VRAM"
          model={CHAT_MODEL_24GB}
          subtitle="Mistral Small 24B abliterated · ~14 GB download · richer reasoning"
        />
      </div>
      <details
        className="wizard-disclosure"
        open={chatModelOverride}
        onToggle={(e) =>
          setChatModelOverride((e.target as HTMLDetailsElement).open)
        }
      >
        <summary>Use a different model</summary>
        <p className="settings-help">
          Anything Ollama can pull works: <code>hf.co/&lt;repo&gt;:&lt;tag&gt;</code>
          , Ollama library names like <code>llama3:8b</code>, or local copies.
        </p>
        <input
          type="text"
          className="settings-input"
          value={customChatModel}
          placeholder={currentChat}
          onChange={(e) => setCustomChatModel(e.target.value)}
          data-testid="ai-setup-chat-model-input"
        />
      </details>
      <p className="settings-meta">
        Both recommendations are uncensored fine-tunes appropriate for adult
        RP, pulled from Hugging Face via Ollama.
      </p>
    </>
  )
}

function RadioCard({
  on,
  onClick,
  testId,
  title,
  model,
  subtitle
}: {
  on: boolean
  onClick: () => void
  testId: string
  title: string
  model: string
  subtitle: string
}) {
  return (
    <button
      type="button"
      className={`wizard-card${on ? ' on' : ''}`}
      onClick={onClick}
      aria-pressed={on}
      data-testid={testId}
    >
      <span className="wizard-card-radio" aria-hidden>
        {on ? '●' : '○'}
      </span>
      <span className="wizard-card-body">
        <span className="wizard-card-title">{title}</span>
        <code className="wizard-card-model">{model}</code>
        <span className="wizard-card-sub">{subtitle}</span>
      </span>
    </button>
  )
}

// ---- Page 3: Env vars --------------------------------------------------

function EnvPage({
  applied,
  skipped,
  onApplied,
  onSkipped
}: {
  applied: boolean
  skipped: boolean
  onApplied: () => void
  onSkipped: () => void
}) {
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text)
  }
  const combined =
    '$env:OLLAMA_FLASH_ATTENTION = "1"\n' +
    '$env:OLLAMA_KV_CACHE_TYPE = "q8_0"\n' +
    "setx OLLAMA_FLASH_ATTENTION 1\n" +
    'setx OLLAMA_KV_CACHE_TYPE q8_0'
  const isWindows =
    typeof window !== 'undefined' &&
    /Win/.test(window.navigator.platform ?? '')
  const openPs = () => {
    window.workbench?.spawnPowerShell?.(combined)
  }
  return (
    <>
      <WizardPaneHeader
        title="Recommended Ollama tuning (optional)"
        subtitle="Two environment variables let Ollama use less VRAM with the same model. Skip this page if you'd rather set them up later — the model still works without them."
      />
      <div className="wizard-env-rows">
        {ENV_VARS.map(([name, value, caption]) => {
          const cmd = `setx ${name} ${value}`
          return (
            <div key={name} className="wizard-env-row">
              <div className="settings-row">
                <code className="wizard-codeblock wizard-codeblock-grow">{cmd}</code>
                <button
                  type="button"
                  className="settings-clear"
                  onClick={() => void copy(cmd)}
                  data-testid={
                    name === 'OLLAMA_FLASH_ATTENTION'
                      ? 'ai-setup-env-copy-flash'
                      : 'ai-setup-env-copy-kv'
                  }
                >
                  Copy
                </button>
              </div>
              <p className="settings-meta">{caption}</p>
            </div>
          )
        })}
      </div>
      <div className="settings-row settings-row-wrap" style={{ marginTop: 14 }}>
        <button
          type="button"
          className="settings-pick"
          onClick={() => void copy(combined)}
          data-testid="ai-setup-env-copy-both"
        >
          Copy both as PowerShell block
        </button>
        {isWindows && (
          <button
            type="button"
            className="settings-pick"
            onClick={openPs}
            disabled={!window.workbench?.spawnPowerShell}
            title={
              window.workbench?.spawnPowerShell
                ? 'Launches a PowerShell window with both commands ready to run — you press Enter.'
                : 'Not available in this build.'
            }
            data-testid="ai-setup-env-open-powershell"
          >
            Open PowerShell with commands staged
          </button>
        )}
      </div>
      <p className="settings-meta">
        <code>setx</code> writes to your user environment (persists across
        reboots). System-wide vars need an elevated PowerShell — skip that
        unless you know you need it.
      </p>
      <p className="settings-error">
        <strong>Ollama must be restarted after setting these</strong>, or it
        won't pick them up. Quit it from the tray and relaunch.
      </p>
      <div className="settings-row" style={{ marginTop: 16 }}>
        <button
          type="button"
          className={`settings-save${applied ? '' : ' wizard-pressable'}`}
          onClick={onApplied}
          aria-pressed={applied}
        >
          {applied ? "✓ I've set these" : "I've set these"}
        </button>
        <button
          type="button"
          className={`settings-clear${skipped ? ' wizard-pressed' : ''}`}
          onClick={onSkipped}
          aria-pressed={skipped}
        >
          {skipped ? '✓ Skipped' : 'Skip — set later'}
        </button>
      </div>
    </>
  )
}

// ---- Page 4: Embedding -------------------------------------------------

function EmbedPage({
  embedModel,
  setEmbedModel,
  applyNomicPrefixes,
  setApplyNomicPrefixes,
  override,
  setOverride
}: {
  embedModel: string
  setEmbedModel: (v: string) => void
  applyNomicPrefixes: boolean
  setApplyNomicPrefixes: (v: boolean) => void
  override: boolean
  setOverride: (v: boolean) => void
}) {
  const isDefault = embedModel === EMBED_MODEL_DEFAULT
  return (
    <>
      <WizardPaneHeader
        title="Embedding model"
        subtitle="A small model that turns your logs into searchable vectors. The default is fine for everyone."
      />
      <div className="wizard-cards">
        <RadioCard
          on={!override && isDefault}
          onClick={() => {
            setOverride(false)
            setEmbedModel(EMBED_MODEL_DEFAULT)
            setApplyNomicPrefixes(true)
          }}
          testId="ai-setup-embed-default"
          title="Recommended"
          model={EMBED_MODEL_DEFAULT}
          subtitle="274 MB · used to index logs · nomic prefixes auto-applied."
        />
      </div>
      <details
        className="wizard-disclosure"
        open={override}
        onToggle={(e) =>
          setOverride((e.target as HTMLDetailsElement).open)
        }
      >
        <summary>Use a different embedding model</summary>
        <p className="settings-help">
          If your model isn't the nomic family, untick the prefix toggle
          below — BGE / e5 / Voyage / Gemini all ignore prefixes.
        </p>
        <input
          type="text"
          className="settings-input"
          value={embedModel}
          onChange={(e) => setEmbedModel(e.target.value)}
          data-testid="ai-setup-embed-model-input"
        />
        <label className="settings-checkbox-row" style={{ marginTop: 10 }}>
          <input
            type="checkbox"
            checked={applyNomicPrefixes}
            onChange={(e) => setApplyNomicPrefixes(e.target.checked)}
            data-testid="ai-setup-embed-nomic-prefix"
          />
          <span>
            <strong>Apply nomic task prefixes</strong>
            <span className="settings-meta">
              Required for <code>nomic-embed-text-*</code> models; harmless to
              tick for other models if you're unsure.
            </span>
          </span>
        </label>
      </details>
    </>
  )
}

// ---- Page 5: Download --------------------------------------------------

function DownloadPage({
  chatModel,
  embedModel,
  chatState,
  setChatState,
  embedState,
  setEmbedState,
  abortRef
}: {
  chatModel: string
  embedModel: string
  chatState: DownloadState
  setChatState: React.Dispatch<React.SetStateAction<DownloadState>>
  embedState: DownloadState
  setEmbedState: React.Dispatch<React.SetStateAction<DownloadState>>
  abortRef: React.MutableRefObject<AbortController | null>
}) {
  const startedRef = useRef(false)

  const pull = async (
    name: string,
    setState: React.Dispatch<React.SetStateAction<DownloadState>>
  ): Promise<'done' | 'cancelled' | 'error'> => {
    setState({ ...initialDownload(), status: 'pulling-manifest', phase: 'pulling manifest' })
    const controller = new AbortController()
    abortRef.current = controller
    // Local sample window for rate/ETA derivation. We don't trust
    // Ollama to report a rate.
    const samples: Array<{ t: number; bytes: number }> = []
    let outcome: 'done' | 'cancelled' | 'error' = 'error'
    try {
      await api.systemOllamaPull(
        name,
        {
          onProgress: (p) => {
            // Mutate the sample window OUTSIDE setState — StrictMode
            // invokes the updater twice in dev, which would otherwise
            // double-push every sample and corrupt the rate.
            const s = p.status.toLowerCase()
            let mappedStatus: DownloadState['status'] = 'downloading'
            if (s.startsWith('pulling manifest')) mappedStatus = 'pulling-manifest'
            else if (s.startsWith('downloading') || s.startsWith('pulling ')) mappedStatus = 'downloading'
            else if (s.startsWith('verifying')) mappedStatus = 'verifying'
            else if (s.startsWith('writing')) mappedStatus = 'writing'
            let nextRate: number | null = null
            let nextEta: number | null = null
            if (
              mappedStatus === 'downloading' &&
              p.completed !== null &&
              p.completed !== undefined
            ) {
              const now = performance.now() / 1000
              samples.push({ t: now, bytes: p.completed })
              if (samples.length > 5) samples.shift()
              if (samples.length >= 2 && p.total) {
                const head = samples[0]
                const tail = samples[samples.length - 1]
                const dt = tail.t - head.t
                const db = tail.bytes - head.bytes
                if (dt > 0 && db > 0) {
                  nextRate = db / dt
                  const remaining = p.total - tail.bytes
                  nextEta = remaining > 0 ? remaining / nextRate : 0
                }
              }
            }
            setState((prev) => ({
              ...prev,
              status: mappedStatus,
              phase: p.status,
              bytes: p.completed ?? prev.bytes,
              total: p.total ?? prev.total,
              rate: nextRate ?? prev.rate,
              eta_sec: nextEta ?? prev.eta_sec
            }))
          },
          onDone: () => {
            // If we never saw a `total`, treat as already-present (dedupe path).
            setState((prev) => ({
              ...prev,
              status: prev.total === null ? 'already-present' : 'success',
              phase: prev.total === null ? 'already pulled' : 'success'
            }))
            outcome = 'done'
          },
          onError: (info) => {
            setState((prev) => ({
              ...prev,
              status: 'error',
              error: info.message
            }))
            outcome = 'error'
          }
        },
        { signal: controller.signal }
      )
    } catch (err) {
      // AbortError when the user cancels — distinguish from real errors.
      const isAbort =
        err instanceof DOMException && err.name === 'AbortError'
      if (isAbort) {
        setState((prev) => ({ ...prev, status: 'cancelled' }))
        outcome = 'cancelled'
      } else {
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: err instanceof Error ? err.message : String(err)
        }))
        outcome = 'error'
      }
    } finally {
      abortRef.current = null
    }
    return outcome
  }

  // Kick off both pulls sequentially when this page mounts. Refs guard
  // re-runs (StrictMode double-effect, parent re-renders).
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void (async () => {
      const chatOutcome = await pull(chatModel, setChatState)
      if (chatOutcome === 'done') {
        await pull(embedModel, setEmbedState)
      } else {
        // Chat didn't finish — flip embed from `queued` to `cancelled`
        // so the row offers a Resume button instead of sitting silent.
        // The user retries embed independently (or retries chat first
        // and the boot loop resumes the chain).
        setEmbedState((prev) =>
          prev.status === 'queued' ? { ...prev, status: 'cancelled' } : prev
        )
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cancelActive = () => {
    abortRef.current?.abort()
  }
  const retryChat = () => {
    // Guard against starting a second pull while one is in flight —
    // abortRef being non-null means there's an active fetch that owns
    // the shared controller; we shouldn't overwrite it.
    if (abortRef.current !== null) return
    void (async () => {
      const out = await pull(chatModel, setChatState)
      if (
        out === 'done' &&
        embedState.status !== 'success' &&
        embedState.status !== 'already-present'
      ) {
        await pull(embedModel, setEmbedState)
      }
    })()
  }
  const retryEmbed = () => {
    if (abortRef.current !== null) return
    void pull(embedModel, setEmbedState)
  }

  const isActive =
    chatState.status === 'pulling-manifest' ||
    chatState.status === 'downloading' ||
    chatState.status === 'verifying' ||
    chatState.status === 'writing' ||
    embedState.status === 'pulling-manifest' ||
    embedState.status === 'downloading' ||
    embedState.status === 'verifying' ||
    embedState.status === 'writing'

  return (
    <>
      <WizardPaneHeader
        title="Downloading models"
        subtitle="Sequential — chat model first, then embedding. Partial downloads resume if cancelled."
      />
      <DownloadRow
        label="Chat model"
        model={chatModel}
        state={chatState}
        onRetry={retryChat}
        barTestId="ai-setup-download-chat-bar"
        statusTestId="ai-setup-download-chat-status"
      />
      <DownloadRow
        label="Embedding model"
        model={embedModel}
        state={embedState}
        onRetry={retryEmbed}
        barTestId="ai-setup-download-embed-bar"
        statusTestId="ai-setup-download-embed-status"
      />
      <p className="settings-meta">
        A small reranker model (~1.1 GB) downloads automatically the first
        time you chat — expect a one-time pause.
      </p>
      {isActive && (
        <div className="settings-actions">
          <button
            type="button"
            className="settings-clear"
            onClick={cancelActive}
            data-testid="ai-setup-download-cancel"
          >
            Cancel
          </button>
          <span className="settings-meta">
            Partial files stay on disk and resume on retry. To free space,
            run <code>ollama rm &lt;model&gt;</code> in a terminal.
          </span>
        </div>
      )}
    </>
  )
}

function DownloadRow({
  label,
  model,
  state,
  onRetry,
  barTestId,
  statusTestId
}: {
  label: string
  model: string
  state: DownloadState
  onRetry: () => void
  barTestId: string
  statusTestId: string
}) {
  const pct =
    state.total && state.bytes !== null
      ? Math.min(100, Math.round((state.bytes / state.total) * 100))
      : 0
  const indeterminate =
    state.status === 'pulling-manifest' ||
    state.status === 'verifying' ||
    state.status === 'writing'
  const showBar =
    state.status === 'downloading' || indeterminate
  return (
    <div className="wizard-download-row">
      <div className="wizard-download-head">
        <strong>{label}</strong>
        <code className="wizard-codeblock-inline">{model}</code>
      </div>
      {state.status === 'already-present' && (
        <p className="settings-meta" data-testid={statusTestId}>
          ✓ Already pulled · skipped (digest match)
        </p>
      )}
      {state.status === 'queued' && (
        <p className="settings-meta" data-testid={statusTestId}>
          Queued · {state.total ? `${formatBytes(state.total)}` : '—'}
        </p>
      )}
      {state.status === 'success' && (
        <p className="settings-meta wizard-success" data-testid={statusTestId}>
          ✓ Done · {state.total ? formatBytes(state.total) : ''}
        </p>
      )}
      {state.status === 'error' && (
        <>
          <p className="settings-error" data-testid={statusTestId}>
            ✕ {state.error ?? 'pull failed'}
          </p>
          <button
            type="button"
            className="settings-clear"
            onClick={onRetry}
            data-testid="ai-setup-download-resume"
          >
            Retry
          </button>
        </>
      )}
      {state.status === 'cancelled' && (
        <>
          <p className="settings-meta wizard-cancelled" data-testid={statusTestId}>
            Cancelled · {state.bytes ? `${formatBytes(state.bytes)} kept on disk` : 'nothing downloaded'}
          </p>
          <button
            type="button"
            className="settings-clear"
            onClick={onRetry}
            data-testid="ai-setup-download-resume"
          >
            Resume
          </button>
        </>
      )}
      {showBar && (
        <>
          <div
            className={`classify-progress-bar${indeterminate ? ' classify-progress-bar-indeterminate' : ''}`}
            aria-label={`${label} progress`}
            data-testid={barTestId}
          >
            <div
              className="classify-progress-fill classify-state-running"
              style={{ width: indeterminate ? '100%' : `${pct}%` }}
            />
          </div>
          <p className="settings-meta" data-testid={statusTestId}>
            {state.status === 'downloading' && state.total && state.bytes !== null ? (
              <>
                {formatBytes(state.bytes)} / {formatBytes(state.total)} ({pct}%)
                {state.rate ? ` · ${formatBytes(state.rate)}/s` : ''}
                {state.eta_sec ? ` · ETA ${formatDuration(state.eta_sec)}` : ''}
              </>
            ) : (
              <>{state.phase || state.status}</>
            )}
          </p>
        </>
      )}
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec - m * 60)
  return `${m}m ${s}s`
}

// ---- Page 6: Done ------------------------------------------------------

function DonePage({
  chatModel,
  embedModel,
  envApplied,
  applyNomicPrefixes,
  chatState,
  embedState,
  onClose
}: {
  chatModel: string
  embedModel: string
  envApplied: boolean
  applyNomicPrefixes: boolean
  chatState: DownloadState
  embedState: DownloadState
  onClose: () => void
}) {
  const [saveStatus, setSaveStatus] = useState<'saving' | 'ok' | 'err'>('saving')
  const [saveError, setSaveError] = useState<string | null>(null)
  const openIngest = useStore((s) => s.openIngest)

  // Persist settings exactly once on first render. The Done page is
  // the wizard's commit point — by the time the user sees it,
  // downloads are settled and choices should reflect in settings even
  // if they X-close right after. Deps are intentionally `[]` (commit
  // = mount); the inputs are stable across the page's lifetime.
  const savedRef = useRef(false)
  const doSave = async () => {
    setSaveStatus('saving')
    setSaveError(null)
    try {
      await api.settingsUpdate({
        labels: {
          llm_endpoint: OLLAMA_OPENAI_ENDPOINT,
          llm_model: chatModel
        },
        rag: {
          chat_endpoint: OLLAMA_OPENAI_ENDPOINT,
          chat_model: chatModel,
          embed_endpoint: OLLAMA_OPENAI_ENDPOINT,
          embed_model: embedModel,
          embed_query_prefix: applyNomicPrefixes ? NOMIC_QUERY_PREFIX : '',
          embed_document_prefix: applyNomicPrefixes ? NOMIC_DOCUMENT_PREFIX : ''
        }
      })
      setSaveStatus('ok')
    } catch (err) {
      setSaveStatus('err')
      setSaveError(err instanceof Error ? err.message : String(err))
    }
  }
  useEffect(() => {
    if (savedRef.current) return
    savedRef.current = true
    void doSave()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const chatOk =
    chatState.status === 'success' || chatState.status === 'already-present'
  const embedOk =
    embedState.status === 'success' || embedState.status === 'already-present'

  return (
    <>
      <WizardPaneHeader
        title={chatOk && embedOk ? "You're set up." : 'Setup finished with issues'}
        subtitle={
          chatOk && embedOk
            ? 'Models pulled, settings saved. Next step: build the searchable index.'
            : "Some models didn't finish pulling. Open Settings to retry manually, or rerun this wizard."
        }
      />
      <div className="wizard-summary" data-testid="ai-setup-finish-summary">
        <SummaryRow label="Chat model" value={<code>{chatModel}</code>} ok={chatOk} />
        <SummaryRow
          label="Embedding model"
          value={
            <>
              <code>{embedModel}</code>
              {applyNomicPrefixes && (
                <span className="settings-meta"> · nomic prefixes applied</span>
              )}
            </>
          }
          ok={embedOk}
        />
        <SummaryRow
          label="Endpoints"
          value={<code>{OLLAMA_OPENAI_ENDPOINT}</code>}
          ok={true}
        />
        <SummaryRow
          label="Tuning"
          value={
            envApplied
              ? 'applied — restart Ollama if you haven\'t already'
              : 'skipped — set in System Properties → Environment Variables later'
          }
          ok={true}
        />
        <SummaryRow
          label="Reranker"
          value="downloads on first chat (~1.1 GB, one-time)"
          ok={true}
        />
      </div>
      {saveStatus === 'err' && (
        <>
          <p
            className="settings-error"
            data-testid="ai-setup-finish-save-status"
          >
            Couldn't write settings: {saveError}.
          </p>
          <div className="settings-actions">
            <button
              type="button"
              className="settings-pick"
              onClick={() => void doSave()}
              data-testid="ai-setup-finish-save-retry"
            >
              Retry save
            </button>
          </div>
        </>
      )}
      <div className="settings-actions">
        <button
          type="button"
          className="settings-save"
          onClick={() => {
            openIngest({}, 'All characters, all partners')
            onClose()
          }}
          disabled={!chatOk || !embedOk || saveStatus !== 'ok'}
          data-testid="ai-setup-finish-ingest"
        >
          Ingest all characters
        </button>
        <button
          type="button"
          className="settings-clear"
          onClick={() => {
            window.workbench?.openSettings?.()
            onClose()
          }}
          data-testid="ai-setup-finish-open-settings"
        >
          Open Settings
        </button>
      </div>
    </>
  )
}

function SummaryRow({
  label,
  value,
  ok
}: {
  label: string
  value: React.ReactNode
  ok: boolean
}) {
  return (
    <div className="wizard-summary-row">
      <span className="wizard-summary-label">
        <span className={`wizard-summary-mark${ok ? '' : ' fail'}`} aria-hidden>
          {ok ? '✓' : '✕'}
        </span>
        {label}
      </span>
      <span className="wizard-summary-value">{value}</span>
    </div>
  )
}

// ---- Footer Next-button logic ------------------------------------------

function WizardNextButton({
  page,
  choice,
  chatModel,
  embedModel,
  envApplied,
  envSkipped,
  ollamaOk,
  onNext
}: {
  page: Page
  choice: Choice
  chatModel: string
  embedModel: string
  envApplied: boolean
  envSkipped: boolean
  ollamaOk: boolean
  onNext: () => void
}) {
  // Next is enabled by default; per-page rules below.
  let enabled = true
  let label = 'Next →'
  if (page === 'ollama') {
    // Stay disabled until the detection probe says Ollama is reachable.
    // The user has to press Continue themselves — testers found the
    // previous 1.5 s auto-advance disorienting (the screen jumped before
    // they'd registered what was detected).
    enabled = ollamaOk
    label = 'Continue →'
  }
  if (page === 'gpu') {
    enabled = chatModel.length > 0
    label = `Use ${choice === '24gb' ? '24 GB+ model' : choice === '12gb' ? '12 GB model' : 'custom model'} →`
  }
  if (page === 'env') {
    enabled = envApplied || envSkipped
    label = 'Next →'
  }
  if (page === 'embed') {
    enabled = embedModel.length > 0
    label = 'Start downloads →'
  }
  return (
    <button
      type="button"
      className="settings-save"
      onClick={onNext}
      disabled={!enabled}
      data-testid="ai-setup-next"
    >
      {label}
    </button>
  )
}

function WizardDownloadNextButton({
  chatState,
  embedState,
  onNext
}: {
  chatState: DownloadState
  embedState: DownloadState
  onNext: () => void
}) {
  const chatTerminal =
    chatState.status === 'success' ||
    chatState.status === 'already-present' ||
    chatState.status === 'error' ||
    chatState.status === 'cancelled'
  const embedTerminal =
    embedState.status === 'success' ||
    embedState.status === 'already-present' ||
    embedState.status === 'error' ||
    embedState.status === 'cancelled'
  return (
    <button
      type="button"
      className="settings-save"
      onClick={onNext}
      disabled={!chatTerminal || !embedTerminal}
      data-testid="ai-setup-next"
    >
      Finish →
    </button>
  )
}

function WizardPaneHeader({
  title,
  subtitle
}: {
  title: string
  subtitle: string
}) {
  return (
    <header className="wizard-pane-head">
      <h3 className="wizard-pane-title">{title}</h3>
      <p className="wizard-pane-subtitle">{subtitle}</p>
    </header>
  )
}
