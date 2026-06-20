type ApiOptions = { signal?: AbortSignal }

export type InlineImage = { hash: string; extension: string; nsfw: boolean }

export type CharacterEntry = { name: string; mtime: number }

// ---- F-list character archive (Phase 7 Tier 1) ----

export type FlistAccountCharacter = {
  name: string
  id: number | string | null
}

export type FlistSessionStatus = {
  active: boolean
  account?: string
  expires_in_sec?: number
  needs_refresh?: boolean
  api_hourly_count?: number
  // True while the sidecar still has the password cached for
  // auto-refresh. False after the idle watchdog drops it.
  password_cached?: boolean
  // Seconds remaining until the idle watchdog drops the cached
  // password; null when nothing is cached. Used by the renderer to
  // surface a pre-drop warning banner.
  password_idle_seconds_remaining?: number | null
}

export type FlistPullStatus = {
  status: 'never_pulled' | 'unknown' | 'interrupted' | 'partial' | 'complete'
  missing_image_ids: { image_id: string; extension: string }[]
  expected: number
  present: number
  last_attempt_ts: number | null
}

export type FlistRosterEntry = {
  name: string
  id: number | string | null
  on_account: boolean
  has_archive: boolean
  has_logs: boolean
  last_pulled_at: number | null
  /** Count of JSON snapshots in `snapshots/` — the auto-on-pull
   *  history. Cheap; one per F-list-side change. */
  snapshot_count: number
  /** Count of ZIP backups in `backups/` — the explicit "Back up"
   *  artefacts that include images + avatar. */
  backup_count: number
  // Only present for rows where has_archive is true. Surfaces whether
  // a prior pull was interrupted or had image failures so the renderer
  // can prompt the user to resume.
  pull_status?: FlistPullStatus
}

/** A single JSON-snapshot entry as listed by /flist/character/<id>/snapshots.
 *  Each snapshot is the full Live JSON captured at the time the
 *  corresponding pull noticed an F-list-side change. */
export type FlistSnapshotEntry = {
  filename: string
  created_at: number
  size: number
}

/** A single ZIP-backup entry as listed by /flist/character/<id>/zip-backups.
 *  Each backup is a userscript-restoreable archive (JSON + images +
 *  avatar) written by the Tools → Back up all sweep or the per-
 *  character right-click → Back up now action. `kind` is read from
 *  the embedded `backup-meta.json` (added 2026-06-17); older backups
 *  predating that write come back as `"unknown"`. */
export type FlistZipBackupKind =
  | 'manual_single'
  | 'manual_bulk'
  | 'import'
  | 'scheduled'
  | 'unknown'

export type FlistZipBackupEntry = {
  filename: string
  created_at: number
  size: number
  kind: FlistZipBackupKind
  /** User-set name from `_names.json`. `null` when the user hasn't
   *  renamed this backup yet — the UI then derives a default label
   *  from the timestamp. */
  name: string | null
}

export type FlistCharacterImage = {
  image_id: string
  extension: string
  size: number
  /** File mtime in unix seconds. Used to sort the Pool pane newest-
   *  first; absent on older sidecar builds, in which case the renderer
   *  falls back to image_id order. */
  added_at?: number
}

// ---- Working-sets v2 wire types -------------------------------------
//
// Snake_case at the wire layer matches the sidecar contract; the store
// converts to camelCase via _setMetaFromWire so in-memory `SetMeta`
// stays consistent with the rest of the slice (e.g. `lastSavedAt`).

export type SetMetaWire = {
  id: string
  name: string
  created_at: number
  updated_at: number
}

export type FlistSetImportResult = {
  set: SetMetaWire
  source: {
    character_id: string
    character_name: string
    set_id: string
    set_name: string
  }
  image_stats: { added: number; skipped: number }
  cross_character: boolean
}

export type SetsListResponseWire = {
  sets: SetMetaWire[]
  active_set_id: string | null
}

export type SetActivateResponseWire = {
  active_set_id: string | null
}

export type FlistPullHandlers = {
  onQueued?: () => void
  onTicket?: () => void
  onFetching?: () => void
  onImages?: (info: { total: number }) => void
  onImage?: (info: {
    index: number
    total: number
    image_id: string
    ok: boolean
    cached?: boolean
    error?: string
  }) => void
  onDone?: (info: {
    character_id: string
    name: string
    image_count: number
    image_downloaded?: number
    image_cached?: number
    image_failed: number
    pull_status?: FlistPullStatus['status']
    pull_missing?: number
  }) => void
  onError?: (info: { stage: string; message: string }) => void
}

export type FlistBackupAllCharacterEvent = {
  name: string
  character_id?: string
  status: 'fetching' | 'saved' | 'unchanged' | 'error'
  filename?: string
  message?: string
}

export type FlistBackupAllHandlers = {
  onStart?: (info: { total: number }) => void
  onQueued?: () => void
  onCharacter?: (info: FlistBackupAllCharacterEvent) => void
  onDone?: (info: {
    total: number
    saved: number
    unchanged: number
    failed: number
  }) => void
  onError?: (info: { stage: string; message: string }) => void
}

export type Profile = {
  name: string
  avatar_url: string | null
  stats: Record<string, string>
  bbcode: string
  inlines: Record<string, InlineImage>
}

export type PartnerEntry = {
  name: string
  bytes: number
  // Alternate names linked to this partner via the alias system.
  // Empty array for unaliased entries. The entry's `name` is the
  // primary; `aliases` are the other members of the group.
  aliases: string[]
}

export type AliasGroups = Record<string, string[]>

export type Label = 'IC' | 'OOC' | 'Unlabeled' | 'Failed'
// 'failed' is a synthetic source the sidecar attaches when a
// label_failures row exists but no labels row does — there's nothing
// in the labels table proper, just a record that the classifier tried
// and couldn't produce a usable answer.
export type LabelSource = 'llm' | 'manual' | 'failed'
export type PriorSource = 'llm' | 'manual' | null

export type LogMessage = {
  ts: number
  iso: string
  type: number
  type_name: string
  speaker: string
  raw: string
  text: string
  mentions: string[]
  // kind is F-Chat's message type bucket (chat/action vs ad/roll/warn/event).
  // Used to keep "System" filtering working independently of semantic IC/OOC.
  kind: 'ic' | 'ooc' | 'system'
  // Sidecar-computed sha1(ts|speaker|raw)[:16] used as the labels-DB
  // primary key. The renderer passes this back when overriding.
  hash: string
  // label is the semantic IC/OOC classification from the resolver. Always
  // present for chat/action messages; absent label_source means rule-or-unlabeled
  // (no explicit DB row).
  label?: Label
  label_source?: LabelSource
  // Free-text reason the model gave for the verdict (LLM source) or
  // "manual override" / similar (manual source). Surfaced in the
  // badge tooltip so users can audit why a label was chosen.
  label_reason?: string
  // Snapshot of what the label was before the most recent change.
  // Present only on manual overrides; lets the UI surface "LLM had
  // said IC; you changed it to OOC" without a separate lookup.
  prior_label?: 'IC' | 'OOC'
  prior_source?: 'llm' | 'manual'
  // Present when label === 'Failed'. Holds the classifier's error
  // message (truncated) so the badge tooltip can explain why the
  // message couldn't be classified — e.g. "bad json: '<garbage>'" or
  // "api error: HTTP 500". The full prompt + context lives in
  // <user_data>/classify-failures.log, surfaced via Tools → Open log.
  label_error?: string
}

