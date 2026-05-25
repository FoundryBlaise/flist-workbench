type ApiOptions = { signal?: AbortSignal }

export type InlineImage = { hash: string; extension: string; nsfw: boolean }

export type CharacterEntry = { name: string; mtime: number }

export type Profile = {
  name: string
  avatar_url: string | null
  stats: Record<string, string>
  bbcode: string
  inlines: Record<string, InlineImage>
}

export type PartnerEntry = { name: string; bytes: number }

export type Document = {
  id: number
  name: string
  scratch: boolean
  created_at: number
  updated_at: number
  latest_revision_id: number | null
  latest_char_count: number | null
  latest_created_at: number | null
  has_draft: boolean
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

export type Label = 'IC' | 'OOC' | 'Unlabeled'
export type LabelSource = 'llm' | 'manual'
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
  label_confidence?: number
  // Free-text reason the model gave for the verdict (LLM source) or
  // "manual override" / similar (manual source). Surfaced in the
  // badge tooltip — useful when confidence saturates near 1.0 and the
  // number alone tells the user nothing about WHY.
  label_reason?: string
  // Snapshot of what the label was before the most recent change.
  // Present only on manual overrides; lets the UI surface "LLM had
  // said IC; you changed it to OOC" without a separate lookup.
  prior_label?: 'IC' | 'OOC'
  prior_source?: 'llm' | 'manual'
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
  }) => void
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
  total: number
}

export type ClassifyJobScope = {
  character?: string | null
  partner?: string | null
}

export type ClassifyJob = {
  id: string
  scope: { character?: string; partner?: string }
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
  labelsClear: (body: { character: string; partner: string }) =>
    request<{ character: string; partner: string; deleted: number }>(
      '/labels/clear',
      {
        method: 'POST',
        body: JSON.stringify(body)
      }
    ),
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
      confidence?: number
      prior_label?: Label | null
      prior_source?: LabelSource | null
      deleted?: boolean
    }>('/labels/override', {
      method: 'POST',
      body: JSON.stringify(body)
    }),
  labelsClassifyStart: (scope: ClassifyJobScope) =>
    request<ClassifyJob>('/labels/classify', {
      method: 'POST',
      body: JSON.stringify(scope)
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
      parsed?: { label: 'IC' | 'OOC'; confidence: number; reason: string } | null
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
  labelsJobGet: (id: string, opts?: ApiOptions) =>
    get<ClassifyJob>(`/labels/jobs/${encodeURIComponent(id)}`, opts),
  labelsJobCancel: (id: string) =>
    request<{ id: string; cancel_requested: boolean }>(
      `/labels/jobs/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    ),
  profile: (name: string) => get<Profile>(`/profile/${encodeURIComponent(name)}`),

  // Documents
  documents: () => get<{ documents: Document[] }>('/documents'),
  documentCreate: (name: string, bbcode = '', inlines: Record<string, InlineImage> = {}) =>
    request<Document>('/documents', {
      method: 'POST',
      body: JSON.stringify({ name, bbcode, inlines })
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
    request<void>(`/documents/${id}/draft`, { method: 'DELETE' })
}
