import { useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  type LabelsSettings,
  type McpInfo,
  type RagSettings,
  type RagStatus
} from '../../lib/api'
import { useStore } from '../../state'

type SettingsState = Awaited<ReturnType<typeof api.settingsGet>>

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

type SectionId =
  | 'general'
  | 'flist'
  | 'backups'
  | 'labels'
  | 'retrieval'
  | 'embedding'
  | 'mcp'
  | 'security'

const SECTION_ORDER: ReadonlyArray<{ id: SectionId; label: string; subtitle: string }> = [
  { id: 'general', label: 'General', subtitle: 'Data directory + index status' },
  { id: 'flist', label: 'F-list', subtitle: 'Sign-in refresh + snapshot behaviour' },
  { id: 'backups', label: 'Backups', subtitle: 'Scheduled-on-start sweep + retention' },
  { id: 'labels', label: 'Labels', subtitle: 'IC / OOC coverage + rules' },
  { id: 'retrieval', label: 'Retrieval', subtitle: 'How log search ranks results' },
  { id: 'embedding', label: 'RAG · Embedding', subtitle: 'Index shape (requires re-ingest)' },
  { id: 'mcp', label: 'MCP', subtitle: 'Let a model drive Workbench' },
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
  }
  rag: {
    embed_model: string
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
    chunk_max_chars: string
    chunk_soft_split_chars: string
    chunk_overlap_msgs: string
  }
  backups: {
    scheduled_interval_days: string
    scheduled_keep_last_n: string
  }
}

function buildDraft(state: SettingsState): Draft {
  return {
    fchat_data_dir: state.fchat_data_dir ?? '',
    labels: {
      threshold_chars: String(state.labels.threshold_chars)
    },
    rag: {
      embed_model: state.rag.embed_model,
      top_k: String(state.rag.top_k),
      rerank_candidates: String(state.rag.rerank_candidates),
      neighbors: String(state.rag.neighbors),
      rerank_model: state.rag.rerank_model,
      rerank_min_ratio: String(state.rag.rerank_min_ratio),
      hybrid_enabled: state.rag.hybrid_enabled,
      hybrid_bm25_candidates: String(state.rag.hybrid_bm25_candidates),
      chunk_max_chars: String(state.rag.chunk_max_chars),
      chunk_soft_split_chars: String(state.rag.chunk_soft_split_chars),
      chunk_overlap_msgs: String(state.rag.chunk_overlap_msgs)
    },
    backups: {
      scheduled_interval_days: String(state.backups.scheduled_interval_days),
      scheduled_keep_last_n: String(state.backups.scheduled_keep_last_n)
    }
  }
}

// Diff each section vs. its baseline to drive the rail dirty dots.
// Strings everywhere → cheap === comparison; we don't need deep-equal
// helpers for nested objects.
function dirtySections(draft: Draft, baseline: Draft): Record<SectionId, boolean> {
  const generalDirty = draft.fchat_data_dir.trim() !== baseline.fchat_data_dir.trim()
  const labelsDirty =
    draft.labels.threshold_chars !== baseline.labels.threshold_chars
  const retrievalDirty =
    draft.rag.top_k !== baseline.rag.top_k ||
    draft.rag.rerank_candidates !== baseline.rag.rerank_candidates ||
    draft.rag.neighbors !== baseline.rag.neighbors ||
    draft.rag.rerank_model !== baseline.rag.rerank_model ||
    draft.rag.rerank_min_ratio !== baseline.rag.rerank_min_ratio ||
    draft.rag.hybrid_enabled !== baseline.rag.hybrid_enabled ||
    draft.rag.hybrid_bm25_candidates !== baseline.rag.hybrid_bm25_candidates
  const embeddingDirty =
    draft.rag.embed_model !== baseline.rag.embed_model ||
    draft.rag.chunk_max_chars !== baseline.rag.chunk_max_chars ||
    draft.rag.chunk_soft_split_chars !== baseline.rag.chunk_soft_split_chars ||
    draft.rag.chunk_overlap_msgs !== baseline.rag.chunk_overlap_msgs
  const backupsDirty =
    draft.backups.scheduled_interval_days !==
      baseline.backups.scheduled_interval_days ||
    draft.backups.scheduled_keep_last_n !==
      baseline.backups.scheduled_keep_last_n
  return {
    general: generalDirty,
    flist: false,
    backups: backupsDirty,
    labels: labelsDirty,
    retrieval: retrievalDirty,
    embedding: embeddingDirty,
    // Read-only panes — nothing to save, so never dirty.
    mcp: false,
    security: false
  }
}

