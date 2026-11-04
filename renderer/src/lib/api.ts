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
  /** Count of ZIP backups in `backups/` — the explicit "Back up"
   *  artefacts that include images + avatar. */
  backup_count: number
  // Only present for rows where has_archive is true. Surfaces whether
  // a prior pull was interrupted or had image failures so the renderer
  // can prompt the user to resume.
  pull_status?: FlistPullStatus
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
  | 'pre_upload'
  | 'unknown'

/** What a Backup holds: the Live or the Workbench of its moment.
 *  Backups from before the app recorded it come back as `'unknown'`. */
export type FlistBackupSource = 'live' | 'workbench' | 'unknown'

/** Why a Backup was made; `null` for Backups from before the app
 *  recorded it. */
export type FlistBackupOccasion =
  | 'manual'
  | 'before-upload'
  | 'before-restore'
  | 'before-replace'
  | 'migration'
  | 'backup-all'

export type FlistZipBackupEntry = {
  filename: string
  created_at: number
  size: number
  kind: FlistZipBackupKind
  source: FlistBackupSource
  occasion: FlistBackupOccasion | null
  /** False for a Backup that holds no profile: the one the move to one
   *  Workbench made of the older copies from before the upgrade. The
   *  sidecar refuses to restore, browse or upload it; it can be
   *  downloaded. */
  holds_profile: boolean
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

/** A file in a character's image trash (`<character>/trash/`). */
export type FlistTrashItem = {
  /** Names this entry for put-back and purge. The image id, unless the
   *  Trash holds several files under that id (a Pull replaced one). */
  trash_id: string
  image_id: string
  extension: string
  filename: string
  size: number
  deleted_at: number
  /** 'ui' or 'mcp'; null for a file that got there without an index entry. */
  deleted_by: string | null
  source_name: string | null
}

/** A deleted Backup in a character's Trash (`<character>/trash/backups/`). */
export type FlistTrashedBackup = {
  /** Its file name in the Trash; what put-back and purge take. */
  id: string
  /** The Backup's file name in the Backup list, where a put-back returns it. */
  filename: string
  /** The user-set name it had, kept for the put-back. */
  name: string | null
  size: number
  deleted_at: number
  deleted_by: string | null
}

/** Labels cleared in one go, kept in the character's Trash. */
export type FlistTrashedLabels = {
  /** What put-back and purge take. */
  id: string
  /** The Log character they were cleared for; null for Labels whose
   *  messages were in none of the Logs when every Label was reset. */
  character: string | null
  /** The conversation cleared; null when every conversation was. */
  partner: string | null
  /** How many Labels the entry holds. */
  count: number
  deleted_at: number
  deleted_by: string | null
}

/** Where an image id is still used, beyond the pool: the Workbench's
 *  gallery, Live, and how many Backups keep it (each with its own copy
 *  of the bytes), with the newest of them. `migration_backup`: the
 *  older copies from before the upgrade name it; that Backup holds JSON
 *  only, no copy of the bytes, and is not counted in `backups`. */
export type FlistImageReferences = {
  workbench: boolean
  live: boolean
  backups: number
  newest_backup: string | null
  migration_backup: boolean
}


// ---- foreign profiles (read-only viewer) ----------------------------
//
// Somebody else's profile. The payload shape is the same
// character-data.php response the archive stores as live.json, so the
// panes that render a Live profile read this without a translation
// layer. Nothing here writes: there is no endpoint that turns one of
// these into a Workbench, and that is deliberate.

/** Where the viewer's candidate names come from. `name` is free text
 *  taken as an exact character name — F-list has no search endpoint. */
export type ForeignSource = 'bookmarks' | 'friends' | 'logs' | 'name'

export type ForeignSearchResult = {
  source: ForeignSource
  query: string
  results: string[]
  truncated: boolean
  /** True for the free-text source: the row is what the user typed,
   *  not something known to exist. */
  exact: boolean
}

/** A character-data.php payload plus the cache's `fetched_at` stamp.
 *  Indexed because F-list may add fields and the viewer passes
 *  anything it doesn't recognise straight through. */
export type ForeignProfilePayload = Record<string, unknown> & {
  name?: string
  id?: number | string
  description?: string
  custom_title?: string | null
  created_at?: number
  updated_at?: number
  views?: number
  infotags?: Record<string, unknown>
  kinks?: Record<string, unknown>
  custom_kinks?: Record<string, unknown>
  images?: Record<string, unknown>[]
  fetched_at?: number
}

export type ForeignProfileResult = {
  name: string
  profile: ForeignProfilePayload
  from_cache: boolean
  age_sec: number | null
  fetched_at: number | null
  /** Set when a refresh failed and the cached copy was served anyway. */
  stale?: boolean
  refresh_error?: string
}

/** The Workbench's metadata as the sidecar sends it. The window reads
 *  only `updated_at`, for the Workbench row's "last changed". */
export type WorkbenchInfoWire = {
  name: string
  created_at: number
  updated_at: number
}

/** A Pull or Back up all runs as a job: the stream's first event is the
 *  job (its id is what Cancel and a reopened view use), and a cancel by
 *  id ends the events with `cancelled`. */
type JobStreamHandlers = {
  onJob?: (job: Job) => void
  onCancelled?: () => void
}

export type FlistPullHandlers = JobStreamHandlers & {
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
  onError?: (info: StreamError) => void
}

export type FlistBackupAllCharacterEvent = {
  name: string
  character_id?: string
  status: 'fetching' | 'saved' | 'unchanged' | 'error'
  filename?: string
  message?: string
}

export type FlistBackupAllHandlers = JobStreamHandlers & {
  onStart?: (info: { total: number }) => void
  onCharacter?: (info: FlistBackupAllCharacterEvent) => void
  onDone?: (info: {
    total: number
    saved: number
    unchanged: number
    failed: number
  }) => void
  onError?: (info: StreamError) => void
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

export type Label = 'IC' | 'OOC' | 'Unlabeled'
/** Who decided a stored verdict. 'mcp' is the model the user connected
 *  over MCP; 'manual' is their own right-click override; 'llm' only
 *  appears on rows written by the in-app classifier that existed
 *  before the MCP migration. */
export type LabelSource = 'mcp' | 'manual' | 'llm'
export type PriorSource = LabelSource | null

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
  // present for chat/action messages, null for a system line (it never gets
  // a Label); absent label_source means rule-or-unlabeled (no explicit DB row).
  label?: Label | null
  label_source?: LabelSource
  // Free-text reason the labeller gave for the verdict. Surfaced in
  // the badge tooltip so users can audit why a label was chosen.
  label_reason?: string
  // Snapshot of what the label was before the most recent change.
  // Present only on manual overrides; lets the UI surface "the model
  // said IC; you changed it to OOC" without a separate lookup.
  prior_label?: 'IC' | 'OOC'
  prior_source?: LabelSource
  // Present when label === 'Failed'. Holds the classifier's error
  // message (truncated) so the badge tooltip can explain why the
  // message couldn't be classified — e.g. "bad json: '<garbage>'" or
  // "api error: HTTP 500". The full prompt + context lives in
  // <user_data>/classify-failures.log, surfaced via Tools → Open log.
  label_error?: string
}

export type LabelsSettings = {
  /** Messages shorter than this are OOC without asking anyone. The
   *  only labels setting left — everything the rules cannot settle now
   *  goes to the model the user connected over MCP. */
  threshold_chars: number
  defaults: {
    threshold_chars: number
  }
}

export type RagSettings = {
  embed_model: string
  rerank_model: string
  rerank_candidates: number
  top_k: number
  neighbors: number
  rerank_min_ratio: number
  hybrid_enabled: boolean
  hybrid_bm25_candidates: number
  chunk_max_chars: number
  chunk_soft_split_chars: number
  chunk_overlap_msgs: number
  defaults: {
      embed_model: string
          rerank_model: string
    rerank_candidates: number
    top_k: number
    neighbors: number
    rerank_min_ratio: number
    hybrid_enabled: boolean
    hybrid_bm25_candidates: number
      chunk_max_chars: number
    chunk_soft_split_chars: number
    chunk_overlap_msgs: number
  }
}

export type LabelsStats = {
  character: string
  partner: string
  ic: number
  ooc: number
  unlabeled: number
  total: number
}

export type IngestJobScope = {
  character?: string | null
  partner?: string | null
}

export type JobState = 'pending' | 'running' | 'done' | 'cancelled' | 'failed'

/** Long work the sidecar runs as a job, of any kind: started by its
 *  own route, then polled and cancelled by id (`/jobs/{id}`). `error`
 *  is set when it failed. */
export type Job<Params = Record<string, unknown>, Progress = Record<string, unknown>, Result = Record<string, unknown>> = {
  id: string
  kind: string
  resource: string
  state: JobState
  params: Params
  progress: Progress
  result: Result | null
  error: ErrorBody | null
  cancel_requested: boolean
  created_at: number
  finished_at: number | null
}

export type IngestProgress = {
  chunked: number
  embedded: number
  upserted: number
  skipped_existing: number
  removed: number
  /** Messages dropped for lack of an IC/OOC verdict. A high count
   *  means the classification flow should run first — an unjudged
   *  message could be either IC prose or OOC chatter, and indexing OOC
   *  poisons retrieval. */
  skipped_unlabeled: number
  failed: number
  total_chunks: number
  current_partner: string | null
  last_error: string | null
  embed_model: string | null
  embed_dimension: number | null
}

export type IngestJob = Job<
  {
    scope: { character?: string; partner?: string }
    include_ooc: boolean
    force_rewipe: boolean
  },
  IngestProgress
>

/** The `error.code` of an ingest stopped because the Index was built
 *  with another embedding model; the dialog offers wipe + re-ingest. */
export const EMBEDDING_MODEL_CHANGED = 'embedding_model_changed'

export type RagStatus = {
  embed_model: string | null
  embed_dimension: number | null
  last_ingest_at: number | null
  /** A job (an ingest, a wipe) holds the Index right now: `job` is it,
   *  and `chunk_count` is null because the Index can't be counted. */
  busy: boolean
  job: Job | null
  chunk_count: number | null
}

/** One MCP endpoint the sidecar serves. `all` carries every tool; the
 *  narrow ones exist because small local models choke on long tool
 *  lists. */
export type McpEndpoint = {
  id: 'all' | 'character' | 'logs' | 'classify'
  label: string
  path: string
  url: string
  tool_count: number
}

/** MCP settings only the window may change. `log_text`: whether MCP
 *  clients get the tools that return Log text; off by default. */
export type McpSettings = {
  log_text: boolean
}

/** The Foreign profile cache's cap, in whole megabytes (at least 1).
 *  Only the window sets it; a lower cap evicts at once. */
export type ForeignSettings = {
  cache_cap_mb: number
  defaults: { cache_cap_mb: number }
}

/** What the Foreign profile cache holds on disk, and what it may hold. */
export type ForeignCacheUsage = {
  bytes: number
  profiles: number
  cap_bytes: number
}

export type McpInfo = {
  port: number
  endpoints: McpEndpoint[]
  /** The optional bearer token. Off by default — the endpoints are
   *  loopback-only, so requiring one buys nothing against an attacker
   *  already running code as this user. */
  auth: { required: boolean; token: string | null }
}

function base(): string {
  return window.workbench?.sidecarUrl ?? 'http://127.0.0.1:27384'
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

/** Every error the sidecar answers: a code to switch on, a message to
 *  show, and whatever else the situation carries (the etag on disk,
 *  the field that was wrong). */
export type ErrorBody = {
  code: string
  message: string
  details: Record<string, unknown>
}

/** A Pull's or Back up all's `error` event: where it stopped, then
 *  the same three fields a REST error carries. */
export type StreamError = ErrorBody & { stage: string }

/**
 * A request the sidecar turned down (`{code, message, details}`), so a
 * caller can tell "not signed in" from "no such character" without
 * matching on prose. Narrow with `instanceof`.
 */
export class RefusalError extends Error {
  readonly code: string
  readonly status: number
  readonly details: Record<string, unknown>

  constructor(
    code: string,
    status: number,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'RefusalError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function isErrorBody(body: unknown): body is ErrorBody {
  if (!body || typeof body !== 'object') return false
  const b = body as Partial<ErrorBody>
  return typeof b.code === 'string' && typeof b.message === 'string'
}

/** The error a failed response stands for: a `RefusalError` carrying
 *  the sidecar's code, message and details, or a plain `HTTP <status>`
 *  error when the body is not one (a proxy, a crash mid-stream). */
async function failure(res: Response): Promise<Error> {
  const body: unknown = await res.json().catch(() => null)
  if (isErrorBody(body)) {
    const details =
      body.details && typeof body.details === 'object' ? body.details : {}
    return new RefusalError(
      body.code,
      res.status,
      `HTTP ${res.status}: ${body.message}`,
      details
    )
  }
  return new Error(`HTTP ${res.status}: ${res.statusText}`)
}

/** What a failed request says, without the `HTTP <status>: ` prefix
 *  `request` puts in front of it: the sidecar's or F-list's own words,
 *  ready to show. Any other error's message as it is. */
export function errorDetail(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^HTTP \d+:\s*/, '')
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
    (path.startsWith('/flist/') || path.startsWith('/foreign/')) &&
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
  if (!res.ok) throw await failure(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

async function get<T>(path: string, opts?: ApiOptions): Promise<T> {
  return request<T>(path, {}, opts)
}

export const api = {
  base,
  // ---- foreign profiles (read-only viewer) ----
  foreignSearch: (source: ForeignSource, q: string, opts?: ApiOptions) =>
    get<ForeignSearchResult>(
      `/foreign/search?source=${encodeURIComponent(source)}&q=${encodeURIComponent(q)}`,
      opts
    ),
  foreignProfile: (name: string, refresh = false, opts?: ApiOptions) =>
    get<ForeignProfileResult>(
      `/foreign/character/${encodeURIComponent(name)}${refresh ? '?refresh=true' : ''}`,
      opts
    ),
  /** Avatar for a foreign profile. Cached in the profile's own folder,
   *  not in `<userdata>/avatars/` — that directory is the account
   *  picker's, and a looked-up stranger does not belong in it. */
  foreignAvatarUrl: (name: string) =>
    `${base()}/foreign/character/${encodeURIComponent(name)}/avatar`,
  /** Gallery image. Downloaded on first request and cached after, so
   *  scrolling a gallery twice costs one fetch per image, not two. */
  foreignImageUrl: (name: string, imageId: string) =>
    `${base()}/foreign/character/${encodeURIComponent(name)}/image/${encodeURIComponent(imageId)}`,
  foreignCacheUsage: () => get<ForeignCacheUsage>('/foreign/cache'),
  /** Delete every cached Foreign profile, images and avatars included. */
  foreignCacheClear: () =>
    request<ForeignCacheUsage & { removed: number }>('/foreign/cache', {
      method: 'DELETE'
    }),
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
      image_import_roots: string[]
      mcp: McpSettings
      foreign: ForeignSettings
    }>('/settings'),
  settingsUpdate: (body: {
    fchat_data_dir?: string | null
    labels?: Partial<Omit<LabelsSettings, 'defaults'>>
    rag?: Partial<Omit<RagSettings, 'defaults'>>
    image_import_roots?: string[]
    mcp?: Partial<McpSettings>
    foreign?: Partial<Omit<ForeignSettings, 'defaults'>>
  }) =>
    request<{
      fchat_data_dir: string | null
      fchat_data_dir_effective: string
      fchat_data_dir_env_locked: boolean
      labels: LabelsSettings
      rag: RagSettings
      image_import_roots: string[]
      mcp: McpSettings
      foreign: ForeignSettings
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
        total: number
        // Epoch seconds. `log_mtime > last_label_at` means the
        // conversation grew since the last classify run — surfaced as
        // a stale dot in the sidebar.
        log_mtime: number | null
        last_label_at: number | null
      }>
    }>(`/labels/stats-all?char=${encodeURIComponent(char)}`),
  labelsClear: (body: { character: string; partner: string }) =>
    request<{ character: string; partner: string; deleted: number; trash_id: string | null }>(
      '/labels/clear',
      {
        method: 'POST',
        body: JSON.stringify(body)
      }
    ),
  labelsClearAll: () =>
    request<{ labels_deleted: number; trash_ids: string[] }>('/labels/clear-all', {
      method: 'POST'
    }),
  /** Every cleared-Labels entry in the Trash, whichever character it
   *  was cleared for: Settings → Labels lists them. */
  labelsTrashList: () => get<{ labels: FlistTrashedLabels[] }>('/labels/trash'),
  /** Put cleared Labels back. A message labelled again since keeps its
   *  newer Label; its hash is listed under `skipped`. */
  labelsTrashPutBack: (ids: string[]) =>
    request<{
      restored: { id: string; restored: number; skipped: string[] }[]
      not_found: string[]
    }>('/labels/trash/put-back', { method: 'POST', body: JSON.stringify({ ids }) }),
  /** Delete cleared Labels for good. */
  labelsTrashPurge: (ids: string[]) =>
    request<{ purged: string[]; not_found: string[] }>('/labels/trash/purge', {
      method: 'POST',
      body: JSON.stringify({ ids })
    }),
  /** Give every still-Unlabeled message in one conversation the same
   *  verdict. Adds labels only: an existing verdict is kept, and the
   *  rules keep deciding what they decide. `hashes` is exactly what
   *  was written, which is what `labelsDeleteHashes` undoes. */
  labelsFillUnlabeled: (body: {
    character: string
    partner: string
    label: 'IC' | 'OOC'
  }) =>
    request<{
      character: string
      partner: string
      label: 'IC' | 'OOC'
      labeled: number
      hashes: string[]
      already_labeled: number
      decided_by_rules: number
      total_messages: number
    }>('/labels/fill-unlabeled', {
      method: 'POST',
      body: JSON.stringify(body)
    }),
  /** Undo for the above — removes named labels and nothing else.
   *  `labelsClear` would take the model's verdicts with it. */
  labelsDeleteHashes: (body: {
    character: string
    partner: string
    hashes: string[]
  }) =>
    request<{ character: string; partner: string; deleted: number }>(
      '/labels/delete-hashes',
      {
        method: 'POST',
        body: JSON.stringify(body)
      }
    ),
  labelsRollup: () =>
    get<{
      ic: number
      ooc: number
      unlabeled: number
      manual: number
      total: number
      character_count: number
    }>('/labels/rollup'),
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
  /** One verdict (or a reset, with `label: null`) for any set of
   *  messages in a conversation — the log view's multi-select. */
  labelsOverrideMany: (body: {
    character: string
    partner: string
    items: { hash: string; ts: number; speaker: string }[]
    label: Label | null
  }) =>
    request<{ character: string; partner: string; label: Label | null; changed: number }>(
      '/labels/override-many',
      {
        method: 'POST',
        body: JSON.stringify(body)
      }
    ),
  ragTestEmbedding: (body: {
    embed_model?: string
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
  // Probe an OpenAI-compatible or Ollama endpoint for the list of
  // loaded/installed models. Returns sorted+deduped IDs. Failure is
  // signalled by an empty `models` + populated `error`.
  /** The embedding models that can be selected — fastembed's catalogue,
   *  with the numbers the choice actually turns on. Licence is in there
   *  because the catalogue mixes apache-2.0 and MIT with cc-by-nc-4.0. */
  discoverModels: () =>
    request<{
      models: Array<{
        model: string
        dimension: number
        size_gb: number | null
        license: string | null
      }>
      source: 'local'
      error: string | null
    }>('/settings/discover-models', {
      method: 'POST',
      body: JSON.stringify({})
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
  /** Any job by id, whatever its kind. */
  jobGet: <J extends Job = Job>(id: string, opts?: ApiOptions) =>
    get<J>(`/jobs/${encodeURIComponent(id)}`, opts),
  /** Ask a job to stop; answers the job as it stands. */
  jobCancel: <J extends Job = Job>(id: string) =>
    request<J>(`/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  ragStatus: () => get<RagStatus>('/rag/status'),
  /** Which MCP endpoints the sidecar serves and how many tools each
   *  carries. Powers Settings → MCP. */
  mcpInfo: () => get<McpInfo>('/mcp-info'),
  /** Issue a bearer token for /mcp, replacing any existing one. */
  mcpCreateToken: () =>
    request<{ token: string }>('/mcp-info/token', { method: 'POST' }),
  /** Turn the bearer requirement back off. */
  mcpRevokeToken: () =>
    request<{ required: boolean }>('/mcp-info/token', { method: 'DELETE' }),
  ragWipe: () =>
    request<{ wiped: true }>('/rag/wipe', { method: 'POST' }),
  // Rebuild the BM25 lexical index from the existing Qdrant chunks.
  // Cheaper than a full re-ingest — no LLM calls, no embeddings.
  ragLexicalRebuild: () =>
    request<{ indexed: number }>('/rag/lexical/rebuild', { method: 'POST' }),
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
    if (!res.ok) throw await failure(res)
    return (await res.json()) as FlistZipBackupEntry
  },
  /** Move a single backup ZIP to the character's Trash. Idempotent
   *  enough that the renderer refreshes the list either way; surfaces
   *  error status to a toast.
   */
  flistZipBackupDelete: async (
    characterId: string | number,
    filename: string
  ): Promise<void> => {
    const res = await fetch(
      `${base()}/flist/character/${encodeURIComponent(String(characterId))}/zip-backups/${encodeURIComponent(filename)}`,
      { method: 'DELETE' }
    )
    if (!res.ok && res.status !== 404) throw await failure(res)
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
    if (!res.ok) throw await failure(res)
    return new Uint8Array(await res.arrayBuffer())
  },
  /** Read the embedded `working.json` (+ `backup-meta.json` if
   *  present) out of a ZIP backup for read-only Browse Backup mode.
   *  409 `backup_too_old` when the backup predates the working.json
   *  write, as Restore answers it — the renderer surfaces that as a
   *  header pill message. `meta` is
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
  // ---- The workbench --------------------------------------------
  // A character has one editable copy of its profile beside Live,
  // seeded from Live when first needed (ADR 0001).
  /** Resolve the character's workbench, creating it from Live if it
   *  does not exist. `create: false` asks without making one, which is
   *  what a read-only render wants — merely looking at a character
   *  should not bring a bench into being. */
  flistWorkbench: (characterId: string | number, create = true) =>
    get<{
      workbench: WorkbenchInfoWire | null
      reason?: string
    }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/workbench`
        + (create ? '' : '?create=false')
    ),
  /** The character's Workbench payload and the etag a save must send
   *  back. Made from Live when there is none yet, and `created` then
   *  says this read made it, so nobody has edited it. `create: false`
   *  reads without making one: a 404 `no_workbench` refusal. */
  flistWorkbenchPayloadRead: (
    characterId: string | number,
    opts: { create?: boolean } = {}
  ) =>
    get<{ payload: Record<string, unknown>; etag: string; created: boolean }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/workbench/payload`
        + (opts.create === false ? '?create=false' : '')
    ),
  /** Save the whole Workbench over the etag it was read with. A 409
   *  (no etag, or a stale one) throws `Error('etag_mismatch')` carrying
   *  the etag on disk as `currentEtag`. */
  flistWorkbenchPayloadPut: async (
    characterId: string | number,
    payload: Record<string, unknown>,
    etag: string | null
  ): Promise<{ etag: string }> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (etag) headers['If-Match'] = etag
    const res = await fetch(
      `${base()}/flist/character/${encodeURIComponent(String(characterId))}/workbench/payload`,
      { method: 'PUT', headers, body: JSON.stringify(payload) }
    )
    if (!res.ok) {
      const err = await failure(res)
      if (res.status === 409) {
        const etag =
          err instanceof RefusalError ? err.details.current_etag : undefined
        throw Object.assign(new Error('etag_mismatch'), {
          currentEtag: typeof etag === 'string' ? etag : null
        })
      }
      throw err
    }
    return (await res.json()) as { etag: string }
  },
  /** Reset to Live: the sidecar saves the Workbench as a Backup
   *  (`backed_up_first`, null when there was no Workbench yet), then
   *  makes it a fresh copy of Live and answers with that payload and
   *  its etag. When the Backup cannot be written nothing is replaced:
   *  a `workbench_not_kept` refusal. */
  flistWorkbenchResetToLive: (characterId: string | number) =>
    request<{
      payload: Record<string, unknown>
      etag: string
      backed_up_first: { filename: string; created_at: number } | null
    }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/workbench/reset-to-live`,
      { method: 'POST' }
    ),
  /** What the confirm dialog needs before overwriting the bench:
   *  whether it holds unpublished edits, and whether F-list has moved
   *  on since this backup was taken. */
  flistWorkbenchLoadPreflight: (
    characterId: string | number,
    filename: string
  ) =>
    get<{
      filename: string
      backup_created_at: number | null
      live_pulled_at: number | null
      live_diverged: boolean
      workbench_has_edits: boolean
    }>(
      `/flist/character/${encodeURIComponent(String(characterId))}`
        + `/workbench/load-backup/preflight?filename=`
        + encodeURIComponent(filename)
    ),
  /** Restore: replace the Workbench contents with a Backup's. The
   *  sidecar saves the Workbench as a Backup first (`backed_up_first`,
   *  null when there was no Workbench yet); when it cannot, nothing is
   *  replaced: a `workbench_not_kept` refusal. */
  flistWorkbenchLoadBackup: (characterId: string | number, filename: string) =>
    request<{
      workbench: WorkbenchInfoWire
      payload: Record<string, unknown>
      etag: string
      loaded: string
      backed_up_first: { filename: string; created_at: number } | null
    }>(
      `/flist/character/${encodeURIComponent(String(characterId))}`
        + `/workbench/load-backup`,
      {
        method: 'POST',
        body: JSON.stringify({ filename })
      }
    ),
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
  /** Put the gallery back together when entries have lost their bytes.
   *  Run when the Images tab opens — a slot pointing at a missing file
   *  shows as a black placeholder and drops out of the restore ZIP,
   *  which the extension reads as "delete this from the profile". */
  flistRepairGallery: (characterId: string | number) =>
    request<{
      relinked: { from: string; to: string }[]
      duplicates_removed: string[]
      stale_removed: string[]
      unresolved: string[]
      sets_rewritten: number
      repaired: boolean
    }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/images/repair`,
      { method: 'POST' }
    ),
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
    if (!res.ok) throw await failure(res)
    return (await res.json()) as FlistCharacterImage
  },
  /** Delete images, in the gallery or only in the pool: the route MCP's
   *  `trash_images` takes too. The sidecar takes gallery images off the
   *  Workbench's gallery (`off_gallery`) and answers the Workbench's new
   *  `etag`, null when the gallery was left alone; every file goes to
   *  the Trash. */
  flistImagesTrash: (characterId: string | number, imageIds: string[]) =>
    request<{
      trashed: FlistTrashItem[]
      not_found: string[]
      off_gallery: string[]
      etag: string | null
    }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/images/trash`,
      { method: 'POST', body: JSON.stringify({ image_ids: imageIds }) }
    ),
  /** Where each image id is still used: the Workbench, Live, Backups. */
  flistImageReferences: (characterId: string | number) =>
    get<Record<string, FlistImageReferences>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/image-references`
    ),
  flistTrashList: (characterId: string | number) =>
    get<{
      character_id: string
      items: FlistTrashItem[]
      backups?: FlistTrashedBackup[]
      labels?: FlistTrashedLabels[]
    }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/trash`
    ),
  flistTrashFileUrl: (characterId: string | number, filename: string) =>
    `${base()}/flist/character/${encodeURIComponent(String(characterId))}/trash/${encodeURIComponent(filename)}`,
  /** Back into the pool, not onto the profile. Takes trash ids. */
  flistTrashPutBack: (characterId: string | number, trashIds: string[]) =>
    request<{
      restored: { image_id: string; deduplicated: boolean; from: string }[]
      not_found: string[]
      conflicts: string[]
    }>(`/flist/character/${encodeURIComponent(String(characterId))}/trash/put-back`, {
      method: 'POST',
      body: JSON.stringify({ image_ids: trashIds })
    }),
  /** Delete trashed files for good. Takes trash ids. */
  flistTrashPurge: (characterId: string | number, trashIds: string[]) =>
    request<{ purged: string[]; not_found: string[] }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/trash/purge`,
      { method: 'POST', body: JSON.stringify({ image_ids: trashIds }) }
    ),
  /** Back into the Backup list, under the name they had. */
  flistTrashBackupsPutBack: (characterId: string | number, ids: string[]) =>
    request<{ restored: string[]; not_found: string[]; conflicts: string[] }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/trash/backups/put-back`,
      { method: 'POST', body: JSON.stringify({ ids }) }
    ),
  /** Delete trashed Backups for good. */
  flistTrashBackupsPurge: (characterId: string | number, ids: string[]) =>
    request<{ purged: string[]; not_found: string[] }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/trash/backups/purge`,
      { method: 'POST', body: JSON.stringify({ ids }) }
    ),
  /** Put cleared Labels back. A message labelled again since keeps its
   *  newer Label; its hash is listed under `skipped`. */
  flistTrashLabelsPutBack: (characterId: string | number, ids: string[]) =>
    request<{
      restored: { id: string; restored: number; skipped: string[] }[]
      not_found: string[]
    }>(`/flist/character/${encodeURIComponent(String(characterId))}/trash/labels/put-back`, {
      method: 'POST',
      body: JSON.stringify({ ids })
    }),
  /** Delete cleared Labels for good. */
  flistTrashLabelsPurge: (characterId: string | number, ids: string[]) =>
    request<{ purged: string[]; not_found: string[] }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/trash/labels/purge`,
      { method: 'POST', body: JSON.stringify({ ids }) }
    ),
  /** Empty the whole Trash: images, Backups and cleared Labels. */
  flistTrashEmpty: (characterId: string | number) =>
    request<{ purged: number }>(
      `/flist/character/${encodeURIComponent(String(characterId))}/trash`,
      { method: 'DELETE' }
    ),
  flistExportZipUrl: (characterId: string | number) =>
    `${base()}/flist/character/${encodeURIComponent(String(characterId))}/export.zip`,
  /** Starts Back up all and follows its progress (SSE). Tools → "Back
   *  up all characters" walks the signed-in account roster, pulls each
   *  character, and keeps its Live as a Backup when the F-list
   *  content has actually changed. Per-character status is
   *  surfaced as `character` events the renderer's progress banner
   *  renders. It runs as a job: aborting `opts.signal` only stops
   *  following; `jobCancel` stops the sweep. */
  flistBackupAll: (handlers: FlistBackupAllHandlers, opts?: ApiOptions): Promise<void> =>
    followStream(`${base()}/flist/backup-all`, { method: 'POST', signal: opts?.signal }, (block) =>
      dispatchBackupAllStream(block, handlers)
    ),
  /** Starts a Pull of `name` and follows its progress (SSE). A job, like
   *  Back up all: aborting `opts.signal` only stops following. */
  flistPull: (name: string, handlers: FlistPullHandlers, opts?: ApiOptions): Promise<void> =>
    followStream(
      `${base()}/flist/character/${encodeURIComponent(name)}/pull`,
      { method: 'POST', signal: opts?.signal },
      (block) => dispatchPullStream(block, handlers)
    ),
  /** Every job the sidecar remembers: running ones, and finished ones
   *  for a few minutes. A reopened window finds its Pulls here. */
  jobsList: (opts?: ApiOptions) => get<{ jobs: Job[] }>('/jobs', opts),
  /** Follow a running Pull from the start of its events. */
  flistPullFollow: (jobId: string, handlers: FlistPullHandlers, opts?: ApiOptions): Promise<void> =>
    followStream(jobEventsUrl(jobId), { signal: opts?.signal }, (block) =>
      dispatchPullStream(block, handlers)
    ),
  /** Follow a running Back up all from the start of its events. */
  flistBackupAllFollow: (
    jobId: string,
    handlers: FlistBackupAllHandlers,
    opts?: ApiOptions
  ): Promise<void> =>
    followStream(jobEventsUrl(jobId), { signal: opts?.signal }, (block) =>
      dispatchBackupAllStream(block, handlers)
    ),

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
    request<{ ok: boolean }>('/restore/token', { method: 'DELETE' }),
  /** Whether a pairing token is stored. The token itself never comes
   *  back; only the app window can ask. */
  pairingStatus: () => get<{ paired: boolean }>('/pairing'),

  /** The extension version the browser runs, as of its last paired
   *  call. Null until the extension has made one since the app started. */
  restoreExtensionSeen: () =>
    request<{ version: string | null; seen_at: number | null }>('/restore/extension')
}

function jobEventsUrl(jobId: string): string {
  return `${base()}/jobs/${encodeURIComponent(jobId)}/events`
}

/** Open an SSE route and hand each block to `onBlock` until the stream
 *  ends. A refused start (busy, not signed in) throws its RefusalError. */
async function followStream(
  url: string,
  init: Pick<RequestInit, 'method' | 'signal'>,
  onBlock: (block: string) => void
): Promise<void> {
  const res = await fetch(url, { ...init, headers: { Accept: 'text/event-stream' } })
  await readEventStream(res, onBlock)
}

/** Read an SSE response block by block until it ends. */
async function readEventStream(res: Response, onBlock: (block: string) => void): Promise<void> {
  if (!res.ok) throw await failure(res)
  if (!res.body) throw new Error(`HTTP ${res.status}: no body`)
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
        onBlock(block)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) onBlock(buffer)
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // best-effort
    }
  }
}

