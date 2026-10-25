import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Builds the fixture F-Chat folder once per run, in a fresh temp root
// that every launch's data folders also live under, and removes the
// root afterwards. The Logs are written by the sidecar's shared Log
// writer (sidecar/tests/fchat_logs.py) through the sidecar's own venv
// python: the app already needs that venv to start its sidecar in a
// dev build, and calling the one writer keeps a single encoder of the
// F-Chat format instead of a TypeScript copy that could drift.
export default async function globalSetup(): Promise<() => Promise<void>> {
  const repo = resolve(__dirname, '../..')
  const python =
    process.platform === 'win32'
      ? join(repo, 'sidecar', '.venv', 'Scripts', 'python.exe')
      : join(repo, 'sidecar', '.venv', 'bin', 'python')
  if (!existsSync(python)) {
    throw new Error(`no sidecar venv at ${python}; run \`uv sync --project sidecar\` first`)
  }

  const root = await mkdtemp(join(tmpdir(), 'flist-wb-e2e-'))
  const fchatDir = join(root, 'fchat')
  execFileSync(python, [join(__dirname, 'fixtures', 'build_fchat_dir.py'), fchatDir], {
    stdio: 'inherit'
  })

  // Workers start after global setup and inherit these.
  process.env['FLIST_WB_E2E_ROOT'] = root
  process.env['FLIST_WB_E2E_FCHAT_DIR'] = fchatDir

  return async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  }
}
