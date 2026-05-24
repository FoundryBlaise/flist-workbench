import { create } from 'zustand'
import {
  api,
  type CharacterEntry,
  type Document,
  type InlineImage,
  type LogMessage,
  type RevisionSummary
} from './lib/api'

export type Mode = 'editor' | 'logs'

const LAST_SEEN_KEY = 'flist-workbench:char-last-seen'

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

  partners: Record<string, { name: string; bytes: number }[]>
  partnersStatus: Record<string, 'loading' | 'ready' | 'error'>

  activePartner: string | null

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

  loadCharacters: () => Promise<void>
  selectCharacter: (name: string | null) => void
  markCharacterSeen: (name: string) => void
  setMode: (mode: Mode) => void
  setCrossSearchOpen: (open: boolean) => void
  loadPartners: (char: string) => Promise<void>
  selectPartner: (name: string | null) => void
  loadMessages: (char: string, partner: string) => Promise<void>
  setEditorContent: (value: string) => void
  fetchProfile: (name: string) => Promise<void>
  resetEditorDirty: () => void

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
[indent]Inline character icons: [icon]Azure Viper[/icon] [icon]Auldren Nadir[/icon][/indent]
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

  async loadMessages(char, partner) {
    const key = partnerKey(char, partner)
    if (get().messagesStatus[key] === 'ready') return
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

  setEditorContent(value) {
    set((s) => ({
      editorContent: value,
      editorDirty: s.editorDirty || value !== s.editorContent,
      // Mark draft stale as soon as the user types — the autosave
      // effect will pick this up and flush after the idle window.
      draftStatus: 'idle'
    }))
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
