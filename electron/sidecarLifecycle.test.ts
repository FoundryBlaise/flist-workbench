// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  RestartBackoff,
  classifyPortHolder,
  compareVersions,
  stopGracefully,
  type ProcessInfo
} from './sidecarLifecycle'

describe('compareVersions', () => {
  it.each([
    ['0.2.16', '0.2.16', 0],
    ['0.2.9', '0.2.16', -1],
    ['0.3.0', '0.2.16', 1],
    ['1.0.0', '0.99.99', 1],
    ['0.0.0-dev', '0.2.16', -1],
    ['0.3.0-beta.1', '0.3.0', -1],
    ['v0.2.16', '0.2.16', 0]
  ])('%s against %s is %d', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected)
  })

  it('cannot order what is not a version', () => {
    expect(compareVersions('banana', '0.2.16')).toBeNull()
    expect(compareVersions('0.2', '0.2.16')).toBeNull()
  })
})

const OWN = '0.2.16'
const HEALTH_OLD = { status: 'ok', version: '0.2.9' }
const HEALTH_SAME = { status: 'ok', version: OWN }

let nextPid = 1000
function proc(name: string, path: string | null, commandLine: string | null, created: string): ProcessInfo {
  nextPid += 1
  return { pid: nextPid, parentPid: 0, name, path, commandLine, created }
}

const INSTALLED = 'C:\\Users\\u\\AppData\\Local\\Programs\\F-list Workbench'
const onedirSidecar = (created = '2026-11-01T10:00:01Z'): ProcessInfo =>
  proc('sidecar.exe', `${INSTALLED}\\resources\\sidecar\\sidecar.exe`, `"${INSTALLED}\\resources\\sidecar\\sidecar.exe"`, created)
const onefileSidecar = (created = '2026-11-01T10:00:01Z'): ProcessInfo =>
  proc('sidecar.exe', `${INSTALLED}\\resources\\sidecar.exe`, `"${INSTALLED}\\resources\\sidecar.exe"`, created)
const devSidecar = (args: string, created = '2026-11-01T10:00:01Z'): ProcessInfo =>
  proc('python.exe', 'C:\\Users\\u\\uv\\python\\cpython-3.12\\python.exe', `"C:\\repo\\sidecar\\.venv\\Scripts\\python.exe" ${args}`, created)
const appProcess = (created = '2026-11-01T10:00:00Z'): ProcessInfo =>
  proc('F-list Workbench.exe', `${INSTALLED}\\F-list Workbench.exe`, `"${INSTALLED}\\F-list Workbench.exe"`, created)

describe('classifyPortHolder', () => {
  it('replaces an older sidecar whose app is gone', () => {
    const listener = onedirSidecar()
    expect(classifyPortHolder(HEALTH_OLD, [listener], OWN)).toEqual({
      kind: 'stale',
      pid: listener.pid,
      version: '0.2.9'
    })
  })

  it('replaces a same-version sidecar whose app is gone: it does not know this launch secret', () => {
    const listener = onedirSidecar()
    expect(classifyPortHolder(HEALTH_SAME, [listener], OWN)).toMatchObject({ kind: 'stale', pid: listener.pid })
  })

  it('recognises the one-file build, its bootloader parent and a dev sidecar', () => {
    const child = onefileSidecar('2026-11-01T10:00:02Z')
    const bootloader = onefileSidecar('2026-11-01T10:00:01Z')
    expect(classifyPortHolder(HEALTH_OLD, [child, bootloader], OWN)).toMatchObject({ kind: 'stale', pid: child.pid })
    for (const args of ['-m uvicorn server:app --port 27385', 'server.py']) {
      const dev = devSidecar(args)
      expect(classifyPortHolder(HEALTH_OLD, [dev], OWN)).toMatchObject({ kind: 'stale', pid: dev.pid })
    }
  })

  it('leaves alone the sidecar of another copy of the app that is still running and not older', () => {
    for (const health of [HEALTH_SAME, { status: 'ok', version: '0.3.0' }]) {
      expect(classifyPortHolder(health, [onedirSidecar(), appProcess()], OWN)).toEqual({
        kind: 'app-running',
        version: health.version
      })
    }
    const dev = devSidecar('server.py')
    const launcher = proc('python.exe', 'C:\\repo\\sidecar\\.venv\\Scripts\\python.exe', 'python.exe server.py', '2026-11-01T10:00:00.5Z')
    const electron = proc('electron.exe', 'C:\\repo\\node_modules\\electron\\dist\\electron.exe', 'electron.exe .', '2026-11-01T10:00:00Z')
    expect(classifyPortHolder(HEALTH_SAME, [dev, launcher, electron], OWN)).toMatchObject({ kind: 'app-running' })
  })

  it('replaces an older sidecar even while its app still runs', () => {
    const listener = onedirSidecar()
    expect(classifyPortHolder(HEALTH_OLD, [listener, appProcess()], OWN)).toMatchObject({
      kind: 'stale',
      pid: listener.pid
    })
  })

  it('does not take a later process that reused the parent pid for the running app', () => {
    const listener = onedirSidecar('2026-11-01T10:00:01Z')
    const reused = appProcess('2026-11-02T09:00:00Z')
    expect(classifyPortHolder(HEALTH_SAME, [listener, reused], OWN)).toMatchObject({ kind: 'stale' })
  })

  it('calls anything else another program, however it answers', () => {
    const node = proc('node.exe', 'C:\\Program Files\\nodejs\\node.exe', 'node server.js', '2026-11-01T10:00:00Z')
    // Answers like a sidecar, is not one.
    expect(classifyPortHolder(HEALTH_OLD, [node], OWN)).toEqual({ kind: 'other-program' })
    // Is named like one, does not answer like one.
    expect(classifyPortHolder(null, [onedirSidecar()], OWN)).toEqual({ kind: 'other-program' })
    expect(classifyPortHolder({ status: 'ok' }, [onedirSidecar()], OWN)).toEqual({ kind: 'other-program' })
    expect(classifyPortHolder('<html>', [onedirSidecar()], OWN)).toEqual({ kind: 'other-program' })
    // A sidecar.exe of some other program.
    const other = proc('sidecar.exe', 'C:\\Tools\\sidecar.exe', 'sidecar.exe', '2026-11-01T10:00:00Z')
    expect(classifyPortHolder(HEALTH_OLD, [other], OWN)).toEqual({ kind: 'other-program' })
    // Some other python program.
    const python = devSidecar('-m http.server 27384')
    expect(classifyPortHolder(HEALTH_OLD, [python], OWN)).toEqual({ kind: 'other-program' })
    // The owner could not be found out: never kill what is not known to be ours.
    expect(classifyPortHolder(HEALTH_OLD, null, OWN)).toEqual({ kind: 'other-program' })
    expect(classifyPortHolder(HEALTH_OLD, [], OWN)).toEqual({ kind: 'other-program' })
  })
})

