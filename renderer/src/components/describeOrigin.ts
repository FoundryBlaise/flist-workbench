import { parseOrigin } from '../state/commit'

/** Who wrote a Workbench, from the origin its change event carried:
 *  "mcp:set_description" reads better as "a connected model —
 *  set_description". An unattributed change says nothing. The
 *  internal:/extension: origins are the sidecar's attribution of the
 *  maintenance writes (gallery repair, image-id folding) that rewrite a
 *  Workbench without anyone clicking anything; naming them is what keeps
 *  a change from outside the editor from being a mystery. */
export function describeOrigin(origin: string): string | null {
  const parsed = parseOrigin(origin)
  if (!parsed) return null
  const { writer, name } = parsed
  switch (writer) {
    case 'mcp':
      return name ? `a connected model — ${name}` : 'a connected model'
    case 'internal':
      return `a maintenance pass in the app (${name.replace(/-/g, ' ')})`
    case 'extension':
      return `the browser extension (${name.replace(/-/g, ' ')})`
  }
}
