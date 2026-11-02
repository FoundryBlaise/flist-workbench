import { existsSync } from 'node:fs'
import { mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Up to 0.2.16 the sidecar was a PyInstaller one-file exe: every start
// unpacked its runtime into %TEMP%\_MEI<digits>, and its own exit removed
// it again. Quit stopped it with taskkill /F, so the exit never ran and
// every session left a few hundred MB behind. The sidecar is a folder
// now (ADR 0005) and unpacks nothing; this removes what older versions
// left, once.

const RUNTIME_NAME = /^_MEI\d+$/
// A one-file sidecar loads its python DLL only once unpacking ends, so
// until then nothing marks the folder as in use. Unpacking takes seconds;
// a folder written to more recently than this is left alone.
const UNPACKING_MS = 2 * 60 * 1000

export interface LeftoverOptions {
  /** The folder PyInstaller unpacked into (%TEMP%). */
  tempDir: string
  /** Written after the sweep; while it exists the sweep never runs again. */
  markerPath: string
  /** Whether a running process still uses the folder; tests stand in for the OS. */
  runtimeInUse?: (dir: string) => Promise<boolean>
}

/**
 * Whether a running one-file sidecar (another install, an old portable
 * build) still runs from `dir`. Its process has the folder's python DLL
 * loaded, and Windows refuses to open a loaded image for writing. A
 * folder with no python DLL left has nothing that can still run.
 */
export async function pythonRuntimeInUse(dir: string): Promise<boolean> {
  const dlls = (await readdir(dir)).filter((n) => /^python3\d*\.dll$/i.test(n))
  for (const dll of dlls) {
    if (await imageInUse(join(dir, dll))) return true
  }
  return false
}

/** Whether `file` is loaded as code by a running process (Windows). */
export async function imageInUse(file: string): Promise<boolean> {
  try {
    const handle = await open(file, 'r+')
    await handle.close()
    return false
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
  }
}

/** Whether a runtime folder came from a Workbench sidecar. */
function isWorkbenchRuntime(entries: string[]): boolean {
  const has = (re: RegExp): boolean => entries.some((e) => re.test(e))
  // Every one-file release carried the embedded vector store and the
  // reranker; another PyInstaller app with both is not to be expected.
  // py_rust_stemmers comes with fastembed and outlives it in folders
  // something already removed in name order and stopped halfway (real
  // leftovers look like that).
  return (
    has(/^qdrant_client-.*\.dist-info$/i) &&
    (has(/^fastembed-.*\.dist-info$/i) || has(/^py_rust_stemmers$/i))
  )
}

export type LeftoverSweep =
  | { ran: false }
  | { ran: true; removed: string[] }

export async function removeOnefileLeftoversOnce(opts: LeftoverOptions): Promise<LeftoverSweep> {
  if (existsSync(opts.markerPath)) return { ran: false }
  const inUse = opts.runtimeInUse ?? pythonRuntimeInUse
  const removed: string[] = []
  const names = (await readdir(opts.tempDir)).filter((n) => RUNTIME_NAME.test(n))
  for (const name of names) {
    const dir = join(opts.tempDir, name)
    try {
      if (!isWorkbenchRuntime(await readdir(dir))) continue
      if ((await stat(dir)).mtimeMs > Date.now() - UNPACKING_MS) continue
      // Checked before anything is deleted: removing files one by one
      // would get past the locked DLL and break the running sidecar.
      if (await inUse(dir)) continue
      await rm(dir, { recursive: true, force: true })
      removed.push(name)
    } catch {
      // Gone already, not a folder, or a file held open by a virus
      // scanner: leave it and go on with the rest.
    }
  }
  await mkdir(dirname(opts.markerPath), { recursive: true })
  await writeFile(
    opts.markerPath,
    JSON.stringify({ at: new Date().toISOString(), removed }, null, 2) + '\n'
  )
  return { ran: true, removed }
}
