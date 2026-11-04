// The Archive slice: Live per character, Pulls and their jobs, the Backup list and browsing, renaming, deleting and downloading a Backup, Back up all, the Pool and the Trash.
// Empty until #123 moves that state and its actions here out of
// state.ts; the store already spreads it, so filling it in touches
// neither state.ts's composition nor its State type.

import type { SliceCreator } from './slice'

export type ArchiveSlice = Record<never, never>

export const createArchiveSlice: SliceCreator<ArchiveSlice> = () => ({})
