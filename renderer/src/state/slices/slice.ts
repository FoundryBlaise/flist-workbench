// What a slice of the one store is. Each slice file declares its state
// and actions as one type and exports a creator for them; state.ts
// spreads every creator into `useStore`, whose state is all of them
// together (`State`). Components and tests only ever see `useStore`.
//
// - A creator gets the store's own `set` and `get`, so `get()` reaches
//   every other slice's state and actions.
// - A slice's `set` writes its own fields. It changes another slice's
//   state by calling that slice's action through `get()`.
// - Timers, tokens and single-flight maps a slice needs are module-level
//   constants in its own file, next to the actions that use them.
// - A slice imports only types from state.ts, never values: state.ts
//   imports every slice, and a value import back would be a cycle.
// - A slice exports `<name>InitialState()`, its state as the window
//   starts (no actions), which its creator spreads; tests reset the slice
//   with `useStore.setState(<name>InitialState())`.

import type { StateCreator } from 'zustand'
import type { State } from '../../state'

export type SliceCreator<Slice> = StateCreator<State, [], [], Slice>
