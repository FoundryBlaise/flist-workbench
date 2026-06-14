import { useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  type LabelsSettings,
  type PromptPreset,
  type RagSettings,
  type RagStatus
} from '../../lib/api'
import {
  categoriseEndpoint,
  isRemoteEndpointAcknowledged,
  acknowledgeRemoteEndpoint
} from '../../lib/endpoint'
import { useStore } from '../../state'

type SettingsState = Awaited<ReturnType<typeof api.settingsGet>>

// Endpoint presets used everywhere a URL field is offered. The first
// entry is what most users want — LM Studio running on the Windows
// host, reachable from the dev container via host.docker.internal
// (see CLAUDE.md). Falls back to localhost-shaped URLs for users who
// run LM Studio / Ollama on the same machine the app runs on.
const ENDPOINT_PRESETS = [
  { label: 'LM Studio (host)', url: 'http://host.docker.internal:1234/v1' },
  { label: 'LM Studio', url: 'http://localhost:1234/v1' },
  { label: 'Ollama', url: 'http://localhost:11434/v1' },
  { label: 'OpenAI', url: 'https://api.openai.com/v1' }
]

// Reranker dropdown options — fastembed's TextCrossEncoder list plus
// a "disabled" sentinel the sidecar honours.
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

// Nomic-family embed models need these task prefixes; one-click apply
// keeps the magic strings out of user-facing copy.
const NOMIC_QUERY_PREFIX = 'search_query: '
const NOMIC_DOCUMENT_PREFIX = 'search_document: '

type SectionId = 'general' | 'flist' | 'labels' | 'chat' | 'embedding' | 'security'

const SECTION_ORDER: ReadonlyArray<{ id: SectionId; label: string; subtitle: string }> = [
  { id: 'general', label: 'General', subtitle: 'Data directory + index status' },
  { id: 'flist', label: 'F-list', subtitle: 'Sign-in refresh + snapshot behaviour' },
  { id: 'labels', label: 'Labels', subtitle: 'IC / OOC classifier' },
  { id: 'chat', label: 'RAG · Chat', subtitle: 'Question-answering model + retrieval' },
  { id: 'embedding', label: 'RAG · Embedding', subtitle: 'Index shape (requires re-ingest)' },
  { id: 'security', label: 'Security', subtitle: 'Browser-extension pairing' }
]

/** Whether the sign-in auto-refresh sweep runs at all. Default off — the
 *  sweep hammers the F-list API once per account character, which is
 *  rude when the user only wanted to open the app to edit one. Off by
 *  default means sign-in just loads roster metadata; characters get
 *  pulled lazily on selection (30-min cache) or via the picker's
 *  "↻ Refresh all" button. */
export const FLIST_AUTO_REFRESH_ENABLED_KEY = 'workbench.flistAutoRefreshEnabled'

/** Threshold for the sign-in sweep, in hours. Floored to 24 to be kind
 *  to the F-list API — anything faster is what the manual button is for. */
export const FLIST_AUTO_REFRESH_HOURS_KEY = 'workbench.flistAutoRefreshHours'

export const FLIST_AUTO_REFRESH_MIN_HOURS = 24
export const FLIST_AUTO_REFRESH_DEFAULT_HOURS = 24

export function readAutoRefreshEnabled(): boolean {
  try {
    return localStorage.getItem(FLIST_AUTO_REFRESH_ENABLED_KEY) === 'true'
  } catch {
    return false
  }
}

export function readAutoRefreshHours(): number {
  try {
    const raw = localStorage.getItem(FLIST_AUTO_REFRESH_HOURS_KEY)
    if (raw === null) return FLIST_AUTO_REFRESH_DEFAULT_HOURS
    const n = Number(raw)
    if (!Number.isFinite(n)) return FLIST_AUTO_REFRESH_DEFAULT_HOURS
    return Math.max(FLIST_AUTO_REFRESH_MIN_HOURS, Math.floor(n))
  } catch {
    return FLIST_AUTO_REFRESH_DEFAULT_HOURS
  }
}

// Local working copy of every editable field, kept alongside the
// loaded snapshot so we can compute per-section dirty state in O(fields).
type Draft = {
  fchat_data_dir: string
  labels: {
    threshold_chars: string
    llm_endpoint: string
    llm_model: string
    llm_api_key: string
    system_prompt: string
    context_before: string
    context_after: string
  }
  rag: {
    embed_endpoint: string
    embed_model: string
    embed_api_key: string
    embed_query_prefix: string
    embed_document_prefix: string
    chat_endpoint: string
    chat_model: string
    chat_api_key: string
    chat_system_prompt: string
    top_k: string
    rerank_candidates: string
    neighbors: string
    rerank_model: string
    // Quality / fusion knobs. Booleans live alongside the rest of the
    // draft as strings ('1' / '0') for symmetry with the rest of the
    // form — saveAll re-parses to bool when posting to the sidecar.
    rerank_min_ratio: string
    hybrid_enabled: boolean
    hybrid_bm25_candidates: string
    multiquery_enabled: boolean
    multiquery_variants: string
    chat_num_ctx: string
    chat_embed_keep_alive: string
    chunk_max_chars: string
    chunk_soft_split_chars: string
    chunk_overlap_msgs: string
  }
}

function buildDraft(state: SettingsState): Draft {
  return {
    fchat_data_dir: state.fchat_data_dir ?? '',
    labels: {
      threshold_chars: String(state.labels.threshold_chars),
      llm_endpoint: state.labels.llm_endpoint,
      llm_model: state.labels.llm_model,
      llm_api_key: state.labels.llm_api_key,
      system_prompt: state.labels.system_prompt,
      context_before: String(state.labels.context_before),
      context_after: String(state.labels.context_after)
    },
    rag: {
      embed_endpoint: state.rag.embed_endpoint,
      embed_model: state.rag.embed_model,
      embed_api_key: state.rag.embed_api_key,
      embed_query_prefix: state.rag.embed_query_prefix,
      embed_document_prefix: state.rag.embed_document_prefix,
      chat_endpoint: state.rag.chat_endpoint,
      chat_model: state.rag.chat_model,
      chat_api_key: state.rag.chat_api_key,
      chat_system_prompt: state.rag.chat_system_prompt,
      top_k: String(state.rag.top_k),
      rerank_candidates: String(state.rag.rerank_candidates),
      neighbors: String(state.rag.neighbors),
      rerank_model: state.rag.rerank_model,
      rerank_min_ratio: String(state.rag.rerank_min_ratio),
      hybrid_enabled: state.rag.hybrid_enabled,
      hybrid_bm25_candidates: String(state.rag.hybrid_bm25_candidates),
      multiquery_enabled: state.rag.multiquery_enabled,
      multiquery_variants: String(state.rag.multiquery_variants),
      chat_num_ctx: String(state.rag.chat_num_ctx),
      chat_embed_keep_alive: state.rag.chat_embed_keep_alive,
      chunk_max_chars: String(state.rag.chunk_max_chars),
      chunk_soft_split_chars: String(state.rag.chunk_soft_split_chars),
      chunk_overlap_msgs: String(state.rag.chunk_overlap_msgs)
    }
  }
}

// Diff each section vs. its baseline to drive the rail dirty dots.
// Strings everywhere → cheap === comparison; we don't need deep-equal
// helpers for nested objects.
function dirtySections(draft: Draft, baseline: Draft): Record<SectionId, boolean> {
  const generalDirty = draft.fchat_data_dir.trim() !== baseline.fchat_data_dir.trim()
  const labelsDirty =
    draft.labels.threshold_chars !== baseline.labels.threshold_chars ||
    draft.labels.llm_endpoint !== baseline.labels.llm_endpoint ||
    draft.labels.llm_model !== baseline.labels.llm_model ||
    draft.labels.llm_api_key !== baseline.labels.llm_api_key ||
    draft.labels.system_prompt !== baseline.labels.system_prompt ||
    draft.labels.context_before !== baseline.labels.context_before ||
    draft.labels.context_after !== baseline.labels.context_after
  const chatDirty =
    draft.rag.chat_endpoint !== baseline.rag.chat_endpoint ||
    draft.rag.chat_model !== baseline.rag.chat_model ||
    draft.rag.chat_api_key !== baseline.rag.chat_api_key ||
    draft.rag.chat_system_prompt !== baseline.rag.chat_system_prompt ||
    draft.rag.top_k !== baseline.rag.top_k ||
    draft.rag.rerank_candidates !== baseline.rag.rerank_candidates ||
    draft.rag.neighbors !== baseline.rag.neighbors ||
    draft.rag.rerank_model !== baseline.rag.rerank_model ||
    draft.rag.rerank_min_ratio !== baseline.rag.rerank_min_ratio ||
    draft.rag.hybrid_enabled !== baseline.rag.hybrid_enabled ||
    draft.rag.hybrid_bm25_candidates !== baseline.rag.hybrid_bm25_candidates ||
    draft.rag.multiquery_enabled !== baseline.rag.multiquery_enabled ||
    draft.rag.multiquery_variants !== baseline.rag.multiquery_variants ||
    draft.rag.chat_num_ctx !== baseline.rag.chat_num_ctx
  const embeddingDirty =
    draft.rag.embed_endpoint !== baseline.rag.embed_endpoint ||
    draft.rag.embed_model !== baseline.rag.embed_model ||
    draft.rag.embed_api_key !== baseline.rag.embed_api_key ||
    draft.rag.embed_query_prefix !== baseline.rag.embed_query_prefix ||
    draft.rag.embed_document_prefix !== baseline.rag.embed_document_prefix ||
    draft.rag.chat_embed_keep_alive !== baseline.rag.chat_embed_keep_alive ||
    draft.rag.chunk_max_chars !== baseline.rag.chunk_max_chars ||
    draft.rag.chunk_soft_split_chars !== baseline.rag.chunk_soft_split_chars ||
    draft.rag.chunk_overlap_msgs !== baseline.rag.chunk_overlap_msgs
  return {
    general: generalDirty,
    flist: false,
    labels: labelsDirty,
    chat: chatDirty,
    embedding: embeddingDirty,
    security: false
  }
}

