// Downloads the browser-extension release pinned in browser-extension.json
// into resources/browser-extension/, where electron-builder picks it up as
// an extra resource. Only a published release is ever shipped, never a
// working copy: the pin names the exact version that was tested against
// this Workbench, and the sha256 makes a replaced release asset fail the
// build instead of slipping into the installer.
//
// Idempotent: when the unpacked folder already holds the pinned version,
// nothing is downloaded.
/* global process, console, Buffer, fetch */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import extract from 'extract-zip'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pin = JSON.parse(readFileSync(join(root, 'browser-extension.json'), 'utf8'))
const outDir = join(root, 'resources', 'browser-extension')
const manifestPath = join(outDir, 'manifest.json')

function installedVersion() {
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')).version ?? null
  } catch {
    return null
  }
}

if (installedVersion() === pin.version) {
  console.log(`[fetch-extension] ${pin.version} already in place`)
  process.exit(0)
}

const url = `https://github.com/${pin.repo}/releases/download/v${pin.version}/${pin.asset}`
console.log(`[fetch-extension] downloading ${url}`)
const res = await fetch(url)
if (!res.ok) {
  console.error(`[fetch-extension] download failed: HTTP ${res.status}`)
  process.exit(1)
}
const bytes = Buffer.from(await res.arrayBuffer())

const sha256 = createHash('sha256').update(bytes).digest('hex')
if (sha256 !== pin.sha256) {
  console.error(
    `[fetch-extension] checksum mismatch for ${pin.asset}\n  expected ${pin.sha256}\n  got      ${sha256}`
  )
  process.exit(1)
}

// extract-zip wants a path on disk, not a buffer.
const zipPath = join(tmpdir(), `flist-workbench-${pin.asset}`)
writeFileSync(zipPath, bytes)
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
try {
  await extract(zipPath, { dir: outDir })
} finally {
  rmSync(zipPath, { force: true })
}

// The release workflow stamps the tag into manifest.json, so a mismatch
// here means the pin points at an asset from some other release.
const got = installedVersion()
if (got !== pin.version) {
  console.error(`[fetch-extension] ${pin.asset} holds version ${got}, pinned ${pin.version}`)
  rmSync(outDir, { recursive: true, force: true })
  process.exit(1)
}
console.log(`[fetch-extension] ${pin.version} unpacked to resources/browser-extension`)
