import { app } from 'electron'
import { cp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

// The browser extension ships inside the app until it is in the stores.
// Chrome loads an unpacked extension from its folder on every browser
// start, so that folder has to outlive the app: the portable build
// unpacks itself to a fresh temp dir per launch, and an installer update
// replaces the install dir. userData stays put across both, which also
// keeps the extension's id — and with it the pairing token — stable.

export interface BrowserExtensionStatus {
  /** Version packed into this build; null when the build has none. */
  bundled: string | null
  /** Version sitting in the folder Chrome loads from. */
  installed: string | null
  /** The folder to point Chrome's "Load unpacked" at. */
  path: string
}

function bundledDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'browser-extension')
    : join(__dirname, '../../resources/browser-extension')
}

export function installDir(): string {
  return join(app.getPath('userData'), 'browser-extension')
}

async function readVersion(dir: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/** Copy the bundled extension to userData when the two differ. Any
 *  difference counts, not only a newer bundle: after a downgrade of the
 *  app, the extension has to follow it back to the version it was
 *  tested with. Files are overwritten in place rather than the folder
 *  being swapped, because the folder may be loaded in Chrome right now. */
export async function syncBrowserExtension(): Promise<BrowserExtensionStatus> {
  const src = bundledDir()
  const dst = installDir()
  const bundled = await readVersion(src)
  let installed = await readVersion(dst)
  if (bundled && bundled !== installed) {
    const keep = new Set(await readdir(src))
    const existing = await readdir(dst).catch(() => [] as string[])
    for (const name of existing) {
      if (!keep.has(name)) await rm(join(dst, name), { recursive: true, force: true })
    }
    await cp(src, dst, { recursive: true, force: true })
    installed = await readVersion(dst)
  }
  return { bundled, installed, path: dst }
}
