import { spawn, ChildProcess } from 'node:child_process'
import { app } from 'electron'
import { join } from 'node:path'

let proc: ChildProcess | null = null

// Packaged builds default to 8770 so they don't collide with the dev
// container's :8765 forward on the maintainer's machine.
const DEFAULT_PORT = app.isPackaged ? 8770 : 8765
const PORT = Number(process.env['SIDECAR_PORT'] ?? DEFAULT_PORT)
process.env['SIDECAR_PORT'] = String(PORT)

// Exposed so the main-process menu handlers can call the sidecar
// directly (e.g. resolving the failure-log path before shell.openPath).
export const sidecarUrl = `http://127.0.0.1:${PORT}`

export async function startSidecar(): Promise<void> {
  if (app.isPackaged) {
    const exe = join(process.resourcesPath, 'sidecar.exe')
    proc = spawn(exe, [], {
      env: { ...process.env, SIDECAR_PORT: String(PORT) },
      stdio: ['ignore', 'inherit', 'inherit']
    })
  } else {
    const sidecarDir = join(__dirname, '../../sidecar')
    // `uv sync` is idempotent and ~100 ms when the lockfile is clean,
    // so we run it on every dev launch — that way a `git pull` that
    // adds a Python dep doesn't crash the next run with a confusing
    // ModuleNotFoundError. Cost is negligible when nothing's stale.
    await runUvSync(sidecarDir)
    // detached: true puts the sidecar into its own process group on
    // POSIX. `uv run` shells out to uvicorn → python; killing only
    // `uv` leaves the python grandchild bound to the port. With its
    // own pgid we can kill the entire tree at quit time. No effect
    // on Windows (no pgid), which uses a different stop path below.
    proc = spawn('uv', ['run', 'uvicorn', 'server:app', '--port', String(PORT)], {
      cwd: sidecarDir,
      env: { ...process.env, SIDECAR_PORT: String(PORT) },
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: process.platform !== 'win32'
    })
  }

  proc.on('exit', (code) => {
    console.log(`[sidecar] exited with code ${code}`)
    proc = null
  })

  await waitForHealth(PORT)
}

export function stopSidecar(): void {
  if (!proc || proc.killed || proc.pid == null) {
    proc = null
    return
  }
  if (process.platform === 'win32') {
    // taskkill /T kills the whole tree, including the uv-spawned
    // python grandchild that survives a plain proc.kill().
    spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
      stdio: 'ignore'
    })
  } else {
    // Negative pid → SIGTERM to the whole process group, which
    // includes the python grandchild that `uv run` would otherwise
    // orphan when we kill only the `uv` parent.
    try {
      process.kill(-proc.pid, 'SIGTERM')
    } catch {
      // Process group already gone — fall through to a direct kill
      // so we still try the leader.
      try {
        proc.kill('SIGTERM')
      } catch {
        /* nothing left to kill */
      }
    }
  }
  proc = null
}

function runUvSync(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('uv', ['sync'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: process.platform === 'win32'
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

async function waitForHealth(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
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
