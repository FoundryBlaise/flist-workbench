// The Workbench slice: the payload per character, opening a character, the save pipeline with its etag, external changes and the merge, reset to Live, Restore, and the edit actions of every tab.
// Empty until #124 moves that state and its actions here out of
// state.ts; the store already spreads it, so filling it in touches
// neither state.ts's composition nor its State type.

import type { SliceCreator } from './slice'

export type WorkbenchSlice = Record<never, never>

export const createWorkbenchSlice: SliceCreator<WorkbenchSlice> = () => ({})
