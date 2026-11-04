import { useEffect, useMemo, useRef, useState } from 'react'
import type { ForeignSettings, LabelsSettings, RagSettings } from '../../lib/api'
import { formatBytes, MB } from '../../lib/bytes'
import { useStore } from '../../state'
import type { EmbeddingTestResult, Settings, SettingsPatch } from '../../state/slices/settings'
import { TrashedLabels } from '../flist/TrashedEntries'
import { IndexStatus } from '../rag/IndexStatus'

// The dialog's panes ask the sidecar nothing themselves: every read and
// write is a Settings slice action, and what they show of the sidecar's
// answers comes from the store.

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

export type SectionId =
  | 'general'
  | 'flist'
  | 'labels'
  | 'retrieval'
  | 'embedding'
  | 'mcp'
  | 'security'
  | 'foreign'

const SECTION_ORDER: ReadonlyArray<{ id: SectionId; label: string; subtitle: string }> = [
  { id: 'general', label: 'General', subtitle: 'Data directory + index status' },
  { id: 'flist', label: 'F-list', subtitle: 'Saved login + sign-in refresh' },
  { id: 'labels', label: 'Labels', subtitle: 'IC / OOC coverage + rules' },
  { id: 'retrieval', label: 'Retrieval', subtitle: 'How log search ranks results' },
  { id: 'embedding', label: 'RAG · Embedding', subtitle: 'Index shape (requires re-ingest)' },
  { id: 'mcp', label: 'MCP', subtitle: 'Let a model drive Workbench' },
  { id: 'security', label: 'Security', subtitle: 'Browser extension and pairing' },
  { id: 'foreign', label: 'Foreign profiles', subtitle: 'Cache size + clear' }
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
}

function buildDraft(state: Settings): Draft {
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
    }
  }
}