function anyDirty(d: Record<SectionId, boolean>): boolean {
  return d.general || d.labels || d.chat || d.embedding
}

const clampInt = (s: string, lo: number, hi: number, fallback: number): number => {
  const n = Math.floor(Number(s))
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, n))
}

const clampFloat = (s: string, lo: number, hi: number, fallback: number): number => {
  const n = Number(s)
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, n))
}

// Per-endpoint discover-button cache, scoped to a single SettingsModal
// lifetime. Cleared on close so a re-opened modal re-queries against
// the (possibly now-running) inference server. ModelField looks up
// `endpoint.trim()` here before issuing the network call.
const discoverCache = new Map<
  string,
  { models: string[]; error: string | null }
>()

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const loadCharacters = useStore((s) => s.loadCharacters)
  const [state, setState] = useState<SettingsState | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [activeSection, setActiveSection] = useState<SectionId>('general')
  const [status, setStatus] = useState<'idle' | 'loading' | 'saving' | 'error'>(
    'loading'
  )
  const [saveError, setSaveError] = useState<string | null>(null)
  const firstFieldRef = useRef<HTMLInputElement | null>(null)
  const focusedOnceRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    api
      .settingsGet()
      .then((s) => {
        if (cancelled) return
        setState(s)
        setDraft(buildDraft(s))
        setStatus('idle')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setSaveError(err instanceof Error ? err.message : String(err))
        setStatus('error')
      })
    return () => {
      cancelled = true
      // Drop the discover cache on close so re-opening Settings
      // re-queries — important after the user (typically) tabs over to
      // LM Studio / Ollama to fix what the empty list told them about.
      discoverCache.clear()
    }
  }, [])

  const baseline = useMemo(() => (state ? buildDraft(state) : null), [state])
  const dirtyByDraft = useMemo(
    () => (draft && baseline ? dirtySections(draft, baseline) : null),
    [draft, baseline]
  )

  const tryClose = () => {
    if (dirtyByDraft && anyDirty(dirtyByDraft)) {
      const ok = window.confirm(
        'You have unsaved changes. Close without saving?'
      )
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
  }, [dirtyByDraft])

  // Wait until settings have loaded (and the General pane has therefore
  // rendered its inputs) before trying to focus — running this on
  // mount alone misses, the input isn't in the DOM yet. One-shot via a
  // ref so save-and-stay-on-the-modal doesn't yank focus back to the
  // dir input every time settings round-trip.
  useEffect(() => {
    if (focusedOnceRef.current || status !== 'idle' || !draft) return
    focusedOnceRef.current = true
    const id = requestAnimationFrame(() => firstFieldRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [status, draft])

  // When true, edits to ANY endpoint field (labels.llm_endpoint /
  // rag.chat_endpoint / rag.embed_endpoint) propagate to all three.
  // Persisted in localStorage because this is a UI-mode preference,
  // not a server-side setting — no sidecar round-trip needed.
  const [mirrorEndpoints, setMirrorEndpoints] = useState<boolean>(() => {
    try {
      return localStorage.getItem('workbench.mirrorEndpoints') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(
        'workbench.mirrorEndpoints',
        mirrorEndpoints ? '1' : '0'
      )
    } catch {
      // Storage may be unavailable in private mode; toggle still works
      // in-session.
    }
  }, [mirrorEndpoints])

  const updateLabels = (patch: Partial<Draft['labels']>) =>
    setDraft((d) => {
      if (!d) return d
      const next = { ...d, labels: { ...d.labels, ...patch } }
      if (mirrorEndpoints && 'llm_endpoint' in patch && patch.llm_endpoint !== undefined) {
        next.rag = {
          ...next.rag,
          chat_endpoint: patch.llm_endpoint,
          embed_endpoint: patch.llm_endpoint
        }
      }
      return next
    })
  const updateRag = (patch: Partial<Draft['rag']>) =>
    setDraft((d) => {
      if (!d) return d
      const next = { ...d, rag: { ...d.rag, ...patch } }
      if (mirrorEndpoints) {
        const v =
          'chat_endpoint' in patch && patch.chat_endpoint !== undefined
            ? patch.chat_endpoint
            : 'embed_endpoint' in patch && patch.embed_endpoint !== undefined
              ? patch.embed_endpoint
              : null
        if (v !== null) {
          next.rag = {
            ...next.rag,
            chat_endpoint: v,
            embed_endpoint: v
          }
          next.labels = { ...next.labels, llm_endpoint: v }
        }
      }
      return next
    })
  const updateGeneral = (patch: Partial<Pick<Draft, 'fchat_data_dir'>>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d))

  const saveAll = async () => {
    if (!state || !draft || !dirtyByDraft) return
    // First-save consent for remote endpoints. A user typing
    // api.openai.com into any endpoint field is about to ship their
    // RP chunks to a third party — gate Save behind an explicit
    // confirm the first time per host, then remember the
    // acknowledgement so we don't nag on every Save.
    const candidateEndpoints: string[] = []
    if (dirtyByDraft.labels) candidateEndpoints.push(draft.labels.llm_endpoint)
    if (dirtyByDraft.chat) candidateEndpoints.push(draft.rag.chat_endpoint)
    if (dirtyByDraft.embedding) candidateEndpoints.push(draft.rag.embed_endpoint)
    const unconsented = candidateEndpoints.filter(
      (ep) =>
        categoriseEndpoint(ep) === 'remote'
        && !isRemoteEndpointAcknowledged(ep)
    )
    if (unconsented.length > 0) {
      const hosts = unconsented
        .map((ep) => {
          try {
            return new URL(ep).host
          } catch {
            return ep
          }
        })
        .join(', ')
      const ok = window.confirm(
        `Workbench is about to save an external endpoint:\n\n  ${hosts}\n\n`
          + 'Messages, retrieved log chunks, and any prompt text will be '
          + 'sent to this host. Continue?'
      )
      if (!ok) return
      for (const ep of unconsented) acknowledgeRemoteEndpoint(ep)
    }
    setStatus('saving')
    setSaveError(null)
    // Validate Labels threshold up-front — non-finite or zero would
    // be silently coerced by the sidecar to its default, which is
    // user-hostile. Other numerics are clamped here so out-of-range
    // typos resolve to sensible values.
    const parsedThreshold = Number(draft.labels.threshold_chars)
    if (!Number.isFinite(parsedThreshold) || parsedThreshold < 1) {
      setSaveError('Threshold must be a positive integer.')
      setStatus('error')
      setActiveSection('labels')
      return
    }
    try {
      const payload: Parameters<typeof api.settingsUpdate>[0] = {}
      if (dirtyByDraft.general) {
        payload.fchat_data_dir = draft.fchat_data_dir.trim() || null
      }
      if (dirtyByDraft.labels) {
        payload.labels = {
          threshold_chars: Math.floor(parsedThreshold),
          llm_endpoint: draft.labels.llm_endpoint,
          llm_model: draft.labels.llm_model,
          llm_api_key: draft.labels.llm_api_key,
          system_prompt: draft.labels.system_prompt,
          context_before: clampInt(
            draft.labels.context_before,
            0,
            10,
            state.labels.context_before
          ),
          context_after: clampInt(
            draft.labels.context_after,
            0,
            10,
            state.labels.context_after
          )
        }
      }
      if (dirtyByDraft.chat || dirtyByDraft.embedding) {
        const nextChunkMax = clampInt(
          draft.rag.chunk_max_chars,
          500,
          20000,
          state.rag.chunk_max_chars
        )
        payload.rag = {
          embed_endpoint: draft.rag.embed_endpoint,
          embed_model: draft.rag.embed_model,
          embed_api_key: draft.rag.embed_api_key,
          embed_query_prefix: draft.rag.embed_query_prefix,
          embed_document_prefix: draft.rag.embed_document_prefix,
          chat_endpoint: draft.rag.chat_endpoint,
          chat_model: draft.rag.chat_model,
          chat_api_key: draft.rag.chat_api_key,
          chat_system_prompt: draft.rag.chat_system_prompt,
          rerank_model: draft.rag.rerank_model,
          rerank_candidates: clampInt(
            draft.rag.rerank_candidates,
            1,
            200,
            state.rag.rerank_candidates
          ),
          top_k: clampInt(draft.rag.top_k, 1, 50, state.rag.top_k),
          neighbors: clampInt(draft.rag.neighbors, 0, 5, state.rag.neighbors),
          rerank_min_ratio: clampFloat(
            draft.rag.rerank_min_ratio,
            0,
            1,
            state.rag.rerank_min_ratio
          ),
          hybrid_enabled: draft.rag.hybrid_enabled,
          hybrid_bm25_candidates: clampInt(
            draft.rag.hybrid_bm25_candidates,
            1,
            200,
            state.rag.hybrid_bm25_candidates
          ),
          multiquery_enabled: draft.rag.multiquery_enabled,
          multiquery_variants: clampInt(
            draft.rag.multiquery_variants,
            2,
            5,
            state.rag.multiquery_variants
          ),
          chat_num_ctx: clampInt(
            draft.rag.chat_num_ctx,
            0,
            131072,
            state.rag.chat_num_ctx
          ),
          chat_embed_keep_alive: draft.rag.chat_embed_keep_alive.trim().slice(0, 32),
          chunk_max_chars: nextChunkMax,
          chunk_soft_split_chars: clampInt(
            draft.rag.chunk_soft_split_chars,
            400,
            Math.max(500, nextChunkMax - 100),
            state.rag.chunk_soft_split_chars
          ),
          chunk_overlap_msgs: clampInt(
            draft.rag.chunk_overlap_msgs,
            0,
            5,
            state.rag.chunk_overlap_msgs
          )
        }
      }
      const updated = await api.settingsUpdate(payload)
      setState(updated)
      setDraft(buildDraft(updated))
      setStatus('idle')
      if (dirtyByDraft.general) {
        // Refresh the sidebar so the new directory's characters appear.
        await loadCharacters()
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  const discardAll = () => {
    if (!state) return
    setDraft(buildDraft(state))
    setSaveError(null)
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal settings-modal settings-modal-rail">
        <header className="modal-head">
          <div>
            <h2 className="modal-title">Settings</h2>
            <p className="modal-subtitle">F-Chat data, label classifier, RAG.</p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={tryClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="settings-shell">
          <nav className="settings-rail" aria-label="Settings sections">
            {SECTION_ORDER.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`settings-rail-item${
                  activeSection === s.id ? ' on' : ''
                }`}
                onClick={() => setActiveSection(s.id)}
                data-testid={`settings-rail-${s.id}`}
              >
                <span className="settings-rail-label">{s.label}</span>
                <span className="settings-rail-sub">{s.subtitle}</span>
                {dirtyByDraft && dirtyByDraft[s.id] && (
                  <span
                    className="settings-rail-dirty"
                    aria-label="Unsaved changes"
                    title="Unsaved changes in this section"
                  />
                )}
              </button>
            ))}
          </nav>
          <div className="settings-pane">
            {status === 'loading' && (
              <p className="settings-help">Loading settings…</p>
            )}
            {state && draft && (
              <>
                {activeSection === 'general' && (
                  <GeneralPane
                    state={state}
                    draft={draft}
                    onChange={updateGeneral}
                    firstFieldRef={firstFieldRef}
                    mirrorEndpoints={mirrorEndpoints}
                    onMirrorEndpointsChange={setMirrorEndpoints}
                  />
                )}
                {activeSection === 'flist' && <FlistPane />}
                {activeSection === 'labels' && (
                  <LabelsPane
                    labels={state.labels}
                    draft={draft.labels}
                    onChange={updateLabels}
                  />
                )}
                {activeSection === 'chat' && (
                  <ChatPane
                    rag={state.rag}
                    draft={draft.rag}
                    onChange={updateRag}
                  />
                )}
                {activeSection === 'embedding' && (
                  <EmbeddingPane
                    rag={state.rag}
                    draft={draft.rag}
                    onChange={updateRag}
                  />
                )}
                {activeSection === 'security' && <SecurityPane />}
              </>
            )}
          </div>
        </div>
        <footer className="settings-footer">
          {saveError && <span className="settings-error">{saveError}</span>}
          <span className="settings-footer-spacer" />
          <button
            type="button"
            className="settings-clear"
            onClick={discardAll}
            disabled={
              status === 'saving' || !dirtyByDraft || !anyDirty(dirtyByDraft)
            }
            data-testid="settings-discard"
          >
            Discard
          </button>
          <button
            type="button"
            className="settings-save"
            onClick={() => void saveAll()}
            disabled={
              status === 'saving' || !dirtyByDraft || !anyDirty(dirtyByDraft)
            }
            data-testid="settings-save"
          >
            {status === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  )
}

// ---------- Reusable building blocks ------------------------------------

function EndpointField({
  id,
  value,
  defaultUrl,
  onChange,
  help,
  testId
}: {
  id: string
  value: string
  defaultUrl: string
  onChange: (v: string) => void
  help?: React.ReactNode
  testId: string
}) {
  return (
    <div className="settings-field">
      <label className="settings-label" htmlFor={id}>
        Endpoint
      </label>
      {help && <p className="settings-help">{help}</p>}
      <div className="settings-row settings-row-wrap">
        {ENDPOINT_PRESETS.map((p) => (
          <button
            key={p.url}
            type="button"
            className={`settings-preset ${value === p.url ? 'on' : ''}`}
            onClick={() => onChange(p.url)}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          className="settings-clear"
          onClick={() => onChange(defaultUrl)}
        >
          Default
        </button>
      </div>
      <input
        id={id}
        type="text"
        className="settings-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
      <EndpointCategoryBadge url={value} />
    </div>
  )
}

function EndpointCategoryBadge({ url }: { url: string }) {
  const category = categoriseEndpoint(url)
  if (category === 'unknown') return null
  if (category === 'local') {
    return (
      <div
        className="endpoint-badge endpoint-badge-local"
        data-testid="endpoint-badge-local"
      >
        ● Local — traffic stays on your machine or LAN
      </div>
    )
  }
  // remote
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    host = url
  }
  return (
    <div
      className="endpoint-badge endpoint-badge-remote"
      role="status"
      data-testid="endpoint-badge-remote"
    >
      ⚠ External endpoint — messages and log excerpts will be sent to{' '}
      <strong>{host}</strong>
    </div>
  )
}

function ApiKeyField({
  id,
  value,
  onChange,
  label,
  testId
}: {
  id: string
  value: string
  onChange: (v: string) => void
  label?: string
  testId: string
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="settings-field">
      <label className="settings-label" htmlFor={id}>
        {label ?? 'API key (blank for local LM Studio / Ollama)'}
      </label>
      <div className="settings-row">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          className="settings-input"
          value={value}
          placeholder="sk-…"
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          data-testid={testId}
        />
        <button
          type="button"
          className="settings-clear"
          onClick={() => setShow((v) => !v)}
          title={show ? 'Hide key' : 'Show key'}
        >
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  )
}

function ModelField({
  id,
  value,
  defaultValue,
  endpoint,
  onChange,
  help,
  testId
}: {
  id: string
  value: string
  defaultValue: string
  endpoint: string
  onChange: (v: string) => void
  help?: React.ReactNode
  testId: string
}) {
  // Discover is lazy — we never auto-fetch on mount. Users often open
  // Settings *because* the endpoint is broken; a hanging fetch on
  // open is the worst UX. The dropdown only appears after an explicit
  // click; an error inlines below the button so the form stays usable.
  const [discoverStatus, setDiscoverStatus] = useState<
    'idle' | 'loading' | 'ok' | 'err'
  >('idle')
  const [discovered, setDiscovered] = useState<string[]>([])
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [showList, setShowList] = useState(false)

  const discover = async () => {
    const ep = endpoint.trim()
    if (!ep) {
      setDiscoverError('Set the endpoint first.')
      setDiscoverStatus('err')
      return
    }
    // Cached result from an earlier click against the same endpoint in
    // this modal session — render it without hitting the network.
    const cached = discoverCache.get(ep)
    if (cached) {
      if (cached.models.length > 0) {
        setDiscovered(cached.models)
        setDiscoverStatus('ok')
        setShowList(true)
      } else {
        setDiscovered([])
        setDiscoverError(cached.error ?? 'no models returned')
        setDiscoverStatus('err')
        setShowList(false)
      }
      return
    }
    setDiscoverStatus('loading')
    setDiscoverError(null)
    try {
      const res = await api.discoverModels(ep)
      discoverCache.set(ep, { models: res.models, error: res.error ?? null })
      if (res.models.length === 0) {
        setDiscovered([])
        setDiscoverError(res.error ?? 'no models returned')
        setDiscoverStatus('err')
        setShowList(false)
        return
      }
      setDiscovered(res.models)
      setDiscoverStatus('ok')
      setShowList(true)
    } catch (err) {
      setDiscoverError(err instanceof Error ? err.message : String(err))
      setDiscoverStatus('err')
      setShowList(false)
    }
  }

  return (
    <div className="settings-field">
      <label className="settings-label" htmlFor={id}>
        Model
      </label>
      {help && <p className="settings-help">{help}</p>}
      <div className="settings-row">
        <input
          id={id}
          type="text"
          className="settings-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          data-testid={testId}
        />
        <button
          type="button"
          className="settings-pick"
          onClick={() => void discover()}
          disabled={discoverStatus === 'loading'}
          title="Query the endpoint above for loaded models (LM Studio / OpenAI / Ollama)"
          data-testid={`${testId}-discover`}
        >
          {discoverStatus === 'loading' ? '…' : '↻ Discover'}
        </button>
        <button
          type="button"
          className="settings-clear"
          onClick={() => onChange(defaultValue)}
        >
          Default
        </button>
      </div>
      {showList && discovered.length > 0 && (
        <div className="settings-discovered" data-testid={`${testId}-list`}>
          <p className="settings-meta">
            {discovered.length} loaded — click to fill the field
          </p>
          <ul className="settings-discovered-list">
            {discovered.map((m) => (
              <li key={m}>
                <button
                  type="button"
                  className={`settings-discovered-item${
                    m === value ? ' on' : ''
                  }`}
                  onClick={() => {
                    onChange(m)
                    setShowList(false)
                  }}
                >
                  {m}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {discoverStatus === 'err' && discoverError && (
        <p className="settings-meta classify-last-error">
          Discover failed: {discoverError}
        </p>
      )}
    </div>
  )
}

// Pill rendering shared between the Labels and Chat test rows so the
// "OK / latency / extra" surface looks identical across panes.
function TestStatusPill({
  status,
  text,
  testId
}: {
  status: 'idle' | 'running' | 'ok' | 'fail'
  text: string
  testId: string
}) {
  return (
    <span
      className={`settings-meta labels-test-result labels-test-${status}`}
      data-testid={testId}
    >
      {status === 'ok' ? '✓ ' : status === 'fail' ? '✕ ' : ''}
      {text}
    </span>
  )
}

// ---------- Section panes ------------------------------------------------

function GeneralPane({
  state,
  draft,
  onChange,
  firstFieldRef,
  mirrorEndpoints,
  onMirrorEndpointsChange
}: {
  state: SettingsState
  draft: Draft
  onChange: (patch: Partial<Pick<Draft, 'fchat_data_dir'>>) => void
  firstFieldRef: React.RefObject<HTMLInputElement>
  mirrorEndpoints: boolean
  onMirrorEndpointsChange: (v: boolean) => void
}) {
  const [indexStatus, setIndexStatus] = useState<RagStatus | null>(null)
  const envLocked = state.fchat_data_dir_env_locked

  useEffect(() => {
    let cancelled = false
    api
      .ragStatus()
      .then((s) => {
        if (!cancelled) setIndexStatus(s)
      })
      .catch(() => {
        // Best-effort; status failure shouldn't block the form.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const pick = async () => {
    const picker = window.workbench?.selectDirectory
    if (!picker) return
    const chosen = await picker({
      title: 'Pick your F-Chat data directory',
      defaultPath: draft.fchat_data_dir || state.fchat_data_dir_effective
    })
    if (chosen) onChange({ fchat_data_dir: chosen })
  }

  return (
    <>
      <PaneHeader
        title="General"
        subtitle="F-Chat data directory and one-glance index status."
      />
      <div className="settings-section">
        <div className="settings-field">
          <label className="settings-label" htmlFor="fchat-data-dir-input">
            F-Chat data directory
          </label>
          <p className="settings-help">
            F-Chat 3.0 writes each character's logs under{' '}
            <code>&lt;data&gt;/&lt;character&gt;/logs</code>. Point this at the
            parent of those character folders.
          </p>
          <div className="settings-row">
            <input
              id="fchat-data-dir-input"
              ref={firstFieldRef}
              type="text"
              className="settings-input"
              placeholder="/path/to/F-Chat/data"
              value={draft.fchat_data_dir}
              onChange={(e) => onChange({ fchat_data_dir: e.target.value })}
              disabled={envLocked}
              data-testid="settings-fchat-dir-input"
            />
            <button
              type="button"
              className="settings-pick"
              onClick={() => void pick()}
              disabled={envLocked || !window.workbench?.selectDirectory}
              data-testid="settings-fchat-dir-pick"
            >
              Browse…
            </button>
            <button
              type="button"
              className="settings-clear"
              onClick={() => onChange({ fchat_data_dir: '' })}
              disabled={envLocked || !draft.fchat_data_dir}
              title="Clear the override and fall back to the default directory"
            >
              Reset
            </button>
          </div>
          <p className="settings-meta">
            Currently reading from: <code>{state.fchat_data_dir_effective}</code>
          </p>
          {envLocked && (
            <p className="settings-note">
              <b>FCHAT_DATA_DIR</b> is set in the environment and overrides this
              setting. Unset it to control the path from here.
            </p>
          )}
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Inference endpoints</h3>
        <p className="settings-help">
          Labels, RAG chat, and embedding each have their own endpoint
          field. Most users run one LM Studio with everything loaded side
          by side — flip this on and edits to any endpoint propagate to
          all three at once.
        </p>
        <label className="settings-checkbox-row">
          <input
            type="checkbox"
            checked={mirrorEndpoints}
            onChange={(e) => onMirrorEndpointsChange(e.target.checked)}
            data-testid="settings-mirror-endpoints"
          />
          <span>
            <strong>Use one endpoint for Labels / Chat / Embedding</strong>
            <span className="settings-meta">
              Editing any endpoint field syncs the other two. Toggle off
              to set them independently.
            </span>
          </span>
        </label>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">RAG index status</h3>
        {indexStatus === null ? (
          <p className="settings-meta">Loading status…</p>
        ) : indexStatus.chunk_count > 0 ? (
          <p className="settings-meta" data-testid="rag-index-status">
            <strong>{indexStatus.chunk_count.toLocaleString()}</strong> chunks
            indexed · model <code>{indexStatus.embed_model}</code> (dim{' '}
            {indexStatus.embed_dimension})
          </p>
        ) : (
          <p className="settings-meta" data-testid="rag-index-status">
            No chunks indexed yet. Use{' '}
            <strong>Logs → Ingest All Characters (RAG)…</strong> to build the
            vector index.
          </p>
        )}
      </div>
    </>
  )
}

function FlistPane() {
  // Stored in localStorage rather than the sidecar `/settings` blob
  // because this preference only affects renderer-side timing — the
  // sidecar is stateless about login-triggered work. Persisted-on-
  // change, no Save button needed for this surface (matches the
  // mirrorEndpoints toggle pattern).
  const [enabled, setEnabled] = useState<boolean>(() => readAutoRefreshEnabled())
  const [hoursRaw, setHoursRaw] = useState<string>(() =>
    String(readAutoRefreshHours())
  )

  const persistEnabled = (next: boolean) => {
    setEnabled(next)
    try {
      localStorage.setItem(FLIST_AUTO_REFRESH_ENABLED_KEY, next ? 'true' : 'false')
    } catch {
      // localStorage unavailable — setting just won't survive a reload.
    }
  }

  const persistHours = (raw: string) => {
    setHoursRaw(raw)
    const n = Number(raw)
    if (!raw.trim() || !Number.isFinite(n)) return
    const floored = Math.max(FLIST_AUTO_REFRESH_MIN_HOURS, Math.floor(n))
    try {
      localStorage.setItem(FLIST_AUTO_REFRESH_HOURS_KEY, String(floored))
    } catch {
      // localStorage unavailable — setting just won't survive a reload.
    }
  }

  // Snap the displayed value up to the floor when the user leaves the
  // field, so typing e.g. "6" doesn't sit there looking accepted while
  // the stored value is 24.
  const onHoursBlur = () => {
    const n = Number(hoursRaw)
    if (!hoursRaw.trim() || !Number.isFinite(n)) {
      setHoursRaw(String(FLIST_AUTO_REFRESH_DEFAULT_HOURS))
      return
    }
    setHoursRaw(String(Math.max(FLIST_AUTO_REFRESH_MIN_HOURS, Math.floor(n))))
  }

  const savedCreds = useStore((s) => s.flistSavedCreds)
  const clearSavedCreds = useStore((s) => s.flistClearSavedCreds)
  const setSavedAutoLogin = useStore((s) => s.flistSetSavedAutoLogin)
  const loadSavedCreds = useStore((s) => s.flistLoadSavedCreds)
  // Re-read on pane mount so opening Settings after a sign-out (or
  // after the user toggled save-login from the modal) shows the live
  // state, not a stale in-memory mirror.
  useEffect(() => {
    void loadSavedCreds()
  }, [loadSavedCreds])

  return (
    <>
      <h3 className="settings-section-h">Saved login</h3>
      <div className="settings-row settings-row-grid">
        {savedCreds.hasPassword && savedCreds.account ? (
          <>
            <div className="settings-saved-login">
              <div>
                <strong>Account:</strong>{' '}
                <code data-testid="settings-flist-saved-account">
                  {savedCreds.account}
                </code>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void clearSavedCreds()}
                data-testid="settings-flist-remove-saved"
              >
                Remove saved login
              </button>
            </div>
            <label className="settings-checkbox-row">
              <input
                type="checkbox"
                checked={savedCreds.autoLogin}
                onChange={(e) => void setSavedAutoLogin(e.target.checked)}
                data-testid="settings-flist-auto-login"
              />
              <span>
                <strong>Auto login on next launch</strong>
              </span>
            </label>
            <p className="settings-help">
              Your password is stored in your operating system's
              credential manager (Windows Credential Manager / macOS
              Keychain / libsecret) — Workbench never writes it to a
              file. <strong>Remove saved login</strong> wipes the
              keychain entry.
            </p>
          </>
        ) : (
          <p className="settings-help" data-testid="settings-flist-no-saved">
            No saved login yet. The next time you sign in, tick{' '}
            <em>Remember password</em> on the sign-in dialog to store
            your password in the OS credential manager.
          </p>
        )}
      </div>

      <h3 className="settings-section-h">Auto-refresh on sign-in</h3>
      <div className="settings-row settings-row-grid">
        <label className="settings-checkbox-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => persistEnabled(e.target.checked)}
            data-testid="settings-flist-auto-refresh-enabled"
          />
          <span>
            <strong>Automatically refresh characters when signing in</strong>
          </span>
        </label>
        <p className="settings-help">
          Off by default. When enabled, Workbench queues a background
          pull at sign-in for every character on your account whose
          local copy is older than the threshold below. Either way you
          can hit <strong>↻ Refresh all</strong> in the character picker
          to pull everyone on demand.
        </p>
      </div>
      <div className="settings-row settings-row-grid">
        <label className="settings-label" htmlFor="flist-auto-refresh-hours">
          Re-pull every character older than
        </label>
        <div className="settings-inline-input">
          <input
            id="flist-auto-refresh-hours"
            type="number"
            min={FLIST_AUTO_REFRESH_MIN_HOURS}
            step={1}
            className="settings-input settings-input-narrow"
            value={hoursRaw}
            disabled={!enabled}
            onChange={(e) => persistHours(e.target.value)}
            onBlur={onHoursBlur}
            data-testid="settings-flist-auto-refresh-hours"
          />
          <span className="settings-inline-suffix">hours</span>
        </div>
        <p className="settings-help">
          <strong>?</strong> To avoid straining the F-list API,
          automatic refresh can't be set faster than{' '}
          {FLIST_AUTO_REFRESH_MIN_HOURS} hours. You can always manually
          refresh from the character picker.
        </p>
      </div>
    </>
  )
}

function SecurityPane() {
  // Tracks whether a token has been issued + accepted. We can't read
  // the token itself (sidecar never returns it after pairing) so this
  // is a coarse "is anything stored?" signal derived from whether a
  // /restore/* auth call succeeds. The simplest probe is to call any
  // authed endpoint; we use snapshots with an empty character — it
  // returns 200 + [] when paired, 401 when not.
  const [paired, setPaired] = useState<'unknown' | 'yes' | 'no'>('unknown')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const res = await fetch(`${api.base()}/restore/snapshots?character=__probe__`, {
        // No X-Workbench-Auth header — if the sidecar replies 401, we
        // know there's no accepted token. We can't actively test "is
        // MY token valid" from the renderer because the renderer
        // doesn't hold the token (only the extension does).
      })
      setPaired(res.status === 401 ? 'no' : res.status === 200 ? 'yes' : 'unknown')
    } catch {
      setPaired('unknown')
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const rotate = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await api.restoreRevokeToken()
      setMsg('Token revoked. The extension will need to re-pair on its next request.')
      await refresh()
    } catch (e) {
      setMsg(`Could not revoke: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h3 className="settings-section-h">Browser-extension pairing</h3>
      <div className="settings-row settings-row-grid">
        <span className="settings-label">Status</span>
        <div className="settings-inline-input">
          <strong>
            {paired === 'yes' && '● Paired'}
            {paired === 'no' && '○ Not paired'}
            {paired === 'unknown' && '… Checking'}
          </strong>
        </div>
        <p className="settings-help">
          The F-list Workbench browser extension talks to this app over
          <code> 127.0.0.1:8765 </code>
          using a per-install token. Pairing happens via an
          accept-this-extension prompt the first time the extension
          asks. The extension never sees your F-list session and this
          app never sees your F-list cookies — the extension just
          fetches snapshots you've already stored locally.
        </p>
      </div>
      <h3 className="settings-section-h">Rotate pairing token</h3>
      <div className="settings-row settings-row-grid">
        <span className="settings-label">Reset trust</span>
        <div className="settings-inline-input">
          <button
            type="button"
            className="settings-clear"
            onClick={rotate}
            disabled={busy || paired !== 'yes'}
            data-testid="settings-security-rotate"
          >
            {busy ? 'Revoking…' : 'Rotate token'}
          </button>
        </div>
        <p className="settings-help">
          Revokes the current pairing token. The extension will be
          locked out until you accept a fresh pairing prompt. Use this
          if you suspect the token leaked, or after uninstalling /
          reinstalling the extension.
        </p>
        {msg && <p className="settings-help"><strong>{msg}</strong></p>}
      </div>
    </>
  )
}

function LabelsPane({
  labels,
  draft,
  onChange
}: {
  labels: LabelsSettings
  draft: Draft['labels']
  onChange: (patch: Partial<Draft['labels']>) => void
}) {
  const [testStatus, setTestStatus] = useState<'idle' | 'running' | 'ok' | 'fail'>(
    'idle'
  )
  const [testResult, setTestResult] = useState<{
    ok: boolean
    elapsed_ms: number
    error?: string | null
    raw?: string
    parsed?: { label: string; reason: string } | null
  } | null>(null)

  type Rollup = Awaited<ReturnType<typeof api.labelsRollup>>
  type JobHistory = Awaited<ReturnType<typeof api.labelsJobHistory>>
  const [rollup, setRollup] = useState<Rollup | null>(null)
  const [rollupStatus, setRollupStatus] = useState<'idle' | 'loading' | 'error'>(
    'loading'
  )
  const [history, setHistory] = useState<JobHistory | null>(null)
  const [resetStatus, setResetStatus] = useState<'idle' | 'resetting' | 'done' | 'error'>(
    'idle'
  )
  const [resetError, setResetError] = useState<string | null>(null)

  const refreshRollup = async () => {
    setRollupStatus('loading')
    try {
      const r = await api.labelsRollup()
      setRollup(r)
      setRollupStatus('idle')
    } catch {
      setRollupStatus('error')
    }
  }

  const refreshHistory = async () => {
    try {
      const h = await api.labelsJobHistory(20)
      setHistory(h)
    } catch {
      // History is cosmetic; silent failure.
    }
  }

  useEffect(() => {
    void refreshRollup()
    void refreshHistory()
  }, [])

  const triggerResetAll = async () => {
    const confirmed = window.confirm(
      'Reset ALL labels across every character?\n\n' +
        'Every LLM and manual label for every conversation reverts to ' +
        'Unlabeled. Rule-based hints (short messages, "((", etc.) keep ' +
        'firing as OOC. This cannot be undone.'
    )
    if (!confirmed) return
    setResetStatus('resetting')
    setResetError(null)
    try {
      await api.labelsClearAll()
      setResetStatus('done')
      void refreshRollup()
    } catch (err) {
      setResetStatus('error')
      setResetError(err instanceof Error ? err.message : String(err))
    }
  }

  const runTest = async () => {
    setTestStatus('running')
    setTestResult(null)
    try {
      const result = await api.labelsTestConnection({
        llm_endpoint: draft.llm_endpoint,
        llm_model: draft.llm_model,
        llm_api_key: draft.llm_api_key,
        system_prompt: draft.system_prompt
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

  const isPromptDefault = draft.system_prompt === labels.defaults.system_prompt
  const testText = testResult
    ? testResult.ok
      ? `OK · ${testResult.elapsed_ms} ms · ${testResult.parsed?.label}`
      : `${testResult.error ?? 'failed'} · ${testResult.elapsed_ms} ms`
    : 'not run yet'

  return (
    <>
      <PaneHeader
        title="Labels — IC / OOC classifier"
        subtitle="Settings for the on-demand classifier. Short messages and `((…` auto-OOC by rule; everything else stays Unlabeled until you run Classify on a conversation."
      />

      <div className="settings-section" data-testid="labels-rollup">
        <h3 className="settings-section-title">Coverage</h3>
        {rollupStatus === 'loading' && (
          <p className="settings-help">Walking every log to compute totals…</p>
        )}
        {rollupStatus === 'error' && (
          <p className="settings-help">
            Couldn't load rollup — open and close Settings to retry.
          </p>
        )}
        {rollup && (
          <p className="settings-help" data-testid="labels-rollup-line">
            Across {rollup.character_count.toLocaleString()} character
            {rollup.character_count === 1 ? '' : 's'}:{' '}
            <strong>{rollup.ic.toLocaleString()}</strong> IC ·{' '}
            <strong>{rollup.ooc.toLocaleString()}</strong> OOC ·{' '}
            <strong>{rollup.manual.toLocaleString()}</strong> manual ·{' '}
            <strong>{rollup.unlabeled.toLocaleString()}</strong> Unlabeled
            {rollup.failed > 0 && (
              <>
                {' '}·{' '}
                <strong>{rollup.failed.toLocaleString()}</strong> Failed
              </>
            )}
          </p>
        )}
        <div className="settings-actions">
          <button
            type="button"
            className="settings-clear"
            onClick={() => void triggerResetAll()}
            disabled={resetStatus === 'resetting' || rollup?.total === 0}
            data-testid="labels-reset-all"
          >
            {resetStatus === 'resetting' ? 'Resetting…' : 'Reset all labels…'}
          </button>
          {resetStatus === 'done' && (
            <span className="settings-meta">All labels cleared.</span>
          )}
          {resetStatus === 'error' && resetError && (
            <span className="settings-meta classify-last-error">{resetError}</span>
          )}
        </div>
      </div>

      <LabelsHistorySection history={history} />

      <div className="settings-section">
        <div className="settings-field">
          <label className="settings-label" htmlFor="labels-threshold">
            OOC threshold (chars)
          </label>
          <p className="settings-help">
            Chat messages shorter than this many characters are auto-classified
            as OOC without asking the LLM.
          </p>
          <div className="settings-row">
            <input
              id="labels-threshold"
              type="number"
              min={1}
              className="settings-input settings-input-narrow"
              value={draft.threshold_chars}
              onChange={(e) => onChange({ threshold_chars: e.target.value })}
              data-testid="labels-threshold-input"
            />
            <button
              type="button"
              className="settings-clear"
              onClick={() =>
                onChange({ threshold_chars: String(labels.defaults.threshold_chars) })
              }
            >
              Default ({labels.defaults.threshold_chars})
            </button>
          </div>
        </div>

        <div className="settings-field">
          <label className="settings-label">Context window (surrounding messages)</label>
          <p className="settings-help">
            How many messages before and after the target are attached as{' '}
            <code>KONTEXT</code> to each classify call. Defaults to{' '}
            <code>1 / 1</code> — wider windows cause the model to latch onto the
            surrounding cluster and bleed across IC/OOC boundaries. If you see
            boundary messages mislabeled, drop to <code>0 / 0</code>, not up.
            Range 0–10 each.
          </p>
          <div className="settings-row">
            <label htmlFor="labels-ctx-before" className="settings-row-label">
              Before
            </label>
            <input
              id="labels-ctx-before"
              type="number"
              min={0}
              max={10}
              className="settings-input settings-input-narrow"
              value={draft.context_before}
              onChange={(e) => onChange({ context_before: e.target.value })}
              data-testid="labels-context-before-input"
            />
            <label htmlFor="labels-ctx-after" className="settings-row-label">
              After
            </label>
            <input
              id="labels-ctx-after"
              type="number"
              min={0}
              max={10}
              className="settings-input settings-input-narrow"
              value={draft.context_after}
              onChange={(e) => onChange({ context_after: e.target.value })}
              data-testid="labels-context-after-input"
            />
            <button
              type="button"
              className="settings-clear"
              onClick={() =>
                onChange({
                  context_before: String(labels.defaults.context_before),
                  context_after: String(labels.defaults.context_after)
                })
              }
            >
              Default ({labels.defaults.context_before} / {labels.defaults.context_after})
            </button>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Inference</h3>
        <EndpointField
          id="labels-endpoint"
          value={draft.llm_endpoint}
          defaultUrl={labels.defaults.llm_endpoint}
          onChange={(v) => onChange({ llm_endpoint: v })}
          help={
            <>
              OpenAI-compatible URL. The classifier posts to{' '}
              <code>&lt;endpoint&gt;/chat/completions</code>.
            </>
          }
          testId="labels-endpoint-input"
        />
        <ModelField
          id="labels-model"
          value={draft.llm_model}
          defaultValue={labels.defaults.llm_model}
          endpoint={draft.llm_endpoint}
          onChange={(v) => onChange({ llm_model: v })}
          help={
            <>The model identifier the server expects. <strong>Discover</strong> queries the endpoint for loaded models.</>
          }
          testId="labels-model-input"
        />
        <ApiKeyField
          id="labels-api-key"
          value={draft.llm_api_key}
          onChange={(v) => onChange({ llm_api_key: v })}
          testId="labels-api-key-input"
        />

        <div className="settings-field">
          <label className="settings-label">Test connection</label>
          <p className="settings-help">
            One canned classification roundtrip against the endpoint + model +
            prompt above. Useful before kicking off a long classify job.
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
              <TestStatusPill
                status={testStatus}
                text={testText}
                testId="labels-test-result"
              />
            )}
          </div>
          {testResult && testResult.raw && !testResult.ok && (
            <p className="settings-meta classify-last-error">
              Raw response: <code>{testResult.raw}</code>
            </p>
          )}
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">System prompt</h3>
        <p className="settings-help">
          Sent as the system message before each target message + its context
          window.
        </p>
        <PromptPresetPicker
          presets={labels.prompt_presets}
          currentBody={draft.system_prompt}
          onPick={(body) => onChange({ system_prompt: body })}
        />
        <textarea
          id="labels-prompt"
          className="settings-textarea"
          rows={14}
          value={draft.system_prompt}
          onChange={(e) => onChange({ system_prompt: e.target.value })}
          data-testid="labels-prompt-input"
        />
        <div className="settings-actions">
          <button
            type="button"
            className="settings-clear"
            onClick={() => onChange({ system_prompt: labels.defaults.system_prompt })}
            disabled={isPromptDefault}
          >
            Reset to default prompt
          </button>
          <span className="settings-meta">
            {draft.system_prompt.length.toLocaleString()} chars
          </span>
        </div>
      </div>
    </>
  )
}

// Single-select dropdown that swaps the system_prompt textarea content
// for one of the bundled presets. The "(custom)" option shows when the
// current body doesn't match any preset verbatim — i.e. the user has
// edited the prompt after picking a preset; selecting a preset replaces
// the body without confirmation, but the user can still Undo via the
// textarea's native edit history.
function LabelsHistorySection({
  history
}: {
  history: Awaited<ReturnType<typeof api.labelsJobHistory>> | null
}) {
  if (!history || history.jobs.length === 0) return null
  return (
    <div className="settings-section" data-testid="labels-history">
      <h3 className="settings-section-title">Recent classify runs</h3>
      <p className="settings-help">
        Persistent across sidecar restarts — the live progress for in-flight
        jobs lives in the Classify panel instead.
      </p>
      <ul className="settings-history-list">
        {history.jobs.map((job) => {
          const scopeLabel = formatJobScope(job.scope)
          const when = new Date(job.finished_at * 1000).toLocaleString()
          const failedNote = job.failed > 0 ? ` · ${job.failed} failed` : ''
          return (
            <li key={job.id} className={`settings-history-row state-${job.state}`}>
              <span className="settings-history-when">{when}</span>
              <span className="settings-history-scope">{scopeLabel}</span>
              <span className="settings-history-counts">
                {job.classified.toLocaleString()} / {job.total.toLocaleString()}
                {failedNote}
              </span>
              <span className={`settings-history-state state-${job.state}`}>
                {job.state}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function formatJobScope(scope: { character?: string; partner?: string }): string {
  if (scope.character && scope.partner) {
    return `${scope.partner} × ${scope.character}`
  }
  if (scope.character) return `all partners × ${scope.character}`
  return 'all characters'
}

function PromptPresetPicker({
  presets,
  currentBody,
  onPick
}: {
  presets: PromptPreset[]
  currentBody: string
  onPick: (body: string) => void
}) {
  if (presets.length === 0) return null
  const matched = presets.find((p) => p.body === currentBody)
  const selectedId = matched?.id ?? ''
  const selectedDesc = matched?.description ?? 'Edited prompt — no preset selected.'
  return (
    <div className="settings-row" style={{ marginBottom: 8 }}>
      <label
        htmlFor="labels-prompt-preset"
        className="settings-row-label settings-row-label-wide"
      >
        Preset
      </label>
      <select
        id="labels-prompt-preset"
        className="settings-input"
        value={selectedId}
        onChange={(e) => {
          const id = e.target.value
          const next = presets.find((p) => p.id === id)
          if (next) onPick(next.body)
        }}
        data-testid="labels-prompt-preset"
      >
        {!matched && (
          <option value="" disabled>
            (custom — edited)
          </option>
        )}
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label} · {p.language}
          </option>
        ))}
      </select>
      <span className="settings-meta" style={{ marginLeft: 8 }}>
        {selectedDesc}
      </span>
    </div>
  )
}

function ChatPane({
  rag,
  draft,
  onChange
}: {
  rag: RagSettings
  draft: Draft['rag']
  onChange: (patch: Partial<Draft['rag']>) => void
}) {
  const [testStatus, setTestStatus] = useState<'idle' | 'running' | 'ok' | 'fail'>(
    'idle'
  )
  const [testResult, setTestResult] = useState<{
    ok: boolean
    elapsed_ms: number
    error: string | null
    raw?: string
  } | null>(null)

  const runTest = async () => {
    setTestStatus('running')
    setTestResult(null)
    try {
      const result = await api.ragTestChat({
        chat_endpoint: draft.chat_endpoint,
        chat_model: draft.chat_model,
        chat_api_key: draft.chat_api_key,
        chat_system_prompt: draft.chat_system_prompt
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

  const testText = testResult
    ? testResult.ok
      ? `OK · ${testResult.elapsed_ms} ms`
      : `${testResult.error ?? 'failed'} · ${testResult.elapsed_ms} ms`
    : 'not run yet'
  const isChatPromptDefault =
    draft.chat_system_prompt === rag.defaults.chat_system_prompt

  return (
    <>
      <PaneHeader
        title="RAG · Chat"
        subtitle="LLM that answers questions over the retrieved chunks. Changes here take effect on the next message — no re-ingest needed."
      />

      <div className="settings-section">
        <h3 className="settings-section-title">Inference</h3>
        <EndpointField
          id="rag-chat-endpoint"
          value={draft.chat_endpoint}
          defaultUrl={rag.defaults.chat_endpoint}
          onChange={(v) => onChange({ chat_endpoint: v })}
          help="Same OpenAI-compatible shape as the Labels endpoint. Often the same server, different loaded model."
          testId="rag-chat-endpoint-input"
        />
        <ModelField
          id="rag-chat-model"
          value={draft.chat_model}
          defaultValue={rag.defaults.chat_model}
          endpoint={draft.chat_endpoint}
          onChange={(v) => onChange({ chat_model: v })}
          help={<>For chat questions over your logs. <strong>Discover</strong> lists loaded models from the endpoint above.</>}
          testId="rag-chat-model-input"
        />
        <ApiKeyField
          id="rag-chat-api-key"
          value={draft.chat_api_key}
          onChange={(v) => onChange({ chat_api_key: v })}
          testId="rag-chat-api-key-input"
        />

        <div className="settings-field">
          <label className="settings-label">Test connection</label>
          <p className="settings-help">
            One non-streaming chat completion to validate the endpoint + model.
            Doesn't touch your index or chat history.
          </p>
          <div className="settings-actions">
            <button
              type="button"
              className="settings-pick"
              onClick={() => void runTest()}
              disabled={testStatus === 'running'}
              data-testid="rag-chat-test-connection"
            >
              {testStatus === 'running' ? 'Testing…' : 'Test connection'}
            </button>
            {testResult && (
              <TestStatusPill
                status={testStatus}
                text={testText}
                testId="rag-chat-test-result"
              />
            )}
          </div>
          {testResult && testResult.raw && !testResult.ok && (
            <p className="settings-meta classify-last-error">
              Raw response: <code>{testResult.raw}</code>
            </p>
          )}
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">System prompt</h3>
        <p className="settings-help">
          Prepended as the system message before each retrieval call. Empty
          resets to the bundled English default that asks the model to ground
          answers in the cited chunks.
        </p>
        <textarea
          id="rag-chat-prompt"
          className="settings-textarea"
          rows={10}
          value={draft.chat_system_prompt}
          onChange={(e) => onChange({ chat_system_prompt: e.target.value })}
          data-testid="rag-chat-prompt-input"
        />
        <div className="settings-actions">
          <button
            type="button"
            className="settings-clear"
            onClick={() =>
              onChange({ chat_system_prompt: rag.defaults.chat_system_prompt })
            }
            disabled={isChatPromptDefault}
          >
            Reset to default prompt
          </button>
          <span className="settings-meta">
            {draft.chat_system_prompt.length.toLocaleString()} chars
          </span>
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Retrieval</h3>
        <p className="settings-help">
          How many chunks fetch / rerank / send to the LLM per question. No
          re-ingest required.
        </p>
        <NumericRow
          label="Top-K"
          help="Number of chunks sent to the chat model."
          value={draft.top_k}
          onChange={(v) => onChange({ top_k: v })}
          min={1}
          max={50}
          testId="rag-top-k-input"
        />
        <NumericRow
          label="Candidates"
          help="How many we pull from Qdrant before reranking down to top-K."
          value={draft.rerank_candidates}
          onChange={(v) => onChange({ rerank_candidates: v })}
          min={1}
          max={200}
          testId="rag-rerank-candidates-input"
        />
        <NumericRow
          label="Neighbors"
          help="±N adjacent chunks attached to each hit for context (0 = no expansion)."
          value={draft.neighbors}
          onChange={(v) => onChange({ neighbors: v })}
          min={0}
          max={5}
          testId="rag-neighbors-input"
        />

        <div className="settings-field">
          <label className="settings-label" htmlFor="rag-rerank-model">
            Reranker model
          </label>
          <p className="settings-help">
            Cross-encoder that re-scores Qdrant candidates against the query.
            Downloads on first use to{' '}
            <code>~/Documents/flist-workbench/models/</code>. Bigger multilingual
            models cost more disk + memory but recover recall on non-English
            corpora.
          </p>
          <div className="settings-row">
            <select
              id="rag-rerank-model"
              className="settings-input"
              value={draft.rerank_model}
              onChange={(e) => onChange({ rerank_model: e.target.value })}
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
              onClick={() => onChange({ rerank_model: rag.defaults.rerank_model })}
            >
              Default
            </button>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Quality</h3>
        <p className="settings-help">
          Optional retrieval extensions. All off by default — turn each on
          once you've validated it improves answers against your own logs.
        </p>

        <div className="settings-field settings-field-tight">
          <div className="settings-row">
            <label
              className="settings-row-label settings-row-label-wide"
              htmlFor="rag-min-ratio"
            >
              Min rerank ratio
            </label>
            <input
              id="rag-min-ratio"
              type="number"
              min={0}
              max={1}
              step={0.05}
              className="settings-input settings-input-narrow"
              value={draft.rerank_min_ratio}
              onChange={(e) => onChange({ rerank_min_ratio: e.target.value })}
              data-testid="rag-min-ratio-input"
            />
            <button
              type="button"
              className="settings-clear"
              onClick={() =>
                onChange({
                  rerank_min_ratio: String(rag.defaults.rerank_min_ratio)
                })
              }
            >
              Default ({rag.defaults.rerank_min_ratio})
            </button>
          </div>
          <p className="settings-help settings-help-tight">
            Drops chunks scoring below <code>top × ratio</code> after
            reranking. Cuts noise on factual lookups where only 1–2 chunks
            are actually relevant. <code>0</code> disables.
          </p>
        </div>

        <div className="settings-field">
          <label className="settings-checkbox-row">
            <input
              type="checkbox"
              checked={draft.hybrid_enabled}
              onChange={(e) => onChange({ hybrid_enabled: e.target.checked })}
              data-testid="rag-hybrid-enabled-input"
            />
            <span>Hybrid retrieval (BM25 + embeddings)</span>
          </label>
          <p className="settings-help">
            Adds SQLite FTS5 keyword search alongside dense embeddings,
            fused with Reciprocal Rank Fusion. Recovers recall on
            proper-noun questions ("who is Amber?", "which cocktail?").
            First use after enabling rebuilds the lexical index from
            existing chunks (a few seconds).
          </p>
          {draft.hybrid_enabled && (
            <div className="settings-row">
              <label
                className="settings-row-label settings-row-label-wide"
                htmlFor="rag-hybrid-bm25"
              >
                BM25 candidates
              </label>
              <input
                id="rag-hybrid-bm25"
                type="number"
                min={1}
                max={200}
                className="settings-input settings-input-narrow"
                value={draft.hybrid_bm25_candidates}
                onChange={(e) =>
                  onChange({ hybrid_bm25_candidates: e.target.value })
                }
                data-testid="rag-hybrid-bm25-input"
              />
              <button
                type="button"
                className="settings-clear"
                onClick={() =>
                  onChange({
                    hybrid_bm25_candidates: String(
                      rag.defaults.hybrid_bm25_candidates
                    )
                  })
                }
              >
                Default ({rag.defaults.hybrid_bm25_candidates})
              </button>
            </div>
          )}
        </div>

        <div className="settings-field">
          <label className="settings-checkbox-row">
            <input
              type="checkbox"
              checked={draft.multiquery_enabled}
              onChange={(e) =>
                onChange({ multiquery_enabled: e.target.checked })
              }
              data-testid="rag-multiquery-enabled-input"
            />
            <span>Multi-query expansion</span>
          </label>
          <p className="settings-help">
            Asks the chat model to paraphrase your question (and quietly
            autocorrect proper-noun typos) before retrieval. Each variant
            triggers its own embedding round; results are unioned. Adds
            1–3 s of latency per question.
          </p>
          {draft.multiquery_enabled && (
            <div className="settings-row">
              <label
                className="settings-row-label settings-row-label-wide"
                htmlFor="rag-multiquery-variants"
              >
                Variants
              </label>
              <input
                id="rag-multiquery-variants"
                type="number"
                min={2}
                max={5}
                className="settings-input settings-input-narrow"
                value={draft.multiquery_variants}
                onChange={(e) =>
                  onChange({ multiquery_variants: e.target.value })
                }
                data-testid="rag-multiquery-variants-input"
              />
              <button
                type="button"
                className="settings-clear"
                onClick={() =>
                  onChange({
                    multiquery_variants: String(rag.defaults.multiquery_variants)
                  })
                }
              >
                Default ({rag.defaults.multiquery_variants})
              </button>
            </div>
          )}
        </div>

        <div className="settings-field settings-field-tight">
          <div className="settings-row">
            <label
              className="settings-row-label settings-row-label-wide"
              htmlFor="rag-num-ctx"
            >
              Context window
            </label>
            <input
              id="rag-num-ctx"
              type="number"
              min={0}
              max={131072}
              step={1024}
              className="settings-input settings-input-narrow"
              value={draft.chat_num_ctx}
              onChange={(e) => onChange({ chat_num_ctx: e.target.value })}
              data-testid="rag-num-ctx-input"
            />
            <button
              type="button"
              className="settings-clear"
              onClick={() =>
                onChange({ chat_num_ctx: String(rag.defaults.chat_num_ctx) })
              }
            >
              Default ({rag.defaults.chat_num_ctx})
            </button>
          </div>
          <p className="settings-help settings-help-tight">
            Sent as <code>options.num_ctx</code> in the chat payload.
            <strong>Ollama:</strong> default 8192 — Ollama's own per-request
            default is only 2048, which truncates retrieved chunks on most
            RAG queries. <strong>LM Studio:</strong> ignored (context is
            set at model load). <code>0</code> suppresses the field.
          </p>
        </div>
      </div>
    </>
  )
}

function EmbeddingPane({
  rag,
  draft,
  onChange
}: {
  rag: RagSettings
  draft: Draft['rag']
  onChange: (patch: Partial<Draft['rag']>) => void
}) {
  const [testStatus, setTestStatus] = useState<'idle' | 'running' | 'ok' | 'fail'>(
    'idle'
  )
  const [testResult, setTestResult] = useState<{
    ok: boolean
    elapsed_ms: number
    dimension: number | null
    model: string
    error: string | null
  } | null>(null)

  const openIngest = useStore((s) => s.openIngest)
  const [wipeStatus, setWipeStatus] = useState<
    'idle' | 'wiping' | 'wiped' | 'error'
  >('idle')
  const [wipeError, setWipeError] = useState<string | null>(null)

  const runTest = async () => {
    setTestStatus('running')
    setTestResult(null)
    try {
      const result = await api.ragTestEmbedding({
        embed_endpoint: draft.embed_endpoint,
        embed_model: draft.embed_model,
        embed_api_key: draft.embed_api_key,
        embed_query_prefix: draft.embed_query_prefix,
        embed_document_prefix: draft.embed_document_prefix
      })
      setTestResult(result)
      setTestStatus(result.ok ? 'ok' : 'fail')
    } catch (err) {
      setTestResult({
        ok: false,
        elapsed_ms: 0,
        dimension: null,
        model: draft.embed_model,
        error: err instanceof Error ? err.message : String(err)
      })
      setTestStatus('fail')
    }
  }

  const triggerWipe = async () => {
    if (wipeStatus === 'wiping') return
    const confirmed = window.confirm(
      'Wipe the local vector index?\n\n' +
        'This deletes every embedded chunk and clears the manifest. It does ' +
        'NOT touch your labels or your F-Chat logs. The next time you run ' +
        'Ingest the index will rebuild from scratch.'
    )
    if (!confirmed) return
    setWipeStatus('wiping')
    setWipeError(null)
    try {
      await api.ragWipe()
      setWipeStatus('wiped')
    } catch (err) {
      setWipeStatus('error')
      setWipeError(err instanceof Error ? err.message : String(err))
    }
  }

  const [lexicalStatus, setLexicalStatus] = useState<
    'idle' | 'rebuilding' | 'done' | 'error'
  >('idle')
  const [lexicalResult, setLexicalResult] = useState<{
    indexed?: number
    error?: string
  } | null>(null)

  const triggerLexicalRebuild = async () => {
    if (lexicalStatus === 'rebuilding') return
    setLexicalStatus('rebuilding')
    setLexicalResult(null)
    try {
      const r = await api.ragLexicalRebuild()
      setLexicalResult({ indexed: r.indexed })
      setLexicalStatus('done')
    } catch (err) {
      setLexicalResult({
        error: err instanceof Error ? err.message : String(err)
      })
      setLexicalStatus('error')
    }
  }

  const triggerReingestAll = () => {
    const confirmed = window.confirm(
      'Re-ingest all logs?\n\n' +
        'This wipes the existing vector index and rebuilds it for every ' +
        'character × partner using the current chunking + embedding settings. ' +
        'The operation runs in the background and you can cancel mid-way.'
    )
    if (!confirmed) return
    openIngest({}, 'All characters, all partners (re-ingest)', {
      forceRewipe: true
    })
  }

  const usesNomicPrefixes =
    draft.embed_query_prefix === NOMIC_QUERY_PREFIX &&
    draft.embed_document_prefix === NOMIC_DOCUMENT_PREFIX

  const testText = testResult
    ? testResult.ok
      ? `OK · ${testResult.elapsed_ms} ms · dim ${testResult.dimension} · ${testResult.model}`
      : `${testResult.error ?? 'failed'} · ${testResult.elapsed_ms} ms`
    : 'not run yet'

  return (
    <>
      <PaneHeader
        title="RAG · Embedding"
        subtitle="Index shape — embedding model + chunking. Changes here invalidate existing chunks; you'll need to re-ingest."
      />

      <div className="settings-section">
        <h3 className="settings-section-title">Inference</h3>
        <EndpointField
          id="rag-endpoint"
          value={draft.embed_endpoint}
          defaultUrl={rag.defaults.embed_endpoint}
          onChange={(v) => onChange({ embed_endpoint: v })}
          help="Usually the same server as the labels classifier — LM Studio can host a chat model and an embedding model side by side."
          testId="rag-endpoint-input"
        />
        <ModelField
          id="rag-model"
          value={draft.embed_model}
          defaultValue={rag.defaults.embed_model}
          endpoint={draft.embed_endpoint}
          onChange={(v) => onChange({ embed_model: v })}
          help={
            <>
              For LM Studio that's the name shown in the model loader — e.g.{' '}
              <code>nomic-ai/nomic-embed-text-v1.5</code> or{' '}
              <code>BAAI/bge-m3</code>. <strong>Discover</strong> lists what's
              loaded.
            </>
          }
          testId="rag-model-input"
        />
        <ApiKeyField
          id="rag-api-key"
          value={draft.embed_api_key}
          onChange={(v) => onChange({ embed_api_key: v })}
          testId="rag-api-key-input"
        />

        <div className="settings-field">
          <label className="settings-label">Task-specific prefixes</label>
          <p className="settings-help">
            Only the <code>nomic-embed-text-*</code> family requires these — they
            drop recall ~30% without them. BGE, e5, Voyage, Gemini and most
            others ignore prefixes; leave blank.
          </p>
          <div className="settings-row">
            <button
              type="button"
              className={`settings-preset ${usesNomicPrefixes ? 'on' : ''}`}
              onClick={() =>
                onChange({
                  embed_query_prefix: NOMIC_QUERY_PREFIX,
                  embed_document_prefix: NOMIC_DOCUMENT_PREFIX
                })
              }
              data-testid="rag-prefix-nomic"
            >
              Use nomic prefixes
            </button>
            <button
              type="button"
              className="settings-clear"
              onClick={() =>
                onChange({ embed_query_prefix: '', embed_document_prefix: '' })
              }
              data-testid="rag-prefix-clear"
            >
              Clear
            </button>
          </div>
          <div className="settings-row">
            <label htmlFor="rag-query-prefix" className="settings-row-label settings-row-label-wide">
              Query
            </label>
            <input
              id="rag-query-prefix"
              type="text"
              className="settings-input"
              value={draft.embed_query_prefix}
              placeholder="(none)"
              onChange={(e) => onChange({ embed_query_prefix: e.target.value })}
              data-testid="rag-query-prefix-input"
            />
          </div>
          <div className="settings-row">
            <label htmlFor="rag-doc-prefix" className="settings-row-label settings-row-label-wide">
              Document
            </label>
            <input
              id="rag-doc-prefix"
              type="text"
              className="settings-input"
              value={draft.embed_document_prefix}
              placeholder="(none)"
              onChange={(e) => onChange({ embed_document_prefix: e.target.value })}
              data-testid="rag-doc-prefix-input"
            />
          </div>
        </div>

        <div className="settings-field">
          <label className="settings-label" htmlFor="rag-embed-keep-alive">
            Chat query keep-alive
          </label>
          <p className="settings-help">
            How long Ollama should keep the embedding model resident after
            embedding a chat question. Short values (e.g. <code>30s</code>)
            free VRAM quickly on tight cards so it doesn't fight your chat
            model. Leave blank to use the server default (~5 min). Ignored
            by LM Studio and other servers that don't honour keep_alive.
          </p>
          <div className="settings-row">
            <input
              id="rag-embed-keep-alive"
              type="text"
              className="settings-input"
              value={draft.chat_embed_keep_alive}
              placeholder="(server default)"
              onChange={(e) => onChange({ chat_embed_keep_alive: e.target.value })}
              data-testid="rag-embed-keep-alive-input"
            />
            <button
              type="button"
              className="settings-reset"
              onClick={() =>
                onChange({ chat_embed_keep_alive: rag.defaults.chat_embed_keep_alive })
              }
              data-testid="rag-embed-keep-alive-reset"
            >
              Default ({rag.defaults.chat_embed_keep_alive || 'unset'})
            </button>
          </div>
        </div>

        <div className="settings-field">
          <label className="settings-label">Test connection</label>
          <p className="settings-help">
            One canned embedding roundtrip. Validates the endpoint, that the
            model is loaded, and reports the vector dimension.
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
              <TestStatusPill
                status={testStatus}
                text={testText}
                testId="rag-test-result"
              />
            )}
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Chunking</h3>
        <p className="settings-help">
          How parsed messages get grouped into retrieval chunks. Smaller chunks
          improve "find the exact moment" queries at the cost of more vectors to
          embed; more overlap reduces meaning getting cut mid-exchange.{' '}
          <strong>Changing any of these requires a re-ingest</strong> for
          existing data to use the new shape.
        </p>
        <NumericRow
          label="Max chars"
          value={draft.chunk_max_chars}
          onChange={(v) => onChange({ chunk_max_chars: v })}
          min={500}
          max={20000}
          step={100}
          testId="rag-chunk-max-input"
          defaultValue={String(rag.defaults.chunk_max_chars)}
        />
        <NumericRow
          label="Soft split"
          value={draft.chunk_soft_split_chars}
          onChange={(v) => onChange({ chunk_soft_split_chars: v })}
          min={400}
          max={20000}
          step={100}
          testId="rag-chunk-soft-input"
          defaultValue={String(rag.defaults.chunk_soft_split_chars)}
        />
        <NumericRow
          label="Overlap msgs"
          value={draft.chunk_overlap_msgs}
          onChange={(v) => onChange({ chunk_overlap_msgs: v })}
          min={0}
          max={5}
          testId="rag-chunk-overlap-input"
          defaultValue={String(rag.defaults.chunk_overlap_msgs)}
        />
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Index maintenance</h3>
        <p className="settings-help">
          <strong>Wipe index</strong> drops the local Qdrant collection — pure
          delete. Useful before changing chunking / embedding settings.{' '}
          <strong>Re-ingest all</strong> wipes <em>and</em> rebuilds every
          conversation in one step using current settings.
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
          <button
            type="button"
            className="settings-clear"
            onClick={() => void triggerLexicalRebuild()}
            disabled={lexicalStatus === 'rebuilding'}
            title="Rebuild the BM25 lexical mirror from the existing Qdrant chunks. No re-embedding, no LLM calls."
            data-testid="rag-lexical-rebuild"
          >
            {lexicalStatus === 'rebuilding'
              ? 'Rebuilding lexical…'
              : 'Rebuild lexical index'}
          </button>
          {wipeStatus === 'wiped' && (
            <span className="settings-meta">Index wiped.</span>
          )}
          {wipeStatus === 'error' && wipeError && (
            <span className="settings-meta classify-last-error">
              Wipe failed: {wipeError}
            </span>
          )}
          {lexicalStatus === 'done' && lexicalResult?.indexed !== undefined && (
            <span className="settings-meta">
              Lexical index rebuilt — {lexicalResult.indexed.toLocaleString()} chunks.
            </span>
          )}
          {lexicalStatus === 'error' && lexicalResult?.error && (
            <span className="settings-meta classify-last-error">
              Rebuild failed: {lexicalResult.error}
            </span>
          )}
        </div>
      </div>
    </>
  )
}

function PaneHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="settings-pane-head">
      <h3 className="settings-pane-title">{title}</h3>
      <p className="settings-pane-subtitle">{subtitle}</p>
    </header>
  )
}

function NumericRow({
  label,
  help,
  value,
  onChange,
  min,
  max,
  step,
  testId,
  defaultValue
}: {
  label: string
  help?: string
  value: string
  onChange: (v: string) => void
  min: number
  max: number
  step?: number
  testId: string
  defaultValue?: string
}) {
  return (
    <div className="settings-field settings-field-tight">
      <div className="settings-row">
        <label className="settings-row-label settings-row-label-wide">{label}</label>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          className="settings-input settings-input-narrow"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          data-testid={testId}
        />
        {defaultValue !== undefined && (
          <button
            type="button"
            className="settings-clear"
            onClick={() => onChange(defaultValue)}
          >
            Default ({defaultValue})
          </button>
        )}
      </div>
      {help && <p className="settings-help settings-help-tight">{help}</p>}
    </div>
  )
}
