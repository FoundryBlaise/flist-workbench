// How the app updates itself, per build (ADR 0005). The installer
// downloads and installs through electron-updater. The portable build
// never does: it unpacks to %TEMP% on every start, and when it ran the
// installer's flow it installed the setup next to itself and stayed on
// the old version. It only checks, and links to the release so the
// user downloads the new portable exe themselves.

/** Which build is running: the NSIS installer's or the portable exe. */
export type UpdateChannel = 'installer' | 'portable'

/**
 * The portable launcher sets PORTABLE_EXECUTABLE_DIR before it starts
 * the unpacked app; the installed app never has it.
 */
export function updateChannel(env: Record<string, string | undefined>): UpdateChannel {
  return env['PORTABLE_EXECUTABLE_DIR'] ? 'portable' : 'installer'
}

/**
 * The release feed the e2e suite serves on localhost
 * (FLIST_WORKBENCH_UPDATE_FEED), so a test can offer a newer release
 * without the real GitHub releases. Only an unpackaged build honors it,
 * and only for a feed on this machine: a shipped app always asks the
 * release feed baked into it.
 */
export function updateFeedOverride(
  isPackaged: boolean,
  env: Record<string, string | undefined>
): string | null {
  if (isPackaged) return null
  const raw = env['FLIST_WORKBENCH_UPDATE_FEED']
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:') return null
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null
  return url.toString()
}

export type UpdaterStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | {
      kind: 'available'
      version: string
      releaseNotes?: string | null
      /** Set on the portable build, which never downloads: where the user gets it. */
      releaseUrl?: string
    }
  | { kind: 'downloading'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'not-available' }
  | { kind: 'error'; message: string }

/** The part of electron-updater's autoUpdater this module drives. */
export interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: string, listener: (...args: never[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export type UpdatesOptions = {
  channel: UpdateChannel
  /** Every status change, for main to push to the window. */
  onStatus: (status: UpdaterStatus) => void
  /** Where a failed check or download is written down (main's diagnostic log). */
  log?: (prefix: string, payload: unknown) => void
}

/** The GitHub release page of `version`; releases are tagged `v<version>`. */
export function releasePageUrl(version: string): string {
  return `https://github.com/FoundryBlaise/flist-workbench/releases/tag/v${encodeURIComponent(version)}`
}

export type Updates = {
  /** The latest status, for a window that asks after it missed a push. */
  status(): UpdaterStatus
  /** Looks for a newer release. False when the check failed. */
  check(): Promise<boolean>
  /** Downloads the newer release. Always false on the portable build. */
  download(): Promise<boolean>
  /**
   * Quits and runs the downloaded installer, then relaunches. Always
   * false on the portable build, which has nothing to install.
   */
  install(): boolean
}

type UpdateInfo = { version: string; releaseNotes?: unknown }
type ProgressInfo = { percent: number; bytesPerSecond: number; transferred: number; total: number }

export function createUpdates(updater: Updater, opts: UpdatesOptions): Updates {
  const portable = opts.channel === 'portable'
  let current: UpdaterStatus = { kind: 'idle' }
  const send = (status: UpdaterStatus): void => {
    current = status
    opts.onStatus(status)
  }

  // Never downloads uninvited: the window asks the user first.
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = !portable

  updater.on('checking-for-update', () => send({ kind: 'checking' }))
  updater.on('update-available', (info: UpdateInfo) => {
    send({
      kind: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
      ...(portable ? { releaseUrl: releasePageUrl(info.version) } : {})
    })
  })
  updater.on('update-not-available', () => send({ kind: 'not-available' }))
  updater.on('download-progress', (p: ProgressInfo) => {
    send({
      kind: 'downloading',
      percent: p.percent,
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total
    })
  })
  updater.on('update-downloaded', (info: UpdateInfo) => send({ kind: 'downloaded', version: info.version }))
  updater.on('error', (err: Error | undefined) => send({ kind: 'error', message: err?.message ?? String(err) }))

  const log = opts.log ?? (() => {})

  return {
    status: () => current,
    async check() {
      try {
        await updater.checkForUpdates()
        return true
      } catch (err) {
        log('updater-check-failed', err)
        return false
      }
    },
    async download() {
      if (portable) return false
      try {
        await updater.downloadUpdate()
        return true
      } catch (err) {
        log('updater-download-failed', err)
        return false
      }
    },
    install() {
      if (portable) return false
      // Runs the NSIS installer in update mode: silent, because the user
      // already said yes in the window, and relaunching afterwards.
      updater.quitAndInstall(true, true)
      return true
    }
  }
}
