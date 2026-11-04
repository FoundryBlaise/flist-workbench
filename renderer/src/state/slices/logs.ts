// The Logs slice: conversations and partners, messages, Labels and Label overrides, the Index and the ingest dialog, and cross search.
// Empty until #121 moves that state and its actions here out of
// state.ts; the store already spreads it, so filling it in touches
// neither state.ts's composition nor its State type.

import type { SliceCreator } from './slice'

export type LogsSlice = Record<never, never>

export const createLogsSlice: SliceCreator<LogsSlice> = () => ({})