export type PromptPreset = {
  id: string
  label: string
  language: string
  description: string
  body: string
}

export type LabelsSettings = {
  threshold_chars: number
  llm_endpoint: string
  llm_model: string
  llm_api_key: string
  system_prompt: string
  context_before: number
  context_after: number
  defaults: {
    threshold_chars: number
    llm_endpoint: string
    llm_model: string
    llm_api_key: string
    system_prompt: string
    context_before: number
    context_after: number
  }
  // Bundled system-prompt presets the user can pick from. First entry's
  // body matches `defaults.system_prompt` and is therefore the
  // "Reset to default" target.
  prompt_presets: PromptPreset[]
}

// ---- AI assistant draft + chat shapes (Phase 9) ----------------------

/** One proposed edit inside `ai-draft.json`. The renderer reuses the
 *  Tier 4 DiffRow component to render `text_replace` / `value_replace`
 *  kinds and renders composite cards (sharing a `composite_id`) as a
 *  single summary with expand. */
export type AiDraftEdit = {
  id: string
  tool: string
  field_path: string
  kind:
    | 'text_replace'
    | 'value_replace'
    | 'value_clear'
    | 'text_patch'
    | 'custom_kink_add'
    | 'custom_kink_remove'
    | 'image_add'
    | 'image_remove'
    | 'gallery_reorder'
  old_value?: unknown
  new_value?: unknown
  old_excerpt?: string
  new_label_hint?: string
  rationale: string
  status: 'pending' | 'stale' | 'accepted' | 'rejected'
  composite_id: string | null
  created_at?: string
}

export type AiDraft = {
  schema_version: number
  base_etag: string | null
  base_working_schema_version: number
  created_at: string
  updated_at: string
  model_endpoint: string
  model_id: string
  edits: AiDraftEdit[]
}

/** OpenAI-style message shape the chat endpoint accepts. `tool_calls`
 *  / `tool_call_id` mirror the OpenAI function-calling contract;
 *  Workbench's chat layer relays them between turns without parsing. */
export type AssistantChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
  /** Set on assistant turns whose content was coerced from
   *  `reasoning_content` (thinking model ran out of budget). Renderer
   *  dims + labels these so the user knows it's reasoning, not a
   *  final answer. Local-only annotation, not sent to the sidecar. */
  _from_reasoning?: boolean
}

/** Captured tool-call → tool-result pair surfaced to the transcript
 *  so the user can see exactly which tool the model invoked and
 *  whether it succeeded. Rejections (anchor_mismatch, stale_base,
 *  bbcode_fidelity, etc.) surface here too with the reason code. */
export type AssistantToolEvent = {
  callId: string
  tool: string
  args: Record<string, unknown>
  ok: boolean
  error?: string
  /** Compact human-readable summary used in chip tooltips. */
  resultSummary?: string
  /** Edit ids the tool landed in the draft (zero-length when the
   *  tool was a read or every edit was rejected). The renderer
   *  groups proposal cards by turn using this — each turn renders
   *  the cards for its own edits inline. */
  acceptedEditIds?: string[]
}

export type AssistantChatHandlers = {
  onStart?: (data: { model_id: string; model_endpoint: string }) => void
  onText?: (data: {
    content: string
    round: number
    /** True when the sidecar coerced the model's reasoning_content
     *  into the visible content because the regular `content` field
     *  was empty — the model ran out of token budget reasoning.
     *  Renderer dims this and labels it "Model thinking (no final
     *  answer)" so users don't mistake reasoning for a reply. */
    from_reasoning?: boolean
  }) => void
  onToolCall?: (data: {
    round: number
    tool: string
    args: Record<string, unknown>
    call_id: string
  }) => void
  onToolResult?: (data: {
    round: number
    call_id: string
    ok: boolean
    result?: unknown
    error?: string
  }) => void
  onDraftUpdate?: (data: { draft: AiDraft }) => void
  onError?: (data: { code: string; message: string }) => void
  onDone?: (data: Record<string, unknown>) => void
}

export type AiAssistantSettings = {
  /** Master opt-in toggle. Until on, the Tools menu hides the
   *  Character Assistant entry, the bottom-dock pane never mounts,
   *  and every assistant + ai-draft sidecar endpoint refuses with
   *  feature_disabled. */
  enabled: boolean
  endpoint: string
  model: string
  api_key: string
  system_prompt: string
  temperature: number
  token_budget: number
  timeout_sec: number
  warn_non_loopback: boolean
  log_requests: boolean
  /** Workaround for Qwen 3.x family thinking-loop failures. When on,
   *  the sidecar appends `/no_think` to the resolved system prompt
   *  every turn so the model skips its chain-of-thought phase. Other
   *  model families ignore it as literal text. Default OFF. */
  append_no_think: boolean
  defaults: {
    temperature: number
    token_budget: number
    timeout_sec: number
    warn_non_loopback: boolean
    log_requests: boolean
    system_prompt: string
  }
  /** Same shape as labels.prompt_presets — drives the shared
   *  PromptPresetPicker. First entry is the "Reset to default"
   *  target. Currently ships four: NSFW/SFW × English/German.
   *  Also re-exposed in the assistant chat dock so the user can
   *  switch language/tone without leaving the conversation. */
  prompt_presets: PromptPreset[]
}

export type BackupsSettings = {
  /** Day interval for the scheduled-on-start sweep. 0 disables. */
  scheduled_interval_days: number
  /** Maximum scheduled backups kept per character. Older entries are
   *  pruned after each successful scheduled write. */
  scheduled_keep_last_n: number
  defaults: {
    scheduled_interval_days: number
    scheduled_keep_last_n: number
  }
  /** Telemetry from the last sweep run. `null` epochs mean the sweep
   *  has never executed in this install — the UI shows "Never run"
   *  instead of a stale relative time. */
  last_sweep: {
    started_at: number | null
    finished_at: number | null
    written: number
    skipped: number
    failed: number
    /** 'on_start' (sidecar boot) or 'manual' (user pressed the
     *  Trigger button in Settings). `null` only when no run has
     *  happened yet. */
    source: 'on_start' | 'manual' | null
  }
  /** Computed `last_sweep.started_at + interval_days × 86400`. `null`
   *  when no sweep has run yet, or when interval=0 (sweep disabled).
   *  UI renders the countdown ("in 3 days" / "due now"). */
  next_due_at: number | null
}

