import { spawn, spawnSync, ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { app } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEV_SERVER_ORIGIN } from './appPage'
import { portOwnerChain } from './portOwner'
import { RestartBackoff, classifyPortHolder, stopGracefully } from './sidecarLifecycle'
import {
  SidecarPortTaken,
  assertPortFree,
  chooseSidecarPort,
  waitForPortFree
} from './sidecarPort'

export { SidecarPortTaken } from './sidecarPort'

// Mirror main.ts's appendDiagLog so sidecar startup paints into the
// same log file. We can't import from main.ts (circular) and we want
// sidecar diagnostics regardless of who called startSidecar.
function sidecarDiag(prefix: string, payload: unknown): void {
  const line = `[${new Date().toISOString()}] sidecar:${prefix}: ${
    payload instanceof Error
      ? `${payload.message}\n${payload.stack ?? ''}`
      : typeof payload === 'string'
        ? payload
        : JSON.stringify(payload)
  }\n`
  process.stderr.write(line)
  try {
    void writeFile(join(app.getPath('userData'), 'main-diag.log'), line, {
      flag: 'a'
    })
  } catch {
    /* no-op */
  }
}

/** A sidecar this app started. */
type Running = {
  child: ChildProcess
  spawnedAt: number
  /** Resolves when the process has exited. */
  exited: Promise<void>
  hasExited: boolean
  /** Stopped on purpose, so its exit is not a crash. */
  intended: boolean
}

let current: Running | null = null
/** Set once the app stops its sidecar for good: nothing restarts after. */
let stopping = false
let restartTimer: ReturnType<typeof setTimeout> | null = null
const backoff = new RestartBackoff()
let gaveUpHandler: ((crashes: number) => void) | null = null
let uvSynced = false
let exitHandlersInstalled = false

/** How long quit waits for the sidecar to stop when asked (it gives
 *  open requests `GRACEFUL_SHUTDOWN_S` in sidecar/services/lifecycle.py)
 *  before it is killed. */
const SHUTDOWN_TIMEOUT_MS = 6000
/** How long a replaced sidecar gets to let go of the port. */
const STALE_RELEASE_MS = 10_000

// Catch every termination path Electron's `before-quit` doesn't:
// terminal Ctrl+C against `npm run dev` (electron-vite kills Electron
// abruptly), main-process uncaught exceptions, parent SIGHUP from a
// closed terminal, etc. process.on('exit') is sync-only, so these kill
// at once (spawnSync on Windows, signal on POSIX); a normal quit asks
// first (stopSidecar).
function installExitHandlers() {
  if (exitHandlersInstalled) return
  exitHandlersInstalled = true
  process.on('exit', () => {
    try {
      killSidecarNow()
    } catch {
      /* nothing useful to do during exit */
    }
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      try {
        killSidecarNow()
      } catch {
        /* nothing useful to do during shutdown */
      }
      process.exit(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129)
    })
  }
}

// The installed app and a dev build default to different ports
// (sidecarPort.ts), so a dev run never reaches an installed sidecar.
// Written back so main can hand the port to the preload.
const PORT = chooseSidecarPort(process.env, app.isPackaged)
process.env['SIDECAR_PORT'] = String(PORT)

// Exposed so the main-process menu handlers can call the sidecar
// directly (e.g. resolving the failure-log path before shell.openPath).
export const sidecarUrl = `http://127.0.0.1:${PORT}`
export const sidecarPort = PORT

// The sidecar answers only callers that carry this (ADR 0002): any web
// page in the user's browser can reach the port, none can know a value
// made fresh at every start. Main adds it to the app page's requests
// (see main.ts) and to its own; the renderer never holds it. A
// restarted sidecar gets the same one, so the window carries on.
export const SECRET_HEADER = 'X-Workbench-Secret'
const launchSecret = randomBytes(32).toString('hex')

export function withLaunchSecret(
  headers: Record<string, string | string[]>
): Record<string, string | string[]> {
  return { ...headers, [SECRET_HEADER]: launchSecret }
}

/** fetch() against the sidecar from the main process. */
export function sidecarFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set(SECRET_HEADER, launchSecret)
  return fetch(`${sidecarUrl}${path}`, { ...init, headers })
}

function sidecarEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SIDECAR_PORT: String(PORT),
    // So /health reports the app's version rather than a
    // hardcoded placeholder. The frozen sidecar has no
    // package.json to read it from. The next start compares it
    // with its own to tell an older sidecar on the port.
    FLIST_WORKBENCH_VERSION: app.getVersion(),
    FLIST_WORKBENCH_LAUNCH_SECRET: launchSecret
  }
  // In dev the window loads from Vite rather than app://workbench, so the
  // sidecar has to grant that origin too. Never set when packaged.
  if (DEV_SERVER_ORIGIN !== undefined) {
    env['FLIST_WORKBENCH_RENDERER_ORIGIN'] = DEV_SERVER_ORIGIN
  } else {
    delete env['FLIST_WORKBENCH_RENDERER_ORIGIN']
  }
  return env
}

