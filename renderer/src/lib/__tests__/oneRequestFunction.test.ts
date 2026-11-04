// Every call the window makes to the sidecar goes through the request
// function in api.ts, so sign-in recovery and refusal codes apply to
// every route, the `/events` stream included. A `fetch` or an
// `EventSource` anywhere else in the window's code would skip them.
//
// The main process cannot use it: it runs in Node, not in the window,
// and cannot import api.ts. Its calls to the sidecar go through
// `sidecarFetch` (electron/sidecar.ts, which adds the launch secret),
// and the ones that read an answer type it from the schema
// (wireTypes.test.ts checks electron/renderLoop.ts). They are listed
// below with why, so a new one is a decision.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..', '..')

/** The main process's calls, by module, with what each is. */
const MAIN_PROCESS: Record<string, string> = {
  'electron/appPage.ts': "net.fetch of the app's own files, not the sidecar",
  'electron/main.ts':
    'the F-list image CDN, and the F-list sign-out at quit (DELETE /flist/session), which reads nothing back',
  'electron/renderLoop.ts': 'the render long-poll and its results; answers typed with Schema<...>',
  'electron/sidecar.ts':
    'sidecarFetch itself, the health probe while the sidecar starts, and /shutdown at quit'
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === '__tests__' || entry.name === 'test' ? [] : sources(path)
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** Every module under `dir` that matches `call`, with how often. */
function calls(dir: string, call: RegExp): string[] {
  return sources(join(ROOT, dir)).flatMap((path) => {
    const count = readFileSync(path, 'utf-8').match(call)?.length ?? 0
    return count ? [`${relative(ROOT, path).split(sep).join('/')}: ${count}`] : []
  })
}

it('calls fetch in one place: the request function', () => {
  expect(calls('renderer/src', /\bfetch\(/g)).toEqual(['renderer/src/lib/api.ts: 1'])
})

it('opens no event stream of its own', () => {
  expect(calls('renderer/src', /\bEventSource\b/g)).toEqual([])
})

it('calls the sidecar from the main process only where listed', () => {
  const modules = calls('electron', /\b(fetch|sidecarFetch)\(/g).map((line) => line.split(':')[0])
  expect(modules).toEqual(Object.keys(MAIN_PROCESS).sort())
})