export type RagSettings = {
  embed_endpoint: string
  embed_model: string
  embed_api_key: string
  embed_query_prefix: string
  embed_document_prefix: string
  chat_endpoint: string
  chat_model: string
  chat_api_key: string
  chat_system_prompt: string
  rerank_model: string
  rerank_candidates: number
  top_k: number
  neighbors: number
  rerank_min_ratio: number
  hybrid_enabled: boolean
  hybrid_bm25_candidates: number
  multiquery_enabled: boolean
  multiquery_variants: number
  chat_num_ctx: number
  chat_embed_keep_alive: string
  chunk_max_chars: number
  chunk_soft_split_chars: number
  chunk_overlap_msgs: number
  defaults: {
    embed_endpoint: string
    embed_model: string
    embed_api_key: string
    embed_query_prefix: string
    embed_document_prefix: string
    chat_endpoint: string
    chat_model: string
    chat_api_key: string
    chat_system_prompt: string
    rerank_model: string
    rerank_candidates: number
    top_k: number
    neighbors: number
    rerank_min_ratio: number
    hybrid_enabled: boolean
    hybrid_bm25_candidates: number
    multiquery_enabled: boolean
    multiquery_variants: number
    chat_num_ctx: number
    chat_embed_keep_alive: string
    chunk_max_chars: number
    chunk_soft_split_chars: number
    chunk_overlap_msgs: number
  }
  /** Shipped chat-prompt presets the user can swap between in the
   *  Settings UI. Same shape as labels.prompt_presets — drives the
   *  shared `PromptPresetPicker`. Currently ships English (default),
   *  German, and language-agnostic minimal. */
  prompt_presets: PromptPreset[]
}

export type RagCitation = {
  chunk_id: string | null
  char_owner: string | null
  partner: string | null
  date: string | null
  label: string | null
  ts_start: number | null
  ts_end: number | null
  speakers: string[]
  score: number
  rerank_score?: number | null
  expanded: boolean
}

export type RagQueryScope = {
  character?: string | null
  partner?: string | null
  partners?: string[] | null
}

export type RagQueryHandlers = {
  onRetrieved?: (info: {
    hit_count: number
    rerank_applied: boolean
    rerank_model: string | null
    embed_model: string
    hybrid_applied?: boolean
    hybrid_lexical_hits?: number
  }) => void
  // Emitted between the optional multi-query expansion step and the
  // first dense retrieval round. `variants` lists the extra queries
  // the LLM generated — the original question is NOT included.
  onExpanded?: (info: { variants: string[] }) => void
  onToken?: (content: string) => void
  onDone?: (citations: RagCitation[]) => void
  onError?: (info: { stage: string; message: string }) => void
}

export type LabelsStats = {
  character: string
  partner: string
  ic: number
  ooc: number
  unlabeled: number
  failed: number
  total: number
}

export type ClassifyJobScope = {
  character?: string | null
  partner?: string | null
}

export type ClassifyJob = {
  id: string
  scope: { character?: string; partner?: string }
  overwrite: boolean
  state: 'pending' | 'running' | 'done' | 'cancelled' | 'failed'
  classified: number
  failed: number
  total: number
  skipped_existing: number
  skipped_rule: number
  last_label?: string | null
  last_error?: string | null
  current_partner?: string | null
  error?: string | null
  created_at: number
  finished_at?: number | null
}

export type IngestJobScope = ClassifyJobScope

export type IngestJob = {
  id: string
  scope: { character?: string; partner?: string }
  include_ooc: boolean
  force_rewipe: boolean
  state: 'pending' | 'running' | 'done' | 'cancelled' | 'failed'
  chunked: number
  embedded: number
  upserted: number
  skipped_existing: number
  failed: number
  total_chunks: number
  current_partner?: string | null
  last_error?: string | null
  error?: string | null
  model_swap: boolean
  embed_model?: string | null
  embed_dimension?: number | null
  created_at: number
  finished_at?: number | null
}

export type RagStatus = {
  embed_model: string | null
  embed_dimension: number | null
  last_ingest_at: number | null
  chunk_count: number
}

function base(): string {
  return window.workbench?.sidecarUrl ?? 'http://127.0.0.1:27384'
}

function dispatchSseBlock(block: string, handlers: RagQueryHandlers): void {
  let event: string | null = null
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim())
  }
  if (!event) return
  const data = dataLines.join('\n')
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    // Sidecar always emits JSON; a malformed payload is a bug, drop it.
    return
  }
  if (event === 'retrieved' && handlers.onRetrieved) {
    handlers.onRetrieved(parsed as Parameters<NonNullable<RagQueryHandlers['onRetrieved']>>[0])
  } else if (event === 'expanded' && handlers.onExpanded) {
    handlers.onExpanded(parsed as { variants: string[] })
  } else if (event === 'token' && handlers.onToken) {
    handlers.onToken((parsed as { content: string }).content)
  } else if (event === 'done' && handlers.onDone) {
    handlers.onDone((parsed as { citations: RagCitation[] }).citations)
  } else if (event === 'error' && handlers.onError) {
    handlers.onError(parsed as { stage: string; message: string })
  }
}

/** SSE dispatcher for the /assistant/chat stream. Mirrors
 *  dispatchSseBlock's parsing approach so error surfaces are uniform;
 *  the assistant's event vocabulary (start/text/tool_call/tool_result/
 *  draft_update/done/error) lives entirely in this function. */
function dispatchAssistantSseBlock(
  block: string,
  handlers: AssistantChatHandlers
): void {
  let event: string | null = null
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim())
  }
  if (!event) return
  let parsed: unknown
  try {
    parsed = JSON.parse(dataLines.join('\n'))
  } catch {
    return
  }
  const data = parsed as Record<string, unknown>
  switch (event) {
    case 'start':
      handlers.onStart?.(data as Parameters<NonNullable<AssistantChatHandlers['onStart']>>[0])
      break
    case 'text':
      handlers.onText?.(data as Parameters<NonNullable<AssistantChatHandlers['onText']>>[0])
      break
    case 'tool_call':
      handlers.onToolCall?.(data as Parameters<NonNullable<AssistantChatHandlers['onToolCall']>>[0])
      break
    case 'tool_result':
      handlers.onToolResult?.(data as Parameters<NonNullable<AssistantChatHandlers['onToolResult']>>[0])
      break
    case 'draft_update':
      handlers.onDraftUpdate?.(data as Parameters<NonNullable<AssistantChatHandlers['onDraftUpdate']>>[0])
      break
    case 'error':
      handlers.onError?.(data as Parameters<NonNullable<AssistantChatHandlers['onError']>>[0])
      break
    case 'done':
      handlers.onDone?.(data)
      break
  }
}

