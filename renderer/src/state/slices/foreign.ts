// The Foreign slice: opening, refreshing and leaving a Foreign profile, with its cache status.
// Empty until #122 moves that state and its actions here out of
// state.ts; the store already spreads it, so filling it in touches
// neither state.ts's composition nor its State type.

import type { SliceCreator } from './slice'

export type ForeignSlice = Record<never, never>

export const createForeignSlice: SliceCreator<ForeignSlice> = () => ({})
