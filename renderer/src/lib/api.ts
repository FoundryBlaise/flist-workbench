import type { components, paths } from './api.gen'

type ApiOptions = { signal?: AbortSignal }

// ---- Generated wire types -----------------------------------------------
// api.gen.ts is generated from the sidecar's OpenAPI schema
// (sidecar/openapi.json; `npm run gen:api` writes both), so a field
// renamed in Python fails the type-check where the window reads it.
// Route groups move from the hand-written types below to these one at
// a time (spec #8: #127-#130).

/** A model the sidecar's schema names, by its Python class name. */
export type Schema<Name extends keyof components['schemas']> = components['schemas'][Name]

type Method = 'get' | 'put' | 'post' | 'delete' | 'patch'
/** The methods `P` serves. */
type MethodOf<P extends keyof paths> = {
  [M in Method]: paths[P][M] extends undefined ? never : M
}[Method]
type Operation<P extends keyof paths, M extends MethodOf<P>> = NonNullable<paths[P][M]>
type JsonOf<X> = X extends { content: { 'application/json': infer B } } ? B : never

/** What `M P` answers when it is ok, as its response model says: the
 *  JSON of its 200, 201 or 202, or undefined for a 204. */
export type Answer<P extends keyof paths, M extends MethodOf<P>> =
  Operation<P, M> extends { responses: infer R }
    ? 204 extends keyof R
      ? undefined
      : JsonOf<R[Extract<keyof R, 200 | 201 | 202>]>
    : never

/** The JSON body `M P` takes. */
export type BodyOf<P extends keyof paths, M extends MethodOf<P>> =
  Operation<P, M> extends { requestBody?: infer B } ? JsonOf<NonNullable<B>> : never

/** Every code a sidecar refusal can carry (`refusals.RefusalCode`). */
export type RefusalCode = Schema<'RefusalCode'>

/** An inline image as F-list's profile payload lists it. */
export type InlineImage = { hash: string; extension: string; nsfw: boolean }

export type CharacterEntry = { name: string; mtime: number }

// ---- F-list character archive (Phase 7 Tier 1) ----

export type FlistAccountCharacter = Schema<'AccountCharacter'>

/** What the window knows of the F-list session: `GET /flist/session`'s
 *  answer, or the part a sign-in or sign-out already tells. */
export type FlistSessionStatus = Pick<Schema<'FlistSession'>, 'active'> &
  Partial<Omit<Schema<'FlistSession'>, 'active'>>

export type FlistPullStatus = Schema<'PullStatus'>

export type FlistRosterEntry = Schema<'RosterEntry'>

/** A Backup as the Backup list shows it: its origin (`source`,
 *  `occasion`; `kind` is the older one the extension sorts by),
 *  whether it holds a profile, and the user's rename (`name`). */
export type FlistZipBackupEntry = Schema<'Backup'>

/** An image file in a character's Pool. */
export type FlistCharacterImage = Schema<'PoolImage'>

/** A file in a character's image Trash (`<character>/trash/`). */
export type FlistTrashItem = Schema<'TrashItem'>

/** A deleted Backup in a character's Trash (`<character>/trash/backups/`). */
export type FlistTrashedBackup = Schema<'TrashedBackup'>

/** Labels cleared in one go, kept in the Trash. */
export type FlistTrashedLabels = Schema<'TrashedLabels'>

/** Where an image id is still used, beyond the Pool. */
export type FlistImageReferences = Schema<'ImageReference'>


// ---- foreign profiles (read-only viewer) ----------------------------
//
// Somebody else's profile. The payload shape is the same
// character-data.php response the archive stores as live.json, so the
// panes that render a Live profile read this without a translation
// layer. Nothing here writes: there is no endpoint that turns one of
// these into a Workbench, and that is deliberate.

/** Where the viewer's candidate names come from. `name` is free text
 *  taken as an exact character name — F-list has no search endpoint. */
export type ForeignSource = Schema<'ForeignSearch'>['source']

export type ForeignSearchResult = Schema<'ForeignSearch'>

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

/** A Foreign profile as the sidecar answers it, its F-list payload
 *  read as `ForeignProfilePayload`. */
