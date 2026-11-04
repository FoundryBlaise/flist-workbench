// The Settings slice: the settings the sidecar keeps and what the Settings dialog asks of the sidecar (MCP tokens, extension pairing, the Labels Trash, the Index, the Foreign profile cache).
// Empty until #120 moves that state and its actions here out of
// state.ts; the store already spreads it, so filling it in touches
// neither state.ts's composition nor its State type.

import type { SliceCreator } from './slice'

export type SettingsSlice = Record<never, never>

export const createSettingsSlice: SliceCreator<SettingsSlice> = () => ({})
