import { spawn, ChildProcess } from 'node:child_process'
import { app } from 'electron'
import { join } from 'node:path'

let proc: ChildProcess | null = null

// Packaged builds default to 8770 so they don't collide with the dev
// container's :8765 forward on the maintainer's machine.
const DEFAULT_PORT = app.isPackaged ? 8770 : 8765
const PORT = Number(process.env['SIDECAR_PORT'] ?? DEFAULT_PORT)
process.env['SIDECAR_PORT'] = String(PORT)

export async function startSidecar(): Promise<void> {
  if (app.isPackaged) {
    const exe = join(process.resourcesPath, 'sidecar.exe')
    proc = spawn(exe, [], {
      env: { ...process.env, SIDECAR_PORT: String(PORT) },
      stdio: ['ignore', 'inherit', 'inherit']
    })
  } else {
    const sidecarDir = join(__dirname, '../../sidecar')
    proc = spawn('uv', ['run', 'uvicorn', 'server:app', '--port', String(PORT)], {
      cwd: sidecarDir,
      env: { ...process.env, SIDECAR_PORT: String(PORT) },
      stdio: ['ignore', 'inherit', 'inherit']
    })
  }

  proc.on('exit', (code) => {
    console.log(`[sidecar] exited with code ${code}`)
    proc = null
  })

  await waitForHealth(PORT)
}

export function stopSidecar(): void {
  if (proc && !proc.killed) {
    proc.kill('SIGTERM')
    proc = null
  }
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
