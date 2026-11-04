// The Settings slice: the settings the sidecar keeps, and everything
// else the Settings dialog asks of the sidecar (MCP access, extension
// pairing, the cleared Labels in the Trash, the Index, the Foreign
// profile cache). The dialog's panes dispatch these actions and never
// call the api themselves; what they show of the sidecar's answers
// lives here, so a change a model makes (the `settings-changed` event)
// reaches an open dialog through the store.
//
// Reads keep their answer, or why there is none, in the slice. Actions
// a person starts from the dialog resolve to the error to show, null
// when they worked; the dialog keeps its own busy and message state.

import {
  api,
  errorDetail,
  type FlistTrashedLabels,
  type ForeignCacheUsage,
  type McpInfo
} from '../../lib/api'
import type { SliceCreator } from './slice'

/** The settings as the sidecar answers them. */
export type Settings = Awaited<ReturnType<typeof api.settingsGet>>
/** What a save may change; fields left out stay as they are. */
export type SettingsPatch = Parameters<typeof api.settingsUpdate>[0]
/** Label coverage across every character. */
export type LabelsRollup = Awaited<ReturnType<typeof api.labelsRollup>>
export type EmbeddingTestResult = Awaited<ReturnType<typeof api.ragTestEmbedding>>
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
  settingsSave: (patch: SettingsPatch) => Promise<string | null>
  /** Something outside this window changed settings (the
   *  `settings-changed` event); `fields` names them, as the sidecar's
   *  settings service does (`labels.threshold_chars`, `rag.top_k`).
   *  Settings already read are read again. */
  noteSettingsChanged: (fields: string[]) => void

  mcpLoadInfo: () => Promise<void>
  /** Require a token for MCP clients: issue one, replacing any. */
  mcpCreateToken: () => Promise<string | null>
  /** Turn the token requirement back off. */
  mcpRevokeToken: () => Promise<string | null>
  /** Let MCP clients read Log text, or not. Saved at once; the
   *  endpoints' tool counts change with it, so they are read again. */
  mcpSetLogText: (on: boolean) => Promise<string | null>

  extensionLoadPairing: () => Promise<void>
  /** Revoke the pairing token; the extension has to pair again. */
  extensionRevokePairing: () => Promise<string | null>
  extensionLoadRunningVersion: () => Promise<void>

  labelsLoadRollup: () => Promise<void>
  labelsLoadTrash: () => Promise<void>
  /** Reset every Label of every character. A copy of each character's
   *  Labels goes to the Trash. */
  labelsClearAll: () => Promise<string | null>
  /** Put cleared Labels back from the Trash. */
  labelsTrashPutBack: (ids: string[]) => ReturnType<typeof api.labelsTrashPutBack>
  /** Delete cleared Labels in the Trash for good. */
  labelsTrashPurge: (ids: string[]) => ReturnType<typeof api.labelsTrashPurge>

  /** Read what the Index holds. Read again when the Index changes
   *  (`indexRevision`), whoever changed it. */
  indexLoadStatus: () => Promise<void>
  /** Embed a test sentence with `model`; a failure is a result too. */
  indexTestEmbedding: (model: string) => Promise<EmbeddingTestResult>
  /** Delete every embedded chunk of the Index. Labels and Logs stay. */
  indexWipe: () => Promise<string | null>
  /** Rebuild the Index's keyword search from the chunks it holds. */
  indexRebuildLexical: () => Promise<{ indexed: number } | { error: string }>

  foreignCacheLoad: () => Promise<void>
  /** Save the cache's cap; a lower one evicts at once, so the cache is
   *  read again. */
  foreignCacheSetCap: (megabytes: number) => Promise<string | null>
  /** Delete every cached Foreign profile, images included. */
  foreignCacheClear: () => Promise<string | null>
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

// Run a sidecar call a person started; resolve to the error to show.
async function attempt(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call()
    return null
  } catch (err) {
    return errorDetail(err)
  }
}

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
    try {
      const settings = await api.settingsUpdate(patch)
      set({ settings, settingsStatus: 'ready', settingsError: null })
    } catch (err) {
      return errorDetail(err)
    }
    // Refresh the sidebar so the new directory's characters appear.
    if ('fchat_data_dir' in patch) await get().loadCharacters()
    return null
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
    const error = await attempt(() => api.mcpCreateToken())
    if (!error) await get().mcpLoadInfo()
    return error
  },

  async mcpRevokeToken() {
    const error = await attempt(() => api.mcpRevokeToken())
    if (!error) await get().mcpLoadInfo()
    return error
  },

  async mcpSetLogText(on) {
    const error = await get().settingsSave({ mcp: { log_text: on } })
    if (!error) await get().mcpLoadInfo()
    return error
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
    const error = await attempt(() => api.restoreRevokeToken())
    if (!error) await get().extensionLoadPairing()
    return error
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
    const error = await attempt(() => api.labelsClearAll())
    if (!error) {
      void get().labelsLoadRollup()
      void get().labelsLoadTrash()
    }
    return error
  },

  labelsTrashPutBack(ids) {
    return api.labelsTrashPutBack(ids)
  },

  labelsTrashPurge(ids) {
    return api.labelsTrashPurge(ids)
  },

  async indexLoadStatus() {
    try {
      set({ indexStatus: await api.ragStatus(), indexStatusError: null })
    } catch (err) {
      set({ indexStatusError: errorDetail(err) })
    }
  },

  async indexTestEmbedding(model) {
    try {
      return await api.ragTestEmbedding({ embed_model: model })
    } catch (err) {
      return { ok: false, elapsed_ms: 0, dimension: null, model, error: errorDetail(err) }
    }
  },

  indexWipe() {
    return attempt(() => api.ragWipe())
  },

  async indexRebuildLexical() {
    try {
      const { indexed } = await api.ragLexicalRebuild()
      return { indexed }
    } catch (err) {
      return { error: errorDetail(err) }
    }
  },

  async foreignCacheLoad() {
    try {
      set({ foreignCacheUsage: await api.foreignCacheUsage(), foreignCacheError: null })
    } catch (err) {
      set({ foreignCacheError: errorDetail(err) })
    }
  },

  async foreignCacheSetCap(megabytes) {
    const error = await get().settingsSave({ foreign: { cache_cap_mb: megabytes } })
    // A lower cap has evicted profiles already: read what is left.
    if (!error) await get().foreignCacheLoad()
    return error
  },

  async foreignCacheClear() {
    try {
      const { bytes, profiles, cap_bytes } = await api.foreignCacheClear()
      set({ foreignCacheUsage: { bytes, profiles, cap_bytes }, foreignCacheError: null })
      return null
    } catch (err) {
      return errorDetail(err)
    }
  }
})
