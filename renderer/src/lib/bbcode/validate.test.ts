// Every case here was run through F-list's own parser in the browser
// —`FList.TagParser.enableWarnings(); parseEverything(htmlentities(s))`
// on f-list.net — and this file asserts the same verdicts. Guessing at
// these rules is how the app ends up disagreeing with the site, which
// is worse than not checking at all: a false "looks fine" is what sent
// the user to the upload in the first place.

import { expect, it } from 'vitest'
import { validateBbcode } from './validate'

const tags = (s: string) => validateBbcode(s).map((w) => w.tag)

it('accepts one level of formatting inside [big]', () => {
  expect(tags('[big][b]X[/b][/big]')).toEqual([])
  expect(tags('[big][color=cyan]X[/color][/big]')).toEqual([])
  expect(tags('[big][i]X[/i][/big]')).toEqual([])
})

it('refuses a second level inside [big]', () => {
  // The shape everyone reaches for when they want a large, bold,
  // coloured heading — and the one F-list rejects.
  expect(tags('[big][b][color=cyan]X[/color][/b][/big]')).toEqual(['color'])
  expect(tags('[big][color=cyan][b]X[/b][/color][/big]')).toEqual(['b'])
})

it('takes the same heading with the colour on the outside', () => {
  expect(tags('[color=cyan][big][b]X[/b][/big][/color]')).toEqual([])
})

it('leaves ordinary nesting alone', () => {
  expect(tags('[b][color=cyan]X[/color][/b]')).toEqual([])
  expect(tags('[color=gray][sub]Y[/sub][/color]')).toEqual([])
  expect(tags('[center][b][i]X[/i][/b][/center]')).toEqual([])
})

it('holds [sub] and [sup] to bold, italic and underline', () => {
  expect(tags('[sub][b]Y[/b][/sub]')).toEqual([])
  expect(tags('[sub][color=gray]Y[/color][/sub]')).toEqual(['color'])
  expect(tags('[sup][s]Y[/s][/sup]')).toEqual(['s'])
})

it('lets nothing inside [url], [icon] or [noparse]', () => {
  expect(tags('[url=https://example.com][b]X[/b][/url]')).toEqual(['b'])
  expect(tags('[icon][b]Name[/b][/icon]')).toEqual(['b'])
  // Inside noparse everything is literal text, so nothing is judged.
  expect(tags('[noparse][big][b][color=red]X[/color][/b][/big][/noparse]')).toEqual([])
})

it('says which tag and where, the way the site does', () => {
  const [w] = validateBbcode('hello [big][b][color=cyan]X[/color][/b][/big]')
  expect(w.tag).toBe('color')
  expect(w.start).toBe('hello [big][b]'.length)
  expect(w.message).toContain('The [color] tag is not allowed here')
})

it('ignores tags F-list does not know', () => {
  // Its parser leaves them as literal text without complaint.
  expect(tags('[big][blink]X[/blink][/big]')).toEqual([])
})

it('has nothing to say about plain text', () => {
  expect(validateBbcode('Just a description, no markup at all.')).toEqual([])
})

// F-list's second class of complaint: tags that do not end in their
// own closer. The site prints such a tag, with everything inside it,
// as literal text. "B" is "Bad BBCode in [x] tag", "O" is "Open [x]
// tag is not properly closed", "N" is "not allowed here". The rows are
// #137's verified-case table, in F-list's own order.
const verdicts = (s: string) =>
  validateBbcode(s).map((w) => `${KIND_LETTER[w.kind]} ${w.tag}`)
const KIND_LETTER = { 'bad-nesting': 'B', 'not-closed': 'O', 'not-allowed': 'N' } as const

it.each<[string, string[]]>([
  ['[color=green][b]x[/color][/b]', ['B b', 'O color']],
  ['[b][i]x[/b][/i]', ['B i', 'O b']],
  ['[b]x', ['O b']],
  // A stray closer is shown as text, without a warning.
  ['x[/b]', []],
  ['[b]x[/b][/b]', []],
  // The well-formed [b] goes literal with its unclosed parent.
  ['[color=green]a[b]b[/b]', ['O color']],
  ['[color=green]x[/b][/color]', ['B color']],
  // The shape from the report: a crossed pair inside a wrapper.
  ['[collapse=Q][color=green][b]x[/color][/b][/collapse] after [b]ok[/b]', ['B b', 'O color']],
  ['[color=green][collapse=Q][b]x[/collapse][/b][/color] after [b]ok[/b]', ['B b', 'O collapse']],
  ['[quote][b]x[/quote]', ['O b', 'O quote']],
  ['[url=https://example.com]x[/url] [b]y', ['O b']],
  ['[noparse][b][/noparse]', []],
  ['[big][b][color=cyan]X[/color][/b][/big]', ['N color']],
  // Literal on the site, so never rendered, so never judged.
  ['[color=green][big][b][color=cyan]X[/color][/b][/big]', ['O color']],
  // Structural first, whatever the source order.
  ['[big][b][color=cyan]X[/color][/b][/big] [color=green][b]x[/color][/b]', ['B b', 'O color', 'N color']],
  // "B", not "O": a [/color follows later.
  ['[color=green][b]x[/color][/b] [big][b][color=cyan]X[/color][/b][/big]', ['B b', 'B color', 'N color']],
  ['[b]ok[/b] [i]ok[/i]', []]
])('reports %j as F-list does', (source, expected) => {
  expect(verdicts(source)).toEqual(expected)
})

it('names the tag and quotes the text after it, as F-list does', () => {
  const [bad, open] = validateBbcode('ab [color=green][b]x[/color][/b]')
  expect(bad).toEqual({
    kind: 'bad-nesting',
    tag: 'b',
    start: 'ab [color=green]'.length,
    message: "Bad BBCode in [b] tag, somewhere around/after 'x[/color][/b]...'."
  })
  expect(open).toEqual({
    kind: 'not-closed',
    tag: 'color',
    start: 'ab '.length,
    message: 'Open [color] tag is not properly closed (with [/color]).'
  })
})

it('marks the nesting complaint as not-allowed', () => {
  const [w] = validateBbcode('[big][b][color=cyan]X[/color][/b][/big]')
  expect(w.kind).toBe('not-allowed')
})

it('treats [spoiler] as a tag F-list does not know', () => {
  // Not in f-list.js's tag table: escaped to text, never judged.
  expect(validateBbcode('[spoiler]x')).toEqual([])
  expect(validateBbcode('[big][b][spoiler]x[/spoiler][/b][/big]')).toEqual([])
})
