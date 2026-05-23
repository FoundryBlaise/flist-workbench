type ApiOptions = { signal?: AbortSignal }

export type Profile = {
  name: string
  avatar_url: string | null
  stats: Record<string, string>
  bbcode: string
}

export type PartnerEntry = { name: string; bytes: number }

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

async function get<T>(path: string, opts?: ApiOptions): Promise<T> {
  const res = await fetch(`${base()}${path}`, { signal: opts?.signal })
  if (!res.ok) {
    let detail: string | undefined
    try {
      detail = ((await res.json()) as { detail?: string })?.detail
    } catch {
      // not JSON
    }
    throw new Error(`HTTP ${res.status}: ${detail ?? res.statusText}`)
  }
  return (await res.json()) as T
}

export const api = {
  health: () => get<{ status: string; version: string }>('/health'),
  characters: () => get<{ characters: string[] }>('/logs/characters'),
  partners: (char: string) =>
    get<{ character: string; partners: PartnerEntry[] }>(
      `/logs/partners?char=${encodeURIComponent(char)}`
    ),
  messages: (char: string, partner: string) =>
    get<{ character: string; partner: string; messages: LogMessage[] }>(
      `/logs/messages?char=${encodeURIComponent(char)}&partner=${encodeURIComponent(partner)}`
    ),
  profile: (name: string) => get<Profile>(`/profile/${encodeURIComponent(name)}`)
}
