/** What F-list's own parser will complain about when the profile is saved.
 *
 *  The site runs its BBCode parser in the browser (`FList.BBParser` /
 *  `FList.TagParser` in `static.f-list.net/js/f-list.js`) and prepends a
 *  warning box to the preview. Our preview renders happily either way
 *  (it follows Horizon on purpose), so without this check the first a
 *  user hears of a problem is the live profile, after they have
 *  already left the app.
 *
 *  F-list complains about two classes of thing.
 *
 *  **Structure.** It parses an open tag's content, then takes the
 *  *first* `[/` after that content as the tag's closer. If that closer
 *  names another tag, or there is none, the whole tag, everything
 *  inside included, becomes literal text on the site, and it says
 *  "Open [x] tag is not properly closed (with [/x])." when no `[/x`
 *  follows anywhere in the enclosing range, or "Bad BBCode in [x] tag,
 *  somewhere around/after '…'." when one does. A stray extra closer
 *  draws no warning at all. A generic open/close stack disagrees with
 *  the site on blame and on cascades, so this is a port of its
 *  algorithm rather than a tag balancer.
 *
 *  **Nesting.** Each tag declares what may nest inside it, as `true`
 *  (anything), `false` (nothing) or a list:
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
 *  F-list finds structural problems while parsing and nesting problems
 *  while rendering, so its structural warnings come first, innermost
 *  first, then the nesting ones in source order. A tag it already
 *  prints as literal text is never rendered, so nothing inside it is
 *  judged for nesting.
 *
 *  Verified against the live parser rather than inferred: each case in
 *  `validate.test.ts` was run through `FList.TagParser.parseEverything`
 *  on f-list.net and matched.
 */

export type BbcodeWarningKind = 'not-allowed' | 'not-closed' | 'bad-nesting'

export type BbcodeWarning = {
  /** not-allowed: "The [x] tag is not allowed here"; not-closed: "Open
   *  [x] tag is not properly closed"; bad-nesting: "Bad BBCode in [x]
   *  tag". The last two mean F-list shows that part as plain text. */
  kind: BbcodeWarningKind
  /** The tag F-list names, without brackets. */
  tag: string
  /** Offset of that tag's opening bracket in the source. */
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

const known = (name: string) => Object.hasOwn(ALLOWED, name)

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

/** A tag that ends in its own closer. Everything else (text, and tags
 *  F-list turns into text) needs no node: only rendered tags are
 *  judged for nesting. */
type TagNode = { tag: string; start: number; content: TagNode[] }

/** F-list's first step: every bracketed thing that is not a known
 *  `[tag]` / `[/tag]` is escaped to `&#91;…&#93;`. Masking those
 *  brackets with a same-length filler gives the same parse while
 *  keeping every offset an offset into the source. */
function maskUnknownBrackets(source: string): string {
  const mask = (s: string) => s.replace(/[[\]]/g, '\u0001')
  let a = source.replace(/\[\]/g, mask)
  const tagRe = /(\[[[ /]*)([^[\]]+)([\] ]*\])/g
  for (let m = tagRe.exec(a); m !== null; m = tagRe.exec(a)) {
    const eq = m[2].indexOf('=')
    const name = eq === -1 ? m[2] : m[2].slice(0, eq)
    if ((m[1] !== '[' && m[1] !== '[/') || m[3] !== ']' || !known(name)) {
      a = a.slice(0, m.index) + mask(m[0]) + a.slice(m.index + m[0].length)
    }
  }
  return a
}

/** Every warning F-list would show for this text, in its order.
 *  Empty means the site renders it as written. */
export function validateBbcode(source: string): BbcodeWarning[] {
  const a = maskUnknownBrackets(source)
  const structural: BbcodeWarning[] = []

  // `a.substring(from, end).indexOf(s)`, as an absolute offset.
  const find = (s: string, from: number, end: number): number => {
    const i = a.substring(from, end).indexOf(s)
    return i === -1 ? -1 : i + Math.max(0, Math.min(from, end))
  }

  // Parses [n, end) into its tags. Returns them and where the parse
  // stopped: the end of the last tag, or the start of the run of text
  // that ends the range. F-list looks for a tag's closer from there.
  const parseRange = (n: number, end: number): { tags: TagNode[]; stop: number } => {
    const tags: TagNode[] = []
    for (;;) {
      const o = find('[', n, end)
      const d = o === -1 ? -1 : find(']', o, end)
      if (o === -1 || d === -1) return { tags, stop: n }
      const mm = a.substring(o + 1, d).match(/^([a-z]+)(?:=([^\]]+))?/i)
      const name = mm ? mm[1].toLowerCase() : ''
      // A closer, or anything else that is not an opening tag, ends
      // the range: the rest of it is text.
      if (!known(name)) return { tags, stop: n }
      const tag = parseTag(name, o, d, end)
      if (tag.node) tags.push(tag.node)
      if (tag.end >= end) return { tags, stop: tag.end }
      n = tag.end
    }
  }

  const parseTag = (
    name: string,
    openStart: number,
    openEnd: number,
    end: number
  ): { node: TagNode | null; end: number } => {
    if (name === 'noparse') {
      const g = find('[/noparse]', openEnd, end)
      return {
        node: { tag: name, start: openStart, content: [] },
        end: g === -1 ? end : g + 10
      }
    }
    const inner = parseRange(openEnd + 1, end)
    const v = find('[/', inner.stop, end)
    const b = v === -1 ? -1 : find(']', v, end)
    if (v !== -1 && b !== -1 && a.substring(v + 2, b) === name) {
      return { node: { tag: name, start: openStart, content: inner.tags }, end: b + 1 }
    }
    if (find('[/' + name, inner.stop, end) === -1) {
      structural.push({
        kind: 'not-closed',
        tag: name,
        start: openStart,
        message: `Open [${name}] tag is not properly closed (with [/${name}]).`
      })
    } else {
      structural.push({
        kind: 'bad-nesting',
        tag: name,
        start: openStart,
        message:
          `Bad BBCode in [${name}] tag, somewhere around/after ` +
          `'${source.substr(openEnd + 1, 50)}...'.`
      })
    }
    // The whole tag is literal text on the site, up to that closer.
    return { node: null, end: v === -1 || b === -1 ? end : b + 1 }
  }

  const notAllowed: BbcodeWarning[] = []
  const judge = (nodes: TagNode[], allowed: Allowed) => {
    for (const node of nodes) {
      if (!permits(allowed, node.tag)) {
        // F-list prints the offending tag as literal text and does not
        // look inside it.
        notAllowed.push({
          kind: 'not-allowed',
          tag: node.tag,
          start: node.start,
          message:
            `The [${node.tag}] tag is not allowed here: ` +
            `${source.substr(node.start, 60)}...`
        })
        continue
      }
      judge(node.content, newAllowed(allowed, node.tag))
    }
  }
  judge(parseRange(0, a.length).tags, true)

  return [...structural, ...notAllowed]
}
