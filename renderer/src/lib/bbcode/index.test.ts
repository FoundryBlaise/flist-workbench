import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bbcodeToHtml, bbcodeFromPreviewDom } from './index'

describe('bbcodeToHtml — simple inline tags', () => {
  it('renders bold, italic, underline, strikethrough', () => {
    expect(bbcodeToHtml('[b]bold[/b]')).toBe('<strong>bold</strong>')
    expect(bbcodeToHtml('[i]em[/i]')).toBe('<em>em</em>')
    expect(bbcodeToHtml('[u]u[/u]')).toBe('<u>u</u>')
    expect(bbcodeToHtml('[s]s[/s]')).toBe('<s>s</s>')
  })

  it('handles tag case-insensitively', () => {
    expect(bbcodeToHtml('[B]Bold[/B]')).toBe('<strong>Bold</strong>')
  })

  it('nests inline tags', () => {
    expect(bbcodeToHtml('[b][i]bi[/i][/b]')).toBe('<strong><em>bi</em></strong>')
  })

  it('auto-closes when nesting overlaps the wrong way', () => {
    // [b][i]xx[/b][/i]  should auto-close [i] when [/b] arrives.
    const out = bbcodeToHtml('[b][i]xx[/b][/i]')
    expect(out).toBe('<strong><em>xx</em></strong>')
  })
})

describe('bbcodeToHtml — block tags and structure', () => {
  it('renders headings, quotes, center, indent', () => {
    expect(bbcodeToHtml('[heading]H[/heading]')).toBe('<div class="bb-heading">H</div>')
    expect(bbcodeToHtml('[quote]Q[/quote]')).toBe('<div class="bb-quote"><b>Quote:</b><br />Q</div>')
    expect(bbcodeToHtml('[center]C[/center]')).toBe('<div class="bb-center">C</div>')
    expect(bbcodeToHtml('[indent]I[/indent]')).toBe('<div class="bb-indent">I</div>')
  })

  it('renders left, right, and justify alignment blocks', () => {
    expect(bbcodeToHtml('[left]L[/left]')).toBe('<div class="bb-left">L</div>')
    expect(bbcodeToHtml('[right]R[/right]')).toBe('<div class="bb-right">R</div>')
    expect(bbcodeToHtml('[justify]J[/justify]')).toBe('<div class="bb-justify">J</div>')
  })

  it('renders [user] as a link to the F-list profile', () => {
    const out = bbcodeToHtml('[user]Azure Viper[/user]')
    expect(out).toContain('href="https://www.f-list.net/c/Azure%20Viper"')
    expect(out).toContain('class="bb-user"')
    expect(out).toContain('Azure Viper')
  })

  it('renders hr standalone', () => {
    expect(bbcodeToHtml('a[hr]b')).toBe('a<hr class="bb-hr" />b')
  })

  it('renders collapse as a card with header and clipped body', () => {
    const out = bbcodeToHtml('[collapse=Show me]hidden[/collapse]')
    expect(out).toContain('class="bb-collapse"')
    expect(out).toContain('class="bb-collapse-header"')
    expect(out).toContain('Show me')
    expect(out).toContain('class="bb-collapse-body"')
    expect(out).toContain('hidden')
  })

  it('keeps newlines as literal text (pre-wrap handles them)', () => {
    // Preview pane sets white-space: pre-wrap, so source newlines render
    // as line breaks without an HTML <br> getting in the way of source
    // mapping during bidirectional editing.
    expect(bbcodeToHtml('line1\nline2')).toBe('line1\nline2')
  })
})

describe('bbcodeToHtml — colors are allowlisted', () => {
  it('renders named colors', () => {
    expect(bbcodeToHtml('[color=red]r[/color]')).toBe(
      '<span class="bb-color bb-color-red">r</span>'
    )
  })

  it('passes through unknown colors as literal text', () => {
    const out = bbcodeToHtml('[color=#fff]x[/color]')
    expect(out).toContain('[color=#fff]')
    expect(out).toContain('x')
  })
})