/**
 * Called when the sidecar kept exiting right after each restart and the
 * app has stopped trying, with the number of crashes in a row.
 */
export function onSidecarGaveUp(handler: (crashes: number) => void): void {
  gaveUpHandler = handler
}

/**
 * Starts the sidecar on its port. Rejects with SidecarPortTaken when the
 * port belongs to something the app must not replace; our sidecar
 * that is older, or left behind by its app, is stopped first and
 * replaced. From then on a sidecar that exits unexpectedly is restarted
 * with a backoff.
 */
export async function startSidecar(): Promise<void> {
  installExitHandlers()
  sidecarDiag('start', {
    isPackaged: app.isPackaged,
    port: PORT,
    platform: process.platform,
    resourcesPath: app.isPackaged ? process.resourcesPath : null
  })
  // Whatever already holds the port would answer the /health wait below,
  // and the app would then talk to it. Find out who it is first.
  try {
    await claimPort()
  } catch (err) {
    sidecarDiag('port-taken', err)
    throw err
  }
  await runSidecar()
}

/** Makes the port free for our sidecar, or rejects with SidecarPortTaken. */
async function claimPort(): Promise<void> {
  try {
    await assertPortFree(PORT)
    return
  } catch (err) {
    if (!(err instanceof SidecarPortTaken)) throw err
  }
  const [health, chain] = await Promise.all([probeHealth(PORT), portOwnerChain(PORT)])
  const holder = classifyPortHolder(health, chain, app.getVersion())
  sidecarDiag('port-holder', {
    holder,
    health,
    chain: chain?.map(({ pid, name, path }) => ({ pid, name, path })) ?? null
  })
  if (holder.kind === 'other-program') throw new SidecarPortTaken(PORT)
  if (holder.kind === 'app-running') throw new SidecarPortTaken(PORT, holder.version)
  // Older, or left behind by its app. It cannot be asked to stop (no
  // shutdown route before this version, and it does not know this
  // launch's secret), so it is killed: that process and its children
  // only. A one-file bootloader above it then cleans up and exits.
  sidecarDiag('replace-stale', holder)
  killTree(holder.pid)
  await waitForPortFree(PORT, STALE_RELEASE_MS)
}

/** What the port's holder answers on /health, or null. */
async function probeHealth(port: number): Promise<unknown> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3000)
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/** Spawns the sidecar and waits for it to answer /health. */
async function runSidecar(): Promise<void> {
  const running = await spawnSidecar()
  current = running
  try {
    await waitForHealth(PORT, running)
    sidecarDiag('healthy', { port: PORT, pid: running.child.pid ?? null })
  } catch (err) {
    sidecarDiag('health-failed', err)
    throw err
  }
}

