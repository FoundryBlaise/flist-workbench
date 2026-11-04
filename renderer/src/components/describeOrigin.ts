/** Who wrote a Workbench, from the origin its change event carried:
 *  "mcp:set_description" reads better as "a connected model —
 *  set_description". An unattributed change says nothing. The
 *  internal:/extension: origins are the sidecar's attribution of the
 *  maintenance writes (gallery repair, image-id folding) that rewrite a
 *  Workbench without anyone clicking anything; naming them is what keeps
 *  a change from outside the editor from being a mystery. */
export function describeOrigin(origin: string): string | null {
  if (!origin || origin === 'ui') return null
  if (origin.startsWith('mcp:')) {
    return `a connected model — ${origin.slice(4)}`
  }
  if (origin === 'mcp') return 'a connected model'
  if (origin.startsWith('internal:')) {
    const name = origin.slice(9).replace(/-/g, ' ')
    return `a maintenance pass in the app (${name})`
  }
  if (origin.startsWith('extension:')) {
    const name = origin.slice(10).replace(/-/g, ' ')
    return `the browser extension (${name})`
  }
  return null
}