// Move the draft onto settings changed elsewhere: a field the user has
// not touched takes the new value, an edited one keeps the user's.
function rebaseDraft(draft: Draft, oldBase: Draft, newBase: Draft): Draft {
  const pick = <T,>(mine: T, old: T, next: T): T => (mine === old ? next : mine)
  const labels = { ...draft.labels }
  for (const k of Object.keys(labels) as (keyof Draft['labels'])[]) {
    labels[k] = pick(draft.labels[k], oldBase.labels[k], newBase.labels[k])
  }
  const rag = { ...draft.rag }
  for (const k of Object.keys(rag) as (keyof Draft['rag'])[]) {
    rag[k] = pick(draft.rag[k], oldBase.rag[k], newBase.rag[k]) as never
  }
  return {
    fchat_data_dir: pick(draft.fchat_data_dir, oldBase.fchat_data_dir, newBase.fchat_data_dir),
    labels,
    rag
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
  return {
    general: generalDirty,
    flist: false,
    labels: labelsDirty,
    retrieval: retrievalDirty,
    embedding: embeddingDirty,
    // Read-only panes — nothing to save, so never dirty.
    mcp: false,
    security: false,
    // Saves its cap with its own button, outside the footer's Save.
    foreign: false
  }
}

function anyDirty(d: Record<SectionId, boolean>): boolean {
  return d.general || d.labels || d.retrieval || d.embedding
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

export function SettingsModal({
  onClose,
  initialSection = 'general'
}: {
  onClose: () => void
  /** Section to open on, for callers that link to one directly. */
  initialSection?: SectionId
}) {
  const settings = useStore((s) => s.settings)
  const settingsError = useStore((s) => s.settingsError)
  const settingsLoad = useStore((s) => s.settingsLoad)
  const settingsSave = useStore((s) => s.settingsSave)
  // The settings the draft was built from. Null until this dialog's
  // own read answered: settings an earlier dialog read may be stale.
  const draftBaseRef = useRef<Settings | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [activeSection, setActiveSection] = useState<SectionId>(initialSection)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const firstFieldRef = useRef<HTMLInputElement | null>(null)
  const focusedOnceRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void settingsLoad().then(() => {
      const loaded = useStore.getState().settings
      if (cancelled || !loaded) return
      draftBaseRef.current = loaded
      setDraft(buildDraft(loaded))
    })
    return () => {
      cancelled = true
    }
  }, [settingsLoad])

  // The settings moved under the draft (a model changed them, or a
  // pane saved its own field): show the new values, but keep any field
  // the user has edited and not saved yet.
  useEffect(() => {
    const base = draftBaseRef.current
    if (!settings || !base || settings === base) return
    draftBaseRef.current = settings
    const oldBase = buildDraft(base)
    const newBase = buildDraft(settings)
    setDraft((d) => (d ? rebaseDraft(d, oldBase, newBase) : newBase))
  }, [settings])

  const baseline = useMemo(() => (settings ? buildDraft(settings) : null), [settings])
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
  }, [dirtyByDraft])

  // Wait until settings have loaded (and the General pane has therefore
  // rendered its inputs) before trying to focus — running this on
  // mount alone misses, the input isn't in the DOM yet. One-shot via a
  // ref so save-and-stay-on-the-modal doesn't yank focus back to the
  // dir input every time settings round-trip.
  useEffect(() => {
    if (focusedOnceRef.current || !draft) return
    focusedOnceRef.current = true
    const id = requestAnimationFrame(() => firstFieldRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [draft])

  const updateLabels = (patch: Partial<Draft['labels']>) =>
    setDraft((d) => (d ? { ...d, labels: { ...d.labels, ...patch } } : d))
  const updateRag = (patch: Partial<Draft['rag']>) =>
    setDraft((d) => (d ? { ...d, rag: { ...d.rag, ...patch } } : d))
  const updateGeneral = (patch: Partial<Pick<Draft, 'fchat_data_dir'>>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d))

  const saveAll = async () => {
    if (!settings || !draft || !dirtyByDraft) return
    // The remote-endpoint consent prompt that used to live here is
    // gone with the endpoints themselves: embedding runs in-process,
    // so no setting can send a log chunk anywhere any more.
    setSaveError(null)
    // Validate Labels threshold up-front — non-finite or zero would
    // be silently coerced by the sidecar to its default, which is
    // user-hostile. Other numerics are clamped here so out-of-range
    // typos resolve to sensible values.
    const parsedThreshold = Number(draft.labels.threshold_chars)
    if (!Number.isFinite(parsedThreshold) || parsedThreshold < 1) {
      setSaveError('Threshold must be a positive integer.')
      setActiveSection('labels')
      return
    }
    setSaving(true)
    const payload: SettingsPatch = {}
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
        settings.rag.chunk_max_chars
      )
      payload.rag = {
        embed_model: draft.rag.embed_model,
        rerank_model: draft.rag.rerank_model,
        rerank_candidates: clampInt(
          draft.rag.rerank_candidates,
          1,
          200,
          settings.rag.rerank_candidates
        ),
        top_k: clampInt(draft.rag.top_k, 1, 50, settings.rag.top_k),
        neighbors: clampInt(draft.rag.neighbors, 0, 5, settings.rag.neighbors),
        rerank_min_ratio: clampFloat(
          draft.rag.rerank_min_ratio,
          0,
          1,
          settings.rag.rerank_min_ratio
        ),
        hybrid_enabled: draft.rag.hybrid_enabled,
        hybrid_bm25_candidates: clampInt(
          draft.rag.hybrid_bm25_candidates,
          1,
          200,
          settings.rag.hybrid_bm25_candidates
        ),
        chunk_max_chars: nextChunkMax,
        chunk_soft_split_chars: clampInt(
          draft.rag.chunk_soft_split_chars,
          400,
          Math.max(500, nextChunkMax - 100),
          settings.rag.chunk_soft_split_chars
        ),
        chunk_overlap_msgs: clampInt(
          draft.rag.chunk_overlap_msgs,
          0,
          5,
          settings.rag.chunk_overlap_msgs
        )
      }
    }
    const error = await settingsSave(payload)
    setSaving(false)
    if (error) {
      setSaveError(error)
      return
    }
    // What was saved is the new baseline, clamped values included.
    const saved = useStore.getState().settings
    if (saved) {
      draftBaseRef.current = saved
      setDraft(buildDraft(saved))
    }
  }

  const discardAll = () => {
    if (!settings) return
    draftBaseRef.current = settings
    setDraft(buildDraft(settings))
    setSaveError(null)
  }

  // A failed first read is shown until this dialog has a draft; later
  // re-reads that fail leave the settings shown as they are.
  const shownError = saveError ?? (draft ? null : settingsError)

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
            {!draft && !settingsError && (
              <p className="settings-help">Loading settings…</p>
            )}
            {settings && draft && (
              <>
                {activeSection === 'general' && (
                  <GeneralPane
                    state={settings}
                    draft={draft}
                    onChange={updateGeneral}
                    firstFieldRef={firstFieldRef}
                  />
                )}
                {activeSection === 'flist' && <FlistPane />}
                {activeSection === 'labels' && (
                  <LabelsPane
                    labels={settings.labels}
                    draft={draft.labels}
                    onChange={updateLabels}
                  />
                )}
                {activeSection === 'retrieval' && (
                  <RetrievalPane
                    rag={settings.rag}
                    draft={draft.rag}
                    onChange={updateRag}
                  />
                )}
                {activeSection === 'embedding' && (
                  <EmbeddingPane
                    rag={settings.rag}
                    draft={draft.rag}
                    onChange={updateRag}
                  />
                )}
                {activeSection === 'mcp' && <McpPane />}
                {activeSection === 'security' && <SecurityPane />}
                {activeSection === 'foreign' && <ForeignPane foreign={settings.foreign} />}
              </>
            )}
          </div>
        </div>
        <footer className="settings-footer">
          {shownError && <span className="settings-error">{shownError}</span>}
          <span className="settings-footer-spacer" />
          <button
            type="button"
            className="settings-clear"
            onClick={discardAll}
            disabled={
              saving || !dirtyByDraft || !anyDirty(dirtyByDraft)
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
              saving || !dirtyByDraft || !anyDirty(dirtyByDraft)
            }
            data-testid="settings-save"
          >
            {saving ? 'Saving…' : 'Save'}
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
  state: Settings
  draft: Draft
  onChange: (patch: Partial<Pick<Draft, 'fchat_data_dir'>>) => void
  firstFieldRef: React.RefObject<HTMLInputElement>
}) {
  const envLocked = state.fchat_data_dir_env_locked

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
        <IndexStatus />
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
  const info = useStore((s) => s.mcpInfo)
  const loadError = useStore((s) => s.mcpError)
  const mcpLoadInfo = useStore((s) => s.mcpLoadInfo)
  const mcpCreateToken = useStore((s) => s.mcpCreateToken)
  const mcpRevokeToken = useStore((s) => s.mcpRevokeToken)
  const mcpSetLogText = useStore((s) => s.mcpSetLogText)
  // null until the sidecar has said whether the switch is on.
  const logText = useStore((s) => (s.settings ? (s.settings.mcp?.log_text ?? false) : null))
  const [actionError, setActionError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const error = actionError ?? loadError

  useEffect(() => {
    void mcpLoadInfo()
  }, [mcpLoadInfo])

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

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true)
    const failed = await action()
    if (failed) setActionError(failed)
    setBusy(false)
  }
  const setToken = (create: boolean) => run(create ? mcpCreateToken : mcpRevokeToken)
  // Saved at once, like the token: there is no draft to lose.
  const setLogTextOn = (on: boolean) => run(() => mcpSetLogText(on))

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
          <p className="settings-help" data-testid={`settings-mcp-tools-${endpoint.id}`}>
            {endpoint.tool_count} tools.
            {endpoint.id === 'all'
              ? ' Use this one unless your model struggles with long tool lists.'
              : ' A smaller set for models that get confused by the full list.'}
          </p>
        </div>
      ))}

      <h3 className="settings-section-h">Log text</h3>
      <div className="settings-row settings-row-grid">
        <span className="settings-label">Let MCP clients read Log text</span>
        <div className="settings-inline-input">
          <strong data-testid="settings-mcp-log-text-state">
            {logText === null ? '…' : logText ? 'On' : 'Off'}
          </strong>
          <button
            type="button"
            className="settings-clear"
            disabled={busy || logText === null}
            onClick={() => void setLogTextOn(!logText)}
            data-testid="settings-mcp-log-text-toggle"
          >
            {logText ? 'Turn off' : 'Turn on'}
          </button>
        </div>
        <p className="settings-help">
          Off by default. The tools that read, search or label your Logs
          return the messages themselves, your partners&apos; lines
          included. When the client runs a cloud model (Claude, ChatGPT
          and the like), its provider receives that text. With a local
          model in LM Studio or Ollama it stays on this computer. While
          this is off, those tools are missing from every endpoint, and
          IC/OOC labelling over MCP cannot fetch messages.
        </p>
      </div>

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

