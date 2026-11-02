import { test, expect, type Page } from '@playwright/test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { portOwnerChain } from '../../electron/portOwner'
import { freePort, withApp } from './launch'

// The app looks after its sidecar: one that dies is started again, an
// older one left on the port is replaced, and quitting asks the sidecar
// to stop rather than killing it.

test.skip(process.platform !== 'win32', 'finds the sidecar process the Windows way')

const repo = resolve(__dirname, '../..')
const python = join(repo, 'sidecar', '.venv', 'Scripts', 'python.exe')

function portOf(url: string): number {
  return Number(new URL(url).port)
}

/** The pid listening on the port, or null when nothing does. */
async function listenerPid(port: number): Promise<number | null> {
  const chain = await portOwnerChain(port)
  return chain?.[0]?.pid ?? null
}

async function health(url: string): Promise<{ status: string; version: string } | null> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok ? ((await res.json()) as { status: string; version: string }) : null
  } catch {
    return null
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A request from the app's page, which main signs with the launch secret. */
function pageRequestStatus(window: Page, url: string): Promise<number> {
  return window.evaluate(async (u) => (await fetch(u)).status, url)
}

test('a sidecar that dies is restarted, and quitting stops it cleanly', async () => {
  let port = 0
  let restartedPid: number | null = null
  let userDataDir = ''
  await withApp(async ({ window, sidecarUrl, userData }) => {
    port = portOf(sidecarUrl)
    userDataDir = userData
    const first = await listenerPid(port)
    expect(first).not.toBeNull()

    spawnSync('taskkill', ['/PID', String(first), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    await expect.poll(() => health(sidecarUrl), { timeout: 45_000 }).toBeNull()
    await expect.poll(() => health(sidecarUrl), { timeout: 60_000 }).toMatchObject({ status: 'ok' })

    restartedPid = await listenerPid(port)
    expect(restartedPid).not.toBeNull()
    expect(restartedPid).not.toBe(first)
    // Same launch secret: the window carries on without a reload.
    expect(await pageRequestStatus(window, `${sidecarUrl}/settings`)).toBe(200)
  })

  // withApp quit the app: the sidecar was asked to stop and did, so no
  // forced kill was needed and nothing is left on the port.
  expect(restartedPid).not.toBeNull()
  expect(alive(restartedPid ?? 0)).toBe(false)
  expect(await listenerPid(port)).toBeNull()
  const diag = await readFile(join(userDataDir, 'main-diag.log'), 'utf8')
  expect(diag).toContain('sidecar:restarted')
  expect(diag).toMatch(/sidecar:stopped: .*"outcome":"clean"/)
})

test('an older sidecar left on the port is replaced by the current one', async () => {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const dataDir = await mkdtemp(join(process.env['FLIST_WB_E2E_ROOT'] ?? repo, 'old-sidecar-'))
  // An older version's sidecar, started the way older dev builds did
  // and left running without its app.
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  Object.assign(env, {
    SIDECAR_PORT: String(port),
    FLIST_WORKBENCH_VERSION: '0.1.0',
    FLIST_WORKBENCH_LAUNCH_SECRET: randomBytes(16).toString('hex'),
    FLIST_WORKBENCH_DATA_DIR: dataDir,
    FLIST_WORKBENCH_OFFLINE_STARTUP: '1'
  })
  const old: ChildProcess = spawn(python, ['-m', 'uvicorn', 'server:app', '--port', String(port)], {
    cwd: join(repo, 'sidecar'),
    env,
    stdio: 'ignore',
    windowsHide: true
  })
  try {
    await expect.poll(() => health(url), { timeout: 60_000 }).toEqual({ status: 'ok', version: '0.1.0' })
    const oldListener = await listenerPid(port)
    expect(oldListener).not.toBeNull()

    await withApp(
      async ({ app, window, sidecarUrl }) => {
        expect(sidecarUrl).toBe(url)
        const own = await app.evaluate(({ app: electronApp }) => electronApp.getVersion())
        expect(await health(url)).toEqual({ status: 'ok', version: own })
        expect(alive(oldListener ?? 0)).toBe(false)
        expect(await listenerPid(port)).not.toBe(oldListener)
        expect(await pageRequestStatus(window, `${url}/settings`)).toBe(200)
      },
      { port }
    )
  } finally {
    if (old.pid !== undefined && old.exitCode === null) {
      spawnSync('taskkill', ['/PID', String(old.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    }
  }
})
