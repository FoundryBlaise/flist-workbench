// The Logs slice: the characters that have Logs and their conversation
// partners, the messages of each conversation read so far and the
// Labels on them, the ingest dialog, the Index and Labels revisions
// other views re-read on, and cross search. It reads Logs through the
// sidecar and never reaches the Workbench: picking a character for both
// the Logs and the profile editor is the Workbench's selectCharacter.

import { api, type CharacterEntry, type LogMessage, type PartnerEntry } from '../../lib/api'
import type { SliceCreator } from './slice'

/** One conversation's key in the per-conversation maps. */
function partnerKey(char: string, partner: string): string {
  return `${char}::${partner}`
}

export type LogsState = {
  characters: CharacterEntry[]
  charactersStatus: 'idle' | 'loading' | 'ready' | 'error'
  charactersError: string | null

  activeCharacter: string | null
  /** When true, the logs main pane shows the cross-conversation search view. */
  crossSearchOpen: boolean

  partners: Record<string, PartnerEntry[]>
  partnersStatus: Record<string, 'loading' | 'ready' | 'error'>

  activePartner: string | null

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
  /** Bumped whenever the sidecar says the Index changed (an ingest
   *  started or ended, a wipe). Views that show the Index status
   *  re-read it when this moves. */
  indexRevision: number
  /** Bumped whenever another writer changed Labels (a model labelled
   *  or cleared them). Views listing cleared Labels re-read it. */
  labelsRevision: number

  messagesByPartner: Record<string, LogMessage[]>
  messagesStatus: Record<string, 'loading' | 'ready' | 'error'>
  messagesError: Record<string, string | null>
}

export type LogsSlice = LogsState & {
  loadCharacters: () => Promise<void>
  setCrossSearchOpen: (open: boolean) => void
  loadPartners: (char: string) => Promise<void>
  selectPartner: (name: string | null) => void
  loadMessages: (char: string, partner: string, opts?: { force?: boolean }) => Promise<void>
  invalidateMessages: (char: string, partner: string) => void
  openIngest: (
    scope: { character?: string | null; partner?: string | null },
    label: string,
    opts?: { forceRewipe?: boolean }
  ) => void
  closeIngest: () => void
  /** The Index changed elsewhere: views showing its status re-read. */
  noteIndexChanged: () => void
  /** Labels changed elsewhere: views listing cleared Labels re-read. */
  noteLabelsChanged: () => void
  /** One message by hash, or every message in a set of hashes. */
  applyLabelOverride: (
    char: string,
    partner: string,
    hash: string | ReadonlySet<string>,
    patch: {
      label?: 'IC' | 'OOC'
      label_source?: 'llm' | 'manual'
    } | null
  ) => void
}

/** The Logs state as the window starts: nothing read yet, nothing
 *  open. Tests reset the slice with `useStore.setState(logsInitialState())`. */
export function logsInitialState(): LogsState {
  return {
    characters: [],
    charactersStatus: 'idle',
    charactersError: null,

    activeCharacter: null,
    crossSearchOpen: false,

    partners: {},
    partnersStatus: {},
    activePartner: null,

    ingestTarget: null,
    indexRevision: 0,
    labelsRevision: 0,

    messagesByPartner: {},
    messagesStatus: {},
    messagesError: {}
  }
}

export const createLogsSlice: SliceCreator<LogsSlice> = (set, get) => ({
  ...logsInitialState(),

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

  openIngest(scope, label, opts) {
    set({
      ingestTarget: { scope, label, forceRewipe: opts?.forceRewipe ?? false }
    })
  },

  closeIngest() {
    set({ ingestTarget: null })
  },

  noteIndexChanged() {
    set((s) => ({ indexRevision: s.indexRevision + 1 }))
  },

  noteLabelsChanged() {
    set((s) => ({ labelsRevision: s.labelsRevision + 1 }))
  },

  // Patches one message's label fields in place, or those of every
  // message in a set of hashes (the log view's multi-select) in the same
  // single pass over the conversation. `patch === null`
  // clears label fields back to rule/Unlabeled resolution — but since
  // the resolver runs server-side, we approximate locally by removing
  // label_source and falling back to the rule the renderer can compute
  // (or 'Unlabeled' if unknown). The next loadMessages refresh
  // re-resolves from the sidecar authoritatively.
  applyLabelOverride(char, partner, hash, patch) {
    const key = partnerKey(char, partner)
    const hit =
      typeof hash === 'string' ? (h: string) => h === hash : (h: string) => hash.has(h)
    set((s) => {
      const list = s.messagesByPartner[key]
      if (!list) return s
      const next = list.map((m) => {
        if (!hit(m.hash)) return m
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
  }
})
