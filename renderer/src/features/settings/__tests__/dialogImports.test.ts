// The Settings dialog asks the sidecar nothing itself: every pane
// dispatches Settings slice actions and shows what the slice holds, so
// a change a model makes reaches an open dialog through the store. A
// value import from lib/api in the dialog, or in a view it renders,
// would be a call around the slice.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const SRC = join(__dirname, '..', '..', '..')

/** The dialog and the views it renders that read the sidecar. */
const DIALOG = ['features/settings/SettingsModal.tsx', 'features/rag/IndexStatus.tsx']

it('the Settings dialog imports only types from the api', () => {
  const valueImports = DIALOG.filter((module) =>
    /^import (?!type )(\w+|\{[^}]*\}) from '[./]*lib\/api'/m.test(
      readFileSync(join(SRC, module), 'utf-8')
    )
  )
  expect(valueImports).toEqual([])
})
