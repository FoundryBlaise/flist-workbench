import { create } from 'zustand'

export type {
  FlistSaveStatus,
  FlistWorkingSlot,
  WorkingPayload
} from './state/flist'

export { selectWorkingSlot } from './state/flist'
export { selectDiffSources, type DiffSource } from './state/diffSources'
export {
  selectEditorDescription,
  selectEditorDirty,
  selectEditorInlines,
  selectEditorTitle
} from './state/editorView'

// The store's slices, one file each; state/slices/slice.ts says what one is.
import { createUiSlice, type UiSlice } from './state/slices/ui'
import { createSettingsSlice, type SettingsSlice } from './state/slices/settings'
import { createLogsSlice, type LogsSlice } from './state/slices/logs'
import { createAccountSlice, type AccountSlice } from './state/slices/account'
import { createForeignSlice, type ForeignSlice } from './state/slices/foreign'
import { createArchiveSlice, type ArchiveSlice } from './state/slices/archive'
import { createWorkbenchSlice, type WorkbenchSlice } from './state/slices/workbench'

export type { Mode } from './state/slices/ui'

/** The one store's state: every slice together. */
export type State = UiSlice &
  SettingsSlice &
  LogsSlice &
  AccountSlice &
  ForeignSlice &
  ArchiveSlice &
  WorkbenchSlice

/** The one store: every slice spread into it. Components and tests
 *  read and drive it, never a slice on its own. */
export const useStore = create<State>((set, get, store) => ({
  ...createUiSlice(set, get, store),
  ...createSettingsSlice(set, get, store),
  ...createLogsSlice(set, get, store),
  ...createAccountSlice(set, get, store),
  ...createForeignSlice(set, get, store),
  ...createArchiveSlice(set, get, store),
  ...createWorkbenchSlice(set, get, store),
}))
