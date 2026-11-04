// The Settings slice: the settings the sidecar keeps, and everything
// else the Settings dialog asks of the sidecar (MCP access, extension
// pairing, the cleared Labels in the Trash, the Index, the Foreign
// profile cache). The dialog's panes dispatch these actions and never
// call the api themselves; what they show of the sidecar's answers
// lives here, so a change a model makes (the `settings-changed` event)
// reaches an open dialog through the store.
//
// Reads keep their answer, or why there is none, in the slice. Actions
// a person starts from the dialog resolve to an `ActionResult`: what
// they answered, or why they did not work (the words to show and the
// sidecar's refusal code). The dialog keeps its own busy and message
// state.

import {
  api,
  errorDetail,
  type FlistTrashedLabels,
  type ForeignCacheUsage,
  type McpInfo
} from '../../lib/api'
import { attempt, attemptDone, type ActionResult } from '../actionResult'
import type { SliceCreator } from './slice'

/** The settings as the sidecar answers them. */
export type Settings = Awaited<ReturnType<typeof api.settingsGet>>
/** What a save may change; fields left out stay as they are. */
export type SettingsPatch = Parameters<typeof api.settingsUpdate>[0]
/** Label coverage across every character. */
export type LabelsRollup = Awaited<ReturnType<typeof api.labelsRollup>>
export type EmbeddingTestResult = Awaited<ReturnType<typeof api.ragTestEmbedding>>
/** Cleared Labels put back from the Trash. */
export type LabelsPutBack = Awaited<ReturnType<typeof api.labelsTrashPutBack>>
/** What the Index holds; while a job (an ingest, a wipe) holds it,
 *  `busy` and that `job`, and `chunk_count` is null because the Index
 *  can't be counted. */
export type IndexStatus = Awaited<ReturnType<typeof api.ragStatus>>
/** Whether the sidecar holds an accepted pairing token. Only the
 *  extension has the token; the sidecar tells the window whether one is
 *  stored, never the token itself (ADR 0002). 'unavailable': the
 *  sidecar could not be asked. */
export type ExtensionPairing = 'checking' | 'paired' | 'unpaired' | 'unavailable'

export type SettingsState = {
  /** Counts settings changes made outside this window. */
  settingsRevision: number
  /** The settings as last read or saved; null until first read. */
  settings: Settings | null
  settingsStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** Why the settings could not be read. */
  settingsError: string | null
  /** The MCP endpoints, their tool counts and the optional token. */
  mcpInfo: McpInfo | null
  /** Why the MCP endpoints could not be read. */
  mcpError: string | null
  extensionPairing: ExtensionPairing
  /** The extension version the browser runs, as of its last paired
   *  call; null when unknown. */
  extensionRunningVersion: string | null
  labelsRollup: LabelsRollup | null
  labelsRollupStatus: 'idle' | 'loading' | 'error'
  /** Every cleared-Labels entry in the Trash, whichever character it
   *  was cleared for. */
  labelsTrash: FlistTrashedLabels[]
  /** Why the Trash's cleared Labels could not be read. */
  labelsTrashError: string | null
  /** How much disk the Foreign profile cache takes, and its cap. */
  foreignCacheUsage: ForeignCacheUsage | null
  /** Why the Foreign profile cache could not be read. */
  foreignCacheError: string | null
  /** What the Index holds; null until read. */
  indexStatus: IndexStatus | null
  /** Why the Index status could not be read. */
  indexStatusError: string | null
}

