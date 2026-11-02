// Starts the packaged app electron-builder left in dist-electron/win-unpacked
// and checks that its sidecar answers /health from the sidecar folder
// (ADR 0005), that nothing is unpacked into %TEMP% at start, and that a
// runtime folder an older one-file sidecar left in %TEMP% is removed.
//
// Everything the app touches points into a fresh temp folder: data,
// %APPDATA%, %LOCALAPPDATA%, %TEMP% and Electron's userData, so the
// user's own data and temp folder are never read or changed. Runs after
// `npm run pack:win` (the release workflow does) or after
// `electron-builder --win --dir`.
/* global process, console, fetch, setTimeout */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = join(root, 'dist-electron', 'win-unpacked')
const exe = join(appDir, 'F-list Workbench.exe')
const HEALTH_TIMEOUT_MS = 90_000

function fail(message) {
  console.error(`smoke-packaged: ${message}`)
  process.exitCode = 1
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(250)
  }
  return null
}

if (process.platform !== 'win32') {
  console.log('smoke-packaged: Windows only, skipped')
  process.exit(0)
}
if (!existsSync(exe)) {
  console.error(`smoke-packaged: ${exe} not found; run npm run pack:win first`)
  process.exit(1)
}

const run = mkdtempSync(join(tmpdir(), 'wb-smoke-'))
const dirs = {}
for (const name of ['temp', 'data', 'appdata', 'localappdata', 'userdata']) {
  dirs[name] = join(run, name)
  mkdirSync(dirs[name])
}

// What a forced kill of an older one-file sidecar left behind.
const leftover = join(dirs.temp, '_MEI100002')
for (const d of ['fastembed-0.8.0.dist-info', 'qdrant_client-1.18.0.dist-info', 'certifi'])
  mkdirSync(join(leftover, d), { recursive: true })
writeFileSync(join(leftover, 'python312.dll'), '')
const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
utimesSync(leftover, dayAgo, dayAgo)

const port = await freePort()
const env = { ...process.env }
// ELECTRON_RUN_AS_NODE (set by editor terminals) would turn the app into
// plain node; the others would point it at a dev setup.
for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'FCHAT_DATA_DIR', 'PORTABLE_EXECUTABLE_DIR'])
  delete env[k]
Object.assign(env, {
  SIDECAR_PORT: String(port),
  FLIST_WORKBENCH_DATA_DIR: dirs.data,
  APPDATA: dirs.appdata,
  LOCALAPPDATA: dirs.localappdata,
  TEMP: dirs.temp,
  TMP: dirs.temp,
  FLIST_WORKBENCH_NO_KEYCHAIN: '1',
  FLIST_WORKBENCH_OFFLINE_STARTUP: '1',
  FLIST_WORKBENCH_NO_FOCUS: '1'
})

const app = spawn(exe, [`--user-data-dir=${dirs.userdata}`], { env, stdio: 'ignore' })
try {
  const health = await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      return res.ok ? await res.json() : null
    } catch {
      return null
    }
  }, HEALTH_TIMEOUT_MS)
  if (!health) fail(`no healthy sidecar on port ${port} within ${HEALTH_TIMEOUT_MS} ms`)
  else console.log(`smoke-packaged: sidecar healthy, version ${health.version}`)

  const diagPath = join(dirs.userdata, 'main-diag.log')
  const diag = () => (existsSync(diagPath) ? readFileSync(diagPath, 'utf8') : '')
  const sidecarExe = join(appDir, 'resources', 'sidecar', 'sidecar.exe')
  if (!diag().includes(JSON.stringify({ exe: sidecarExe }))) {
    fail(`the app did not start ${sidecarExe}`)
  }

  const swept = await waitFor(() => diag().includes('onefile-leftovers'), 20_000)
  if (!swept || existsSync(leftover)) fail('the one-file leftover in %TEMP% was not removed')

  const unpacked = readdirSync(dirs.temp).filter((n) => /^_MEI\d+$/.test(n))
  if (unpacked.length > 0) fail(`runtime unpacked into %TEMP%: ${unpacked.join(', ')}`)
} finally {
  spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
  await sleep(1000)
  rmSync(run, { recursive: true, force: true, maxRetries: 5 })
}
if (!process.exitCode) console.log('smoke-packaged: ok')