// Until the extension is in the stores, it ships inside the app and
// the user loads it into Chrome as an unpacked extension. Chrome does
// not let another program install it, nor open chrome:// pages for
// it, so the best the app can do is hand over the folder and the steps.
function BrowserExtensionInstall() {
  type Status = { bundled: string | null; installed: string | null; path: string }
  const bridge = window.workbench?.browserExtension
  const [status, setStatus] = useState<Status | null>(null)
  const running = useStore((s) => s.extensionRunningVersion)
  const loadRunning = useStore((s) => s.extensionLoadRunningVersion)
  const [msg, setMsg] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!bridge) return
    void bridge.status().then(setStatus, () => setStatus(null))
    void loadRunning()
  }, [bridge, loadRunning])

  if (!bridge) return null

  const reveal = async () => {
    const err = await bridge.reveal()
    setMsg(err || null)
  }

  const copyPath = async () => {
    if (!status) return
    try {
      await navigator.clipboard.writeText(status.path)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setMsg('Could not copy. Select the path above and copy it by hand.')
    }
  }

  const version = status?.installed ?? null
  const outdated = running !== null && version !== null && running !== version

  return (
    <>
      <h3 className="settings-section-h">Browser extension</h3>
      <div className="settings-section">
        <div className="settings-field">
          <span className="settings-label" data-testid="settings-extension-version">
            {version ? `Version ${version} included with this app` : 'Not included in this build'}
          </span>
          {running && (
            <p className="settings-help" data-testid="settings-extension-running">
              {outdated ? (
                <strong>
                  Your browser is still running {running}. Reload the extension on{' '}
                  <code>chrome://extensions</code>, or restart the browser, to use {version}.
                </strong>
              ) : (
                <>Your browser is running {running}.</>
              )}
            </p>
          )}
        </div>
        {version && status && (
          <div className="settings-field">
            <label className="settings-label" htmlFor="settings-extension-path">
              Install in Chrome or Edge
            </label>
            <div className="settings-row">
              <input
                id="settings-extension-path"
                type="text"
                className="settings-input"
                value={status.path}
                readOnly
                onFocus={(e) => e.target.select()}
                data-testid="settings-extension-path"
              />
              <button
                type="button"
                className="settings-pick"
                onClick={copyPath}
                data-testid="settings-extension-copy-path"
              >
                {copied ? 'Copied' : 'Copy path'}
              </button>
              <button
                type="button"
                className="settings-clear"
                onClick={reveal}
                data-testid="settings-extension-reveal"
              >
                Open folder
              </button>
            </div>
            <ol className="settings-help settings-steps">
              <li>
                Type <code>chrome://extensions</code> into the address bar
                (<code>edge://extensions</code> in Edge).
              </li>
              <li>Turn on <strong>Developer mode</strong>, top right.</li>
              <li>
                Click <strong>Load unpacked</strong> and choose the folder above. Pasting the
                copied path into the folder dialog is quickest.
              </li>
              <li>
                Pin the extension, click its icon and choose <strong>Pair with Workbench</strong>.
                Accept the prompt that appears here.
              </li>
            </ol>
            <p className="settings-help">
              Leave the folder where it is: the browser loads the extension from it on every
              start. App updates replace its contents, and the next browser restart picks
              them up.
            </p>
            {msg && <p className="settings-help"><strong>{msg}</strong></p>}
          </div>
        )}
      </div>
    </>
  )
}