export type SettingsSlice = SettingsState & {
  /** Read the settings from the sidecar. */
  settingsLoad: () => Promise<void>
  /** Save `patch`; the settings become what the sidecar answers. A new
   *  F-Chat data directory reads the Log characters again. */
  settingsSave: (patch: SettingsPatch) => Promise<ActionResult<Settings>>
  /** Something outside this window changed settings (the
   *  `settings-changed` event); `fields` names them, as the sidecar's
   *  settings service does (`labels.threshold_chars`, `rag.top_k`).
   *  Settings already read are read again. */
  noteSettingsChanged: (fields: string[]) => void

  mcpLoadInfo: () => Promise<void>
  /** Require a token for MCP clients: issue one, replacing any. */
  mcpCreateToken: () => Promise<ActionResult>
  /** Turn the token requirement back off. */
  mcpRevokeToken: () => Promise<ActionResult>
  /** Let MCP clients read Log text, or not. Saved at once; the
   *  endpoints' tool counts change with it, so they are read again. */
  mcpSetLogText: (on: boolean) => Promise<ActionResult>

  extensionLoadPairing: () => Promise<void>
  /** Revoke the pairing token; the extension has to pair again. */
  extensionRevokePairing: () => Promise<ActionResult>
  extensionLoadRunningVersion: () => Promise<void>

  labelsLoadRollup: () => Promise<void>
  labelsLoadTrash: () => Promise<void>
  /** Reset every Label of every character. A copy of each character's
   *  Labels goes to the Trash. */
  labelsClearAll: () => Promise<ActionResult>
  /** Put cleared Labels back from the Trash. */
  labelsTrashPutBack: (ids: string[]) => Promise<ActionResult<LabelsPutBack>>
  /** Delete cleared Labels in the Trash for good. */
  labelsTrashPurge: (ids: string[]) => Promise<ActionResult>

  /** Read what the Index holds. Read again when the Index changes
   *  (`indexRevision`), whoever changed it. */
  indexLoadStatus: () => Promise<void>
  /** Embed a test sentence with `model`. A model that could not embed
   *  is the sidecar's answer too (`ok: false` in the value). */
  indexTestEmbedding: (model: string) => Promise<ActionResult<EmbeddingTestResult>>
  /** Delete every embedded chunk of the Index. Labels and Logs stay. */
  indexWipe: () => Promise<ActionResult>
  /** Rebuild the Index's keyword search from the chunks it holds;
   *  answers how many chunks it indexed. */
  indexRebuildLexical: () => Promise<ActionResult<number>>

  foreignCacheLoad: () => Promise<void>
  /** Save the cache's cap; a lower one evicts at once, so the cache is
   *  read again. */
  foreignCacheSetCap: (megabytes: number) => Promise<ActionResult>
  /** Delete every cached Foreign profile, images included. */
  foreignCacheClear: () => Promise<ActionResult>
}

/** The Settings state as the window starts. Tests reset the slice with
 *  `useStore.setState(settingsInitialState())`. */
export function settingsInitialState(): SettingsState {
  return {
    settingsRevision: 0,
    settings: null,
    settingsStatus: 'idle',
    settingsError: null,
    mcpInfo: null,
    mcpError: null,
    extensionPairing: 'checking',
    extensionRunningVersion: null,
    labelsRollup: null,
    labelsRollupStatus: 'idle',
    labelsTrash: [],
    labelsTrashError: null,
    foreignCacheUsage: null,
    foreignCacheError: null,
    indexStatus: null,
    indexStatusError: null
  }
}

// Bumped by every read and save of the settings: a read answered after
// a newer read or save started would put older settings back.
let settingsGeneration = 0