// Mid-session ticket recovery. The sidecar holds the F-list password
// in RAM only and drops it after an idle window (P0-C safety), so a
// long-running session eventually loses the ability to auto-refresh
// its ticket and the next /flist/* call returns 401. If the user saved
// their password to the OS keychain we can transparently re-sign in
// and retry, so they don't see "invalid ticket" pop up.
let recoveryInFlight: Promise<boolean> | null = null
async function tryFlistRecovery(): Promise<boolean> {
  if (recoveryInFlight) return recoveryInFlight
  recoveryInFlight = (async () => {
    const creds = (globalThis as { workbench?: { creds?: WindowCreds } })
      .workbench?.creds
    if (!creds) return false
    try {
      const meta = await creds.getMeta()
      // Only recover transparently when the user opted into auto-login.
      // hasPassword without autoLogin means "pre-fill the modal" — they
      // expect a confirmation step, so surface the 401 normally and let
      // the sign-in modal handle it.
      if (!meta.autoLogin || !meta.hasPassword || !meta.account) return false
      const password = await creds.getPassword()
      if (!password) return false
      const res = await fetch(`${base()}/flist/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: meta.account, password })
      })
      if (res.ok) {
        // Let the renderer refresh its FlistSessionStatus so the sidebar
        // chip stops showing "expired" after we just resurrected it.
        window.dispatchEvent(new CustomEvent('flist-session-recovered'))
        return true
      }
      // Surface the failure so debugging "autologin not reliable" has
      // something to read in DevTools — the alternative is a silent
      // false that leaves the user wondering why the modal popped.
      console.warn('[flist] auto-recovery POST /flist/session failed:', res.status)
      return false
    } catch (e) {
      console.warn('[flist] auto-recovery threw:', e)
      return false
    } finally {
      // Cleared in microtask so concurrent callers that joined this
      // promise still see the resolved value before a fresh attempt.
      queueMicrotask(() => {
        recoveryInFlight = null
      })
    }
  })()
  return recoveryInFlight
}

type WindowCreds = {
  getMeta: () => Promise<{
    account: string | null
    autoLogin: boolean
    encryptionAvailable: boolean
    hasPassword: boolean
  }>
  getPassword: () => Promise<string | null>
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  opts?: ApiOptions,
  // Internal — set on the retry leg after a successful recovery so a
  // second 401 surfaces normally instead of looping.
  _retried = false
): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    ...init,
    signal: opts?.signal,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {})
    }
  })
  if (
    res.status === 401 &&
    !_retried &&
    path.startsWith('/flist/') &&
    path !== '/flist/session'
  ) {
    if (await tryFlistRecovery()) {
      return request<T>(path, init, opts, true)
    }
    // Recovery didn't fire (no autoLogin, no stored password) or it
    // tried and failed. Either way the user needs to re-authenticate
    // mid-session — surface this as an event so AppLayout can open the
    // sign-in modal. Without this, /flist/mapping-list 401-stuck leaves
    // the kink picker and diff silently empty.
    window.dispatchEvent(new CustomEvent('flist-session-expired'))
  }
  if (!res.ok) {
    let detail: string | undefined
    try {
      detail = ((await res.json()) as { detail?: string })?.detail
    } catch {
      // not JSON
    }
    throw new Error(`HTTP ${res.status}: ${detail ?? res.statusText}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

async function get<T>(path: string, opts?: ApiOptions): Promise<T> {
  return request<T>(path, {}, opts)
}

export const api = {
  base,
  health: () => get<{ status: string; version: string }>('/health'),
  eiconsSearch: (q: string, limit = 200, opts?: ApiOptions) =>
    get<{
      eicons: string[]
      total: number
      as_of: number
      status: 'loading' | 'ready' | 'error'
      error: string | null
    }>(`/eicons/search?q=${encodeURIComponent(q)}&limit=${limit}`, opts),
  characters: () => get<{ characters: CharacterEntry[] }>('/logs/characters'),
  partners: (char: string) =>
    get<{ character: string; partners: PartnerEntry[] }>(
      `/logs/partners?char=${encodeURIComponent(char)}`
    ),
  messages: (char: string, partner: string) =>
    get<{ character: string; partner: string; messages: LogMessage[] }>(
      `/logs/messages?char=${encodeURIComponent(char)}&partner=${encodeURIComponent(partner)}`
    ),
  searchAll: (char: string, q: string) =>
    get<{
      character: string
      query: string
      partners: {
        partner: string
        bytes: number
        hits: (LogMessage & { index: number })[]
        truncated: boolean
      }[]
    }>(`/logs/search_all?char=${encodeURIComponent(char)}&q=${encodeURIComponent(q)}`),
  aliasesList: (char: string) =>
    get<{ character: string; groups: AliasGroups }>(
      `/aliases?char=${encodeURIComponent(char)}`
    ),
  aliasesAdd: (body: { character: string; name: string; primary_name: string }) =>
    request<{ character: string; primary_name: string; group: string[] }>(
      '/aliases',
      { method: 'POST', body: JSON.stringify(body) }
    ),
  aliasesRemove: (char: string, name: string) =>
    request<{ character: string; name: string; removed: boolean }>(
      `/aliases?char=${encodeURIComponent(char)}&name=${encodeURIComponent(name)}`,
      { method: 'DELETE' }
    ),
  aliasesUnlinkGroup: (char: string, primary: string) =>
    request<{ character: string; primary: string; deleted: number }>(
      `/aliases/group?char=${encodeURIComponent(char)}&primary=${encodeURIComponent(primary)}`,
      { method: 'DELETE' }
    ),
  findContacts: (name: string) =>
    get<{
      name: string
      dm: { character: string; partner: string; bytes: number; mtime: number }[]
    }>(`/logs/contacts?name=${encodeURIComponent(name)}`),

  settingsGet: () =>
    get<{
      fchat_data_dir: string | null
      fchat_data_dir_effective: string
      fchat_data_dir_env_locked: boolean
      labels: LabelsSettings
      rag: RagSettings
      backups: BackupsSettings
      ai_assistant: AiAssistantSettings
    }>('/settings'),
  settingsUpdate: (body: {
    fchat_data_dir?: string | null
    labels?: Partial<Omit<LabelsSettings, 'defaults'>>
    rag?: Partial<Omit<RagSettings, 'defaults'>>
    backups?: Partial<Omit<BackupsSettings, 'defaults'>>
    ai_assistant?: Partial<Omit<AiAssistantSettings, 'defaults'>>
  }) =>
    request<{
      fchat_data_dir: string | null
      fchat_data_dir_effective: string
      fchat_data_dir_env_locked: boolean
      labels: LabelsSettings
      rag: RagSettings
      backups: BackupsSettings
      ai_assistant: AiAssistantSettings
    }>('/settings', {
      method: 'PUT',
      body: JSON.stringify(body)
    }),
  labelsStats: (char: string, partner: string) =>
    get<LabelsStats>(
      `/labels/stats?char=${encodeURIComponent(char)}&partner=${encodeURIComponent(partner)}`
    ),
  // Batch coverage stats for every partner of a character. Lets the
  // sidebar render per-partner pips in a single roundtrip instead of
  // fanning out 30+ /labels/stats requests on first paint.
  labelsStatsAll: (char: string) =>
    get<{
      character: string
      partners: Array<{
        partner: string
        ic: number
        ooc: number
        unlabeled: number
        failed: number
        total: number
        // Epoch seconds. `log_mtime > last_label_at` means the
        // conversation grew since the last classify run — surfaced as
        // a stale dot in the sidebar.
        log_mtime: number | null
        last_label_at: number | null
      }>
    }>(`/labels/stats-all?char=${encodeURIComponent(char)}`),
  labelsClear: (body: { character: string; partner: string }) =>
    request<{ character: string; partner: string; deleted: number }>(
      '/labels/clear',
      {
        method: 'POST',
        body: JSON.stringify(body)
      }
    ),
  labelsClearAll: () =>
    request<{ labels_deleted: number; failures_deleted: number }>(
      '/labels/clear-all',
      { method: 'POST' }
    ),
  labelsRollup: () =>
    get<{
      ic: number
      ooc: number
      unlabeled: number
      failed: number
      manual: number
      total: number
      character_count: number
    }>('/labels/rollup'),
  labelsJobHistory: (limit = 20) =>
    get<{
      jobs: Array<{
        id: string
        scope: { character?: string; partner?: string }
        state: 'done' | 'cancelled' | 'failed'
        classified: number
        failed: number
        total: number
        started_at: number
        finished_at: number
        error: string | null
      }>
      limit: number
    }>(`/labels/job-history?limit=${limit}`),
  labelsOverride: (body: {
    character: string
    partner: string
    hash: string
    ts: number
    speaker: string
    label: Label | null
  }) =>
    request<{
      hash: string
      label: Label | null
      source?: LabelSource
      prior_label?: Label | null
      prior_source?: LabelSource | null
      deleted?: boolean
    }>('/labels/override', {
      method: 'POST',
      body: JSON.stringify(body)
    }),
  labelsClassifyStart: (
    scope: ClassifyJobScope,
    opts: { overwrite?: boolean } = {}
  ) =>
    request<ClassifyJob>('/labels/classify', {
      method: 'POST',
      body: JSON.stringify({ ...scope, overwrite: opts.overwrite ?? false })
    }),
  labelsTestConnection: (body: {
    llm_endpoint?: string
    llm_model?: string
    llm_api_key?: string
    system_prompt?: string
  }) =>
    request<{
      ok: boolean
      elapsed_ms: number
      error?: string | null
      raw?: string
      parsed?: { label: 'IC' | 'OOC'; reason: string } | null
    }>('/labels/test-connection', {
      method: 'POST',
      body: JSON.stringify(body)
    }),
  ragTestEmbedding: (body: {
    embed_endpoint?: string
    embed_model?: string
    embed_api_key?: string
    embed_query_prefix?: string
    embed_document_prefix?: string
  }) =>
    request<{
      ok: boolean
      elapsed_ms: number
      dimension: number | null
      model: string
      error: string | null
    }>('/rag/test-embedding', {
      method: 'POST',
      body: JSON.stringify(body)
    }),
  ragTestChat: (body: {
    chat_endpoint?: string
    chat_model?: string
    chat_api_key?: string
    chat_system_prompt?: string
  }) =>
    request<{
      ok: boolean
      elapsed_ms: number
      raw?: string
      error: string | null
    }>('/rag/test-chat', {
      method: 'POST',
      body: JSON.stringify(body)
    }),
  // Probe an OpenAI-compatible or Ollama endpoint for the list of
  // loaded/installed models. Returns sorted+deduped IDs. Failure is
  // signalled by an empty `models` + populated `error`.
  discoverModels: (endpoint: string) =>
    request<{
      models: string[]
      source: 'openai' | 'ollama' | 'unknown'
      error: string | null
      elapsed_ms?: number
    }>('/settings/discover-models', {
      method: 'POST',
      body: JSON.stringify({ endpoint })
    }),
  ragIngestStart: (
    scope: IngestJobScope,
    opts: { include_ooc?: boolean; force_rewipe?: boolean } = {}
  ) =>
    request<IngestJob>('/rag/ingest', {
      method: 'POST',
      body: JSON.stringify({
        ...scope,
        include_ooc: opts.include_ooc ?? false,
        force_rewipe: opts.force_rewipe ?? false
      })
    }),
  ragJobGet: (id: string, opts?: ApiOptions) =>
    get<IngestJob>(`/rag/jobs/${encodeURIComponent(id)}`, opts),
  ragJobCancel: (id: string) =>
    request<{ id: string; cancel_requested: boolean }>(
      `/rag/jobs/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    ),
  ragStatus: () => get<RagStatus>('/rag/status'),
  ragWipe: () =>
    request<{ wiped: true }>('/rag/wipe', { method: 'POST' }),
  // Rebuild the BM25 lexical index from the existing Qdrant chunks.
  // Cheaper than a full re-ingest — no LLM calls, no embeddings.
  ragLexicalRebuild: () =>
    request<{ indexed: number }>('/rag/lexical/rebuild', { method: 'POST' }),
  ragQuery: async (
    body: {
      question: string
      scope?: RagQueryScope | null
      top_k?: number
      neighbors?: number
    },
    handlers: RagQueryHandlers,
    opts?: ApiOptions
  ): Promise<void> => {
    // SSE consumer using fetch streaming. ReadableStream is available
    // in Electron's chromium renderer; no EventSource because we want
    // POST with a JSON body which EventSource doesn't support.
    const res = await fetch(`${base()}/rag/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: opts?.signal
    })
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE events are separated by a blank line.
        let sep
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          dispatchSseBlock(block, handlers)
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) {
        // Tail event without trailing blank line — still dispatch.
        dispatchSseBlock(buffer, handlers)
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // best-effort
      }
    }
  },
  ragTalk: async (
    body: {
      messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
      system?: string
    },
    handlers: RagQueryHandlers,
    opts?: ApiOptions
  ): Promise<void> => {
    // Free-form chat counterpart to ragQuery. Same SSE wire format
    // minus the `retrieved` / `expanded` events; reuses dispatchSseBlock
    // so the renderer code path stays identical to the grounded mode.
    const res = await fetch(`${base()}/rag/talk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: opts?.signal
    })
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          dispatchSseBlock(block, handlers)
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) dispatchSseBlock(buffer, handlers)
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // best-effort
      }
    }
  },

  // ---- AI assistant (Phase 9) ----

  aiDraftGet: (characterId: string) =>
    request<{
      draft: AiDraft
      current_working_etag: string | null
    }>(`/flist/character/${encodeURIComponent(characterId)}/ai-draft`, {}),
  aiDraftDelete: (characterId: string) =>
    request<{ deleted: boolean }>(
      `/flist/character/${encodeURIComponent(characterId)}/ai-draft`,
      { method: 'DELETE' }
    ),
  /** Wipes every pending ai-draft.json across the local archive. Used
   *  by Settings → Disable AI Assistant + discard drafts so disabling
   *  the feature really does evict everything, not just the active
   *  character's draft. */
  aiDraftDeleteAll: () =>
    request<{ deleted: number }>('/assistant/drafts', { method: 'DELETE' }),
  aiDraftAccept: (
    characterId: string,
    body: { edit_ids: string[] },
    ifMatch: string | null
  ) =>
    request<{
      applied_edit_ids: string[]
      new_etag: string | null
      draft: AiDraft | null
      /** Edits in the request whose status was `stale` and so weren't
       *  applied. The renderer surfaces a non-error chip so the user
       *  understands why some cards still appear after Accept-all. */
      skipped_stale: string[]
    }>(`/flist/character/${encodeURIComponent(characterId)}/ai-draft/accept`, {
      method: 'POST',
      headers: ifMatch ? { 'If-Match': ifMatch } : undefined,
      body: JSON.stringify(body)
    }),
  aiDraftReject: (characterId: string, body: { edit_ids: string[] }) =>
    request<{ draft: AiDraft | null }>(
      `/flist/character/${encodeURIComponent(characterId)}/ai-draft/reject`,
      { method: 'POST', body: JSON.stringify(body) }
    ),
  /** Drives one user turn. Same fetch-SSE shape as ragQuery/ragTalk —
   *  handlers fire as events arrive. The chat history lives in the
   *  caller (state.ts); the sidecar does NOT remember conversations. */
  assistantChat: async (
    body: {
      messages: AssistantChatMessage[]
      active_character_id: string | null
    },
    handlers: AssistantChatHandlers,
    opts?: ApiOptions
  ): Promise<void> => {
    const res = await fetch(`${base()}/assistant/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: opts?.signal
    })
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          dispatchAssistantSseBlock(block, handlers)
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) dispatchAssistantSseBlock(buffer, handlers)
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // best-effort
      }
    }
  },

  labelsJobGet: (id: string, opts?: ApiOptions) =>
    get<ClassifyJob>(`/labels/jobs/${encodeURIComponent(id)}`, opts),
  labelsJobCancel: (id: string) =>
    request<{ id: string; cancel_requested: boolean }>(
      `/labels/jobs/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    ),
  profile: (name: string) => get<Profile>(`/profile/${encodeURIComponent(name)}`),

  // ---- F-list character archive ----
  flistSignIn: (body: { account: string; password: string }) =>
    request<{
      characters: FlistAccountCharacter[]
      expires_in_sec: number
      account: string
    }>('/flist/session', {
      method: 'POST',
      body: JSON.stringify(body)
    }),
  flistSignOut: () =>
    request<{ signed_out: true }>('/flist/session', { method: 'DELETE' }),
  flistSession: () => get<FlistSessionStatus>('/flist/session'),
  flistActivity: () =>
    get<{
      started_at: number
      event_count: number
      max_events: number
      events: { t: number; kind: string; [k: string]: unknown }[]
    }>('/flist/activity'),
  flistRoster: () => get<{ characters: FlistRosterEntry[] }>('/flist/characters'),
  flistLive: (characterId: string | number) =>
    get<Record<string, unknown>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/live`
    ),
  /** List the per-character JSON snapshots (the auto-on-pull
   *  forever-history). Distinct from `flistZipBackups`, which lists
   *  the userscript-restoreable ZIP artefacts. */
  flistSnapshots: (characterId: string | number) =>
    get<{ character_id: string; snapshots: FlistSnapshotEntry[] }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/snapshots`
    ),
  flistSnapshotRead: (characterId: string | number, filename: string) =>
    get<Record<string, unknown>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/snapshots/${encodeURIComponent(filename)}`
    ),
  /** Capture the current Live JSON into a new snapshot. POST'd by the
   *  diff/history flow when the user wants an explicit checkpoint
   *  beyond what the auto-on-pull dedup gives them. */
  flistSaveSnapshot: (characterId: string | number) =>
    request<{ path: string; created_at: number; filename: string }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/snapshot`,
      { method: 'POST' }
    ),
  /** Right-click → 'Back up now': pulls (assumed already done by the
   *  caller) and writes a fresh ZIP regardless of dedup. */
  flistZipBackup: (characterId: string | number) =>
    request<{
      saved: boolean
      path?: string
      filename?: string
      created_at?: number
      size?: number
      reason?: string
    }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/zip-backup`,
      { method: 'POST' }
    ),
  flistZipBackups: (characterId: string | number) =>
    get<{ character_id: string; backups: FlistZipBackupEntry[] }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/zip-backups`
    ),
  /** Rename a single backup (user-set label persisted in a sidecar
   *  `_names.json` map; the ZIP file is untouched). Empty name
   *  clears the rename. Returns the canonical updated entry so the
   *  renderer can patch its row without a full list re-fetch. */
  flistZipBackupRename: async (
    characterId: string | number,
    filename: string,
    name: string
  ) => {
    const res = await fetch(
      `${base()}/flist/character/${encodeURIComponent(String(characterId))}/zip-backups/${encodeURIComponent(filename)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      }
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    return (await res.json()) as FlistZipBackupEntry
  },
  /** Delete a single backup ZIP. Idempotent enough that the renderer
   *  refreshes the list either way; surfaces error status to a toast.
   */
  flistZipBackupDelete: async (
    characterId: string | number,
    filename: string
  ): Promise<void> => {
    const res = await fetch(
      `${base()}/flist/character/${encodeURIComponent(String(characterId))}/zip-backups/${encodeURIComponent(filename)}`,
      { method: 'DELETE' }
    )
    if (!res.ok && res.status !== 404) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }
  },
  /** Raw ZIP bytes for Sidebar → Backups → right-click → Download.
   *  The renderer pipes these through `window.workbench.writeFile`
   *  to whatever path the user picks in the OS save dialog. */
  flistZipBackupDownload: async (
    characterId: string | number,
    filename: string
  ): Promise<Uint8Array> => {
    const res = await fetch(
      `${base()}/flist/character/${encodeURIComponent(String(characterId))}/zip-backups/${encodeURIComponent(filename)}/download`
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    return new Uint8Array(await res.arrayBuffer())
  },
  /** Read the embedded `working.json` (+ `backup-meta.json` if
   *  present) out of a ZIP backup for read-only Browse Backup mode.
   *  410 Gone when the backup predates the working.json write — the
   *  renderer surfaces that as a header pill message. `meta` is
   *  `null` for backups created before the metadata write shipped
   *  (2026-06-17). */
  flistZipBackupPayload: (
    characterId: string | number,
    filename: string
  ) =>
    get<{
      payload: Record<string, unknown>
      filename: string
      meta: { kind?: string; created_at?: string; note?: string } | null
    }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/zip-backups/${encodeURIComponent(filename)}/payload`
    ),
  // ---- F-list mapping list (Tier 2: §2.x cached + force-refresh) ----
  flistMappingList: (opts?: { force?: boolean }) =>
    get<
      Record<string, unknown> & {
        _etag: string | null
        _fetched_at: number | null
      }
    >(`/flist/mapping-list${opts?.force ? '?force=true' : ''}`),
  // ---- F-list working copy (Tier 2: §1 persistence) ----
  flistWorkingRead: (characterId: string | number) =>
    get<{ payload: Record<string, unknown>; etag: string | null }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/working`
    ),
  flistWorkingWrite: async (
    characterId: string | number,
    payload: Record<string, unknown>,
    opts?: { etag?: string | null }
  ): Promise<{ etag: string }> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (opts?.etag) headers['If-Match'] = opts.etag
    const res = await fetch(
      `${base()}/flist/character/${encodeURIComponent(String(characterId))}/working`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload)
      }
    )
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as
        | { detail?: { detail: string; current_etag: string | null } }
        | null
      const current = body?.detail?.current_etag ?? null
      const err = new Error('etag_mismatch') as Error & {
        currentEtag: string | null
      }
      err.currentEtag = current
      throw err
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }
    return (await res.json()) as { etag: string }
  },
  flistWorkingDelete: (characterId: string | number) =>
    request<{ deleted: boolean }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/working`,
      { method: 'DELETE' }
    ),
  // ---- F-list working sets v2 (sets list + per-set payload) ----
  flistSetsList: (characterId: string | number) =>
    get<SetsListResponseWire>(
      `/flist/character/${encodeURIComponent(String(characterId))}/sets`
    ),
  flistSetCreate: (characterId: string | number, body: { name: string }) =>
    request<{ set: SetMetaWire }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/sets`,
      { method: 'POST', body: JSON.stringify(body) }
    ),
  /** Create a new working set seeded from an existing backup ZIP's
   *  embedded working.json. Distinct from flistSetImport (which
   *  expects the userscript-bundle manifest.json shape); this hits
   *  a dedicated sidecar endpoint that reads working.json directly
   *  out of the backup. 410 Gone when the backup predates the
   *  working.json write (older than 2026-06-17). */
  flistSetCreateFromBackup: (
    characterId: string | number,
    backupFilename: string,
    body: { name: string }
  ) =>
    request<{ set: SetMetaWire }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/zip-backups/${encodeURIComponent(backupFilename)}/create-set`,
      { method: 'POST', body: JSON.stringify(body) }
    ),
  flistSetRename: (
    characterId: string | number,
    setId: string,
    body: { name: string }
  ) =>
    request<{ set: SetMetaWire }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/sets/${encodeURIComponent(setId)}`,
      { method: 'PATCH', body: JSON.stringify(body) }
    ),
  flistSetDelete: (characterId: string | number, setId: string) =>
    request<SetActivateResponseWire>(
      `/flist/character/${encodeURIComponent(String(characterId))}/sets/${encodeURIComponent(setId)}`,
      { method: 'DELETE' }
    ),
  flistSetDuplicate: (
    characterId: string | number,
    setId: string,
    body: { name: string }
  ) =>
    request<{ set: SetMetaWire }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/sets/${encodeURIComponent(setId)}/duplicate`,
      { method: 'POST', body: JSON.stringify(body) }
    ),
  flistSetActivate: (characterId: string | number, setId: string) =>
    request<SetActivateResponseWire>(
      `/flist/character/${encodeURIComponent(String(characterId))}/sets/${encodeURIComponent(setId)}/activate`,
      { method: 'POST' }
    ),
  flistFromFlistActivate: (characterId: string | number) =>
    request<SetActivateResponseWire>(
      `/flist/character/${encodeURIComponent(String(characterId))}/from-flist/activate`,
      { method: 'POST' }
    ),
  flistSetPayloadRead: (characterId: string | number, setId: string) =>
    get<{ payload: Record<string, unknown>; etag: string | null }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/sets/${encodeURIComponent(setId)}/payload`
    ),
  /** Download the Workbench-native bundle for a working set. Returns
   *  the raw bytes + the suggested filename pulled out of the
   *  `Content-Disposition` header so the caller can hand a clean
   *  default-name to the save dialog. */
  flistSetExport: async (
    characterId: string | number,
    setId: string
  ): Promise<{ bytes: Uint8Array; suggestedFilename: string }> => {
    const res = await fetch(
      `${base()}/flist/character/${encodeURIComponent(String(characterId))}/sets/${encodeURIComponent(setId)}/export`
    )
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    // Parse `filename="…"` out of Content-Disposition. Falls back to a
    // generic name; the renderer will overlay the character + set name
    // on top of that anyway.
    const cd = res.headers.get('content-disposition') ?? ''
    const m = /filename="([^"]+)"/.exec(cd)
    return {
      bytes: buf,
      suggestedFilename: m ? m[1] : 'workbench-set.zip'
    }
  },
  /** Upload a bundle and create a new working set under
   *  `characterId`. The cross-character handshake is a 422 with
   *  `detail.code === 'requires_cross_character_confirmation'`; the
   *  caller catches that, shows a confirm modal, and retries with
   *  `confirmCrossCharacter: true`. */
  flistSetImport: async (
    characterId: string | number,
    zipBytes: Uint8Array,
    body: { name: string; confirmCrossCharacter?: boolean }
  ): Promise<FlistSetImportResult> => {
    const form = new FormData()
    form.append(
      'zip',
      new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }),
      'bundle.zip'
    )
    form.append('name', body.name)
    form.append(
      'confirm_cross_character',
      body.confirmCrossCharacter ? 'true' : 'false'
    )
    const res = await fetch(
      `${base()}/flist/character/${encodeURIComponent(String(characterId))}/sets/import`,
      { method: 'POST', body: form }
    )
    if (res.status === 422) {
      const errBody = (await res.json().catch(() => null)) as
        | {
            detail?:
              | string
              | {
                  code?: string
                  source?: {
                    character_id?: string
                    character_name?: string
                    set_name?: string
                  }
                }
          }
        | null
      const detail = errBody?.detail
      if (
        detail &&
        typeof detail === 'object' &&
        detail.code === 'requires_cross_character_confirmation'
      ) {
        const err = new Error(
          'requires_cross_character_confirmation'
        ) as Error & {
          code: 'requires_cross_character_confirmation'
          source: {
            characterId: string
            characterName: string
            setName: string
          }
        }
        err.code = 'requires_cross_character_confirmation'
        err.source = {
          characterId: String(detail.source?.character_id ?? ''),
          characterName: String(detail.source?.character_name ?? ''),
          setName: String(detail.source?.set_name ?? '')
        }
        throw err
      }
      const msg = typeof detail === 'string' ? detail : 'invalid bundle'
      throw new Error(msg)
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }
    return (await res.json()) as FlistSetImportResult
  },
  flistSetPayloadPut: async (
    characterId: string | number,
    setId: string,
    payload: Record<string, unknown>,
    etag: string | null
  ): Promise<{ etag: string }> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (etag) headers['If-Match'] = etag
    const res = await fetch(
      `${base()}/flist/character/${encodeURIComponent(String(characterId))}/sets/${encodeURIComponent(setId)}/payload`,
      { method: 'PUT', headers, body: JSON.stringify(payload) }
    )
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as
        | { detail?: { detail: string; current_etag: string | null } }
        | null
      const current = body?.detail?.current_etag ?? null
      const err = new Error('etag_mismatch') as Error & {
        currentEtag: string | null
      }
      err.currentEtag = current
      throw err
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }
    return (await res.json()) as { etag: string }
  },
  flistAvatarUrl: (name: string) =>
    `${base()}/flist/avatar/${encodeURIComponent(name)}`,
  flistImageUrl: (characterId: string | number, filename: string) =>
    `${base()}/flist/character/${encodeURIComponent(String(characterId))}/images/${encodeURIComponent(filename)}`,
  /** Extension-blind variant — the sidecar tries png/jpg/gif on disk
   *  and serves whichever exists. Lets the renderer render thumbnails
   *  without first round-tripping the /images list. */
  flistImageByIdUrl: (characterId: string | number, imageId: string) =>
    `${base()}/flist/character/${encodeURIComponent(String(characterId))}/image/${encodeURIComponent(imageId)}`,
  // ---- F-list per-character images/ (unified store, v5) ----------------
  flistCharacterImages: (characterId: string | number) =>
    get<{ character_id: string; images: FlistCharacterImage[] }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/images`
    ),
  /** Upload a local image (PNG/JPG/GIF). Lands as `images/local-<sha8>.<ext>`
   *  and shows up in the renderer's Pool view; only a working.json
   *  gallery edit moves it on-profile. */
  flistImageUpload: async (
    characterId: string | number,
    data: Blob
  ): Promise<FlistCharacterImage> => {
    const res = await fetch(
      `${base()}/flist/character/${encodeURIComponent(String(characterId))}/images`,
      { method: 'POST', body: data }
    )
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const body = (await res.json()) as { detail?: string }
        if (typeof body?.detail === 'string') detail = body.detail
      } catch {
        // best-effort — server may not have returned JSON
      }
      throw new Error(detail)
    }
    return (await res.json()) as FlistCharacterImage
  },
  /** Permanently remove `images/<image_id>.<ext>` from disk. There's no
   *  secondary store, so the renderer wraps every call in an explicit
   *  confirm dialog (the Images tab's only destructive path). */
  flistImageRemove: (characterId: string | number, imageId: string) =>
    request<{ deleted: boolean; image_id: string }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/images/${encodeURIComponent(imageId)}`,
      { method: 'DELETE' }
    ),
  flistExportZipUrl: (characterId: string | number) =>
    `${base()}/flist/character/${encodeURIComponent(String(characterId))}/export.zip`,
  /** Streams the Backup-all SSE protocol. Tools → "Back up all
   *  characters" walks the signed-in account roster, pulls each
   *  character (JSON only — no images), and snapshots a backup when
   *  the F-list content has actually changed. Per-character status is
   *  surfaced as `character` events the renderer's progress banner
   *  renders. */
  flistBackupAll: async (
    handlers: FlistBackupAllHandlers,
    opts?: ApiOptions & { kind?: 'manual_bulk' | 'scheduled' }
  ): Promise<void> => {
    const kind = opts?.kind ?? 'manual_bulk'
    const res = await fetch(
      `${base()}/flist/backup-all?kind=${encodeURIComponent(kind)}`,
      {
        method: 'POST',
        headers: { Accept: 'text/event-stream' },
        signal: opts?.signal
      }
    )
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          dispatchBackupAllStream(block, handlers)
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) dispatchBackupAllStream(buffer, handlers)
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // best-effort
      }
    }
  },
  flistPull: async (
    name: string,
    handlers: FlistPullHandlers,
    opts?: ApiOptions
  ): Promise<void> => {
    const res = await fetch(`${base()}/flist/character/${encodeURIComponent(name)}/pull`, {
      method: 'POST',
      headers: { Accept: 'text/event-stream' },
      signal: opts?.signal
    })
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          dispatchPullStream(block, handlers)
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) dispatchPullStream(buffer, handlers)
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // best-effort
      }
    }
  },

  // ---- AI Setup wizard surface ------------------------------------------
  systemOllamaStatus: () =>
    get<{
      running: boolean
      installed: boolean
      version: string | null
      models: string[] | null
      error: string | null
    }>('/system/ollama-status'),
  systemOllamaPull: async (
    name: string,
    handlers: {
      onProgress?: (p: OllamaPullProgress) => void
      onDone?: (model: string) => void
      onError?: (info: { message: string }) => void
    },
    opts?: ApiOptions
  ): Promise<void> => {
    // Same fetch-streaming pattern as ragQuery — POST with JSON body
    // rules out EventSource. AbortController.signal stops the upstream
    // pull; partial Ollama blob files stay on disk and resume on retry.
    const res = await fetch(`${base()}/system/ollama-pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ name }),
      signal: opts?.signal
    })
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          dispatchPullBlock(block, handlers)
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) {
        dispatchPullBlock(buffer, handlers)
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // best-effort
      }
    }
  },

  // ---- Browser-extension pairing (restore flow) -------------------------
  restorePendingHandshakes: () =>
    get<{ pending: { handshake_id: string; fingerprint: string; created_at: number }[] }>(
      '/restore/handshake/pending'
    ),
  restoreAcceptHandshake: (handshakeId: string) =>
    request<{ ok: boolean; error?: string }>('/restore/handshake/accept', {
      method: 'POST',
      body: JSON.stringify({ handshake_id: handshakeId })
    }),
  restoreRejectHandshake: (handshakeId: string) =>
    request<{ ok: boolean; error?: string }>('/restore/handshake/reject', {
      method: 'POST',
      body: JSON.stringify({ handshake_id: handshakeId })
    }),
  restoreRevokeToken: () =>
    request<{ ok: boolean }>('/restore/token', { method: 'DELETE' })
}

export type OllamaPullProgress = {
  status: string
  digest: string | null
  completed: number | null
  total: number | null
}

function dispatchPullStream(block: string, handlers: FlistPullHandlers): void {
  let event: string | null = null
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim())
  }
  if (!event) return
  let parsed: unknown = {}
  try {
    parsed = JSON.parse(dataLines.join('\n'))
  } catch {
    parsed = {}
  }
  switch (event) {
    case 'queued':
      handlers.onQueued?.()
      break
    case 'ticket':
      handlers.onTicket?.()
      break
    case 'fetching':
      handlers.onFetching?.()
      break
    case 'images':
      handlers.onImages?.(parsed as { total: number })
      break
    case 'image':
      handlers.onImage?.(parsed as Parameters<NonNullable<FlistPullHandlers['onImage']>>[0])
      break
    case 'done':
      handlers.onDone?.(parsed as Parameters<NonNullable<FlistPullHandlers['onDone']>>[0])
      break
    case 'error':
      handlers.onError?.(parsed as { stage: string; message: string })
      break
  }
}

function dispatchBackupAllStream(
  block: string,
  handlers: FlistBackupAllHandlers
): void {
  let event: string | null = null
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
    else if (line.startsWith('data:'))
      dataLines.push(line.slice('data:'.length).trim())
  }
  if (!event) return
  let parsed: unknown = {}
  try {
    parsed = JSON.parse(dataLines.join('\n'))
  } catch {
    parsed = {}
  }
  switch (event) {
    case 'start':
      handlers.onStart?.(parsed as { total: number })
      break
    case 'queued':
      handlers.onQueued?.()
      break
    case 'character':
      handlers.onCharacter?.(parsed as FlistBackupAllCharacterEvent)
      break
    case 'done':
      handlers.onDone?.(
        parsed as Parameters<NonNullable<FlistBackupAllHandlers['onDone']>>[0]
      )
      break
    case 'error':
      handlers.onError?.(parsed as { stage: string; message: string })
      break
  }
}

function dispatchPullBlock(
  block: string,
  handlers: {
    onProgress?: (p: OllamaPullProgress) => void
    onDone?: (model: string) => void
    onError?: (info: { message: string }) => void
  }
): void {
  let event: string | null = null
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim())
  }
  if (!event) return
  let parsed: unknown
  try {
    parsed = JSON.parse(dataLines.join('\n'))
  } catch {
    return
  }
  if (event === 'progress' && handlers.onProgress) {
    handlers.onProgress(parsed as OllamaPullProgress)
  } else if (event === 'done' && handlers.onDone) {
    handlers.onDone((parsed as { model: string }).model)
  } else if (event === 'error' && handlers.onError) {
    handlers.onError(parsed as { message: string })
  }
}
