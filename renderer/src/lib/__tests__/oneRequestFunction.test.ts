// Every call the window makes to the sidecar goes through the request
// function in api.ts, so sign-in recovery and refusal codes apply to
// every route. A `fetch` anywhere else in the window's code would skip
// them.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { expect, it } from 'vitest'

const SRC = join(__dirname, '..', '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === '__tests__' || entry.name === 'test' ? [] : sources(path)
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

it('calls fetch in one place: the request function', () => {
  const calls = sources(SRC).flatMap((path) => {
    const count = readFileSync(path, 'utf-8').match(/\bfetch\(/g)?.length ?? 0
    return count ? [`${relative(SRC, path).split(sep).join('/')}: ${count}`] : []
  })

  expect(calls).toEqual(['lib/api.ts: 1'])
})
