/**
 * F-list BBCode → HTML transformer.
 *
 * F-list ships its own BBCode dialect — same surface as most others but
 * with two custom inline tags (`[icon]`, `[eicon]`) plus `[img=ID]` for
 * inline gallery images, and named-only colour values.
 *
 * The transformer is intentionally permissive: malformed input renders
 * as close to F-list's own behaviour as we can manage (unknown tags
 * pass through as literal text, unclosed tags auto-close at end of
 * input). It is *strictly* not permissive about HTML injection — every
 * piece of user text gets escaped, attribute values are validated
 * against allowlists, and URLs must start with `http(s):` or be one of
 * the inline image forms.
 *
 * The tag handling here follows the Horizon Client — the community F-Chat
 * 3.0 client (https://github.com/Fchat-Horizon/Horizon, Mozilla Public
 * License 2.0). Only the decisions are ported (tag behaviour, element
 * shapes), not their source code; matching values and CSS live on in
 * app.css under the same intent.
 */

const NAMED_COLORS = new Set([
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'purple',
  'pink',
  'black',
  'brown',
  'white',
  'gray'
])

const SIMPLE_INLINE: Record<string, string> = {
  b: 'strong',
  i: 'em',
  u: 'u',
  s: 's',
  sub: 'span class="bb-sub"',
  sup: 'span class="bb-sup"',
  big: 'span class="bb-big"',
  small: 'span class="bb-small"',
  heading: 'h2 class="bb-heading"',
  center: 'div class="bb-center"',
  left: 'div class="bb-left"',
  right: 'div class="bb-right"',
  justify: 'div class="bb-justify"',
  indent: 'div class="bb-indent"',
  noparse: '__noparse__'
}

const SIMPLE_INLINE_NAMES = new Set(Object.keys(SIMPLE_INLINE))

const CDN_AVATAR = 'https://static.f-list.net/images/avatar/'
const CDN_EICON = 'https://static.f-list.net/images/eicon/'
const CDN_INLINE = 'https://static.f-list.net/images/charinline/'

export interface InlineImage {
  hash: string
  extension: string
  nsfw: boolean
}
export type InlinesManifest = Record<string, InlineImage>

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E')
}

function isSafeUrl(url: string): boolean {
  // Reject anything that doesn't parse as a clean http(s) URL. The
  // URL constructor handles all the variants we care about; the only
  // way past it is via http: or https: with no embedded whitespace.
  if (/\s/.test(url)) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function characterAvatarUrl(name: string): string {
  return CDN_AVATAR + encodeURIComponent(name.toLowerCase()).replace(/%20/g, ' ') + '.png'
}

function eiconUrl(name: string): string {
  return CDN_EICON + encodeURIComponent(name.toLowerCase()).replace(/%20/g, ' ') + '.gif'
}

function inlineImageUrl(inline: InlineImage): string {
  // F-list's content-addressed CDN scheme: shard by the first two hex
  // bytes of the hash, then file by full hash + extension.
  const p1 = inline.hash.slice(0, 2)
  const p2 = inline.hash.slice(2, 4)
  return `${CDN_INLINE}${p1}/${p2}/${encodeURIComponent(inline.hash)}.${encodeURIComponent(inline.extension)}`
}

// `start` is the offset of the opening bracket. Tag tokens carry it so
// a caller can quote the source around a tag — the validator reports
// the same excerpt F-list does.
export type Token =
  | { type: 'text'; value: string; start: number; end: number }
  | { type: 'open'; name: string; attr: string | null; raw: string; start: number }
  | { type: 'close'; name: string; raw: string; start: number }
  | { type: 'self'; name: string; attr: string | null; raw: string; start: number }

const TAG_RE = /\[(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:=([^\]]*))?\]/g

const SELF_CLOSING = new Set(['hr', 'br'])

