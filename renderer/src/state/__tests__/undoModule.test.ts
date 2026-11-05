// Undo is its own module (state/undo.ts), used by the Workbench slice:
// the slice records its commits, steps Undo and Redo and has trashed
// images put back only through that module's interface, never through
// the stacks or the Trash helpers behind it. What undo does is pinned by
// the store tests (undo, typing, undoTrash, commitPoint); this pins
// where it lives.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const STATE = join(__dirname, '..')

function importsOf(file: string): string[] {
  const source = readFileSync(join(STATE, file), 'utf-8')
  return [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1])
}

it('the Workbench slice reaches undo only through the undo module', () => {
  const imports = importsOf('slices/workbench.ts')

  expect(imports).toContain('../undo')
  expect(imports.filter((path) => /\/undo(Stack|Trash)$/.test(path))).toEqual([])
})
