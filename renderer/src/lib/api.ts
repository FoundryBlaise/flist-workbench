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

export type LogMessage = {
  ts: number
  iso: string
  type: number
  type_name: string
  speaker: string
  raw: string
  text: string
  mentions: string[]
  kind: 'ic' | 'ooc' | 'system'
}

function base(): string {
  return window.workbench?.sidecarUrl ?? 'http://127.0.0.1:8765'
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
      channels: {
        character: string
        channel: string
        messages_from_name: number
        bytes: number
      }[]
    }>(`/logs/contacts?name=${encodeURIComponent(name)}`),
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
