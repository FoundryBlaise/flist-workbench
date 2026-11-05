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
 *  `validate.test.ts` and in `__fixtures__/flist_verified.json` (which
 *  the sidecar's tests read too) was run through
 *  `FList.TagParser.parseEverything` on f-list.net and matched.
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
  // F-list escapes in a loop that scans on past each match; a single
  // replace pass sees the same matches, since no escape reaches beyond
  // its own match.
  return source
    .replace(/\[\]/g, mask)
    .replace(/(\[[[ /]*)([^[\]]+)([\] ]*\])/g, (whole, open, inner, close) => {
      const eq = inner.indexOf('=')
      const name = eq === -1 ? inner : inner.slice(0, eq)
      const isTag = (open === '[' || open === '[/') && close === ']' && known(name)
      return isTag ? whole : mask(whole)
    })
}

/** A tag whose content is being parsed: F-list's recursion, made an
 *  explicit stack so a long description cannot run out of it. */
type Frame = {
  /** null for the whole text. */
  tag: string | null
  start: number
  /** The opening tag's `]`. */
  openEnd: number
  /** End of the enclosing range. */
  end: number
  /** Where the sibling scan goes on. */
  n: number
  children: TagNode[]
  /** Where the content stopped: the end of the last tag in it, or the
   *  start of the run of text that ends it. F-list looks for the tag's
   *  closer from there. */
  stop: number
  done: boolean
}

/** Every warning F-list would show for this text, in its order.
 *  Empty means the site renders it as written. */
export function validateBbcode(source: string): BbcodeWarning[] {
  const a = maskUnknownBrackets(source)
  const structural: BbcodeWarning[] = []

  // The first `s` at or after `from` that ends by `end`; Python's
  // `a.find(s, from, end)`.
  const find = (s: string, from: number, end: number): number => {
    const i = a.indexOf(s, from)
    return i === -1 || i + s.length > end ? -1 : i
  }

  // The content ends at `to`, or goes on after it.
  const advance = (frame: Frame, to: number) => {
    frame.stop = to
    if (to >= frame.end) frame.done = true
    else frame.n = to
  }

  // One step of the sibling scan: the next opening tag at or after
  // `frame.n`, or the end of the content where F-list would put it.
  const scan = (frame: Frame, stack: Frame[]) => {
    const { n, end } = frame
    const o = find('[', n, end)
    const d = o === -1 ? -1 : find(']', o, end)
    // F-list's own pattern, case-insensitive and a prefix match. Both
    // matter: a lone `[` the escape leaves alone pairs with the next
    // tag's `]`, so in `x [B [b]y` this reads "B [b" and opens a [b].
    const mm = o === -1 || d === -1 ? null : a.substring(o + 1, d).match(/^([a-z]+)(?:=([^\]]+))?/i)
    const name = mm ? mm[1].toLowerCase() : ''
    if (!known(name)) {
      // A closer, or no tag left: the rest of the content is text.
      frame.stop = n
      frame.done = true
      return
    }
    if (name === 'noparse') {
      const g = find('[/noparse]', d, end)
      frame.children.push({ tag: name, start: o, content: [] })
      advance(frame, g === -1 ? end : g + 10)
      return
    }
    stack.push({ tag: name, start: o, openEnd: d, end, n: d + 1, children: [], stop: d + 1, done: false })
  }

  // F-list's verdict on an open tag: the first `[/` after its content
  // is its closer, or the whole tag becomes text.
  const close = (frame: Frame, name: string): { node: TagNode | null; end: number } => {
    const { end, stop } = frame
    const v = find('[/', stop, end)
    const b = v === -1 ? -1 : find(']', v, end)
    if (v !== -1 && b !== -1 && a.substring(v + 2, b) === name) {
      return { node: { tag: name, start: frame.start, content: frame.children }, end: b + 1 }
    }
    if (find('[/' + name, stop, end) === -1) {
      structural.push({
        kind: 'not-closed',
        tag: name,
        start: frame.start,
        message: `Open [${name}] tag is not properly closed (with [/${name}]).`
      })
    } else {
      structural.push({
        kind: 'bad-nesting',
        tag: name,
        start: frame.start,
        message:
          `Bad BBCode in [${name}] tag, somewhere around/after ` +
          `'${source.substr(frame.openEnd + 1, 50)}...'.`
      })
    }
    // The whole tag is literal text on the site, up to that closer.
    return { node: null, end: v === -1 || b === -1 ? end : b + 1 }
  }

  const parse = (): TagNode[] => {
    const stack: Frame[] = [
      { tag: null, start: 0, openEnd: -1, end: a.length, n: 0, children: [], stop: 0, done: false }
    ]
    for (;;) {
      const frame = stack[stack.length - 1]
      if (!frame.done) {
        scan(frame, stack)
        continue
      }
      stack.pop()
      if (frame.tag === null) return frame.children
      const closed = close(frame, frame.tag)
      const parent = stack[stack.length - 1]
      if (closed.node) parent.children.push(closed.node)
      advance(parent, closed.end)
    }
  }

  // F-list's rendering pass, in source order. A tag it prints as
  // literal text has no node, so is never looked into; neither is one
  // it refuses, since it prints that as literal text too.
  const notAllowed: BbcodeWarning[] = []
  const pending: [TagNode, Allowed][] = parse()
    .reverse()
    .map((node) => [node, true])
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [node, allowed] = next
    if (!permits(allowed, node.tag)) {
      notAllowed.push({
        kind: 'not-allowed',
        tag: node.tag,
        start: node.start,
        message:
          `The [${node.tag}] tag is not allowed here: ` + `${source.substr(node.start, 60)}...`
      })
      continue
    }
    const inner = newAllowed(allowed, node.tag)
    for (let i = node.content.length - 1; i >= 0; i--) pending.push([node.content[i], inner])
  }

  return [...structural, ...notAllowed]
}