function SecurityPane() {
  // Whether the sidecar holds an accepted pairing token; see
  // ExtensionPairing. 'unavailable' shows neither answer.
  const paired = useStore((s) => s.extensionPairing)
  const loadPairing = useStore((s) => s.extensionLoadPairing)
  const revokePairing = useStore((s) => s.extensionRevokePairing)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    void loadPairing()
  }, [loadPairing])

  const rotate = async () => {
    setBusy(true)
    setMsg(null)
    const failed = await revokePairing()
    setMsg(
      failed
        ? `Could not revoke: ${failed}`
        : 'Token revoked. The extension will need to re-pair on its next request.'
    )
    setBusy(false)
  }

  return (
    <>
      <BrowserExtensionInstall />
      <h3 className="settings-section-h">Browser-extension pairing</h3>
      <div className="settings-row settings-row-grid">
        <span className="settings-label">Status</span>
        <div className="settings-inline-input">
          <strong>
            {paired === 'paired' && '● Paired'}
            {paired === 'unpaired' && '○ Not paired'}
            {paired === 'checking' && '… Checking'}
            {paired === 'unavailable' && 'Pairing status unavailable'}
          </strong>
        </div>
        <p className="settings-help">
          The F-list Workbench browser extension talks to this app over
          <code> 127.0.0.1:27384 </code>
          using a per-install token. Pairing happens via an
          accept-this-extension prompt the first time the extension
          asks. The extension never sees your F-list session and this
          app never sees your F-list cookies — the extension just
          fetches the Workbench and Backups already stored here.
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
            disabled={busy || paired !== 'paired'}
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
      <ImageImportFolders />
    </>
  )
}