export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let lastIndex = 0
  for (const match of source.matchAll(TAG_RE)) {
    const start = match.index ?? 0
    if (start > lastIndex) {
      tokens.push({
        type: 'text',
        value: source.slice(lastIndex, start),
        start: lastIndex,
        end: start
      })
    }
    const [raw, slash, rawName, attr] = match
    const name = rawName.toLowerCase()
    if (SELF_CLOSING.has(name)) {
      tokens.push({ type: 'self', name, attr: attr ?? null, raw, start })
    } else if (slash) {
      tokens.push({ type: 'close', name, raw, start })
    } else {
      tokens.push({ type: 'open', name, attr: attr ?? null, raw, start })
    }
    lastIndex = start + raw.length
  }
  if (lastIndex < source.length) {
    tokens.push({
      type: 'text',
      value: source.slice(lastIndex),
      start: lastIndex,
      end: source.length
    })
  }
  return tokens
}

interface Frame {
  name: string
  attr: string | null
  raw: string
  children: string[]
  // Source offsets: of the opening tag's bracket, and just past the
  // closing tag (unset when the tag is auto-closed).
  start: number
  end?: number
}

/**
 * Where an image's tag sits in the source, so text typed beside the
 * image in the preview can be put back next to it (see
 * textBesideImages).
 */
function imageAnchor(frame: Frame, opts: BbcodeOptions): string {
  if (!opts.withSourceMap) return ''
  const after = frame.end === undefined ? '' : ` data-bb-after="${frame.end}"`
  return ` data-bb-before="${frame.start}"${after}`
}