async function spawnSidecar(): Promise<Running> {
  let child: ChildProcess
  if (app.isPackaged) {
    // A folder build (ADR 0005): the exe runs from its own folder and
    // unpacks nothing.
    const exe = join(process.resourcesPath, 'sidecar', 'sidecar.exe')
    sidecarDiag('spawn-packaged', { exe })
    // Pipe stdout/stderr so we can tee them into the diag log — a
    // PyInstaller bundle that crashes on startup prints the traceback
    // to stderr, and we want that traceback in a place a user can
    // grep without attaching a debugger.
    child = spawn(exe, [], {
      env: sidecarEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout?.on('data', (chunk: Buffer) =>
      sidecarDiag('stdout', chunk.toString('utf8').trimEnd())
    )
    child.stderr?.on('data', (chunk: Buffer) =>
      sidecarDiag('stderr', chunk.toString('utf8').trimEnd())
    )
  } else {
    const sidecarDir = join(__dirname, '../../sidecar')
    sidecarDiag('spawn-dev', { sidecarDir })
    // `uv sync` is idempotent and ~100 ms when the lockfile is clean,
    // so we run it on every dev launch — that way a `git pull` that
    // adds a Python dep doesn't crash the next run with a confusing
    // ModuleNotFoundError. Cost is negligible when nothing's stale.
    // A restart within the same run skips it.
    if (!uvSynced) {
      await runUvSync(sidecarDir)
      uvSynced = true
    }
    // Skip the `uv run` indirection and invoke the venv's python
    // directly. Going through `uv run` builds a multi-layer chain
    // (uv.exe → venv launcher → uv-managed cpython on Windows) that
    // taskkill /T won't always walk to completion — multiple python
    // processes can survive shutdown. `server.py` runs the server loop
    // as the packaged exe does, so POST /shutdown can end it.
    //
    // detached: true on POSIX puts the python in its own process
    // group so we can SIGTERM the whole group from killSidecar.
    const pythonExe =
      process.platform === 'win32'
        ? join(sidecarDir, '.venv', 'Scripts', 'python.exe')
        : join(sidecarDir, '.venv', 'bin', 'python')
    child = spawn(pythonExe, ['server.py'], {
      cwd: sidecarDir,
      env: sidecarEnv(),
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: process.platform !== 'win32',
      // Electron has no console of its own, so on Windows a console
      // child would open its own window and take the focus.
      windowsHide: true
    })
  }

  sidecarDiag('spawned', { pid: child.pid ?? null })
  let markExited: () => void = () => undefined
  const running: Running = {
    child,
    spawnedAt: Date.now(),
    exited: new Promise<void>((resolve) => (markExited = resolve)),
    hasExited: false,
    intended: false
  }
  const onGone = (): void => {
    if (running.hasExited) return
    running.hasExited = true
    markExited()
    if (current !== running) return
    current = null
    if (running.intended || stopping) return
    scheduleRestart(Date.now() - running.spawnedAt)
  }
  child.on('exit', (code, signal) => {
    sidecarDiag('exited', {
      pid: child.pid ?? null,
      code,
      signal,
      intended: running.intended || stopping
    })
    onGone()
  })
  child.on('error', (err) => {
    sidecarDiag('spawn-error', err)
    // A spawn that failed outright emits no 'exit'.
    if (child.pid === undefined) onGone()
  })
  return running
}

/** Restarts after an unexpected exit, waiting longer after each fast crash. */
function scheduleRestart(ranMs: number): void {
  if (stopping || restartTimer !== null) return
  const decision = backoff.next(ranMs)
  if (decision.kind === 'give-up') {
    sidecarDiag('gave-up', decision)
    gaveUpHandler?.(decision.crashes)
    return
  }
  sidecarDiag('restart-scheduled', decision)
  restartTimer = setTimeout(() => {
    restartTimer = null
    void restartSidecar()
  }, decision.delayMs)
}

async function restartSidecar(): Promise<void> {
  if (stopping) return
  try {
    // A restart never replaces anything: whoever took the port in the
    // meantime keeps it, and this counts as one more failed start.
    await assertPortFree(PORT)
    await runSidecar()
    sidecarDiag('restarted', { pid: current?.child.pid ?? null })
  } catch (err) {
    sidecarDiag('restart-failed', err)
    const running = current
    if (running && !running.hasExited) {
      // Started but never answered: kill it; its exit schedules the next try.
      killSidecar(running)
    } else if (running === null) {
      scheduleRestart(0)
    }
  }
}

/**
 * Stops the sidecar for good (at quit): asks it over POST /shutdown,
 * which needs this launch's secret, waits for it to exit, and kills it
 * only if it has not exited within SHUTDOWN_TIMEOUT_MS. Nothing restarts
 * it afterwards.
 */
export async function stopSidecar(): Promise<void> {
  stopping = true
  if (restartTimer !== null) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  const running = current
  if (!running || running.hasExited) {
    current = null
    return
  }
  running.intended = true
  const outcome = await stopGracefully({
    requestShutdown: () =>
      sidecarFetch('/shutdown', { method: 'POST', signal: AbortSignal.timeout(2000) }),
    exited: running.exited,
    forceKill: () => killSidecar(running),
    timeoutMs: SHUTDOWN_TIMEOUT_MS
  })
  sidecarDiag('stopped', { pid: running.child.pid ?? null, outcome })
  if (current === running) current = null
}

/** Kills the sidecar at once, for exits that cannot wait (installExitHandlers). */
export function killSidecarNow(): void {
  stopping = true
  if (restartTimer !== null) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  const running = current
  current = null
  if (running && !running.hasExited) {
    running.intended = true
    killSidecar(running)
  }
}

function killSidecar(running: Running): void {
  const pid = running.child.pid
  if (pid == null) return
  if (process.platform === 'win32') {
    killTree(pid)
    return
  }
  // Negative pid → SIGTERM to the whole process group. With direct
  // python spawn the group only contains the sidecar process and any
  // worker children it forks, all of which we want gone.
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // Process group already gone — fall through to a direct kill
    // so we still try the leader.
    try {
      running.child.kill('SIGTERM')
    } catch {
      /* nothing left to kill */
    }
  }
}

/**
 * Kills a process and its descendants. On Windows taskkill /T walks
 * parent-PID descendants (a dev sidecar's venv launcher has the real
 * python below it); spawnSync so app.quit() / process.exit() can't
 * race ahead of the kill.
 */
function killTree(pid: number): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
    return
  }
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true
  })
}

function runUvSync(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('uv', ['sync'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: process.platform === 'win32',
      windowsHide: true
    })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`uv sync exited with code ${code}`))
    })
    child.on('error', (err) => {
      // Surface a more actionable message than the default ENOENT for
      // the common "uv not on PATH" Windows case.
      reject(
        new Error(
          `failed to spawn 'uv sync' (${err.message}). ` +
            "Is 'uv' on PATH? See https://docs.astral.sh/uv/getting-started/installation/"
        )
      )
    })
  })
}

async function waitForHealth(port: number, running: Running, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    // Our sidecar is gone (e.g. it lost a race for the port), so a
    // /health answer could only come from someone else's process.
    if (running.hasExited) throw new Error('sidecar exited before it answered /health')
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) return
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`sidecar /health not ready in ${timeoutMs}ms: ${String(lastErr)}`)
}
