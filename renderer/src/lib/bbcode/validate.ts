import { tokenize } from './index'

/** What F-list's own parser will complain about when the profile is saved.
 *
 *  The site runs its BBCode parser in the browser (`FList.TagParser` in
 *  `static.f-list.net/js/f-list.js`) and prepends a warning box to the
 *  preview: "The [color] tag is not allowed here: …". Our preview
 *  renders happily either way, so the first a user hears of a problem
 *  is the site refusing their upload — after they have already left
 *  the app.
 *
 *  The rules are not what you would guess. Each tag declares what may
 *  nest inside it, as `true` (anything), `false` (nothing) or a list:
 *
 *      b, i, u, s, color, quote, center, left, right, justify,
 *      indent, heading, collapse .... true
 *      noparse, url, user, icon, eicon, img ................... false
 *      sub, sup .............................. ['b', 'i', 'u']
 *      big, small ........ ['url', 'i', 'u', 'b', 'color', 's']
 *
 *  and the restriction compounds downward. The surprise is in how it
 *  compounds: F-list intersects the parent's list with the child's
 *  `allowed`, and when the child's is the boolean `true` the
 *  intersection loop iterates over a boolean and produces nothing —
 *  so the child ends up allowing *nothing at all*.
 *
 *  In practice: inside [big] you may use b/i/u/s/color/url, but only
 *  one level deep. `[big][b]X[/b][/big]` is fine, `[big][color=cyan]X
 *  [/color][/big]` is fine, and `[big][b][color=cyan]X[/color][/b]
 *  [/big]` is not — which is exactly the shape people reach for when
 *  they want a large, bold, coloured heading.
 *
 *  Verified against the live parser rather than inferred: each case in
 *  `validate.test.ts` was run through `FList.TagParser.parseEverything`
 *  on f-list.net and matched.
 */

export type BbcodeWarning = {
  /** The tag F-list will refuse, without brackets. */
  tag: string
  /** Offset of the opening bracket in the source. */
  start: number
  /** The message F-list shows, reproduced so the two agree. */
  message: string
}

type Allowed = boolean | readonly string[]

/** Mirrors F-list's tag table. Tags it does not know are left alone by
 *  its parser — no warning, rendered literally — so they are absent
 *  here too. */
const ALLOWED: Record<string, Allowed> = {
  b: true,
  i: true,
  u: true,
  s: true,
  color: true,
  quote: true,
  center: true,
  left: true,
  right: true,
  justify: true,
  indent: true,
  heading: true,
  collapse: true,
  spoiler: true,
  noparse: false,
  url: false,
  user: false,
  icon: false,
  eicon: false,
  img: false,
  sub: ['b', 'i', 'u'],
  sup: ['b', 'i', 'u'],
  big: ['url', 'i', 'u', 'b', 'color', 's'],
  small: ['url', 'i', 'u', 'b', 'color', 's']
}

/** F-list's `newAllowed`, boolean-versus-list quirk included. Removing
 *  the quirk would make us disagree with the site, which is the one
 *  thing this must not do. */
function newAllowed(outer: Allowed, tag: string): Allowed {
  const inner = ALLOWED[tag]
  if (inner === undefined) return outer
  if (outer === true && inner === true) return true
  if (outer === false) return false
  if (inner === true || inner === false) {
    // `for (i of true)` yields nothing on their side; the intersection
    // comes back empty and empty means false.
    return outer === true ? inner : false
  }
  const keep = inner.filter((name) => outer === true || outer.includes(name))
  return keep.length === 0 ? false : keep
}

function permits(outer: Allowed, tag: string): boolean {
  if (outer === true) return true
  if (outer === false) return false
  return outer.includes(tag)
}

/** Every tag F-list would reject, in source order. Empty means the
 *  site will take it. */
export function validateBbcode(source: string): BbcodeWarning[] {
  const warnings: BbcodeWarning[] = []
  const stack: { tag: string; allowed: Allowed }[] = []
  let allowed: Allowed = true
  let inNoparse = false

  for (const tok of tokenize(source)) {
    if (inNoparse) {
      if (tok.type === 'close' && tok.name === 'noparse') inNoparse = false
      continue
    }
    if (tok.type === 'text') continue

    const name = (tok.name || '').toLowerCase()
    if (tok.type === 'close') {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === name) {
          allowed = stack[i].allowed
          stack.length = i
          break
        }
      }
      continue
    }

    // `self` covers [hr] and the like: nothing nests inside, but the
    // tag itself still has to be permitted where it stands.
    if (ALLOWED[name] !== undefined && !permits(allowed, name)) {
      warnings.push({
        tag: name,
        start: tok.start,
        message:
          `The [${name}] tag is not allowed here: ` +
          `${source.substr(tok.start, 60)}...`
      })
      // F-list renders the offending tag as literal text and carries
      // on with the same restriction in force, so we do too.
      continue
    }
    if (tok.type === 'self') continue
    if (name === 'noparse') {
      inNoparse = true
      continue
    }
    stack.push({ tag: name, allowed })
    allowed = newAllowed(allowed, name)
  }

  return warnings
}
