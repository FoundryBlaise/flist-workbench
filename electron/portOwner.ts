import { execFile } from 'node:child_process'
import type { ProcessInfo } from './sidecarLifecycle'

/** How many processes up from the listener to report: listener, a
 *  one-file bootloader or venv launcher, the app, and one spare. */
const CHAIN_DEPTH = 4

// One PowerShell run: the process listening on the port, then its
// parents. Only for a port the app found taken, so its start-up cost
// (a few seconds the first time) is paid only then.
const SCRIPT = `
$c = Get-NetTCPConnection -State Listen -LocalPort __PORT__ -ErrorAction SilentlyContinue | Select-Object -First 1
$out = @()
$id = if ($c) { [int]$c.OwningProcess } else { 0 }
for ($i = 0; $i -lt ${CHAIN_DEPTH} -and $id -gt 0; $i++) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
  if (-not $p) { break }
  $out += [pscustomobject]@{
    pid = [int]$p.ProcessId
    parentPid = [int]$p.ParentProcessId
    name = $p.Name
    path = $p.ExecutablePath
    commandLine = $p.CommandLine
    created = if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { $null }
  }
  $id = [int]$p.ParentProcessId
}
ConvertTo-Json -Compress -Depth 2 -InputObject $out
`

function asProcessInfo(value: unknown): ProcessInfo | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v['pid'] !== 'number' || typeof v['name'] !== 'string') return null
  const text = (x: unknown): string | null => (typeof x === 'string' ? x : null)
  return {
    pid: v['pid'],
    parentPid: typeof v['parentPid'] === 'number' ? v['parentPid'] : 0,
    name: v['name'],
    path: text(v['path']),
    commandLine: text(v['commandLine']),
    created: text(v['created'])
  }
}

/**
 * The process listening on `port` on this machine, followed by its
 * parents; `[]` when nothing listens; null when the OS could not tell
 * (and on platforms other than Windows, which the app does not ship
 * for). A null owner is never treated as our sidecar.
 */
export function portOwnerChain(port: number): Promise<ProcessInfo[] | null> {
  if (process.platform !== 'win32' || !Number.isInteger(port)) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT.replace('__PORT__', String(port))],
      { windowsHide: true, timeout: 20_000 },
      (err, stdout) => {
        if (err) return resolve(null)
        try {
          const parsed: unknown = JSON.parse(stdout.trim() || '[]')
          const list = Array.isArray(parsed) ? parsed : [parsed]
          const chain = list.map(asProcessInfo)
          resolve(chain.every((p) => p !== null) ? (chain as ProcessInfo[]) : null)
        } catch {
          resolve(null)
        }
      }
    )
  })
}
