import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bbcodeToHtml } from './index'

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
    expect(bbcodeToHtml('[heading]H[/heading]')).toBe('<h2>H</h2>')
    expect(bbcodeToHtml('[quote]Q[/quote]')).toBe('<blockquote>Q</blockquote>')
    expect(bbcodeToHtml('[center]C[/center]')).toBe('<div class="bb-center">C</div>')
    expect(bbcodeToHtml('[indent]I[/indent]')).toBe('<div class="bb-indent">I</div>')
  })

  it('renders hr standalone', () => {
    expect(bbcodeToHtml('a[hr]b')).toBe('a<hr class="bb-hr" />b')
  })

  it('renders collapse with label', () => {
    const out = bbcodeToHtml('[collapse=Show me]hidden[/collapse]')
    expect(out).toBe('<details class="bb-collapse"><summary>Show me</summary>hidden</details>')
  })

  it('converts newlines in text to <br />', () => {
    expect(bbcodeToHtml('line1\nline2')).toBe('line1<br />\nline2')
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
