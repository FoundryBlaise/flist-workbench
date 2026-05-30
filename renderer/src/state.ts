import { create } from 'zustand'
import {
  api,
  type CharacterEntry,
  type Document,
  type FlistAccountCharacter,
  type FlistBackupEntry,
  type FlistRosterEntry,
  type FlistSessionStatus,
  type InlineImage,
  type LogMessage,
  type PartnerEntry,
  type RevisionSummary
} from './lib/api'

export type Mode = 'editor' | 'logs'

const LAST_SEEN_KEY = 'flist-workbench:char-last-seen'
const FLIST_ACCOUNT_KEY = 'flist-workbench:last-account'
const FLIST_LAST_CHAR_KEY = 'flist-workbench:last-flist-char-id'
// Auto-pull threshold. Matches the picker's own staleness display so
// the UI and the auto-pull policy can't drift apart. F-list's hourly
// API cap is 200 — even a user hopping between 30 characters all day
// stays well under it at this rate.
const STALE_AGE_SEC = 30 * 60

function readLastSeen(): Record<string, number> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(LAST_SEEN_KEY)
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function writeLastSeen(map: Record<string, number>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(map))
  } catch {
    // private mode / storage full — fine, dots just won't persist
  }
}

type State = {
  characters: CharacterEntry[]
  charactersStatus: 'idle' | 'loading' | 'ready' | 'error'
  charactersError: string | null
  /** Last time the user opened the log tab for each character (epoch seconds). */
  charLastSeen: Record<string, number>

  activeCharacter: string | null
  mode: Mode
  /** When true, the logs main pane shows the cross-conversation search view. */
  crossSearchOpen: boolean

  partners: Record<string, PartnerEntry[]>
  partnersStatus: Record<string, 'loading' | 'ready' | 'error'>

  activePartner: string | null

  /** When set, a Classify-labels progress dialog is open over the app. */
  classifyTarget: { scope: { character?: string | null; partner?: string | null }; label: string } | null

  /** When set, a RAG-ingest progress dialog is open over the app.
   *  forceRewipe=true makes the dialog start the job with wipe-and-
   *  reingest semantics; used by the Settings → RAG "Re-ingest all"
   *  button after the user confirms. Default false. */
  ingestTarget:
    | {
        scope: { character?: string | null; partner?: string | null }
        label: string
        forceRewipe: boolean
      }
    | null

  /** Visibility of the RAG chat panel beside the Log Viewer. */
  chatPanelOpen: boolean
  /** Bumped any time something wants the chat input focused — e.g. the
   *  "Chat with this log" context-menu action. ChatPanel watches it. */
  chatFocusNonce: number
  /** Pending "scroll the log viewer to this timestamp range" intent
   *  raised by a clicked citation. LogViewer consumes & clears it. */
  logJump:
    | { character: string; partner: string; ts_start: number; ts_end: number; nonce: number }
    | null

  messagesByPartner: Record<string, LogMessage[]>
  messagesStatus: Record<string, 'loading' | 'ready' | 'error'>
  messagesError: Record<string, string | null>

  // Documents — F5 persisted document store
  documents: Document[]
  documentsStatus: 'idle' | 'loading' | 'ready' | 'error'
  documentsError: string | null
  activeDocId: number | null
  /** Revision summaries per doc (lazy). */
  revisionsByDoc: Record<number, RevisionSummary[]>
  revisionsStatus: Record<number, 'loading' | 'ready' | 'error'>

  editorContent: string
  editorTitle: string
  editorInlines: Record<string, InlineImage>
  editorFetchStatus: 'idle' | 'fetching' | 'ok' | 'error'
  editorFetchError: string | null
  editorDirty: boolean

  saveStatus: 'idle' | 'saving' | 'saved' | 'error'
  saveError: string | null
  /** Set by EditorPane after an idle window; "draft has been flushed". */
  draftStatus: 'idle' | 'saving' | 'saved' | 'error'

  // ---- F-list character archive (Phase 7 Tier 1) ----
  /** Whether the user has signed in to F-list this session. The sidecar
   *  holds the ticket; the renderer mirrors enough state to render the
   *  chip + footer. */
  flistSession: FlistSessionStatus
  /** Account-roster characters returned by the most recent sign-in. */
  flistAccountCharacters: FlistAccountCharacter[]
  /** Unified roster (account + archived + log-only) from /flist/characters. */
  flistRoster: FlistRosterEntry[]
  flistRosterStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** ID of the F-list character whose Live/Backup docs the user is
   *  currently viewing. Distinct from `activeCharacter` (the F-Chat-log
   *  filter) because the two rosters don't always overlap. */
  flistActiveCharacterId: string | null
  /** Per-character archive state. Keyed by character_id string. */
  flistArchive: Record<
    string,
    {
      live: Record<string, unknown> | null
      backups: FlistBackupEntry[]
      pullStatus: 'idle' | 'queued' | 'running' | 'done' | 'error'
      pullStage?: string
      pullProgress?: { done: number; total: number }
      pullError?: string | null
      lastPullAt?: number | null
      // On-disk integrity status: was the prior pull complete, or was
      // it interrupted / did some images fail? Sourced from
      // /flist/characters (server walks images_dir) and updated when a
      // new pull's "done" event arrives. Drives the "Pull incomplete"
      // affordance in FlistCharacterZone.
      integrity?: {
        status: 'complete' | 'partial' | 'interrupted' | 'unknown' | 'never_pulled'
        missing: number
      }
    }
  >
  /** Per-character in-memory working copies. Keyed by character_id.
   *  Picking a character loads its working copy into the editor;
   *  switching to another character preserves the previous one's
   *  unsaved edits so the user can flip back without losing work.
   *  Tier 1 keeps this strictly in-memory — Tier 2 will persist to
   *  `<userdata>/characters/<id>/working.json` so edits survive an
   *  app restart. */
  flistWorking: Record<string, { content: string; dirty: boolean }>
  /** AbortController for the in-flight character pull. Sign-out
   *  aborts this before clearing the ticket so a long-running pull
   *  doesn't continue writing to disk against a torn-down session. */
  flistPullAbortController: AbortController | null
  /** When true, EditorPane/PreviewPane/Toolbar all switch to read-only
   *  mode. Set whenever the user opens a Live or historical Backup
   *  document. */
  editorReadOnly: boolean
  /** Modal visibility for the sign-in dialog. */
  flistSignInOpen: boolean
  /** Last error from a sign-in attempt; passed verbatim from F-list per
   *  the Tier 1 decision. */
  flistSignInError: string | null
  flistSignInStatus: 'idle' | 'submitting' | 'error'

  loadCharacters: () => Promise<void>
  selectCharacter: (name: string | null) => void
  markCharacterSeen: (name: string) => void
  setMode: (mode: Mode) => void
  setCrossSearchOpen: (open: boolean) => void
  loadPartners: (char: string) => Promise<void>
  selectPartner: (name: string | null) => void
  loadMessages: (char: string, partner: string, opts?: { force?: boolean }) => Promise<void>
  invalidateMessages: (char: string, partner: string) => void
  openClassify: (
    scope: { character?: string | null; partner?: string | null },
    label: string
  ) => void
  closeClassify: () => void
  openIngest: (
    scope: { character?: string | null; partner?: string | null },
    label: string,
    opts?: { forceRewipe?: boolean }
  ) => void
  closeIngest: () => void
  toggleChatPanel: (force?: boolean) => void
  requestChatFocus: () => void
  requestLogJump: (
    character: string,
    partner: string,
    ts_start: number,
    ts_end: number
  ) => void
  clearLogJump: () => void
  applyLabelOverride: (
    char: string,
    partner: string,
    hash: string,
    patch: {
      label?: 'IC' | 'OOC'
      label_source?: 'llm' | 'manual'
    } | null
  ) => void
  setEditorContent: (value: string) => void
  fetchProfile: (name: string) => Promise<void>
  resetEditorDirty: () => void

  // ---- F-list actions ----
  flistOpenSignIn: () => void
  flistCloseSignIn: () => void
  flistSignIn: (account: string, password: string) => Promise<void>
  flistSignOut: () => Promise<void>
  flistRefreshSession: () => Promise<void>
  flistLoadRoster: () => Promise<void>
  flistSelectCharacter: (characterId: string | null) => Promise<void>
  flistLoadArchive: (characterId: string) => Promise<void>
  flistPullCharacter: (name: string, characterId?: string | null) => Promise<void>
  flistSaveBackup: (characterId: string) => Promise<void>
  flistOpenLive: (characterId: string) => Promise<void>
  flistOpenBackup: (characterId: string, filename: string) => Promise<void>
  /** Load the editor with this character's in-memory working copy.
   *  Falls back to the Live description when no working copy exists
   *  yet. The previous character's edits stay in `flistWorking` so a
   *  later switch-back restores them verbatim. */
  flistOpenWorking: (characterId: string) => Promise<void>
  flistGetLastAccount: () => string

  // Documents
  loadDocuments: () => Promise<void>
  openDocument: (id: number) => Promise<void>
  createDocument: (name: string) => Promise<Document>
  duplicateActiveDocument: (name: string) => Promise<Document | null>
  renameDocument: (id: number, name: string) => Promise<void>
  deleteDocument: (id: number) => Promise<void>
  saveActiveDocument: () => Promise<void>
  saveActiveDraft: () => Promise<void>
  loadRevisions: (id: number) => Promise<void>
  restoreRevision: (revId: number) => Promise<void>
}

