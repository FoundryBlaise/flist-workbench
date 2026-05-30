/** Classify an LLM endpoint URL as a privacy-relevant category.
 *
 * The point isn't to be a perfect URL parser — it's to give the user
 * a load-bearing visual signal that "your RP messages are about to
 * leave your machine" before they hit Save. Local-network and link-
 * local addresses count as local even though they technically leave
 * the loopback interface; users routinely run LM Studio on a different
 * box on their LAN and shouldn't see a red "external" badge for that.
 *
 *  local   → loopback, *.local, host.docker.internal, RFC1918 / RFC4193,
 *            or any unresolved hostname like `lmstudio` that's clearly
 *            not an Internet hostname
 *  remote  → anything resolvable on the public Internet
 *  unknown → URL is blank, malformed, or we can't classify confidently
 */
export type EndpointCategory = 'local' | 'remote' | 'unknown'

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  'host.docker.internal',
  'host.containers.internal',
])

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const octets = m.slice(1, 5).map(Number)
  if (octets.some((n) => n > 255)) return false
  const [a, b] = octets
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true // link-local
  return false
}

export function categoriseEndpoint(rawUrl: string): EndpointCategory {
  const url = rawUrl.trim()
  if (!url) return 'unknown'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'unknown'
  }
  const host = parsed.hostname.toLowerCase()
  if (!host) return 'unknown'
  if (LOOPBACK_HOSTS.has(host)) return 'local'
  if (host.endsWith('.local')) return 'local'
  if (host.endsWith('.lan') || host.endsWith('.home') || host.endsWith('.internal'))
    return 'local'
  if (isPrivateIPv4(host)) return 'local'
  // Hostname with no dot is almost always a LAN name like `lmstudio-box`
  // or `nas`. Definitely-not-Internet.
  if (!host.includes('.') && !host.includes(':')) return 'local'
  return 'remote'
}

/** Strip credentials + path so the consent flag is keyed on the host:port
 *  the user actually targets, not noise like trailing slashes. */
export function endpointConsentKey(rawUrl: string): string | null {
  const url = rawUrl.trim()
  if (!url) return null
  try {
    const u = new URL(url)
    return `workbench.remoteEndpointAck.${u.host.toLowerCase()}`
  } catch {
    return null
  }
}

/** True when the user has previously acknowledged sending traffic to this
 *  specific remote endpoint. We don't want to keep nagging them. */
export function isRemoteEndpointAcknowledged(rawUrl: string): boolean {
  const key = endpointConsentKey(rawUrl)
  if (!key) return false
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export function acknowledgeRemoteEndpoint(rawUrl: string): void {
  const key = endpointConsentKey(rawUrl)
  if (!key) return
  try {
    localStorage.setItem(key, '1')
  } catch {
    // localStorage unavailable — accept session-only consent.
  }
}
