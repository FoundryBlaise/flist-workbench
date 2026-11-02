import { createServer } from 'node:net'

// The installed app's port. Picked in the upper-20k range so it doesn't
// collide with the cluster of common ports around :8xxx that dev tools
// fight over (vite, mongo, code-server forwards, etc). The browser
// extension hardcodes this one: keep them aligned.
export const PACKAGED_PORT = 27384

// A dev run (`npm run dev`, an unpackaged build) gets a port of its own,
// so it never reaches the sidecar of an installed app running on the
// same machine. The browser extension does not know this port: to try
// the extension against a dev build, quit the installed app and start
// dev with SIDECAR_PORT=27384.
export const DEV_PORT = 27385

/** SIDECAR_PORT when set, else the default for this kind of build. */
export function chooseSidecarPort(env: NodeJS.ProcessEnv, isPackaged: boolean): number {
  const raw = env['SIDECAR_PORT']
  if (raw === undefined || raw === '') return isPackaged ? PACKAGED_PORT : DEV_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SIDECAR_PORT=${JSON.stringify(raw)} is not a port number (1-65535)`)
  }
  return port
}

/**
 * Something the app must not replace holds the port the sidecar needs:
 * another program, or the sidecar of another F-list Workbench that is
 * still running and not older than this one (`workbenchVersion`).
 */
export class SidecarPortTaken extends Error {
  constructor(
    readonly port: number,
    readonly workbenchVersion?: string
  ) {
    super(
      workbenchVersion === undefined
        ? `Another program is using port ${port} on this computer, so F-list Workbench ` +
            'cannot start its sidecar there. Close that program, or start F-list Workbench ' +
            'with SIDECAR_PORT set to a free port.'
        : `Another F-list Workbench (version ${workbenchVersion}) is running and uses ` +
            `port ${port}. Close it, then start this one again.`
    )
    this.name = 'SidecarPortTaken'
  }
}

/**
 * Resolves when the port can be bound on 127.0.0.1, rejects with
 * SidecarPortTaken when something already listens there. Checked before
 * the sidecar starts: its /health wait would otherwise be answered by
 * whatever holds the port, and the app would talk to a stranger.
 */
export function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'EADDRINUSE' ? new SidecarPortTaken(port) : err)
    })
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      probe.close(() => resolve())
    })
  })
}

/** Resolves once the port can be bound again, or rejects with SidecarPortTaken after `timeoutMs`. */
export async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await assertPortFree(port)
      return
    } catch (err) {
      if (!(err instanceof SidecarPortTaken) || Date.now() >= deadline) throw err
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}