/** One SSE block as its event name and JSON data. */
function parseBlock(block: string): { event: string | null; data: unknown } {
  let event: string | null = null
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim())
  }
  let data: unknown = {}
  try {
    data = JSON.parse(dataLines.join('\n'))
  } catch {
    data = {}
  }
  return { event, data }
}

/** The events every job stream carries. True when `event` was one. */
function dispatchJobEvent(event: string, data: unknown, handlers: JobStreamHandlers): boolean {
  if (event === 'job') {
    handlers.onJob?.(data as Job)
    return true
  }
  if (event === 'cancelled') {
    handlers.onCancelled?.()
    return true
  }
  return false
}

function dispatchPullStream(block: string, handlers: FlistPullHandlers): void {
  const { event, data: parsed } = parseBlock(block)
  if (!event || dispatchJobEvent(event, parsed, handlers)) return
  switch (event) {
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
      handlers.onError?.(parsed as StreamError)
      break
  }
}

function dispatchBackupAllStream(
  block: string,
  handlers: FlistBackupAllHandlers
): void {
  const { event, data: parsed } = parseBlock(block)
  if (!event || dispatchJobEvent(event, parsed, handlers)) return
  switch (event) {
    case 'start':
      handlers.onStart?.(parsed as { total: number })
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
      handlers.onError?.(parsed as StreamError)
      break
  }
}

