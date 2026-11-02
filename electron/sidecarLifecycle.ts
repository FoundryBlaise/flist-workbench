// The decisions behind starting, stopping and restarting the sidecar,
// kept apart from the processes themselves (electron/sidecar.ts) so they
// can be tested on their own.

/** A process as the OS reports it (electron/portOwner.ts). */
export type ProcessInfo = {
  pid: number
  parentPid: number
  /** Image name, e.g. `sidecar.exe`. */
  name: string
  path: string | null
  commandLine: string | null
  /** Creation time, ISO 8601. */
  created: string | null
}

/** Who holds the sidecar's port when the app starts. */
export type PortHolder =
  /** Another program, or a process not known to be our sidecar: never touched. */
  | { kind: 'other-program' }
  /** The sidecar of another copy of the app that still runs, and is not older than this one. */
  | { kind: 'app-running'; version: string }
  /** Our sidecar to stop and replace: older, or left behind by its app. */
  | { kind: 'stale'; pid: number; version: string }

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/**
 * Orders two app versions: negative when `a` is older, 0 when equal,
 * positive when newer; null when either is not a version. A
 * pre-release (`0.3.0-beta.1`, the standalone `0.0.0-dev`) comes before
 * its release.
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = VERSION.exec(a.trim())
  const pb = VERSION.exec(b.trim())
  if (!pa || !pb) return null
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i])
    if (diff !== 0) return Math.sign(diff)
  }
  const [preA, preB] = [pa[4], pb[4]]
  if (preA === preB) return 0
  if (preA === undefined) return 1
  if (preB === undefined) return -1
  return preA < preB ? -1 : 1
}

/** `/health` as every one of our sidecars has answered it: `{status: 'ok', version}`. */
function appHealthVersion(health: unknown): string | null {
  if (typeof health !== 'object' || health === null) return null
  const { status, version } = health as Record<string, unknown>
  return status === 'ok' && typeof version === 'string' ? version : null
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/**
 * A process that runs our sidecar's code: the packaged exe from an
 * app's `resources` folder (folder build or the older one-file build,
 * whose bootloader and child share the exe), or a dev build's python
 * running the sidecar's server module.
 */
export function isOurSidecarProcess(p: ProcessInfo): boolean {
  const name = p.name.toLowerCase()
  const path = (p.path ?? '').toLowerCase().replace(/\//g, '\\')
  if (name === 'sidecar.exe') {
    return path.endsWith('\\resources\\sidecar\\sidecar.exe') || path.endsWith('\\resources\\sidecar.exe')
  }
  if (/^pythonw?(\d+(\.\d+)?)?(\.exe)?$/.test(name)) {
    const cmd = p.commandLine ?? ''
    return /\buvicorn\b.*\bserver:app\b/.test(cmd) || /(^|[\s"\\/])server\.py("|\s|$)/.test(cmd)
  }
  return false
}

/** The Electron process of an F-list Workbench, packaged or a dev build. */
function isAppProcess(p: ProcessInfo): boolean {
  const name = baseName(p.name).toLowerCase()
  return name === 'f-list workbench.exe' || name === 'f-list workbench' || name === 'electron.exe' || name === 'electron'
}

/** Whether `ancestor` started no later than `child`, so it is really its parent and not a later process that got the parent's pid. */
function startedBefore(ancestor: ProcessInfo, child: ProcessInfo): boolean {
  const a = ancestor.created === null ? NaN : Date.parse(ancestor.created)
  const c = child.created === null ? NaN : Date.parse(child.created)
  // Unknown times count as the parent: wrongly thinking an app still
  // runs only means its sidecar is not replaced.
  if (Number.isNaN(a) || Number.isNaN(c)) return true
  return a <= c
}

/** Whether the app that started the sidecar `chain[0]` still runs. */
function appStillRuns(chain: ProcessInfo[]): boolean {
  let child = chain[0]
  for (const ancestor of chain.slice(1)) {
    if (!startedBefore(ancestor, child)) return false
    // A one-file bootloader or a venv launcher between the app and the
    // listener: look past it.
    if (!isOurSidecarProcess(ancestor)) return isAppProcess(ancestor)
    child = ancestor
  }
  return false
}

/**
 * What to do about the process holding the sidecar's port at start.
 *
 * `health` is what it answered on `/health` (parsed JSON, or null when
 * it answered nothing useful); `chain` is the listening process followed
 * by its ancestors, or null when the OS could not tell. Only a process
 * that both answers like our sidecar and runs our sidecar's code is
 * ever stopped. An older one is replaced, so new UI never runs
 * against old logic; one whose app is gone is replaced whatever its
 * version, as it does not know this launch's secret. The sidecar of a
 * copy of the app that still runs and is not older is left alone.
 */
export function classifyPortHolder(
  health: unknown,
  chain: ProcessInfo[] | null,
  ownVersion: string
): PortHolder {
  const version = appHealthVersion(health)
  const listener = chain?.[0]
  if (version === null || !chain || !listener || !isOurSidecarProcess(listener)) {
    return { kind: 'other-program' }
  }
  const order = compareVersions(version, ownVersion)
  if (appStillRuns(chain) && (order === null || order >= 0)) {
    return { kind: 'app-running', version }
  }
  return { kind: 'stale', pid: listener.pid, version }
}

export type RestartDecision =
  | { kind: 'restart'; delayMs: number; attempt: number }
  | { kind: 'give-up'; crashes: number }

export type BackoffOptions = {
  /** Wait before the first restart; doubled for each fast crash after it. */
  baseMs: number
  maxMs: number
  /** A sidecar that ran this long before it exited was not crashing on start. */
  stableMs: number
  /** Fast crashes in a row that are still restarted. */
  maxFastCrashes: number
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 1000,
  maxMs: 15_000,
  stableMs: 60_000,
  maxFastCrashes: 5
}

/** When to restart a sidecar that exited unexpectedly, and when to stop trying. */
export class RestartBackoff {
  private fastCrashes = 0

  constructor(private readonly opts: BackoffOptions = DEFAULT_BACKOFF) {}

  /** Called for each unexpected exit, with how long that sidecar ran. */
  next(ranMs: number): RestartDecision {
    if (ranMs >= this.opts.stableMs) this.fastCrashes = 0
    this.fastCrashes += 1
    if (this.fastCrashes > this.opts.maxFastCrashes) {
      return { kind: 'give-up', crashes: this.fastCrashes }
    }
    const delayMs = Math.min(this.opts.baseMs * 2 ** (this.fastCrashes - 1), this.opts.maxMs)
    return { kind: 'restart', delayMs, attempt: this.fastCrashes }
  }
}

/**
 * Asks the sidecar to stop and waits up to `timeoutMs` for it to exit;
 * only then is it killed. A failed request is no reason to kill early:
 * the sidecar may already be on its way out.
 */
export async function stopGracefully(opts: {
  requestShutdown: () => Promise<unknown>
  exited: Promise<void>
  forceKill: () => void
  timeoutMs: number
}): Promise<'clean' | 'forced'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'forced'>((resolve) => {
    timer = setTimeout(() => resolve('forced'), opts.timeoutMs)
  })
  opts.requestShutdown().catch(() => undefined)
  const outcome = await Promise.race([opts.exited.then(() => 'clean' as const), timedOut])
  clearTimeout(timer)
  if (outcome === 'forced') opts.forceKill()
  return outcome
}