describe('bbcodeToHtml — URL safety', () => {
  it('renders http and https links', () => {
    const out = bbcodeToHtml('[url=https://f-list.net]F-list[/url]')
    expect(out).toContain('href="https://f-list.net"')
    expect(out).toContain('rel="noreferrer noopener"')
  })

  it('rejects javascript: URLs (no anchor is generated)', () => {
    const out = bbcodeToHtml('[url=javascript:alert(1)]nope[/url]')
    expect(out).not.toContain('<a')
    expect(out).not.toContain('href=')
  })

  it('rejects data: URLs (no anchor is generated)', () => {
    const out = bbcodeToHtml('[url=data:text/html,x]nope[/url]')
    expect(out).not.toContain('<a')
    expect(out).not.toContain('href=')
  })

  it('rejects URLs with whitespace', () => {
    const out = bbcodeToHtml('[url=https://x.com/path with spaces]nope[/url]')
    expect(out).not.toContain('<a')
  })
})

describe('bbcodeToHtml — F-list custom inline tags', () => {
  it('renders [icon] using the avatar CDN', () => {
    const out = bbcodeToHtml('[icon]Auldren Nadir[/icon]')
    expect(out).toContain('https://static.f-list.net/images/avatar/auldren nadir.png')
    expect(out).toContain('alt="Auldren Nadir"')
  })

  it('renders [eicon] using the eicon CDN', () => {
    const out = bbcodeToHtml('[eicon]smirk[/eicon]')
    expect(out).toContain('https://static.f-list.net/images/eicon/smirk.gif')
  })

  it('renders [img=ID] gallery images and rejects non-numeric ids', () => {
    const ok = bbcodeToHtml('[img=3338463]inline[/img]')
    expect(ok).toContain('https://static.f-list.net/images/charimage/3338463.png')

    const bad = bbcodeToHtml('[img=evil]inline[/img]')
    expect(bad).toContain('[img=evil]')
    expect(bad).not.toContain('charimage/evil')
  })
})

describe('bbcodeToHtml — security and noparse', () => {
  it('escapes raw HTML in text', () => {
    expect(bbcodeToHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;'
    )
  })

  it('quote-injection in url attribute cannot break out of href', () => {
    const out = bbcodeToHtml('[url=https://x.com/" onclick="evil]bad[/url]')
    // URL is rejected by isSafeUrl because of whitespace, so no anchor.
    expect(out).not.toContain('<a')
  })

  it('preserves [noparse] contents literally and escaped', () => {
    const out = bbcodeToHtml('[noparse][b]not bold[/b][/noparse]')
    expect(out).toBe('[b]not bold[/b]')
  })

  it('passes unknown tags through as literal text', () => {
    expect(bbcodeToHtml('[unknowntag]x[/unknowntag]')).toContain('[unknowntag]')
  })

  it('handles unbalanced opens by auto-closing at end', () => {
    expect(bbcodeToHtml('[b]forever bold')).toBe('<strong>forever bold</strong>')
  })

  it('drops stray close tags silently', () => {
    expect(bbcodeToHtml('hello[/b]world')).toBe('helloworld')
  })
})

describe('bbcodeToHtml — real F-list profile round-trip', () => {
  // Real character profile pulled from F-list and saved as a fixture so
  // this test runs offline. The transformer must survive it intact, and
  // produce no leftover BBCode brackets in the output.
  const bbcode = readFileSync(
    resolve(__dirname, '__fixtures__/azure_viper.bbcode'),
    'utf-8'
  )

  it('produces non-empty HTML', () => {
    const html = bbcodeToHtml(bbcode)
    expect(html.length).toBeGreaterThan(bbcode.length / 2)
  })

  it('renders block tags found in real content', () => {
    const html = bbcodeToHtml(bbcode)
    expect(html).toContain('<hr')
    expect(html).toContain('bb-center')
    expect(html).toContain('bb-indent')
    expect(html).toContain('<strong>')
  })

  it('does not leak BBCode brackets for known tags', () => {
    const html = bbcodeToHtml(bbcode)
    // The fixture contains [hr] [b] [center] [indent] [img=…]. None of
    // those should survive as literal text after rendering.
    expect(html).not.toMatch(/\[hr]/)
    expect(html).not.toMatch(/\[\/?b]/)
    expect(html).not.toMatch(/\[\/?center]/)
    expect(html).not.toMatch(/\[\/?indent]/)
  })

  it('inline gallery [img=ID] maps to the F-list image CDN', () => {
    const html = bbcodeToHtml(bbcode)
    expect(html).toContain('static.f-list.net/images/charimage/')
  })
})