/** Folders a connected model may import images from (MCP
 *  `import_images`). Saved on every change, like the token rotation
 *  above: there is no draft to lose. Only this pane can set them — the
 *  MCP settings tool can read the list but not change it. */
function ImageImportFolders() {
  const settings = useStore((s) => s.settings)
  const roots = settings ? (settings.image_import_roots ?? []) : null
  const settingsSave = useStore((s) => s.settingsSave)
  const [error, setError] = useState<string | null>(null)

  const save = async (next: string[]) => {
    setError(null)
    setError(await settingsSave({ image_import_roots: next }))
  }

  const add = async () => {
    const picker = window.workbench?.selectDirectory
    if (!picker || !roots) return
    const chosen = await picker({ title: 'Allow importing images from this folder' })
    if (chosen) await save([...roots, chosen])
  }

  return (
    <>
      <h3 className="settings-section-h">Image import folders</h3>
      <div className="settings-import-roots" data-testid="settings-import-roots">
        <p className="settings-help">
          A model connected over MCP can copy images from these folders, and
          their subfolders, into a character&apos;s Pool with{' '}
          <code>import_images</code>. Nothing outside them can be read, and
          only you can change this list. The source files are copied, never
          moved or changed.
        </p>
        {roots === null && !error && <p className="settings-meta">… Loading</p>}
        {roots?.length === 0 && (
          <p className="settings-meta">None yet — a model cannot import any files.</p>
        )}
        {roots?.map((root) => (
          <div key={root} className="settings-row">
            <code className="settings-import-root">{root}</code>
            <button
              type="button"
              className="settings-clear"
              onClick={() => void save(roots.filter((r) => r !== root))}
              data-testid="settings-import-root-remove"
            >
              Remove
            </button>
          </div>
        ))}
        <div className="settings-row">
          <button
            type="button"
            className="settings-pick"
            onClick={() => void add()}
            disabled={roots === null || !window.workbench?.selectDirectory}
            data-testid="settings-import-root-add"
          >
            Add folder…
          </button>
        </div>
        {error && (
          <p className="settings-help">
            <strong>{error}</strong>
          </p>
        )}
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
  const rollup = useStore((s) => s.labelsRollup)
  const rollupStatus = useStore((s) => s.labelsRollupStatus)
  const loadRollup = useStore((s) => s.labelsLoadRollup)
  const clearAll = useStore((s) => s.labelsClearAll)
  const [resetStatus, setResetStatus] = useState<'idle' | 'resetting' | 'done' | 'error'>(
    'idle'
  )
  const [resetError, setResetError] = useState<string | null>(null)

  // Every cleared-Labels entry, whichever character it was cleared for:
  // a Log character with no Workbench has no character Trash view, so
  // this is the one place its cleared Labels can always be put back.
  const trashed = useStore((s) => s.labelsTrash)
  const trashError = useStore((s) => s.labelsTrashError)
  const loadTrash = useStore((s) => s.labelsLoadTrash)
  const putBack = useStore((s) => s.labelsTrashPutBack)
  const purge = useStore((s) => s.labelsTrashPurge)

  useEffect(() => {
    void loadRollup()
    void loadTrash()
  }, [loadRollup, loadTrash])
  // Labels another writer cleared (a model over MCP) land in the Trash.
  const labelsRevision = useStore((s) => s.labelsRevision)
  const seenLabelsRevision = useRef(labelsRevision)
  useEffect(() => {
    if (labelsRevision === seenLabelsRevision.current) return
    seenLabelsRevision.current = labelsRevision
    void loadTrash()
  }, [labelsRevision])

  const triggerResetAll = async () => {
    const confirmed = window.confirm(
      'Reset ALL labels across every character?\n\n' +
        'Every stored IC/OOC verdict for every conversation reverts to ' +
        'Unlabeled. Rule-based hints (short messages, "((", etc.) keep ' +
        'firing as OOC. A copy of each character’s labels goes to the ' +
        'Trash, listed below under Cleared Labels, where Put back returns ' +
        'them.'
    )
    if (!confirmed) return
    setResetStatus('resetting')
    setResetError(null)
    const failed = await clearAll()
    setResetStatus(failed ? 'error' : 'done')
    setResetError(failed)
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

      <div className="settings-section" data-testid="labels-trash">
        <h3 className="settings-section-title">Cleared Labels</h3>
        <p className="settings-help">
          Labels you clear, here or in a Log, go to the Trash and wait
          here for every character until you put them back or delete them
          for good.
        </p>
        {trashError && <p className="settings-help">Couldn’t read the Trash: {trashError}</p>}
        {!trashError && trashed.length === 0 && (
          <p className="settings-meta">No cleared Labels in the Trash.</p>
        )}
        <TrashedLabels
          heading="In the Trash"
          items={trashed}
          readOnly={false}
          putBack={putBack}
          purge={purge}
          onChanged={loadTrash}
        />
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
  const [testResult, setTestResult] = useState<EmbeddingTestResult | null>(null)

  const openIngest = useStore((s) => s.openIngest)
  const testEmbedding = useStore((s) => s.indexTestEmbedding)
  const wipeIndex = useStore((s) => s.indexWipe)
  const rebuildLexical = useStore((s) => s.indexRebuildLexical)
  const [wipeStatus, setWipeStatus] = useState<
    'idle' | 'wiping' | 'wiped' | 'error'
  >('idle')
  const [wipeError, setWipeError] = useState<string | null>(null)

  const runTest = async () => {
    setTestStatus('running')
    setTestResult(null)
    const result = await testEmbedding(draft.embed_model)
    setTestResult(result)
    setTestStatus(result.ok ? 'ok' : 'fail')
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
    const failed = await wipeIndex()
    setWipeStatus(failed ? 'error' : 'wiped')
    setWipeError(failed)
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
    const result = await rebuildLexical()
    setLexicalResult(result)
    setLexicalStatus('error' in result ? 'error' : 'done')
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

/** Settings → Foreign profiles. The cache of other people's profiles
 *  you opened, here or through a model: how much disk it takes, its
 *  cap, and a way to empty it. The cap saves with its own button, like
 *  the MCP switch, because the sidecar evicts at once when it drops. */
function ForeignPane({ foreign }: { foreign: ForeignSettings }) {
  const usage = useStore((s) => s.foreignCacheUsage)
  const loadError = useStore((s) => s.foreignCacheError)
  const loadUsage = useStore((s) => s.foreignCacheLoad)
  const saveCap = useStore((s) => s.foreignCacheSetCap)
  const clearCache = useStore((s) => s.foreignCacheClear)
  const [capRaw, setCapRaw] = useState<string>(String(foreign.cache_cap_mb))
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const error = actionError ?? loadError

  useEffect(() => {
    void loadUsage()
  }, [loadUsage])

  // The cap field follows the cap the sidecar reports.
  const capBytes = usage?.cap_bytes
  useEffect(() => {
    if (capBytes !== undefined) setCapRaw(String(Math.round(capBytes / MB)))
  }, [capBytes])

  const setCap = async () => {
    const n = Number(capRaw)
    if (!Number.isInteger(n) || n < 1) {
      setActionError('The cap must be a whole number of at least 1 MB.')
      return
    }
    setBusy(true)
    setActionError(null)
    setActionError(await saveCap(n))
    setBusy(false)
  }

  const clear = async () => {
    const ok = window.confirm(
      'Delete every cached Foreign profile, images included?\n\n' +
        'They are copies of other people’s profiles, so they do not go ' +
        'to the Trash. Opening a profile again fetches it from F-list.'
    )
    if (!ok) return
    setBusy(true)
    setActionError(null)
    setActionError(await clearCache())
    setBusy(false)
  }

  return (
    <>
      <PaneHeader
        title="Foreign profiles"
        subtitle="Profiles of other people's characters you opened, here or through a model, are cached on disk until the cap below evicts them."
      />

      <div className="settings-section">
        <h3 className="settings-section-title">Cache</h3>
        <p className="settings-help">
          Each Foreign profile you open is kept with its gallery images and
          avatar, so opening it again costs no F-list request. When the cache
          outgrows its cap, the least recently viewed profiles go first; the
          one you are viewing always stays. A profile F-list no longer shows
          (deleted, private or blocked) is deleted at once. The activity log
          (Help → F-list Activity Log) records which profiles a model fetched.
        </p>
        <p className="settings-meta">
          In use:{' '}
          <strong data-testid="settings-foreign-cache-used">
            {usage
              ? `${formatBytes(usage.bytes)} in ${usage.profiles.toLocaleString()} profile${
                  usage.profiles === 1 ? '' : 's'
                }`
              : '…'}
          </strong>
        </p>
        <div className="settings-field">
          <label className="settings-label" htmlFor="foreign-cache-cap">
            Cap (MB)
          </label>
          <div className="settings-row">
            <input
              id="foreign-cache-cap"
              type="number"
              min={1}
              step={1}
              className="settings-input settings-input-narrow"
              value={capRaw}
              onChange={(e) => setCapRaw(e.target.value)}
              data-testid="settings-foreign-cache-cap"
            />
            <button
              type="button"
              className="settings-save"
              onClick={() => void setCap()}
              disabled={busy}
              data-testid="settings-foreign-cache-cap-set"
            >
              Set cap
            </button>
            <button
              type="button"
              className="settings-clear"
              onClick={() => setCapRaw(String(foreign.defaults.cache_cap_mb))}
            >
              Default ({foreign.defaults.cache_cap_mb})
            </button>
          </div>
          <p className="settings-help settings-help-tight">
            A lower cap evicts profiles right away; a higher one applies from
            the next profile you open or refresh.
          </p>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            className="settings-clear"
            onClick={() => void clear()}
            disabled={busy || usage?.profiles === 0}
            data-testid="settings-foreign-cache-clear"
          >
            Clear the cache…
          </button>
          {error && <span className="settings-meta classify-last-error">{error}</span>}
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