function partnerKey(char: string, partner: string): string {
  return `${char}::${partner}`
}

// F-list serves descriptions with literal CRLF / CR. Normalise before
// they hit CodeMirror + the BBCode→HTML preview so they don't render
// as doubled blank lines.
function normaliseNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

// character-data.php returns `inlines` as a top-level dict mapping
// inline-image id → {hash, extension, nsfw}. The renderer's BBCode
// transformer needs that dict to resolve `[img=<id>]` tags to CDN
// URLs (`static.f-list.net/images/charinline/<hash>.<ext>`). Without
// it, every inline tag renders as a broken image — caught after the
// JSON-API swap because the working/Live/Backup loaders hardcoded
// `editorInlines: {}` and only the old Fetch-profile path extracted
// them properly.
function extractInlines(payload: unknown): Record<string, InlineImage> {
  if (!payload || typeof payload !== 'object') return {}
  const raw = (payload as { inlines?: unknown }).inlines
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, InlineImage> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (
      v &&
      typeof v === 'object' &&
      typeof (v as { hash?: unknown }).hash === 'string' &&
      typeof (v as { extension?: unknown }).extension === 'string'
    ) {
      const entry = v as { hash: string; extension: string; nsfw?: unknown }
      out[String(k)] = {
        hash: entry.hash,
        extension: entry.extension,
        nsfw: Boolean(entry.nsfw)
      }
    }
  }
  return out
}