export type ForeignProfileResult = Omit<Schema<'ForeignProfile'>, 'profile'> & {
  profile: ForeignProfilePayload
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

/** A public profile for the editor's "Fetch profile", its F-list
 *  inlines read as `InlineImage`. */
export type Profile = Omit<Schema<'PublicProfile'>, 'inlines'> & {
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

/** Messages shorter than `threshold_chars` are OOC without asking
 *  anyone; `defaults` for the "(default)" hints. */
export type LabelsSettings = Schema<'LabelsSettings'>
export type RagSettings = Schema<'RagSettings'>

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
export type McpEndpoint = Schema<'McpEndpoint'>

/** MCP settings only the window may change. `log_text`: whether MCP
 *  clients get the tools that return Log text; off by default. */
export type McpSettings = Schema<'McpSettings'>

/** The Foreign profile cache's cap, in whole megabytes (at least 1).
 *  Only the window sets it; a lower cap evicts at once. */
export type ForeignSettings = Schema<'ForeignSettings'>

/** What the Foreign profile cache holds on disk, and what it may hold. */
export type ForeignCacheUsage = Schema<'ForeignCacheUsage'>

/** The MCP endpoints and the optional bearer token. The token is off
 *  by default: the endpoints are loopback-only, so requiring one buys
 *  nothing against an attacker already running code as this user. */
export type McpInfo = Schema<'McpInfo'>

function base(): string {
  return window.workbench?.sidecarUrl ?? 'http://127.0.0.1:27384'
}

// Mid-session ticket recovery. The sidecar holds the F-list password
// in RAM only and drops it after an idle window (P0-C safety), so a
// long-running session eventually loses the ability to auto-refresh
// its ticket and the next F-list call is refused `not_signed_in`. If
// the user saved their password to the OS keychain we can transparently
// re-sign in and retry, so they don't see "invalid ticket" pop up.
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
      await send('/flist/session', {
        method: 'POST',
        body: JSON.stringify({ account: meta.account, password })
      })
      // Let the renderer refresh its FlistSessionStatus so the sidebar
      // chip stops showing "expired" after we just resurrected it.
      window.dispatchEvent(new CustomEvent('flist-session-recovered'))
      return true
    } catch (e) {
      // Surface the failure so debugging "autologin not reliable" has
      // something to read in DevTools — the alternative is a silent
      // false that leaves the user wondering why the modal popped.
      console.warn(
        '[flist] auto-recovery POST /flist/session failed:',
        e instanceof HttpError ? e.status : e
      )
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
 * A sidecar answer that was not ok. `status` is its HTTP status and
 * `detail` what it says, ready to show: the sidecar's or F-list's own
 * words, without the status. The message (`HTTP <status>: <detail>`)
 * is for logs; nothing reads it back.
 */
export class HttpError extends Error {
  readonly status: number
  readonly detail: string

  constructor(status: number, detail: string) {
    super(`HTTP ${status}: ${detail}`)
    this.name = 'HttpError'
    this.status = status
    this.detail = detail
  }
}

/**
 * A request the sidecar turned down (`{code, message, details}`), so a
 * caller can tell "not signed in" from "no such character" without
 * matching on prose. Narrow with `instanceof`, or read the code with
 * `refusalCode`. `message` is the sidecar's own words.
 */
export class RefusalError extends HttpError {
  readonly code: RefusalCode
  readonly details: Record<string, unknown>

  constructor(
    code: RefusalCode,
    status: number,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(status, message)
    this.name = 'RefusalError'
    this.code = code
    this.details = details
  }
}

function isErrorBody(body: unknown): body is ErrorBody {
  if (!body || typeof body !== 'object') return false
  const b = body as Partial<ErrorBody>
  return typeof b.code === 'string' && typeof b.message === 'string'
}

/** The error a failed response stands for: a `RefusalError` carrying
 *  the sidecar's code, message and details, or a plain `HttpError`
 *  when the body is not one (a proxy, a crash mid-stream). */
async function failure(res: Response): Promise<HttpError> {
  const body: unknown = await res.json().catch(() => null)
  if (isErrorBody(body)) {
    const details =
      body.details && typeof body.details === 'object' ? body.details : {}
    // The sidecar answers only codes its schema lists (RefusalCode).
    return new RefusalError(body.code as RefusalCode, res.status, body.message, details)
  }
  return new HttpError(res.status, res.statusText)
}

/** What a failed request says, ready to show: the sidecar's or
 *  F-list's own words for a failed answer, any other error's message
 *  as it is. */
export function errorDetail(err: unknown): string {
  if (err instanceof HttpError) return err.detail
  return err instanceof Error ? err.message : String(err)
}

// ---- Refusal codes ----------------------------------------------------
// The window tells refusals apart by the sidecar's code, never by its
// words or an `HTTP <status>` string, and reads the codes here.

/** The sidecar's code for a lost F-list session: no ticket, or one
 *  F-list rejected. */
const SESSION_LOST: RefusalCode = 'not_signed_in'

/** The codes of a Workbench write that has not seen what is on disk
 *  now: it sent no etag, or a stale one. */
const WORKBENCH_CONFLICT_CODES: readonly RefusalCode[] = ['etag_mismatch', 'etag_required']

/** The sidecar's code for a request it refused; null for any other
 *  error (the network, an answer that is not a refusal). */
export function refusalCode(err: unknown): RefusalCode | null {
  return err instanceof RefusalError ? err.code : null
}

/** A Workbench save refused because something else wrote the Workbench
 *  since it was read, however the sidecar words it: the etag on disk
 *  (null when the sidecar did not say). Null when `err` is not one. */
export function workbenchConflict(err: unknown): { currentEtag: string | null } | null {
  const code = refusalCode(err)
  if (!code || !WORKBENCH_CONFLICT_CODES.includes(code)) return null
  const etag = (err as RefusalError).details.current_etag
  return { currentEtag: typeof etag === 'string' ? etag : null }
}

/** Whether `err`, answered for `path`, says the F-list session is
 *  gone. Signing in itself is never one: its refusal is the answer. */
function sessionLost(err: HttpError, path: string): boolean {
  return err.status === 401 && refusalCode(err) === SESSION_LOST && path !== '/flist/session'
}

// ---- The request function ----------------------------------------------

/** What a call sends: `RequestInit` with plain-object headers (such as
 *  `If-Match`). A string body is JSON and goes as `application/json`;
 *  a Blob or bytes go as they are, typed by the browser. */
type SendInit = Omit<RequestInit, 'headers' | 'signal'> & {
  headers?: Record<string, string>
}

/**
 * The one place the window calls `fetch` for a sidecar route. Answers
 * the response when it is ok; anything else throws a `RefusalError`
 * (or an `HttpError` for an answer that is not a refusal).
 *
 * A route refused because the F-list session is gone (401
 * `not_signed_in`) gets one recovery attempt and is sent again; when
 * recovery cannot run or the second answer is refused the same way,
 * the window hears `flist-session-expired` so it can open the sign-in
 * modal. Without this, a 401-stuck /flist/mapping-list leaves the kink
 * picker and diff silently empty.
 *
 * `request`, `requestBytes` and `requestStream` read the answer.
 */
async function send(path: string, init: SendInit = {}, opts?: ApiOptions): Promise<Response> {
  const attempt = () =>
    fetch(`${base()}${path}`, {
      ...init,
      signal: opts?.signal,
      headers: {
        ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers
      }
    })
  const res = await attempt()
  if (res.ok) return res
  let err = await failure(res)
  if (sessionLost(err, path)) {
    if (await tryFlistRecovery()) {
      const retried = await attempt()
      if (retried.ok) return retried
      err = await failure(retried)
    }
    if (sessionLost(err, path)) window.dispatchEvent(new CustomEvent('flist-session-expired'))
  }
  throw err
}

/** A call answered with JSON (or nothing, for a 204). */
async function request<T>(path: string, init: SendInit = {}, opts?: ApiOptions): Promise<T> {
  const res = await send(path, init, opts)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** A call answered with bytes: a Backup's zip. */
async function requestBytes(path: string, init: SendInit = {}, opts?: ApiOptions): Promise<Uint8Array> {
  const res = await send(path, init, opts)
  return new Uint8Array(await res.arrayBuffer())
}

/** A call answered with a server-sent event stream: each block goes to
 *  `onBlock` until the stream ends. A refused start (busy, not signed
 *  in) throws its RefusalError. */
async function requestStream(
  path: string,
  init: SendInit,
  onBlock: (block: string) => void,
  opts?: ApiOptions
): Promise<void> {
  const res = await send(
    path,
    { ...init, headers: { Accept: 'text/event-stream', ...init.headers } },
    opts
  )
  await readEventStream(res, onBlock)
}

async function get<T>(path: string, opts?: ApiOptions): Promise<T> {
  return request<T>(path, {}, opts)
}

export const api = {
  base,
  // ---- foreign profiles (read-only viewer) ----
  foreignSearch: (source: ForeignSource, q: string, opts?: ApiOptions) =>
    get<Answer<'/foreign/search', 'get'>>(
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
  foreignCacheUsage: () => get<Answer<'/foreign/cache', 'get'>>('/foreign/cache'),
  /** Delete every cached Foreign profile, images and avatars included. */
  foreignCacheClear: () =>
    request<Answer<'/foreign/cache', 'delete'>>('/foreign/cache', {
      method: 'DELETE'
    }),
  health: () => get<Answer<'/health', 'get'>>('/health'),
  eiconsSearch: (q: string, limit = 200, opts?: ApiOptions) =>
    get<Answer<'/eicons/search', 'get'>>(`/eicons/search?q=${encodeURIComponent(q)}&limit=${limit}`, opts),
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

  settingsGet: () => get<Answer<'/settings', 'get'>>('/settings'),
  /** Fields left out (or null, for the numbers) stay as they are. */
  settingsUpdate: (body: BodyOf<'/settings', 'put'>) =>
    request<Answer<'/settings', 'put'>>('/settings', {
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
  labelsTrashList: () => get<Answer<'/labels/trash', 'get'>>('/labels/trash'),
  /** Put cleared Labels back. A message labelled again since keeps its
   *  newer Label; its hash is listed under `skipped`. */
  labelsTrashPutBack: (ids: string[]) =>
    request<Answer<'/labels/trash/put-back', 'post'>>('/labels/trash/put-back', { method: 'POST', body: JSON.stringify({ ids }) }),
  /** Delete cleared Labels for good. */
  labelsTrashPurge: (ids: string[]) =>
    request<Answer<'/labels/trash/purge', 'post'>>('/labels/trash/purge', {
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
    request<Answer<'/settings/discover-models', 'post'>>('/settings/discover-models', {
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
  mcpInfo: () => get<Answer<'/mcp-info', 'get'>>('/mcp-info'),
  /** Issue a bearer token for /mcp, replacing any existing one. */
  mcpCreateToken: () =>
    request<Answer<'/mcp-info/token', 'post'>>('/mcp-info/token', { method: 'POST' }),
  /** Turn the bearer requirement back off. */
  mcpRevokeToken: () =>
    request<Answer<'/mcp-info/token', 'delete'>>('/mcp-info/token', { method: 'DELETE' }),
  ragWipe: () =>
    request<{ wiped: true }>('/rag/wipe', { method: 'POST' }),
  // Rebuild the BM25 lexical index from the existing Qdrant chunks.
  // Cheaper than a full re-ingest — no LLM calls, no embeddings.
  ragLexicalRebuild: () =>
    request<{ indexed: number }>('/rag/lexical/rebuild', { method: 'POST' }),
  profile: (name: string) => get<Profile>(`/profile/${encodeURIComponent(name)}`),

  // ---- F-list character archive ----
  flistSignIn: (body: BodyOf<'/flist/session', 'post'>) =>
    request<Answer<'/flist/session', 'post'>>('/flist/session', {
      method: 'POST',
      body: JSON.stringify(body)
    }),
  flistSignOut: () =>
    request<Answer<'/flist/session', 'delete'>>('/flist/session', { method: 'DELETE' }),
  flistSession: () => get<Answer<'/flist/session', 'get'>>('/flist/session'),
  flistActivity: () =>
    get<Answer<'/flist/activity', 'get'>>('/flist/activity'),
  flistRoster: () => get<Answer<'/flist/characters', 'get'>>('/flist/characters'),
  flistLive: (characterId: string | number) =>
    get<Answer<'/flist/character/{character_id}/live', 'get'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/live`
    ),
  /** Right-click → 'Back up now': pulls (assumed already done by the
   *  caller) and writes a fresh ZIP regardless of dedup. */
  flistZipBackup: (characterId: string | number) =>
    request<Answer<'/flist/character/{character_id}/zip-backup', 'post'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/zip-backup`,
      { method: 'POST' }
    ),
  flistZipBackups: (characterId: string | number) =>
    get<Answer<'/flist/character/{character_id}/zip-backups', 'get'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/zip-backups`
    ),
  /** Rename a single backup (user-set label persisted in a sidecar
   *  `_names.json` map; the ZIP file is untouched). Empty name
   *  clears the rename. Returns the canonical updated entry so the
   *  renderer can patch its row without a full list re-fetch. */
  flistZipBackupRename: (
    characterId: string | number,
    filename: string,
    name: string
  ) =>
    request<Answer<'/flist/character/{character_id}/zip-backups/{filename}', 'patch'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/zip-backups/${encodeURIComponent(filename)}`,
      { method: 'PATCH', body: JSON.stringify({ name }) }
    ),
  /** Move a single backup ZIP to the character's Trash. Idempotent
   *  enough that the renderer refreshes the list either way: a Backup
   *  already gone (404) is not an error. Anything else surfaces to a
   *  toast.
   */
  flistZipBackupDelete: async (
    characterId: string | number,
    filename: string
  ): Promise<void> => {
    try {
      await request<Answer<'/flist/character/{character_id}/zip-backups/{filename}', 'delete'>>(
        `/flist/character/${encodeURIComponent(String(characterId))}/zip-backups/${encodeURIComponent(filename)}`,
        { method: 'DELETE' }
      )
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 404) throw err
    }
  },
  /** Raw ZIP bytes for Sidebar → Backups → right-click → Download.
   *  The renderer pipes these through `window.workbench.writeFile`
   *  to whatever path the user picks in the OS save dialog. */
  flistZipBackupDownload: (characterId: string | number, filename: string) =>
    requestBytes(
      `/flist/character/${encodeURIComponent(String(characterId))}/zip-backups/${encodeURIComponent(filename)}/download`
    ),
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
    get<Answer<'/flist/character/{character_id}/zip-backups/{filename}/payload', 'get'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/zip-backups/${encodeURIComponent(filename)}/payload`
    ),
  // ---- F-list mapping list (Tier 2: §2.x cached + force-refresh) ----
  flistMappingList: (opts?: { force?: boolean }) =>
    get<Answer<'/flist/mapping-list', 'get'>>(`/flist/mapping-list${opts?.force ? '?force=true' : ''}`),
  // ---- The workbench --------------------------------------------
  // A character has one editable copy of its profile beside Live,
  // seeded from Live when first needed (ADR 0001).
  /** Resolve the character's workbench, creating it from Live if it
   *  does not exist. `create: false` asks without making one, which is
   *  what a read-only render wants — merely looking at a character
   *  should not bring a bench into being. */
  flistWorkbench: (characterId: string | number, create = true) =>
    get<Answer<'/flist/character/{character_id}/workbench', 'get'>>(
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
    get<Answer<'/flist/character/{character_id}/workbench/payload', 'get'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/workbench/payload`
        + (opts.create === false ? '?create=false' : '')
    ),
  /** Save the whole Workbench over the etag it was read with, sent as
   *  `If-Match`. Saved without one, or over a stale one, it is refused
   *  as a conflict: `workbenchConflict` reads the etag on disk from
   *  the refusal. */
  flistWorkbenchPayloadPut: (
    characterId: string | number,
    payload: BodyOf<'/flist/character/{character_id}/workbench/payload', 'put'>,
    etag: string | null
  ) =>
    request<Answer<'/flist/character/{character_id}/workbench/payload', 'put'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/workbench/payload`,
      {
        method: 'PUT',
        headers: etag ? { 'If-Match': etag } : {},
        body: JSON.stringify(payload)
      }
    ),
  /** Reset to Live: the sidecar saves the Workbench as a Backup
   *  (`backed_up_first`, null when there was no Workbench yet), then
   *  makes it a fresh copy of Live and answers with that payload and
   *  its etag. When the Backup cannot be written nothing is replaced:
   *  a `workbench_not_kept` refusal. */
  flistWorkbenchResetToLive: (characterId: string | number) =>
    request<Answer<'/flist/character/{character_id}/workbench/reset-to-live', 'post'>>(
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
    get<Answer<'/flist/character/{character_id}/workbench/load-backup/preflight', 'get'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}`
        + `/workbench/load-backup/preflight?filename=`
        + encodeURIComponent(filename)
    ),
  /** Restore: replace the Workbench contents with a Backup's. The
   *  sidecar saves the Workbench as a Backup first (`backed_up_first`,
   *  null when there was no Workbench yet); when it cannot, nothing is
   *  replaced: a `workbench_not_kept` refusal. */
  flistWorkbenchLoadBackup: (characterId: string | number, filename: string) =>
    request<Answer<'/flist/character/{character_id}/workbench/load-backup', 'post'>>(
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
    request<Answer<'/flist/character/{character_id}/images/repair', 'post'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/images/repair`,
      { method: 'POST' }
    ),
  flistCharacterImages: (characterId: string | number) =>
    get<Answer<'/flist/character/{character_id}/images', 'get'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/images`
    ),
  /** Upload a local image (PNG/JPG/GIF). Lands as `images/local-<sha8>.<ext>`
   *  and shows up in the renderer's Pool view; only a working.json
   *  gallery edit moves it on-profile. */
  flistImageUpload: (characterId: string | number, data: Blob) =>
    request<Answer<'/flist/character/{character_id}/images', 'post'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/images`,
      { method: 'POST', body: data }
    ),
  /** Delete images, in the gallery or only in the pool: the route MCP's
   *  `trash_images` takes too. The sidecar takes gallery images off the
   *  Workbench's gallery (`off_gallery`) and answers the Workbench's new
   *  `etag`, null when the gallery was left alone; every file goes to
   *  the Trash. */
  flistImagesTrash: (characterId: string | number, imageIds: string[]) =>
    request<Answer<'/flist/character/{character_id}/images/trash', 'post'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/images/trash`,
      { method: 'POST', body: JSON.stringify({ image_ids: imageIds }) }
    ),
  /** Where each image id is still used: the Workbench, Live, Backups. */
  flistImageReferences: (characterId: string | number) =>
    get<Answer<'/flist/character/{character_id}/image-references', 'get'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/image-references`
    ),
  flistTrashList: (characterId: string | number) =>
    get<Answer<'/flist/character/{character_id}/trash', 'get'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/trash`
    ),
  flistTrashFileUrl: (characterId: string | number, filename: string) =>
    `${base()}/flist/character/${encodeURIComponent(String(characterId))}/trash/${encodeURIComponent(filename)}`,
  /** Back into the pool, not onto the profile. Takes trash ids. */
  flistTrashPutBack: (characterId: string | number, trashIds: string[]) =>
    request<Answer<'/flist/character/{character_id}/trash/put-back', 'post'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/trash/put-back`,
      { method: 'POST', body: JSON.stringify({ image_ids: trashIds }) }
    ),
  /** Delete trashed files for good. Takes trash ids. */
  flistTrashPurge: (characterId: string | number, trashIds: string[]) =>
    request<Answer<'/flist/character/{character_id}/trash/purge', 'post'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/trash/purge`,
      { method: 'POST', body: JSON.stringify({ image_ids: trashIds }) }
    ),
  /** Back into the Backup list, under the name they had. */
  flistTrashBackupsPutBack: (characterId: string | number, ids: string[]) =>
    request<Answer<'/flist/character/{character_id}/trash/backups/put-back', 'post'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/trash/backups/put-back`,
      { method: 'POST', body: JSON.stringify({ ids }) }
    ),
  /** Delete trashed Backups for good. */
  flistTrashBackupsPurge: (characterId: string | number, ids: string[]) =>
    request<Answer<'/flist/character/{character_id}/trash/backups/purge', 'post'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/trash/backups/purge`,
      { method: 'POST', body: JSON.stringify({ ids }) }
    ),
  /** Put cleared Labels back. A message labelled again since keeps its
   *  newer Label; its hash is listed under `skipped`. */
  flistTrashLabelsPutBack: (characterId: string | number, ids: string[]) =>
    request<Answer<'/flist/character/{character_id}/trash/labels/put-back', 'post'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/trash/labels/put-back`,
      { method: 'POST', body: JSON.stringify({ ids }) }
    ),
  /** Delete cleared Labels for good. */
  flistTrashLabelsPurge: (characterId: string | number, ids: string[]) =>
    request<Answer<'/flist/character/{character_id}/trash/labels/purge', 'post'>>(
      `/flist/character/${encodeURIComponent(String(characterId))}/trash/labels/purge`,
      { method: 'POST', body: JSON.stringify({ ids }) }
    ),
  /** Empty the whole Trash: images, Backups and cleared Labels. */
  flistTrashEmpty: (characterId: string | number) =>
    request<Answer<'/flist/character/{character_id}/trash', 'delete'>>(
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
    requestStream(
      '/flist/backup-all',
      { method: 'POST' },
      (block) => dispatchBackupAllStream(block, handlers),
      opts
    ),
  /** Starts a Pull of `name` and follows its progress (SSE). A job, like
   *  Back up all: aborting `opts.signal` only stops following. */
  flistPull: (name: string, handlers: FlistPullHandlers, opts?: ApiOptions): Promise<void> =>
    requestStream(
      `/flist/character/${encodeURIComponent(name)}/pull`,
      { method: 'POST' },
      (block) => dispatchPullStream(block, handlers),
      opts
    ),
  /** Every job the sidecar remembers: running ones, and finished ones
   *  for a few minutes. A reopened window finds its Pulls here. */
  jobsList: (opts?: ApiOptions) => get<{ jobs: Job[] }>('/jobs', opts),
  /** Follow a running Pull from the start of its events. */
  flistPullFollow: (jobId: string, handlers: FlistPullHandlers, opts?: ApiOptions): Promise<void> =>
    requestStream(jobEventsPath(jobId), {}, (block) => dispatchPullStream(block, handlers), opts),
  /** Follow a running Back up all from the start of its events. */
  flistBackupAllFollow: (
    jobId: string,
    handlers: FlistBackupAllHandlers,
    opts?: ApiOptions
  ): Promise<void> =>
    requestStream(
      jobEventsPath(jobId),
      {},
      (block) => dispatchBackupAllStream(block, handlers),
      opts
    ),

  // ---- Browser-extension pairing (restore flow) -------------------------
  restorePendingHandshakes: () =>
    get<Answer<'/restore/handshake/pending', 'get'>>('/restore/handshake/pending'),
  restoreAcceptHandshake: (handshakeId: string) =>
    request<Answer<'/restore/handshake/accept', 'post'>>('/restore/handshake/accept', {
      method: 'POST',
      body: JSON.stringify({ handshake_id: handshakeId })
    }),
  restoreRejectHandshake: (handshakeId: string) =>
    request<Answer<'/restore/handshake/reject', 'post'>>('/restore/handshake/reject', {
      method: 'POST',
      body: JSON.stringify({ handshake_id: handshakeId })
    }),
  restoreRevokeToken: () =>
    request<Answer<'/restore/token', 'delete'>>('/restore/token', { method: 'DELETE' }),
  /** Whether a pairing token is stored. The token itself never comes
   *  back; only the app window can ask. */
  pairingStatus: () => get<Answer<'/pairing', 'get'>>('/pairing'),

  /** The extension version the browser runs, as of its last paired
   *  call. Null until the extension has made one since the app started. */
  restoreExtensionSeen: () =>
    request<Answer<'/restore/extension', 'get'>>('/restore/extension')
}

function jobEventsPath(jobId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}/events`
}

/** Read an ok SSE response block by block until it ends. */
async function readEventStream(res: Response, onBlock: (block: string) => void): Promise<void> {
  if (!res.body) throw new HttpError(res.status, 'no body')
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