describe('RestartBackoff', () => {
  it('restarts a crash after a short wait that grows with each fast crash', () => {
    const backoff = new RestartBackoff({ baseMs: 1000, maxMs: 8000, stableMs: 60_000, maxFastCrashes: 5 })
    const delays = [1, 2, 3, 4, 5].map(() => backoff.next(500))
    expect(delays).toEqual([
      { kind: 'restart', delayMs: 1000, attempt: 1 },
      { kind: 'restart', delayMs: 2000, attempt: 2 },
      { kind: 'restart', delayMs: 4000, attempt: 3 },
      { kind: 'restart', delayMs: 8000, attempt: 4 },
      { kind: 'restart', delayMs: 8000, attempt: 5 }
    ])
  })

  it('gives up after repeated fast crashes', () => {
    const backoff = new RestartBackoff({ baseMs: 1000, maxMs: 8000, stableMs: 60_000, maxFastCrashes: 3 })
    backoff.next(100)
    backoff.next(100)
    backoff.next(100)
    expect(backoff.next(100)).toEqual({ kind: 'give-up', crashes: 4 })
  })

  it('starts over after a sidecar that ran for a while', () => {
    const backoff = new RestartBackoff({ baseMs: 1000, maxMs: 8000, stableMs: 60_000, maxFastCrashes: 3 })
    backoff.next(100)
    backoff.next(100)
    backoff.next(100)
    expect(backoff.next(5 * 60_000)).toEqual({ kind: 'restart', delayMs: 1000, attempt: 1 })
  })
})

describe('stopGracefully', () => {
  function exitAfter(ms: number | null): { exited: Promise<void>; killed: () => boolean; forceKill: () => void } {
    let killed = false
    let resolveExit: () => void = () => undefined
    const exited = new Promise<void>((r) => (resolveExit = r))
    if (ms !== null) setTimeout(resolveExit, ms)
    return {
      exited,
      killed: () => killed,
      forceKill: () => {
        killed = true
        resolveExit()
      }
    }
  }

  it('does not kill a sidecar that stops when asked', async () => {
    const proc = exitAfter(20)
    let asked = false
    const outcome = await stopGracefully({
      requestShutdown: async () => {
        asked = true
      },
      exited: proc.exited,
      forceKill: proc.forceKill,
      timeoutMs: 1000
    })
    expect(asked).toBe(true)
    expect(outcome).toBe('clean')
    expect(proc.killed()).toBe(false)
  })

  it('kills only once the timeout has passed', async () => {
    const proc = exitAfter(null)
    const started = Date.now()
    const outcome = await stopGracefully({
      requestShutdown: async () => undefined,
      exited: proc.exited,
      forceKill: proc.forceKill,
      timeoutMs: 150
    })
    expect(outcome).toBe('forced')
    expect(proc.killed()).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
  })

  it('still waits out the timeout when the request itself fails', async () => {
    const proc = exitAfter(30)
    const outcome = await stopGracefully({
      requestShutdown: () => Promise.reject(new Error('ECONNRESET')),
      exited: proc.exited,
      forceKill: proc.forceKill,
      timeoutMs: 1000
    })
    expect(outcome).toBe('clean')
    expect(proc.killed()).toBe(false)
  })
})