// Pulled out so fetchProfile and openDocument can both reset shared
// editor state cleanly.
function editorReplaceState(profile: {
  bbcode: string
  title: string
  inlines: Record<string, InlineImage>
}) {
  return {
    editorContent: profile.bbcode,
    editorTitle: profile.title,
    editorInlines: profile.inlines,
    editorDirty: false,
    saveStatus: 'idle' as const,
    saveError: null,
    draftStatus: 'idle' as const
  }
}

const SAMPLE_BBCODE = `[heading]F-list Workbench[/heading]
[i]Type BBCode here, watch it render on the right.[/i]

[hr]

[b]Try:[/b]
[indent][b]Bold[/b], [i]italic[/i], [u]underline[/u], [s]strike[/s].[/indent]
[indent]Coloured text in [color=red]red[/color], [color=blue]blue[/color], [color=green]green[/color].[/indent]
[indent]Inline character icons: [icon]CharacterName[/icon] — replace with any public F-list character name.[/indent]
[indent]Emote icons: [eicon]smirk[/eicon] [eicon]wink[/eicon][/indent]
[indent]A link: [url=https://www.f-list.net]F-list[/url][/indent]

[collapse=Click to expand][center]Hidden content.[/center][/collapse]`

export const useStore = create<State>((set, get) => ({
  characters: [],
  charactersStatus: 'idle',
  charactersError: null,
  charLastSeen: readLastSeen(),

  activeCharacter: null,
  mode: 'editor',
  crossSearchOpen: false,

  partners: {},
  partnersStatus: {},
  activePartner: null,

  classifyTarget: null,
  ingestTarget: null,
  chatPanelOpen: false,
  chatFocusNonce: 0,
  logJump: null,

  messagesByPartner: {},
  messagesStatus: {},
  messagesError: {},

  documents: [],
  documentsStatus: 'idle',
  documentsError: null,
  activeDocId: null,
  revisionsByDoc: {},
  revisionsStatus: {},

  editorContent: SAMPLE_BBCODE,
  editorTitle: 'Scratch.bbcode',
  editorInlines: {},
  editorFetchStatus: 'idle',
  editorFetchError: null,
  editorDirty: false,

  saveStatus: 'idle',
  saveError: null,
  draftStatus: 'idle',

  flistSession: { active: false },
  flistAccountCharacters: [],
  flistRoster: [],
  flistRosterStatus: 'idle',
  flistActiveCharacterId: null,
  flistArchive: {},
  flistWorking: {},
  flistPullAbortController: null,
  editorReadOnly: false,
  flistSignInOpen: false,
  flistSignInError: null,
  flistSignInStatus: 'idle',

  // ---- F-list actions ----------------------------------------------------

  flistGetLastAccount() {
    if (typeof localStorage === 'undefined') return ''
    try {
      return localStorage.getItem(FLIST_ACCOUNT_KEY) ?? ''
    } catch {
      return ''
    }
  },

  flistOpenSignIn() {
    set({ flistSignInOpen: true, flistSignInError: null, flistSignInStatus: 'idle' })
  },

  flistCloseSignIn() {
    set({ flistSignInOpen: false })
  },

  async flistSignIn(account, password) {
    set({ flistSignInStatus: 'submitting', flistSignInError: null })
    try {
      const res = await api.flistSignIn({ account, password })
      try {
        localStorage.setItem(FLIST_ACCOUNT_KEY, account)
      } catch {
        // localStorage unavailable — account just won't pre-fill next session
      }
      set({
        flistSignInStatus: 'idle',
        flistSignInOpen: false,
        flistAccountCharacters: res.characters,
        flistSession: {
          active: true,
          account: res.account,
          expires_in_sec: res.expires_in_sec
        }
      })
      await get().flistLoadRoster()
    } catch (err) {
      // F-list returns the human-readable error in `detail`; the
      // request() helper folds it into `HTTP 401: <detail>`. Strip the
      // prefix so the modal shows "Invalid account name or password"
      // instead of "HTTP 401: Invalid account name or password".
      const raw = err instanceof Error ? err.message : String(err)
      const stripped = raw.replace(/^HTTP \d+:\s*/, '')
      set({ flistSignInStatus: 'error', flistSignInError: stripped })
    }
  },

  async flistSignOut() {
    // Abort any in-flight pull BEFORE clearing the ticket so the
    // sidecar's producer task doesn't keep writing live.json + image
    // bytes against a torn-down session. The pull-lock and httpx
    // client clean up via the producer's try/finally on disconnect.
    const ctrl = get().flistPullAbortController
    if (ctrl) {
      try { ctrl.abort() } catch { /* already aborted */ }
    }
    try {
      await api.flistSignOut()
    } catch {
      // Server-side clear is best-effort; clearing local state is the
      // user-visible signal that matters.
    }
    set({
      flistSession: { active: false },
      flistAccountCharacters: [],
      flistActiveCharacterId: null,
      editorReadOnly: false,
      flistPullAbortController: null
    })
    await get().flistLoadRoster()
  },

  async flistRefreshSession() {
    try {
      const status = await api.flistSession()
      set({ flistSession: status })
      if (!status.active && get().flistActiveCharacterId !== null) {
        // Session lapsed (e.g. sidecar restart). Drop active selection
        // so the UI doesn't render stale read-only docs.
        set({ flistActiveCharacterId: null, editorReadOnly: false })
      }
    } catch {
      // Sidecar unreachable — leave existing flag, /health card already
      // surfaces it.
    }
  },

  async flistLoadRoster() {
    set({ flistRosterStatus: 'loading' })
    try {
      const { characters } = await api.flistRoster()
      set((s) => {
        const archive = { ...s.flistArchive }
        for (const entry of characters) {
          if (entry.id === null || !entry.pull_status) continue
          const key = String(entry.id)
          const prev = archive[key] ?? {
            live: null,
            backups: [],
            pullStatus: 'idle' as const,
          }
          archive[key] = {
            ...prev,
            integrity: {
              status: entry.pull_status.status,
              missing: entry.pull_status.missing_image_ids.length,
            },
          }
        }
        return {
          flistRoster: characters,
          flistRosterStatus: 'ready',
          flistArchive: archive,
        }
      })
    } catch {
      set({ flistRosterStatus: 'error' })
    }
  },

  async flistSelectCharacter(characterId) {
    set({ flistActiveCharacterId: characterId })
    if (characterId === null) {
      set({ editorReadOnly: false })
      return
    }
    try {
      localStorage.setItem(FLIST_LAST_CHAR_KEY, characterId)
    } catch {
      // ignore
    }
    await get().flistLoadArchive(characterId)
  },

  async flistLoadArchive(characterId) {
    // Initialise the slot if missing so the UI has somewhere to render
    // the "no Live yet" empty state.
    set((s) => ({
      flistArchive: {
        ...s.flistArchive,
        [characterId]: s.flistArchive[characterId] ?? {
          live: null,
          backups: [],
          pullStatus: 'idle'
        }
      }
    }))
    const [live, backups] = await Promise.all([
      api.flistLive(characterId).catch(() => null),
      api
        .flistBackups(characterId)
        .then((r) => r.backups)
        .catch(() => [])
    ])
    set((s) => ({
      flistArchive: {
        ...s.flistArchive,
        [characterId]: {
          ...(s.flistArchive[characterId] ?? { pullStatus: 'idle' }),
          live,
          backups,
          lastPullAt:
            (live && typeof live.fetched_at === 'number'
              ? (live.fetched_at as number)
              : null) ?? null
        }
      }
    }))
  },

  async flistPullCharacter(name, characterId) {
    const targetId = characterId ?? null
    const setStatus = (
      patch: Partial<{
        pullStatus: 'idle' | 'queued' | 'running' | 'done' | 'error'
        pullStage: string
        pullProgress: { done: number; total: number }
        pullError: string | null
      }>
    ) => {
      if (!targetId) return
      set((s) => ({
        flistArchive: {
          ...s.flistArchive,
          [targetId]: {
            ...(s.flistArchive[targetId] ?? {
              live: null,
              backups: [],
              pullStatus: 'idle'
            }),
            ...patch
          }
        }
      }))
    }
    setStatus({ pullStatus: 'queued', pullError: null })
    const ctrl = new AbortController()
    set({ flistPullAbortController: ctrl })
    try {
      await api.flistPull(name, {
        onQueued: () => setStatus({ pullStatus: 'queued', pullStage: 'queued' }),
        onTicket: () =>
          setStatus({ pullStatus: 'running', pullStage: 'ticket' }),
        onFetching: () =>
          setStatus({ pullStatus: 'running', pullStage: 'fetching' }),
        onImages: ({ total }) =>
          setStatus({
            pullStatus: 'running',
            pullStage: 'images',
            pullProgress: { done: 0, total }
          }),
        onImage: ({ index, total }) =>
          setStatus({
            pullProgress: { done: index, total }
          }),
        onDone: async (info) => {
          // We know the character_id now even if we didn't before. Make
          // sure the per-id slot exists and gets reloaded.
          set((s) => ({
            flistArchive: {
              ...s.flistArchive,
              [info.character_id]: {
                ...(s.flistArchive[info.character_id] ?? {
                  live: null,
                  backups: [],
                  pullStatus: 'idle'
                }),
                pullStatus: 'done',
                pullStage: 'done'
              }
            }
          }))
          await get().flistLoadArchive(info.character_id)
          await get().flistLoadRoster()
          // If the user is sitting on this character's working copy and
          // hasn't typed anything yet, refresh the editor with the
          // freshly-pulled Live content. Skip when the working copy is
          // dirty OR when the live editorContent has already diverged
          // from the seeded content — covers the race where keystrokes
          // arrived between the dirty=false snapshot we took and now.
          const isActive =
            get().flistActiveCharacterId === info.character_id &&
            get().activeDocId === null &&
            !get().editorReadOnly
          const working = get().flistWorking[info.character_id]
          const liveDiverged =
            working !== undefined &&
            get().editorContent !== working.content
          const safe = isActive && (!working || (!working.dirty && !liveDiverged))
          if (safe) {
            // Clear any seeded-but-clean working entry so flistOpenWorking
            // re-reads from the new Live rather than reusing the stale
            // content it cached at the previous open.
            if (working) {
              set((s) => {
                const next = { ...s.flistWorking }
                delete next[info.character_id]
                return { flistWorking: next }
              })
            }
            void get().flistOpenWorking(info.character_id)
          }
        },
        onError: ({ message }) => {
          setStatus({ pullStatus: 'error', pullError: message })
        }
      }, { signal: ctrl.signal })
    } catch (err) {
      // AbortError = user-initiated (sign-out / explicit cancel).
      // Don't surface as a scary error to the user.
      const raw = err instanceof Error ? err.message : String(err)
      if (err instanceof Error && err.name === 'AbortError') {
        setStatus({ pullStatus: 'idle', pullError: null })
      } else {
        setStatus({ pullStatus: 'error', pullError: raw })
      }
    } finally {
      if (get().flistPullAbortController === ctrl) {
        set({ flistPullAbortController: null })
      }
    }
  },

  async flistSaveBackup(characterId) {
    try {
      await api.flistSaveBackup(characterId)
      await get().flistLoadArchive(characterId)
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      set((s) => ({
        flistArchive: {
          ...s.flistArchive,
          [characterId]: {
            ...(s.flistArchive[characterId] ?? {
              live: null,
              backups: [],
              pullStatus: 'idle'
            }),
            pullError: raw
          }
        }
      }))
    }
  },

  async flistOpenLive(characterId) {
    const archive = get().flistArchive[characterId]
    const live = archive?.live ?? (await api.flistLive(characterId).catch(() => null))
    if (!live) return
    const character = (live.character ?? live) as Record<string, unknown>
    const name =
      (typeof character.name === 'string' && character.name) ||
      (typeof live.name === 'string' && (live.name as string)) ||
      'Live'
    const rawBbcode =
      (typeof character.description === 'string' && (character.description as string)) ||
      (typeof live.description === 'string' && (live.description as string)) ||
      ''
    set({
      activeDocId: null,
      editorContent: normaliseNewlines(rawBbcode),
      editorTitle: `${name} — Live.bbcode`,
      editorInlines: extractInlines(live),
      editorReadOnly: true,
      editorDirty: false,
      saveStatus: 'idle',
      saveError: null,
      draftStatus: 'idle'
    })
  },

  async flistOpenBackup(characterId, filename) {
    const payload = await api.flistBackupRead(characterId, filename).catch(() => null)
    if (!payload) return
    const character = (payload.character ?? payload) as Record<string, unknown>
    const name =
      (typeof character.name === 'string' && character.name) || 'Backup'
    const rawBbcode =
      (typeof character.description === 'string' && (character.description as string)) ||
      ''
    set({
      activeDocId: null,
      editorContent: normaliseNewlines(rawBbcode),
      editorTitle: `${name} — ${filename}`,
      editorInlines: extractInlines(payload),
      editorReadOnly: true,
      editorDirty: false,
      saveStatus: 'idle',
      saveError: null,
      draftStatus: 'idle'
    })
  },

  async flistOpenWorking(characterId) {
    const existing = get().flistWorking[characterId]
    let content = existing?.content ?? ''
    let dirty = existing?.dirty ?? false
    // Resolve inlines from the Live payload regardless of whether
    // we use the cached working content or seed fresh — `[img=N]`
    // tags in the BBCode need the manifest to render.
    let inlines: Record<string, InlineImage> = {}
    const slot = get().flistArchive[characterId]
    let live = slot?.live
    if (!live) {
      live = await api.flistLive(characterId).catch(() => null)
    }
    if (live) {
      inlines = extractInlines(live)
    }
    // No working copy yet → seed from Live so the editor isn't blank.
    // If Live isn't on disk (never pulled), fall back to empty and let
    // the auto-pull triggered by selectCharacter refill us later via
    // the pull-completion handler in flistPullCharacter.
    if (!existing && live) {
      const character = (live.character ?? live) as Record<string, unknown>
      const desc =
        (typeof character.description === 'string' &&
          (character.description as string)) ||
        ''
      content = normaliseNewlines(desc)
      set((s) => ({
        flistWorking: {
          ...s.flistWorking,
          [characterId]: { content, dirty: false }
        }
      }))
    }
    const entry = get().flistRoster.find(
      (r) => String(r.id ?? '') === characterId
    )
    const name = entry?.name ?? 'My edits'
    set({
      activeDocId: null,
      editorContent: content,
      editorTitle: `${name} — My edits (draft)`,
      editorInlines: inlines,
      editorReadOnly: false,
      editorDirty: dirty,
      saveStatus: 'idle',
      saveError: null,
      draftStatus: 'idle'
    })
  },

  async loadCharacters() {
    set({ charactersStatus: 'loading', charactersError: null })
    try {
      const { characters } = await api.characters()
      set({
        characters,
        charactersStatus: 'ready',
        activeCharacter: get().activeCharacter ?? characters[0]?.name ?? null
      })
    } catch (err) {
      set({
        charactersStatus: 'error',
        charactersError: err instanceof Error ? err.message : String(err)
      })
    }
  },

  selectCharacter(name) {
    set({ activeCharacter: name, activePartner: null })
    if (!name) {
      set({ flistActiveCharacterId: null, editorReadOnly: false })
      return
    }
    // Mirror the pick into the F-list slice when the name matches a
    // roster entry that has an F-list id. Keeps the one-active-character
    // mental model coherent — the same selection drives both the logs
    // filter and the F-list zone's Live/Backup docs.
    const match = get().flistRoster.find(
      (r) => r.name.toLowerCase() === name.toLowerCase()
    )
    if (match && match.id !== null) {
      const id = String(match.id)
      const switched = get().flistActiveCharacterId !== id
      if (switched) {
        try {
          localStorage.setItem(FLIST_LAST_CHAR_KEY, id)
        } catch {
          // ignore
        }
        set({ flistActiveCharacterId: id })
        void get().flistLoadArchive(id)
      }
      // Always reload the working copy on a picker click, even when
      // the character id didn't change. Otherwise a user who's
      // currently viewing the Live or a Backup (editor in read-only
      // mode) and re-picks the same character stays stuck in read-only
      // — the picker click looks ignored. flistOpenWorking is a no-op
      // if the working slot already exists with the user's edits, so
      // re-loading the same character costs nothing.
      void get().flistOpenWorking(id)
      // Auto-pull on select when the Live snapshot is missing or older
      // than the staleness threshold. User can still trigger a manual
      // refresh via the FlistCharacterZone's button at any time.
      const slot = get().flistArchive[id]
      const lastPullAt = slot?.lastPullAt ?? match.last_pulled_at ?? null
      const ageSec = lastPullAt
        ? Date.now() / 1000 - lastPullAt
        : Number.POSITIVE_INFINITY
      const pullInFlight =
        slot?.pullStatus === 'queued' || slot?.pullStatus === 'running'
      if (ageSec >= STALE_AGE_SEC && !pullInFlight) {
        void get().flistPullCharacter(match.name, id)
      }
    } else if (get().flistActiveCharacterId !== null) {
      // Picked a log-only character that isn't on F-list — clear the
      // F-list zone so it doesn't show stale Live/Backup docs from the
      // previous character.
      set({ flistActiveCharacterId: null, editorReadOnly: false })
    }
  },

  markCharacterSeen(name) {
    const now = Date.now() / 1000
    set((s) => {
      const next = { ...s.charLastSeen, [name]: now }
      writeLastSeen(next)
      return { charLastSeen: next }
    })
  },

  setMode(mode) {
    set({ mode, crossSearchOpen: mode === 'logs' ? get().crossSearchOpen : false })
  },

  setCrossSearchOpen(open) {
    set({ crossSearchOpen: open })
  },

  async loadPartners(char) {
    set((s) => ({ partnersStatus: { ...s.partnersStatus, [char]: 'loading' } }))
    try {
      const { partners } = await api.partners(char)
      set((s) => ({
        partners: { ...s.partners, [char]: partners },
        partnersStatus: { ...s.partnersStatus, [char]: 'ready' }
      }))
    } catch {
      set((s) => ({
        partnersStatus: { ...s.partnersStatus, [char]: 'error' }
      }))
    }
  },

  selectPartner(name) {
    set({ activePartner: name, crossSearchOpen: false })
  },

  async loadMessages(char, partner, opts) {
    const key = partnerKey(char, partner)
    if (get().messagesStatus[key] === 'ready' && !opts?.force) return
    set((s) => ({
      messagesStatus: { ...s.messagesStatus, [key]: 'loading' },
      messagesError: { ...s.messagesError, [key]: null }
    }))
    try {
      const { messages } = await api.messages(char, partner)
      set((s) => ({
        messagesByPartner: { ...s.messagesByPartner, [key]: messages },
        messagesStatus: { ...s.messagesStatus, [key]: 'ready' }
      }))
    } catch (err) {
      set((s) => ({
        messagesStatus: { ...s.messagesStatus, [key]: 'error' },
        messagesError: {
          ...s.messagesError,
          [key]: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  // Drop the cached entry so the next loadMessages refetches. Used
  // after a multi-scope classify so the currently open conversation
  // doesn't show stale labels.
  invalidateMessages(char, partner) {
    const key = partnerKey(char, partner)
    set((s) => {
      const { [key]: _, ...byPartner } = s.messagesByPartner
      const { [key]: __, ...status } = s.messagesStatus
      void _
      void __
      return { messagesByPartner: byPartner, messagesStatus: status }
    })
  },

  openClassify(scope, label) {
    set({ classifyTarget: { scope, label } })
  },

  closeClassify() {
    set({ classifyTarget: null })
  },

  openIngest(scope, label, opts) {
    set({
      ingestTarget: { scope, label, forceRewipe: opts?.forceRewipe ?? false }
    })
  },

  closeIngest() {
    set({ ingestTarget: null })
  },

  toggleChatPanel(force) {
    set((s) => ({
      chatPanelOpen: typeof force === 'boolean' ? force : !s.chatPanelOpen
    }))
  },

  requestChatFocus() {
    set((s) => ({ chatFocusNonce: s.chatFocusNonce + 1 }))
  },

  requestLogJump(character, partner, ts_start, ts_end) {
    // nonce guarantees a fresh value even if the user clicks the same
    // citation twice — useEffect dependencies see a new reference.
    set({
      logJump: { character, partner, ts_start, ts_end, nonce: Date.now() }
    })
  },

  clearLogJump() {
    set({ logJump: null })
  },

  // Patches a single message's label fields in place. `patch === null`
  // clears label fields back to rule/Unlabeled resolution — but since
  // the resolver runs server-side, we approximate locally by removing
  // label_source and falling back to the rule the renderer can compute
  // (or 'Unlabeled' if unknown). The next loadMessages refresh
  // re-resolves from the sidecar authoritatively.
  applyLabelOverride(char, partner, hash, patch) {
    const key = partnerKey(char, partner)
    set((s) => {
      const list = s.messagesByPartner[key]
      if (!list) return s
      const next = list.map((m) => {
        if (m.hash !== hash) return m
        if (patch === null) {
          const { label_source, ...rest } = m
          void label_source
          // Drop the explicit label so the UI treats it as needing
          // rule recomputation; the resolver re-runs on next fetch.
          return { ...rest, label: undefined }
        }
        return {
          ...m,
          label: patch.label ?? m.label,
          label_source: patch.label_source ?? m.label_source
        }
      })
      return { messagesByPartner: { ...s.messagesByPartner, [key]: next } }
    })
  },

  setEditorContent(value) {
    set((s) => {
      // Working-copy mode: editor is showing an F-list character's
      // editable copy (no local doc active, not in read-only Live /
      // Backup view). Keep the per-character working slot in sync so
      // switching characters and back doesn't lose edits.
      const isWorkingCopyMode =
        s.flistActiveCharacterId !== null &&
        s.activeDocId === null &&
        !s.editorReadOnly
      const workingPatch = isWorkingCopyMode
        ? {
            flistWorking: {
              ...s.flistWorking,
              [s.flistActiveCharacterId!]: {
                content: value,
                dirty: true
              }
            }
          }
        : {}
      return {
        editorContent: value,
        editorDirty: s.editorDirty || value !== s.editorContent,
        // Mark draft stale as soon as the user types — the autosave
        // effect will pick this up and flush after the idle window.
        draftStatus: 'idle',
        ...workingPatch
      }
    })
  },

  resetEditorDirty() {
    set({ editorDirty: false })
  },

  async fetchProfile(name) {
    // Synchronous guard against rapid duplicate clicks: a `disabled`
    // button alone doesn't help because React hasn't repainted between
    // a burst of click events. Reading `editorFetchStatus` here AND
    // setting it before the first await closes that race.
    if (get().editorFetchStatus === 'fetching') return
    set({ editorFetchStatus: 'fetching', editorFetchError: null })
    try {
      const profile = await api.profile(name)
      const previousContent = get().editorContent
      set({
        ...editorReplaceState({
          bbcode: profile.bbcode,
          title: `${profile.name}.bbcode`,
          inlines: profile.inlines ?? {}
        }),
        editorFetchStatus: 'ok',
        editorFetchError: null,
        // Mark dirty only when the fetched content actually differs
        // from what was on screen — re-fetching the same profile into
        // the same doc shouldn't surprise the user with a forced save.
        editorDirty: get().activeDocId !== null && previousContent !== profile.bbcode
      })
    } catch (err) {
      set({
        editorFetchStatus: 'error',
        editorFetchError: humanizeFetchError(err, name)
      })
    }
  },

  // ---- documents ------------------------------------------------------

  async loadDocuments() {
    set({ documentsStatus: 'loading', documentsError: null })
    try {
      const { documents } = await api.documents()
      set({ documents, documentsStatus: 'ready' })
      // Open whichever doc we were on, or Scratch on first launch.
      const wanted = get().activeDocId
      if (wanted !== null && documents.some((d) => d.id === wanted)) {
        await get().openDocument(wanted)
      } else {
        const scratch = documents.find((d) => d.scratch) ?? documents[0]
        if (scratch) await get().openDocument(scratch.id)
      }
    } catch (err) {
      set({
        documentsStatus: 'error',
        documentsError: err instanceof Error ? err.message : String(err)
      })
    }
  },

  async openDocument(id) {
    try {
      const { document, current } = await api.documentGet(id)
      set({
        activeDocId: document.id,
        // Switching to a local document always exits read-only mode —
        // local docs are always editable.
        editorReadOnly: false,
        ...editorReplaceState({
          bbcode: current.bbcode,
          title: document.scratch ? 'Scratch.bbcode' : `${document.name}.bbcode`,
          inlines: current.inlines
        })
      })
    } catch (err) {
      set({
        documentsError: err instanceof Error ? err.message : String(err)
      })
    }
  },

  async createDocument(name) {
    const doc = await api.documentCreate(name)
    // Refresh the list so the new entry shows in the sidebar.
    await get().loadDocuments()
    await get().openDocument(doc.id)
    return doc
  },

  async duplicateActiveDocument(name) {
    const active = get().activeDocId
    if (active === null) return null
    const doc = await api.documentDuplicate(active, name)
    await get().loadDocuments()
    await get().openDocument(doc.id)
    return doc
  },

  async renameDocument(id, name) {
    await api.documentRename(id, name)
    await get().loadDocuments()
    if (get().activeDocId === id) {
      const doc = get().documents.find((d) => d.id === id)
      if (doc && !doc.scratch) set({ editorTitle: `${doc.name}.bbcode` })
    }
  },

  async deleteDocument(id) {
    await api.documentDelete(id)
    const wasActive = get().activeDocId === id
    await get().loadDocuments()
    if (wasActive) {
      const scratch = get().documents.find((d) => d.scratch)
      if (scratch) await get().openDocument(scratch.id)
    }
  },

  async saveActiveDocument() {
    const id = get().activeDocId
    if (id === null) return
    set({ saveStatus: 'saving', saveError: null })
    try {
      await api.revisionSave(id, get().editorContent, get().editorInlines)
      set({ saveStatus: 'saved', editorDirty: false, draftStatus: 'idle' })
      // Refresh list (updated_at + latest_revision_id) and any open
      // revision panel.
      await get().loadDocuments()
      const revs = get().revisionsByDoc[id]
      if (revs) await get().loadRevisions(id)
    } catch (err) {
      set({
        saveStatus: 'error',
        saveError: err instanceof Error ? err.message : String(err)
      })
    }
  },

  async saveActiveDraft() {
    const id = get().activeDocId
    if (id === null) return
    if (!get().editorDirty) return
    set({ draftStatus: 'saving' })
    try {
      await api.draftSave(id, get().editorContent, get().editorInlines)
      set({ draftStatus: 'saved' })
    } catch {
      // Drafts are crash-safety only — a single failed flush is
      // acceptable. Surface a quiet error state without blocking the
      // user.
      set({ draftStatus: 'error' })
    }
  },

  async loadRevisions(id) {
    set((s) => ({ revisionsStatus: { ...s.revisionsStatus, [id]: 'loading' } }))
    try {
      const { revisions } = await api.revisionsList(id)
      set((s) => ({
        revisionsByDoc: { ...s.revisionsByDoc, [id]: revisions },
        revisionsStatus: { ...s.revisionsStatus, [id]: 'ready' }
      }))
    } catch {
      set((s) => ({ revisionsStatus: { ...s.revisionsStatus, [id]: 'error' } }))
    }
  },

  async restoreRevision(revId) {
    const id = get().activeDocId
    if (id === null) return
    const rev = await api.revisionGet(id, revId)
    // "Restore" writes a NEW revision at HEAD with the old content —
    // history is never destroyed. The current pane mirrors what was
    // just saved.
    await api.revisionSave(id, rev.bbcode, rev.inlines)
    await get().openDocument(id)
    await get().loadRevisions(id)
    await get().loadDocuments()
  }
}))

function humanizeFetchError(err: unknown, name: string): string {
  const raw = err instanceof Error ? err.message : String(err)
  // 401 — JSON API path now requires sign-in. Surface a clear CTA.
  if (/HTTP 401/.test(raw)) {
    return 'Sign in to F-list to fetch profiles. Click the chip in the sidebar.'
  }
  // 404 from the sidecar — F-list said "no such character".
  if (/HTTP 404/.test(raw)) return `No character named "${name}" on F-list.`
  // Network reach failures: fetch throws "Failed to fetch" / "TypeError"
  // on the renderer side when the sidecar is down.
  if (/Failed to fetch|NetworkError|ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(raw)) {
    return "Can't reach the sidecar. Is it running on port 8765?"
  }
  if (/HTTP 5\d\d/.test(raw)) return 'F-list is having trouble right now. Try again in a moment.'
  if (/HTTP 4\d\d/.test(raw)) return `F-list refused that name (${raw.replace(/^HTTP \d+:\s*/, '')}).`
  return raw
}