export const createSettingsSlice: SliceCreator<SettingsSlice> = (set, get) => ({
  ...settingsInitialState(),

  async settingsLoad() {
    const generation = ++settingsGeneration
    set({ settingsStatus: 'loading', settingsError: null })
    try {
      const settings = await api.settingsGet()
      if (generation !== settingsGeneration) return
      set({ settings, settingsStatus: 'ready' })
    } catch (err) {
      if (generation !== settingsGeneration) return
      set({ settingsStatus: 'error', settingsError: errorDetail(err) })
    }
  },

  async settingsSave(patch) {
    ++settingsGeneration
    const saved = await attempt(() => api.settingsUpdate(patch))
    if (!saved.ok) return saved
    set({ settings: saved.value, settingsStatus: 'ready', settingsError: null })
    // Refresh the sidebar so the new directory's characters appear.
    if ('fchat_data_dir' in patch) await get().loadCharacters()
    return saved
  },

  noteSettingsChanged(fields) {
    set((s) => ({ settingsRevision: s.settingsRevision + 1 }))
    if (get().settings) void get().settingsLoad()
    // The OOC threshold is applied when a Log is read, so the open
    // Log's Labels are only current after a re-read.
    const { activeCharacter: char, activePartner: partner } = get()
    if (fields.includes('labels.threshold_chars') && char && partner) {
      get().invalidateMessages(char, partner)
      void get().loadMessages(char, partner, { force: true })
    }
  },

  async mcpLoadInfo() {
    try {
      set({ mcpInfo: await api.mcpInfo(), mcpError: null })
    } catch (err) {
      set({ mcpError: errorDetail(err) })
    }
  },

  async mcpCreateToken() {
    const result = await attemptDone(() => api.mcpCreateToken())
    if (result.ok) await get().mcpLoadInfo()
    return result
  },

  async mcpRevokeToken() {
    const result = await attemptDone(() => api.mcpRevokeToken())
    if (result.ok) await get().mcpLoadInfo()
    return result
  },

  async mcpSetLogText(on) {
    const saved = await get().settingsSave({ mcp: { log_text: on } })
    if (!saved.ok) return saved
    await get().mcpLoadInfo()
    return { ok: true, value: null }
  },

  async extensionLoadPairing() {
    set({ extensionPairing: 'checking' })
    try {
      const { paired } = await api.pairingStatus()
      set({ extensionPairing: paired ? 'paired' : 'unpaired' })
    } catch {
      set({ extensionPairing: 'unavailable' })
    }
  },

  async extensionRevokePairing() {
    const result = await attemptDone(() => api.restoreRevokeToken())
    if (result.ok) await get().extensionLoadPairing()
    return result
  },

  async extensionLoadRunningVersion() {
    try {
      set({ extensionRunningVersion: (await api.restoreExtensionSeen()).version })
    } catch {
      set({ extensionRunningVersion: null })
    }
  },

  async labelsLoadRollup() {
    set({ labelsRollupStatus: 'loading' })
    try {
      set({ labelsRollup: await api.labelsRollup(), labelsRollupStatus: 'idle' })
    } catch {
      set({ labelsRollupStatus: 'error' })
    }
  },

  async labelsLoadTrash() {
    try {
      set({ labelsTrash: (await api.labelsTrashList()).labels, labelsTrashError: null })
    } catch (err) {
      set({ labelsTrashError: errorDetail(err) })
    }
  },

  async labelsClearAll() {
    const result = await attemptDone(() => api.labelsClearAll())
    if (result.ok) {
      void get().labelsLoadRollup()
      void get().labelsLoadTrash()
    }
    return result
  },

  labelsTrashPutBack(ids) {
    return attempt(() => api.labelsTrashPutBack(ids))
  },

  labelsTrashPurge(ids) {
    return attemptDone(() => api.labelsTrashPurge(ids))
  },

  async indexLoadStatus() {
    try {
      set({ indexStatus: await api.ragStatus(), indexStatusError: null })
    } catch (err) {
      set({ indexStatusError: errorDetail(err) })
    }
  },

  indexTestEmbedding(model) {
    return attempt(() => api.ragTestEmbedding({ embed_model: model }))
  },

  indexWipe() {
    return attemptDone(() => api.ragWipe())
  },

  indexRebuildLexical() {
    return attempt(async () => (await api.ragLexicalRebuild()).indexed)
  },

  async foreignCacheLoad() {
    try {
      set({ foreignCacheUsage: await api.foreignCacheUsage(), foreignCacheError: null })
    } catch (err) {
      set({ foreignCacheError: errorDetail(err) })
    }
  },

  async foreignCacheSetCap(megabytes) {
    const saved = await get().settingsSave({ foreign: { cache_cap_mb: megabytes } })
    if (!saved.ok) return saved
    // A lower cap has evicted profiles already: read what is left.
    await get().foreignCacheLoad()
    return { ok: true, value: null }
  },

  async foreignCacheClear() {
    const cleared = await attempt(() => api.foreignCacheClear())
    if (!cleared.ok) return cleared
    const { bytes, profiles, cap_bytes } = cleared.value
    set({ foreignCacheUsage: { bytes, profiles, cap_bytes }, foreignCacheError: null })
    return { ok: true, value: null }
  }
})
