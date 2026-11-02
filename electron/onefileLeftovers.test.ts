// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageInUse, removeOnefileLeftoversOnce } from './onefileLeftovers'

const HOUR = 60 * 60 * 1000

let root: string
let tempDir: string
let markerPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'onefile-leftovers-'))
  tempDir = join(root, 'temp')
  await mkdir(tempDir)
  markerPath = join(root, 'userdata', 'onefile-leftovers-removed.json')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A runtime folder as an older onefile sidecar left it after a forced kill. */
async function workbenchRuntime(name: string, ageMs = 24 * HOUR): Promise<string> {
  const dir = join(tempDir, name)
  await mkdir(join(dir, 'fastembed-0.8.0.dist-info'), { recursive: true })
  await mkdir(join(dir, 'qdrant_client-1.18.0.dist-info'))
  await mkdir(join(dir, 'certifi'))
  await writeFile(join(dir, 'certifi', 'cacert.pem'), 'pem')
  await writeFile(join(dir, 'python312.dll'), 'dll')
  await writeFile(join(dir, 'base_library.zip'), 'zip')
  await age(dir, ageMs)
  return dir
}

/** Another PyInstaller app's runtime folder: same shape, none of our packages. */
async function otherAppRuntime(name: string): Promise<string> {
  const dir = join(tempDir, name)
  await mkdir(join(dir, 'certifi'), { recursive: true })
  await writeFile(join(dir, 'python312.dll'), 'dll')
  await writeFile(join(dir, 'base_library.zip'), 'zip')
  await age(dir, 24 * HOUR)
  return dir
}

async function age(dir: string, ageMs: number): Promise<void> {
  const then = new Date(Date.now() - ageMs)
  await utimes(dir, then, then)
}

describe('removeOnefileLeftoversOnce', () => {
  it('removes stale Workbench runtime folders and leaves everything else', async () => {
    const ours = [await workbenchRuntime('_MEI490042'), await workbenchRuntime('_MEI20242')]
    const other = await otherAppRuntime('_MEI777772')
    const unrelated = join(tempDir, 'some-other-folder')
    await mkdir(join(unrelated, 'fastembed-0.8.0.dist-info'), { recursive: true })
    await mkdir(join(unrelated, 'qdrant_client-1.18.0.dist-info'))

    await removeOnefileLeftoversOnce({ tempDir, markerPath })

    for (const dir of ours) expect(existsSync(dir)).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })

  it('runs only once, even when a later start finds new leftovers', async () => {
    await workbenchRuntime('_MEI1')
    await removeOnefileLeftoversOnce({ tempDir, markerPath })

    const later = await workbenchRuntime('_MEI2')
    await removeOnefileLeftoversOnce({ tempDir, markerPath })

    expect(existsSync(later)).toBe(true)
  })

  it('keeps the folder of a one-file sidecar that is still running', async () => {
    const running = await workbenchRuntime('_MEI1')
    const stale = await workbenchRuntime('_MEI2')

    await removeOnefileLeftoversOnce({
      tempDir,
      markerPath,
      // Another install's sidecar has its python DLL loaded from here.
      runtimeInUse: async (dir) => dir === running
    })

    expect(existsSync(running)).toBe(true)
    expect(await readdir(running)).toContain('python312.dll')
    expect(existsSync(stale)).toBe(false)
  })

  it('keeps a folder a one-file sidecar is unpacking into right now', async () => {
    // Its python DLL is not loaded until unpacking ends.
    const unpacking = await workbenchRuntime('_MEI1', 5_000)
    const stale = await workbenchRuntime('_MEI2')

    await removeOnefileLeftoversOnce({ tempDir, markerPath })

    expect(existsSync(unpacking)).toBe(true)
    expect(existsSync(stale)).toBe(false)
  })

  it('recognises a leftover that something else already half removed', async () => {
    // Real leftovers show it: removed in name order, stopped halfway,
    // so the earlier entries (fastembed among them) are gone.
    const half = join(tempDir, '_MEI154562')
    for (const d of ['numpy.libs', 'py_rust_stemmers', 'qdrant_client-1.18.0.dist-info', 'yaml'])
      await mkdir(join(half, d), { recursive: true })
    await age(half, 24 * HOUR)

    await removeOnefileLeftoversOnce({ tempDir, markerPath })

    expect(existsSync(half)).toBe(false)
  })

  it('goes on past an entry it cannot read', async () => {
    await writeFile(join(tempDir, '_MEI1'), 'a file, not a folder')
    const stale = await workbenchRuntime('_MEI2')

    const sweep = await removeOnefileLeftoversOnce({ tempDir, markerPath })

    expect(sweep).toEqual({ ran: true, removed: ['_MEI2'] })
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(markerPath)).toBe(true)
  })

  it('tries again next start when the temp folder cannot be listed', async () => {
    const missing = join(root, 'no-such-temp')
    await expect(removeOnefileLeftoversOnce({ tempDir: missing, markerPath })).rejects.toThrow()
    expect(existsSync(markerPath)).toBe(false)
  })
})

describe.runIf(process.platform === 'win32')('imageInUse', () => {
  it('tells a loaded executable from a plain file', async () => {
    // This test's own node.exe is loaded; a file written here is not.
    expect(await imageInUse(process.execPath)).toBe(true)
    const plain = join(root, 'python312.dll')
    await writeFile(plain, 'dll')
    expect(await imageInUse(plain)).toBe(false)
  })
})
