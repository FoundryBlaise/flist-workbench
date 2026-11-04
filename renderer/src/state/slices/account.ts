// The Account slice: the F-list session, sign-in and sign-out, saved credentials and auto-login, the roster and the account sweep.
// Empty until #122 moves that state and its actions here out of
// state.ts; the store already spreads it, so filling it in touches
// neither state.ts's composition nor its State type.

import type { SliceCreator } from './slice'

export type AccountSlice = Record<never, never>

export const createAccountSlice: SliceCreator<AccountSlice> = () => ({})