function emit(frame: Frame, opts: BbcodeOptions = {}): string {
  const body = frame.children.join('')
  switch (frame.name) {
    case 'noparse':
      return body
    case 'color': {
      const c = (frame.attr ?? '').toLowerCase().trim()
      if (!c || !NAMED_COLORS.has(c)) return escapeHtml(frame.raw) + body + `[/color]`
      return `<span class="bb-color bb-color-${c}">${body}</span>`
    }
    case 'url': {
      const target = frame.attr ?? body
      if (!isSafeUrl(target)) return escapeHtml(frame.raw) + body + `[/url]`
      return `<a class="bb-url" href="${escapeAttr(target)}" target="_blank" rel="noreferrer noopener">${body}</a>`
    }
    case 'quote':
      // Horizon-style: a blockquote carrying a "Quote:" header strip that
      // is styled (bordered, uppercased) rather than an inline bold label.
      return `<blockquote class="bb-quote"><div class="bb-quote-header">Quote:</div>${body}</blockquote>`
    case 'user': {
      const name = stripTags(body).trim()
      if (!name) return ''
      return `<a class="bb-user" href="https://www.f-list.net/c/${escapeAttr(encodeURIComponent(name))}" target="_blank" rel="noreferrer noopener">${escapeHtml(name)}</a>`
    }
    case 'spoiler':
      return `<span class="bb-spoiler" tabindex="0">${body}</span>`
    case 'collapse': {
      const label = (frame.attr ?? '').trim() || 'Show'
      // F-Chat 3.0 renders this as a bordered card with a header strip
      // and a clipped body. We mirror that with <details>, but the
      // preview pane is contentEditable so the native summary-click
      // toggle is swallowed. contenteditable="false" on the summary
      // restores native click behaviour without breaking editing in
      // the surrounding text.
      return `<details class="bb-collapse"><summary class="bb-collapse-header" contenteditable="false"><span class="bb-collapse-chevron"></span>${escapeHtml(label)}</summary><div class="bb-collapse-body">${body}</div></details>`
    }
    case 'icon': {
      const name = stripTags(body).trim()
      if (!name) return ''
      return `<a class="bb-icon"${imageAnchor(frame, opts)} href="https://www.f-list.net/c/${escapeAttr(encodeURIComponent(name))}" target="_blank" rel="noreferrer noopener"><img src="${escapeAttr(characterAvatarUrl(name))}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}" /></a>`
    }
    case 'eicon': {
      const name = stripTags(body).trim()
      if (!name) return ''
      return `<img class="bb-eicon"${imageAnchor(frame, opts)} src="${escapeAttr(eiconUrl(name))}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}" />`
    }
    case 'img': {
      // [img=12345]optional alt[/img] — F-list inline gallery image,
      // resolved via the per-character inlines manifest.
      const id = (frame.attr ?? '').trim()
      if (!/^\d+$/.test(id)) return escapeHtml(frame.raw) + body + `[/img]`
      const inline = opts.inlines?.[id]
      if (!inline) {
        // No manifest entry — render a placeholder rather than guessing.
        const alt = stripTags(body).trim() || `inline ${id}`
        return `<span class="bb-img bb-img-missing"${imageAnchor(frame, opts)} title="No manifest entry for inline ${escapeHtml(id)}">[Inline ${escapeHtml(alt)}]</span>`
      }
      const alt = stripTags(body).trim() || `inline ${id}`
      return `<img class="bb-img"${imageAnchor(frame, opts)} src="${escapeAttr(inlineImageUrl(inline))}" alt="${escapeHtml(alt)}" />`
    }
    case 'row':
      return `<div class="bb-row">${body}</div>`
    case 'col': {
      // Horizon's [col=n] widths: 1 → narrowest, 3 → widest; an
      // unrecognised parameter shares the row space instead of failing.
      const n = (frame.attr ?? '').trim()
      if (n === '1' || n === '2' || n === '3') return `<div class="bb-col-${n}">${body}</div>`
      return `<div class="bb-col">${body}</div>`
    }
    default: {
      const wrap = SIMPLE_INLINE[frame.name]
      if (!wrap) {
        // Unknown — pass through literally.
        return escapeHtml(frame.raw) + body + `[/${frame.name}]`
      }
      const closeTag = wrap.split(' ')[0]
      return `<${wrap}>${body}</${closeTag}>`
    }
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

function emitSelfClosing(name: string): string {
  if (name === 'hr') return '<hr class="bb-hr" />'
  if (name === 'br') return '<br />'
  return ''
}

const ALL_KNOWN_NAMES = new Set<string>([
  ...SIMPLE_INLINE_NAMES,
  'color',
  'url',
  'quote',
  'user',
  'spoiler',
  'collapse',
  'icon',
  'eicon',
  'img',
  'hr',
  'br',
  'row',
  'col'
])

/**
 * Rebuild BBCode source from the live preview DOM after the user has
 * edited it inline. The transformer must have emitted with
 * `withSourceMap: true` so each visible text segment carries its
 * original source range as `data-bb-start` / `data-bb-end`.
 *
 * Strategy: walk the DOM in document order, collect every span with a
 * source range, then stitch:
 *   - source[0..firstSpan.start]                  (BBCode tags before first text)
 *   - currentText(firstSpan)
 *   - source[firstSpan.end..secondSpan.start]    (BBCode tags between)
 *   - currentText(secondSpan)
 *   - …
 *   - source[lastSpan.end..]                     (trailing BBCode tags)
 *
 * Spans that the user fully deleted from the DOM simply don't appear,
 * so their source range gets elided — which matches the user's intent.
 */
/**
 * Tags that consume their inner text rather than rendering it as an
 * editable run in the preview. `[icon]Name[/icon]` becomes an <img>,
 * `[noparse]…[/noparse]` is rendered as literal escaped text without
 * a data-bb span. We need to tell "user deleted the span" apart from
 * "the span was never editable" when reversing edits.
 */
const CONSUMING_TAGS = new Set(['icon', 'eicon', 'img', 'noparse'])

function computeEditableTextStarts(source: string): Set<number> {
  const tokens = tokenize(source)
  const editable = new Set<number>()
  const stack: string[] = []
  for (const tok of tokens) {
    if (tok.type === 'text') {
      const insideConsuming = stack.some((name) => CONSUMING_TAGS.has(name))
      if (!insideConsuming) editable.add(tok.start)
    } else if (tok.type === 'open') {
      stack.push(tok.name)
    } else if (tok.type === 'close') {
      const idx = stack.lastIndexOf(tok.name)
      if (idx !== -1) stack.splice(idx)
    }
  }
  return editable
}

function isBareText(n: Node | null): n is Text {
  return n !== null && n.nodeType === 3
}

/**
 * Text typed right next to an image ([icon], [eicon], [img]). Chromium
 * puts it in a bare text node beside the <img> (or inside the icon's
 * link), outside every source-mapped span, so the span walk never sees
 * it. Returns it keyed by the source offset it belongs at: just past
 * the image's closing tag, or at its opening tag when typed before it.
 *
 * A side where the render itself put bare text (an unknown tag's
 * literal, say) is left alone: that text is the render's, not the
 * user's, and copying it would duplicate it in the source.
 */
function textBesideImages(root: HTMLElement, originalSource: string): Map<number, string> {
  const fresh = root.ownerDocument.createElement('div')
  fresh.innerHTML = bbcodeToHtml(originalSource, { withSourceMap: true })
  const renderedBare = new Set<string>()
  for (const el of fresh.querySelectorAll<HTMLElement>('[data-bb-before]')) {
    if (isBareText(el.previousSibling)) renderedBare.add(`before:${el.dataset.bbBefore}`)
    if (isBareText(el.nextSibling)) renderedBare.add(`after:${el.dataset.bbAfter}`)
  }

  const taken = new Set<Node>()
  const inserted = new Map<number, string>()
  const take = (offset: number, nodes: Text[]) => {
    let text = ''
    for (const n of nodes) {
      if (taken.has(n)) continue
      taken.add(n)
      text += n.nodeValue ?? ''
    }
    if (text) inserted.set(offset, (inserted.get(offset) ?? '') + text)
  }
  const images = Array.from(root.querySelectorAll<HTMLElement>('[data-bb-before]'))
  // Text after one image and before the next sits at the same offset;
  // afters first keeps it in document order.
  for (const el of images) {
    const after = el.dataset.bbAfter
    if (after === undefined || renderedBare.has(`after:${after}`)) continue
    const nodes: Text[] = []
    if (el.tagName === 'A') for (const c of el.childNodes) if (isBareText(c)) nodes.push(c)
    for (let n = el.nextSibling; isBareText(n); n = n.nextSibling) nodes.push(n)
    take(Number(after), nodes)
  }
  for (const el of images) {
    const before = el.dataset.bbBefore!
    if (renderedBare.has(`before:${before}`)) continue
    const nodes: Text[] = []
    for (let n = el.previousSibling; isBareText(n); n = n.previousSibling) nodes.unshift(n)
    take(Number(before), nodes)
  }
  return inserted
}

export function bbcodeFromPreviewDom(root: HTMLElement, originalSource: string): string {
  const editableStarts = computeEditableTextStarts(originalSource)
  const besideImages = textBesideImages(root, originalSource)
  const currentBySrcStart = new Map<number, string>()
  for (const span of root.querySelectorAll<HTMLElement>('[data-bb-start]')) {
    const start = Number(span.getAttribute('data-bb-start'))
    if (!Number.isFinite(start)) continue
    // Two spans with one start are halves of a span the browser split
    // into separate blocks (a paragraph break): keep both, joined by
    // the newline the split stands for.
    const text = domTextWithBreaks(span)
    const earlier = currentBySrcStart.get(start)
    currentBySrcStart.set(start, earlier === undefined ? text : `${earlier}\n${text}`)
  }

  // Walk the ORIGINAL token stream. For each text token:
  //   - If it was editable and its span is in the DOM, use current text.
  //   - If it was editable and the span is gone, emit nothing (user deleted).
  //   - If it wasn't editable (inside [icon] / [noparse] / etc.), keep the
  //     original text — it never had an editable surface to begin with.
  // Tag tokens always pass through verbatim. Text typed beside an image
  // goes in before the token at its offset.
  const tokens = tokenize(originalSource)
  let out = ''
  for (const tok of tokens) {
    out += besideImages.get(tok.start) ?? ''
    if (tok.type === 'text') {
      if (editableStarts.has(tok.start)) {
        out += currentBySrcStart.get(tok.start) ?? ''
      } else {
        out += tok.value
      }
    } else {
      out += tok.raw
    }
  }
  return out + (besideImages.get(originalSource.length) ?? '')
}

function domTextWithBreaks(el: HTMLElement): string {
  // <br> elements become \n; everything else is read from text nodes.
  let out = ''
  const walker = el.ownerDocument!.createTreeWalker(el, NodeFilter.SHOW_ALL)
  let n: Node | null = walker.currentNode
  while ((n = walker.nextNode())) {
    if (n.nodeType === 3) {
      out += n.nodeValue ?? ''
    } else if ((n as Element).tagName === 'BR') {
      out += '\n'
    }
  }
  return out
}

export interface BbcodeOptions {
  /**
   * When true, every text segment from source is wrapped in
   *   <span data-bb-start="N" data-bb-end="M">…</span>
   * so a contentEditable preview can be diff-mapped back to source
   * offsets. The tag tokens themselves (open / close / self-closing)
   * keep their existing markup — they have no editable surface in the
   * preview.
   */
  withSourceMap?: boolean
  /**
   * Per-character inline-image manifest. F-list stores inline images on
   * a content-addressed CDN: each `[img=ID]` tag's numeric id resolves
   * to a hash+extension that we need to build the URL. Profiles fetched
   * via /profile/<name> bring this manifest with them.
   */
  inlines?: InlinesManifest
}

export function bbcodeToHtml(source: string, opts: BbcodeOptions = {}): string {
  const root: Frame = { name: '__root__', attr: null, raw: '', children: [], start: 0 }
  const stack: Frame[] = [root]
  const top = (): Frame => stack[stack.length - 1]

  const tokens = tokenize(source)
  let inNoparse = false

  const wrapText = (value: string, start: number, end: number): string => {
    // We rely on `white-space: pre-wrap` in the preview CSS so source
    // newlines render as line breaks without an HTML <br> getting in
    // the way of bidirectional source mapping. F-list does the same.
    const inner = escapeHtml(value)
    if (!opts.withSourceMap) return inner
    return `<span data-bb-start="${start}" data-bb-end="${end}">${inner}</span>`
  }

  for (const tok of tokens) {
    if (inNoparse) {
      if (tok.type === 'close' && tok.name === 'noparse') {
        const frame = stack.pop()!
        top().children.push(emit(frame, opts))
        inNoparse = false
      } else {
        // Inside [noparse]: everything renders as escaped text.
        top().children.push(escapeHtml(tok.type === 'text' ? tok.value : tok.raw))
      }
      continue
    }

    if (tok.type === 'text') {
      top().children.push(wrapText(tok.value, tok.start, tok.end))
    } else if (tok.type === 'self') {
      top().children.push(emitSelfClosing(tok.name))
    } else if (tok.type === 'open') {
      if (!ALL_KNOWN_NAMES.has(tok.name)) {
        top().children.push(escapeHtml(tok.raw))
        continue
      }
      stack.push({ name: tok.name, attr: tok.attr, raw: tok.raw, children: [], start: tok.start })
      if (tok.name === 'noparse') inNoparse = true
    } else {
      // close
      // Find the matching open in the stack; auto-close anything above it.
      let depth = -1
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === tok.name) {
          depth = i
          break
        }
      }
      if (depth === -1) {
        // Stray close — no matching open in the stack. Drop it
        // silently; this matches the way F-list's own renderer
        // forgives mismatched closing tags.
        continue
      }
      while (stack.length - 1 > depth) {
        const frame = stack.pop()!
        top().children.push(emit(frame, opts))
      }
      const frame = stack.pop()!
      frame.end = tok.start + tok.raw.length
      top().children.push(emit(frame, opts))
    }
  }

  while (stack.length > 1) {
    const frame = stack.pop()!
    top().children.push(emit(frame, opts))
  }

  return root.children.join('')
}