function anyDirty(d: Record<SectionId, boolean>): boolean {
  return d.general || d.labels || d.retrieval || d.embedding || d.backups
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

  const updateLabels = (patch: Partial<Draft['labels']>) =>
    setDraft((d) => (d ? { ...d, labels: { ...d.labels, ...patch } } : d))
  const updateRag = (patch: Partial<Draft['rag']>) =>
    setDraft((d) => (d ? { ...d, rag: { ...d.rag, ...patch } } : d))
  const updateGeneral = (patch: Partial<Pick<Draft, 'fchat_data_dir'>>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d))
  const updateBackups = (patch: Partial<Draft['backups']>) =>
    setDraft((d) => (d ? { ...d, backups: { ...d.backups, ...patch } } : d))

  const saveAll = async () => {
    if (!state || !draft || !dirtyByDraft) return
    // The remote-endpoint consent prompt that used to live here is
    // gone with the endpoints themselves: embedding runs in-process,
    // so no setting can send a log chunk anywhere any more.
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
        payload.labels = { threshold_chars: Math.floor(parsedThreshold) }
      }
      if (dirtyByDraft.retrieval || dirtyByDraft.embedding) {
        const nextChunkMax = clampInt(
          draft.rag.chunk_max_chars,
          500,
          20000,
          state.rag.chunk_max_chars
        )
        payload.rag = {
          embed_model: draft.rag.embed_model,
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
      if (dirtyByDraft.backups) {
        payload.backups = {
          scheduled_interval_days: clampInt(
            draft.backups.scheduled_interval_days,
            0,
            365,
            state.backups.scheduled_interval_days
          ),
          scheduled_keep_last_n: clampInt(
            draft.backups.scheduled_keep_last_n,
            1,
            200,
            state.backups.scheduled_keep_last_n
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
                  />
                )}
                {activeSection === 'flist' && <FlistPane />}
                {activeSection === 'backups' && (
                  <BackupsPane
                    state={state}
                    draft={draft}
                    onChange={updateBackups}
                    onStateRefresh={(next) => {
                      setState(next)
                      // Rebuild the form's baseline from the refreshed
                      // state — last_sweep / next_due_at aren't editable
                      // fields, so this won't clobber unsaved knob edits.
                      setDraft((d) =>
                        d
                          ? { ...d, backups: buildDraft(next).backups }
                          : buildDraft(next)
                      )
                    }}
                  />
                )}
                {activeSection === 'labels' && (
                  <LabelsPane
                    labels={state.labels}
                    draft={draft.labels}
                    onChange={updateLabels}
                  />
                )}
                {activeSection === 'retrieval' && (
                  <RetrievalPane
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
                {activeSection === 'mcp' && <McpPane />}
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
  firstFieldRef
}: {
  state: SettingsState
  draft: Draft
  onChange: (patch: Partial<Pick<Draft, 'fchat_data_dir'>>) => void
  firstFieldRef: React.RefObject<HTMLInputElement>
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

function BackupsPane({
  state,
  draft,
  onChange,
  onStateRefresh
}: {
  state: SettingsState
  draft: Draft
  onChange: (patch: Partial<Draft['backups']>) => void
  onStateRefresh: (next: SettingsState) => void
}) {
  const defaults = state.backups.defaults
  const intervalNum = Number(draft.backups.scheduled_interval_days)
  const disabled = Number.isFinite(intervalNum) && intervalNum === 0
  const lastSweep = state.backups.last_sweep
  const nextDueAt = state.backups.next_due_at
  // Re-use the existing BackupAllBanner state so the manual Trigger
  // button shares the same in-flight indicator as the post-login auto
  // path. Disabled while any backup-all is running.
  const backupAllStatus = useStore((s) => s.flistBackupAllStatus)
  const flistSession = useStore((s) => s.flistSession)
  const fireBackupAll = useStore((s) => s.flistBackupAll)
  const running = backupAllStatus.phase === 'running'
  const signedIn = flistSession.active
  const [runError, setRunError] = useState<string | null>(null)

  // When the user-triggered backup-all finishes, re-fetch /settings so
  // the Last-ran / Next-due rows reflect the new telemetry. We only
  // care about transitions from running → done|error, not initial
  // mount state.
  const lastPhase = useRef(backupAllStatus.phase)
  useEffect(() => {
    if (
      lastPhase.current === 'running' &&
      (backupAllStatus.phase === 'done' || backupAllStatus.phase === 'error')
    ) {
      void api.settingsGet().then(onStateRefresh).catch(() => {})
    }
    lastPhase.current = backupAllStatus.phase
  }, [backupAllStatus.phase, onStateRefresh])

  const runNow = async () => {
    setRunError(null)
    if (!signedIn) {
      setRunError('Sign in to F-list first — scheduled backups pull fresh data per character.')
      return
    }
    try {
      await fireBackupAll({ kind: 'scheduled', source: 'manual' })
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <>
      <PaneHeader
        title="Backups"
        subtitle="On-start sweep that auto-snapshots each character every N days."
      />
      <div className="settings-section">
        <div className="settings-field">
          <label className="settings-label">Scheduled sweep status</label>
          <p className="settings-help">
            Workbench checks for due backups every time the app starts
            (not while it's open — it's not a background daemon). Use
            the button below to run the sweep without restarting. A
            manual run resets the clock — the next backup will then be
            due {Number.isFinite(intervalNum) && intervalNum > 0 ? `${intervalNum} day${intervalNum === 1 ? '' : 's'}` : 'N days'}{' '}
            from when you press it.
          </p>
          <dl className="settings-sweep-status">
            <div>
              <dt>Last ran</dt>
              <dd data-testid="settings-backups-last-ran">
                {lastSweep.started_at
                  ? `${formatAbsoluteDate(lastSweep.started_at)} · ${
                      lastSweep.source === 'manual'
                        ? 'manual trigger'
                        : 'on app launch'
                    }`
                  : 'Never run'}
              </dd>
            </div>
            <div>
              <dt>Last result</dt>
              <dd>
                {lastSweep.started_at
                  ? `${lastSweep.written} written, ${lastSweep.skipped} skipped${lastSweep.failed > 0 ? `, ${lastSweep.failed} failed` : ''}`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Next due</dt>
              <dd data-testid="settings-backups-next-due">
                {disabled
                  ? 'Sweep disabled (set interval ≥ 1)'
                  : nextDueAt
                    ? `${formatAbsoluteDate(nextDueAt)} · ${formatRelativeDueIn(nextDueAt)}`
                    : 'On next app launch'}
              </dd>
            </div>
          </dl>
          <div className="settings-actions">
            <button
              type="button"
              className="settings-secondary-btn"
              onClick={() => void runNow()}
              disabled={running || !signedIn}
              title={
                !signedIn
                  ? 'Sign in to F-list first — scheduled backups pull fresh data'
                  : undefined
              }
              data-testid="settings-backups-trigger"
            >
              {running
                ? 'Sweep running — see banner above…'
                : 'Trigger scheduled backup now'}
            </button>
            {!signedIn && (
              <span className="settings-sweep-warn">
                Sign in to F-list to enable this button.
              </span>
            )}
          </div>
          {runError && (
            <p className="settings-help" data-testid="settings-backups-error">
              <strong>{runError}</strong>
            </p>
          )}
        </div>
        <div className="settings-field">
          <label
            className="settings-label"
            htmlFor="settings-backups-interval-input"
          >
            Interval (days)
          </label>
          <p className="settings-help">
            On startup, Workbench checks each character's newest{' '}
            <em>scheduled</em> backup. If it's older than this many days
            — or doesn't exist yet — a fresh scheduled backup is
            written. Manual and import backups are left alone. Set to{' '}
            <code>0</code> to disable the auto-sweep entirely.
          </p>
          <input
            id="settings-backups-interval-input"
            type="number"
            inputMode="numeric"
            min={0}
            max={365}
            step={1}
            className="settings-input settings-input-narrow"
            value={draft.backups.scheduled_interval_days}
            onChange={(e) =>
              onChange({ scheduled_interval_days: e.target.value })
            }
            data-testid="settings-backups-interval"
          />
          <p className="settings-help">
            Default <code>{defaults.scheduled_interval_days}</code>.
            {disabled && (
              <>
                {' '}
                <strong>Sweep currently disabled</strong> — set to 1 or
                more days to re-enable.
              </>
            )}
          </p>
        </div>
        <div className="settings-field">
          <label
            className="settings-label"
            htmlFor="settings-backups-keep-input"
          >
            Keep last N
          </label>
          <p className="settings-help">
            After each successful scheduled write, older scheduled
            backups for that character are pruned down to this many.
            Only scheduled backups are counted — manual, import, and
            unknown-kind backups are never pruned by this number.
          </p>
          <input
            id="settings-backups-keep-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={200}
            step={1}
            className="settings-input settings-input-narrow"
            value={draft.backups.scheduled_keep_last_n}
            onChange={(e) =>
              onChange({ scheduled_keep_last_n: e.target.value })
            }
            data-testid="settings-backups-keep"
          />
          <p className="settings-help">
            Default <code>{defaults.scheduled_keep_last_n}</code>. A
            character whose Live hasn't changed since the last
            scheduled backup is a no-op write (dedup'd by content hash),
            so an idle character won't spawn a fresh ZIP every week.
          </p>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            className="settings-secondary-btn"
            onClick={() =>
              onChange({
                scheduled_interval_days: String(
                  defaults.scheduled_interval_days
                ),
                scheduled_keep_last_n: String(defaults.scheduled_keep_last_n)
              })
            }
            data-testid="settings-backups-reset"
          >
            Reset to defaults
          </button>
        </div>
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

/** Settings → MCP. The "getting started" surface that replaced the AI
 *  Setup wizard: Workbench has no model of its own any more, so the
 *  only thing to configure is which client drives it. */
function McpPane() {
  const [info, setInfo] = useState<McpInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .mcpInfo()
      .then((next) => alive && setInfo(next))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [])

  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500)
    } catch {
      setCopied(null)
    }
  }

  const url = info?.endpoints.find((e) => e.id === 'all')?.url ?? ''
  const token = info?.auth.token ?? null

  const lmStudioConfig = JSON.stringify(
    {
      mcpServers: {
        'flist-workbench': token
          ? { url, headers: { Authorization: `Bearer ${token}` } }
          : { url }
      }
    },
    null,
    2
  )
  const claudeCodeConfig = token
    ? `claude mcp add --transport http flist-workbench ${url} \\\n  --header "Authorization: Bearer ${token}"`
    : `claude mcp add --transport http flist-workbench ${url}`
  const claudeDesktopConfig = JSON.stringify(
    {
      mcpServers: {
        'flist-workbench': {
          command: 'npx',
          args: token
            ? ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${token}`]
            : ['-y', 'mcp-remote', url]
        }
      }
    },
    null,
    2
  )

  const setToken = async (create: boolean) => {
    setBusy(true)
    try {
      if (create) await api.mcpCreateToken()
      else await api.mcpRevokeToken()
      setInfo(await api.mcpInfo())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PaneHeader
        title="MCP"
        subtitle="Let a model read and edit your characters through this app"
      />
      <p className="settings-help">
        Workbench runs a local <strong>Model Context Protocol</strong>{' '}
        server. Point an MCP-capable client at it and the model can do
        everything the UI can: read and rewrite descriptions, set
        profile fields and kinks, browse your logs, label them IC/OOC
        and search the index. Workbench itself no longer runs any
        language model — the client brings its own.
      </p>
      <p className="settings-help">
        <strong>It never uploads anything to F-list.</strong> Every tool
        changes local files only. Publishing stays your manual step in
        the browser, via the userscript or the extension.
      </p>

      <h3 className="settings-section-h">Endpoints</h3>
      {error && (
        <p className="settings-help">
          <strong>Could not reach the sidecar: {error}</strong>
        </p>
      )}
      {info?.endpoints.map((endpoint) => (
        <div className="settings-row settings-row-grid" key={endpoint.id}>
          <span className="settings-label">{endpoint.label}</span>
          <div className="settings-inline-input">
            <code data-testid={`settings-mcp-url-${endpoint.id}`}>
              {endpoint.url}
            </code>
            <button
              type="button"
              className="settings-clear"
              onClick={() => copy(`url-${endpoint.id}`, endpoint.url)}
            >
              {copied === `url-${endpoint.id}` ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="settings-help">
            {endpoint.tool_count} tools.
            {endpoint.id === 'all'
              ? ' Use this one unless your model struggles with long tool lists.'
              : ' A smaller set for models that get confused by the full list.'}
          </p>
        </div>
      ))}

      <h3 className="settings-section-h">Access</h3>
      <div className="settings-row settings-row-grid">
        <span className="settings-label">Require a token</span>
        <div className="settings-inline-input">
          <button
            type="button"
            className="settings-clear"
            disabled={busy}
            onClick={() => void setToken(!info?.auth.required)}
            data-testid="settings-mcp-token-toggle"
          >
            {info?.auth.required ? 'Turn off' : 'Turn on'}
          </button>
          {info?.auth.required && (
            <button
              type="button"
              className="settings-clear"
              disabled={busy}
              onClick={() => void setToken(true)}
              data-testid="settings-mcp-token-rotate"
            >
              New token
            </button>
          )}
        </div>
        <p className="settings-help">
          Off by default, and that is usually right: the endpoint only
          listens on this machine, and anything already running here can
          reach the rest of the app without a token anyway. Turn it on if
          you share this computer, or want to keep a sandboxed tool out.
          The snippets below include the token once there is one.
        </p>
        {info?.auth.required && token && (
          <div className="settings-inline-input">
            <code data-testid="settings-mcp-token">{token}</code>
            <button
              type="button"
              className="settings-clear"
              onClick={() => copy('token', token)}
            >
              {copied === 'token' ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}
      </div>

      <h3 className="settings-section-h">Connect a client</h3>
      <McpSnippet
        title="LM Studio"
        hint={
          <>
            Put this in <code>%USERPROFILE%\.lmstudio\mcp.json</code>, or
            use the app&apos;s Program → Install → Edit mcp.json. Needs
            LM Studio 0.3.17 or newer and a model that supports tool
            calling.
          </>
        }
        text={lmStudioConfig}
        copied={copied === 'lmstudio'}
        onCopy={() => copy('lmstudio', lmStudioConfig)}
      />
      <McpSnippet
        title="Claude Code"
        hint="Run this once in any terminal."
        text={claudeCodeConfig}
        copied={copied === 'claude-code'}
        onCopy={() => copy('claude-code', claudeCodeConfig)}
      />
      <McpSnippet
        title="Claude Desktop"
        hint={
          <>
            Put this in <code>claude_desktop_config.json</code>. Desktop
            only speaks stdio to local servers, so it goes through the{' '}
            <code>mcp-remote</code> bridge — that needs Node installed.
          </>
        }
        text={claudeDesktopConfig}
        copied={copied === 'claude-desktop'}
        onCopy={() => copy('claude-desktop', claudeDesktopConfig)}
      />
      <p className="settings-help">
        Ollama on its own is not an MCP client. Use a front-end that is
        — LM Studio, Goose, Open WebUI or Jan — and point it at your
        Ollama model.
      </p>
    </>
  )
}

function McpSnippet({
  title,
  hint,
  text,
  copied,
  onCopy
}: {
  title: string
  hint: React.ReactNode
  text: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="settings-row settings-row-grid">
      <span className="settings-label">{title}</span>
      <div className="settings-inline-input">
        <button type="button" className="settings-clear" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy config'}
        </button>
      </div>
      <pre className="settings-help settings-mcp-snippet">{text}</pre>
      <p className="settings-help">{hint}</p>
    </div>
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
          <code> 127.0.0.1:27384 </code>
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
  type Rollup = Awaited<ReturnType<typeof api.labelsRollup>>
  const [rollup, setRollup] = useState<Rollup | null>(null)
  const [rollupStatus, setRollupStatus] = useState<'idle' | 'loading' | 'error'>(
    'loading'
  )
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

  useEffect(() => {
    void refreshRollup()
  }, [])

  const triggerResetAll = async () => {
    const confirmed = window.confirm(
      'Reset ALL labels across every character?\n\n' +
        'Every stored IC/OOC verdict for every conversation reverts to ' +
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

  return (
    <>
      <PaneHeader
        title="Labels — IC / OOC"
        subtitle="Only labelled messages are indexed for search. Short messages and `((…` are OOC by rule; the rest is judged by a model you connect over MCP, or by you."
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
          </p>
        )}
        {rollup && rollup.unlabeled > 0 && (
          <p className="settings-help">
            Unlabeled messages are skipped by ingest — an unjudged message
            could be either roleplay or player chatter, and indexing the
            latter poisons search. To clear the backlog, ask a model
            connected through <strong>Settings → MCP</strong> to classify
            the conversation, or right-click individual messages in the log
            viewer.
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

      <div className="settings-section">
        <h3 className="settings-section-title">Rules</h3>
        <div className="settings-field">
          <label className="settings-label" htmlFor="labels-threshold">
            OOC threshold (chars)
          </label>
          <p className="settings-help">
            Chat messages shorter than this many characters are OOC without
            asking anyone. Applied at read time, so changing it takes effect
            immediately — no re-labelling needed.
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
        <p className="settings-help">
          Two more rules always apply and are not configurable: an empty
          message is OOC, and a message starting with <code>((</code> is OOC.
        </p>
      </div>
    </>
  )
}

function RetrievalPane({
  rag,
  draft,
  onChange
}: {
  rag: RagSettings
  draft: Draft['rag']
  onChange: (patch: Partial<Draft['rag']>) => void
}) {
  return (
    <>
      <PaneHeader
        title="Retrieval"
        subtitle="How searching your logs picks and ranks chunks. None of this requires a re-ingest."
      />

      <div className="settings-section">
        <h3 className="settings-section-title">Result shape</h3>
        <p className="settings-help">
          Applies to the <code>search_logs_semantic</code> MCP tool — the way
          a connected model reads your logs.
        </p>
        <NumericRow
          label="Top-K"
          help="Number of chunks returned per search."
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
            Runs locally — no inference server involved. Downloads on first
            use to <code>~/Documents/flist-workbench/models/</code>. Bigger
            multilingual models cost more disk + memory but recover recall on
            non-English corpora. Set to <strong>Disabled</strong> to skip
            reranking entirely.
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
          Optional retrieval extensions. Both off by default — turn each on
          once you've validated it improves results against your own logs.
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
        embed_model: draft.embed_model
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
        <h3 className="settings-section-title">Embedding model</h3>
        <p className="settings-help">
          Runs inside Workbench — there is no server to start and nothing to
          configure. The model downloads itself the first time it is used.
          Changing it invalidates every existing chunk, so a re-ingest is
          required afterwards.
        </p>
        <div className="settings-field">
          <label className="settings-label">{rag.embed_model}</label>
          <p className="settings-help">
            Chunk size follows this model's context window automatically; a
            chunk longer than the window would be silently truncated.
          </p>
          <div className="settings-actions">
            <button
              type="button"
              className="settings-pick"
              onClick={() => void runTest()}
              disabled={testStatus === 'running'}
              data-testid="rag-test-embedding"
            >
              {testStatus === 'running' ? 'Checking…' : 'Check model'}
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

function formatAbsoluteDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  if (isNaN(d.getTime())) return '—'
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatRelativeDueIn(unixSeconds: number): string {
  const now = Date.now() / 1000
  const delta = unixSeconds - now
  if (delta <= 0) return 'due now'
  const days = Math.round(delta / 86400)
  if (days < 1) {
    const hours = Math.round(delta / 3600)
    if (hours < 1) return 'in under an hour'
    return `in ${hours} hour${hours === 1 ? '' : 's'}`
  }
  return `in ${days} day${days === 1 ? '' : 's'}`
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
