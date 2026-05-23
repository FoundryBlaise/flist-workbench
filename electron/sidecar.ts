import { spawn, ChildProcess } from 'node:child_process'
import { app } from 'electron'
import { join } from 'node:path'

let proc: ChildProcess | null = null

const PORT = Number(process.env['SIDECAR_PORT'] ?? 8765)

export async function startSidecar(): Promise<void> {
  const sidecarDir = app.isPackaged
    ? join(process.resourcesPath, 'sidecar')
    : join(__dirname, '../../sidecar')

  // Dev runs through `uv run` so deps resolve against the project venv.
  // Phase 8 packaging will swap in a bundled Python interpreter.
  const cmd = app.isPackaged ? 'python' : 'uv'
  const args = app.isPackaged
    ? ['-m', 'uvicorn', 'server:app', '--port', String(PORT)]
    : ['run', 'uvicorn', 'server:app', '--port', String(PORT)]

  proc = spawn(cmd, args, {
    cwd: sidecarDir,
    env: { ...process.env, SIDECAR_PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit']
  })

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
