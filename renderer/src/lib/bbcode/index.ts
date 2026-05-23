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
  sub: 'sub',
  sup: 'sup',
  big: 'span class="bb-big"',
  small: 'span class="bb-small"',
  heading: 'h2',
  quote: 'blockquote',
  center: 'div class="bb-center"',
  indent: 'div class="bb-indent"',
  noparse: '__noparse__'
}

const SIMPLE_INLINE_NAMES = new Set(Object.keys(SIMPLE_INLINE))

const CDN_AVATAR = 'https://static.f-list.net/images/avatar/'
const CDN_EICON = 'https://static.f-list.net/images/eicon/'
const CDN_GALLERY = 'https://static.f-list.net/images/charimage/'

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

function galleryImageUrl(id: string): string {
  return CDN_GALLERY + encodeURIComponent(id) + '.png'
}

type Token =
  | { type: 'text'; value: string }
  | { type: 'open'; name: string; attr: string | null; raw: string }
  | { type: 'close'; name: string; raw: string }
  | { type: 'self'; name: string; attr: string | null; raw: string }

const TAG_RE = /\[(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:=([^\]]*))?\]/g

const SELF_CLOSING = new Set(['hr', 'br'])

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let lastIndex = 0
  for (const match of source.matchAll(TAG_RE)) {
    const start = match.index ?? 0
    if (start > lastIndex) {
      tokens.push({ type: 'text', value: source.slice(lastIndex, start) })
    }
    const [raw, slash, rawName, attr] = match
    const name = rawName.toLowerCase()
    if (SELF_CLOSING.has(name)) {
      tokens.push({ type: 'self', name, attr: attr ?? null, raw })
    } else if (slash) {
      tokens.push({ type: 'close', name, raw })
    } else {
      tokens.push({ type: 'open', name, attr: attr ?? null, raw })
    }
    lastIndex = start + raw.length
  }
  if (lastIndex < source.length) {
    tokens.push({ type: 'text', value: source.slice(lastIndex) })
  }
  return tokens
}

interface Frame {
  name: string
  attr: string | null
  raw: string
  children: string[]
}

function emit(frame: Frame): string {
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
    case 'spoiler':
      return `<span class="bb-spoiler" tabindex="0">${body}</span>`
    case 'collapse': {
      const label = frame.attr ?? 'Show'
      return `<details class="bb-collapse"><summary>${escapeHtml(label)}</summary>${body}</details>`
    }
    case 'icon': {
      const name = stripTags(body).trim()
      if (!name) return ''
      return `<a class="bb-icon" href="https://www.f-list.net/c/${escapeAttr(encodeURIComponent(name))}" target="_blank" rel="noreferrer noopener"><img src="${escapeAttr(characterAvatarUrl(name))}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}" /></a>`
    }
    case 'eicon': {
      const name = stripTags(body).trim()
      if (!name) return ''
      return `<img class="bb-eicon" src="${escapeAttr(eiconUrl(name))}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}" />`
    }
    case 'img': {
      // [img=12345]optional alt[/img] — F-list inline gallery image
      const id = (frame.attr ?? '').trim()
      if (!/^\d+$/.test(id)) return escapeHtml(frame.raw) + body + `[/img]`
      const alt = stripTags(body).trim() || `gallery image ${id}`
      return `<img class="bb-img" src="${escapeAttr(galleryImageUrl(id))}" alt="${escapeHtml(alt)}" />`
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
  'spoiler',
  'collapse',
  'icon',
  'eicon',
  'img',
  'hr',
  'br'
])

export function bbcodeToHtml(source: string): string {
  const root: Frame = { name: '__root__', attr: null, raw: '', children: [] }
  const stack: Frame[] = [root]
  const top = (): Frame => stack[stack.length - 1]

  const tokens = tokenize(source)
  let inNoparse = false

  for (const tok of tokens) {
    if (inNoparse) {
      if (tok.type === 'close' && tok.name === 'noparse') {
        const frame = stack.pop()!
        top().children.push(emit(frame))
        inNoparse = false
      } else {
        // Inside [noparse]: everything renders as escaped text.
        top().children.push(escapeHtml(tok.type === 'text' ? tok.value : tok.raw))
      }
      continue
    }

    if (tok.type === 'text') {
      top().children.push(escapeHtml(tok.value).replace(/\n/g, '<br />\n'))
    } else if (tok.type === 'self') {
      top().children.push(emitSelfClosing(tok.name))
    } else if (tok.type === 'open') {
      if (!ALL_KNOWN_NAMES.has(tok.name)) {
        top().children.push(escapeHtml(tok.raw))
        continue
      }
      stack.push({ name: tok.name, attr: tok.attr, raw: tok.raw, children: [] })
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
        top().children.push(emit(frame))
      }
      const frame = stack.pop()!
      top().children.push(emit(frame))
    }
  }

  while (stack.length > 1) {
    const frame = stack.pop()!
    top().children.push(emit(frame))
  }

  return root.children.join('')
}
