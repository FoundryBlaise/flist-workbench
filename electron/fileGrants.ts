import { isAbsolute, resolve } from 'node:path'

/** Files the renderer may read or write through main: exactly the ones
 *  the user picked in an open or save dialog, once each.
 *
 *  The renderer asks for a path, then sends it back with the bytes. If
 *  main trusted whatever path came back, any script running in the
 *  window could read or overwrite any file the user can (ADR 0002).
 *  Every caller today picks a file and uses it once, so a grant is
 *  spent on use. */
export class FileGrants {
  private readonly reads = new Set<string>()
  private readonly writes = new Set<string>()

  grantRead(filePath: string): void {
    this.reads.add(key(filePath))
  }

  grantWrite(filePath: string): void {
    this.writes.add(key(filePath))
  }

  takeRead(filePath: unknown): boolean {
    return take(this.reads, filePath)
  }

  takeWrite(filePath: unknown): boolean {
    return take(this.writes, filePath)
  }
}

function take(granted: Set<string>, filePath: unknown): boolean {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) return false
  return granted.delete(key(filePath))
}

// One spelling per file: `resolve` folds `..` segments, and Windows
// paths are case-insensitive.
function key(filePath: string): string {
  const resolved = resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