describe('bbcodeToHtml — source map for bidirectional editing', () => {
  it('wraps each text segment in a data-bb span when requested', () => {
    const html = bbcodeToHtml('[b]hello[/b] world', { withSourceMap: true })
    // First text "hello" is at source offset 3..8.
    expect(html).toContain('data-bb-start="3"')
    expect(html).toContain('data-bb-end="8"')
    // Trailing " world" is at 12..18.
    expect(html).toContain('data-bb-start="12"')
    expect(html).toContain('data-bb-end="18"')
  })

  it('does not wrap when withSourceMap is omitted', () => {
    const html = bbcodeToHtml('[b]hello[/b] world')
    expect(html).not.toContain('data-bb-start')
  })
})

function renderToDom(source: string): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = bbcodeToHtml(source, { withSourceMap: true })
  return div
}

describe('bbcodeFromPreviewDom — reverse mapping', () => {
  it('round-trips an unedited render back to the original source', () => {
    const source = '[b]hello[/b] [i]world[/i]'
    const dom = renderToDom(source)
    expect(bbcodeFromPreviewDom(dom, source)).toBe(source)
  })

  it('reflects an in-place text edit into the source', () => {
    const source = '[b]hello[/b] world'
    const dom = renderToDom(source)
    // Edit the "hello" text node to "HELLO".
    const span = dom.querySelector('[data-bb-start="3"]') as HTMLElement
    span.textContent = 'HELLO'
    expect(bbcodeFromPreviewDom(dom, source)).toBe('[b]HELLO[/b] world')
  })

  it('reflects edits to multiple text spans simultaneously', () => {
    const source = '[b]hello[/b] world'
    const dom = renderToDom(source)
    ;(dom.querySelector('[data-bb-start="3"]') as HTMLElement).textContent = 'HI'
    ;(dom.querySelector('[data-bb-start="12"]') as HTMLElement).textContent = ' there'
    expect(bbcodeFromPreviewDom(dom, source)).toBe('[b]HI[/b] there')
  })

  it('treats a deleted span as deletion of that text', () => {
    const source = 'before [b]middle[/b] after'
    const dom = renderToDom(source)
    // Remove the middle span entirely.
    const span = dom.querySelector('[data-bb-start="10"]')
    span?.remove()
    expect(bbcodeFromPreviewDom(dom, source)).toBe('before [b][/b] after')
  })

  it('preserves BBCode tags around inline character icons', () => {
    // [icon] frames render as <a>+<img> with NO data-bb-start spans for
    // their inner text, so the icon is effectively read-only in preview.
    const source = 'see [icon]Aurora[/icon] here'
    const dom = renderToDom(source)
    // Edit the trailing " here" to " there"
    const trailing = dom.querySelector('[data-bb-start="23"]') as HTMLElement
    expect(trailing).not.toBeNull()
    trailing.textContent = ' there'
    expect(bbcodeFromPreviewDom(dom, source)).toBe('see [icon]Aurora[/icon] there')
  })

  it('preserves <br /> conversions on newline-containing text', () => {
    const source = 'line one\nline two'
    const dom = renderToDom(source)
    expect(bbcodeFromPreviewDom(dom, source)).toBe(source)
  })
})
