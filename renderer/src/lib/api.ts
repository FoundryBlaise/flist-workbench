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
  backup_count: number
  // Only present for rows where has_archive is true. Surfaces whether
  // a prior pull was interrupted or had image failures so the renderer
  // can prompt the user to resume.
  pull_status?: FlistPullStatus
}

export type FlistBackupEntry = {
  filename: string
  created_at: number
  size: number
}

export type FlistPoolEntry = {
  sha256: string
  extension: string
  source: string
  added_at: number
  size: number
}

export type FlistCharacterImage = {
  image_id: string
  extension: string
  size: number
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
    image_pruned?: number
    pull_status?: FlistPullStatus['status']
    pull_missing?: number
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

export type Document = {
  id: number
  name: string
  folder_id: number | null
  scratch: boolean
  created_at: number
  updated_at: number
  latest_revision_id: number | null
  latest_char_count: number | null
  latest_created_at: number | null
  has_draft: boolean
}

export type Folder = {
  id: number
  name: string
  created_at: number
}

export type Revision = {
  id: number
  doc_id: number
  bbcode: string
  inlines: Record<string, InlineImage>
  char_count: number
  created_at: number
}

export type RevisionSummary = {
  id: number
  char_count: number
  created_at: number
}

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
  return window.workbench?.sidecarUrl ?? 'http://127.0.0.1:8765'
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

async function request<T>(
  path: string,
  init: RequestInit = {},
  opts?: ApiOptions
): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    ...init,
    signal: opts?.signal,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {})
    }
  })
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
    }>('/settings'),
  settingsUpdate: (body: {
    fchat_data_dir?: string | null
    labels?: Partial<Omit<LabelsSettings, 'defaults'>>
    rag?: Partial<Omit<RagSettings, 'defaults'>>
  }) =>
    request<{
      fchat_data_dir: string | null
      fchat_data_dir_effective: string
      fchat_data_dir_env_locked: boolean
      labels: LabelsSettings
      rag: RagSettings
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
  flistBackups: (characterId: string | number) =>
    get<{ character_id: string; backups: FlistBackupEntry[] }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/backups`
    ),
  flistBackupRead: (characterId: string | number, filename: string) =>
    get<Record<string, unknown>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/backups/${encodeURIComponent(filename)}`
    ),
  flistSaveBackup: (characterId: string | number) =>
    request<{ path: string; created_at: number; filename: string }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/backup`,
      { method: 'POST' }
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
  flistAvatarUrl: (name: string) =>
    `${base()}/flist/avatar/${encodeURIComponent(name)}`,
  flistImageUrl: (characterId: string | number, filename: string) =>
    `${base()}/flist/character/${encodeURIComponent(String(characterId))}/images/${encodeURIComponent(filename)}`,
  // ---- F-list per-character pool (Tier 6) ------------------------------
  flistPoolList: (characterId: string | number) =>
    get<{ character_id: string; pool: FlistPoolEntry[] }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/pool`
    ),
  flistPoolUpload: async (
    characterId: string | number,
    data: Blob
  ): Promise<FlistPoolEntry> => {
    const res = await fetch(
      `${base()}/flist/character/${encodeURIComponent(String(characterId))}/pool`,
      {
        method: 'POST',
        body: data
      }
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
    return (await res.json()) as FlistPoolEntry
  },
  flistPoolDelete: (characterId: string | number, sha: string) =>
    request<{ deleted: boolean; sha256: string }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/pool/${encodeURIComponent(sha)}`,
      { method: 'DELETE' }
    ),
  flistPoolFileUrl: (
    characterId: string | number,
    sha: string,
    extension: string
  ) =>
    `${base()}/flist/character/${encodeURIComponent(String(characterId))}/pool/${encodeURIComponent(`${sha}.${extension}`)}`,
  // ---- F-list per-character images/ (image_id-keyed) -------------------
  flistCharacterImages: (characterId: string | number) =>
    get<{ character_id: string; images: FlistCharacterImage[] }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/images`
    ),
  flistImageFromPool: (characterId: string | number, sha: string) =>
    request<{ image_id: string; extension: string; sha256: string }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/images/from-pool/${encodeURIComponent(sha)}`,
      { method: 'POST' }
    ),
  flistImageRemove: (characterId: string | number, imageId: string) =>
    request<{ deleted: boolean; image_id: string }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/images/${encodeURIComponent(imageId)}`,
      { method: 'DELETE' }
    ),
  flistExportZipUrl: (characterId: string | number) =>
    `${base()}/flist/character/${encodeURIComponent(String(characterId))}/export.zip`,
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

  // Snippets (UI label) — internal naming is still "documents" to bound
  // the rename churn. Endpoints, types, and store fields keep `document`
  // / `doc` terminology; only user-facing labels switched.
  documents: () => get<{ documents: Document[] }>('/documents'),
  documentCreate: (
    name: string,
    bbcode = '',
    inlines: Record<string, InlineImage> = {},
    folderId: number | null = null
  ) =>
    request<Document>('/documents', {
      method: 'POST',
      body: JSON.stringify({ name, bbcode, inlines, folder_id: folderId })
    }),
  documentGet: (id: number) =>
    get<{ document: Document; current: Revision }>(`/documents/${id}`),
  documentRename: (id: number, name: string) =>
    request<Document>(`/documents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name })
    }),
  documentDelete: (id: number) =>
    request<void>(`/documents/${id}`, { method: 'DELETE' }),
  documentDuplicate: (id: number, name: string) =>
    request<Document>(`/documents/${id}/duplicate`, {
      method: 'POST',
      body: JSON.stringify({ name })
    }),
  documentMove: (id: number, folderId: number | null) =>
    request<Document>(`/documents/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ folder_id: folderId })
    }),
  folders: () => get<{ folders: Folder[] }>('/folders'),
  folderCreate: (name: string) =>
    request<Folder>('/folders', {
      method: 'POST',
      body: JSON.stringify({ name })
    }),
  folderRename: (id: number, name: string) =>
    request<Folder>(`/folders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name })
    }),
  folderDelete: (id: number) =>
    request<void>(`/folders/${id}`, { method: 'DELETE' }),
  revisionsList: (id: number) =>
    get<{ doc_id: number; revisions: RevisionSummary[] }>(`/documents/${id}/revisions`),
  revisionGet: (id: number, revId: number) =>
    get<Revision>(`/documents/${id}/revisions/${revId}`),
  revisionSave: (id: number, bbcode: string, inlines: Record<string, InlineImage> = {}) =>
    request<Revision>(`/documents/${id}/revisions`, {
      method: 'POST',
      body: JSON.stringify({ bbcode, inlines })
    }),
  draftSave: (id: number, bbcode: string, inlines: Record<string, InlineImage> = {}) =>
    request<void>(`/documents/${id}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ bbcode, inlines })
    }),
  draftDiscard: (id: number) =>
    request<void>(`/documents/${id}/draft`, { method: 'DELETE' }),

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
  }
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
