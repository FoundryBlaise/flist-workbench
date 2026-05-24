import { test, chromium, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const OUT = resolve(__dirname, 'artifacts')

// Opens the side-by-side page produced by parsers-side-by-side.spec.ts,
// expands every collapse on both sides, and asserts that the expanded
// body never extends beyond the bounding box of its containing
// <details>/.bbcode-collapse card. That's the "text pips out" bug.
test('opening any collapse keeps its body inside the card', async () => {
  await mkdir(OUT, { recursive: true })
  const page = resolve(OUT, 'parsers-side-by-side.html')

  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 2000, height: 2200 } })
  const tab = await ctx.newPage()
  await tab.goto('file://' + page)
  await tab.waitForSelector('#ours')
  await tab.waitForSelector('#fchat')

  // Open every <details> on our side.
  await tab.evaluate(() => {
    document.querySelectorAll<HTMLDetailsElement>('#ours details').forEach((d) => {
      d.open = true
    })
  })
  // Force-open F-Chat's collapse cards by setting body height inline.
  await tab.evaluate(() => {
    document.querySelectorAll<HTMLElement>('#fchat .bbcode-collapse-body').forEach((b) => {
      b.style.height = 'auto'
    })
  })
  await tab.waitForTimeout(200)

  // Verify on our side: every collapse-body fits within its <details>.
  const overflows = await tab.evaluate(() => {
    const out: { side: string; index: number; bodyRect: DOMRect; cardRect: DOMRect }[] = []
    document.querySelectorAll<HTMLDetailsElement>('#ours details.bb-collapse').forEach((d, i) => {
      const body = d.querySelector<HTMLElement>('.bb-collapse-body')
      if (!body) return
      const cardRect = d.getBoundingClientRect()
      const bodyRect = body.getBoundingClientRect()
      // Body must be contained — tolerate 1px sub-pixel rounding.
      const overflows = bodyRect.right > cardRect.right + 1 || bodyRect.bottom > cardRect.bottom + 1
      if (overflows) out.push({ side: 'ours', index: i, bodyRect: bodyRect.toJSON(), cardRect: cardRect.toJSON() })
    })
    return out
  })

  await tab.screenshot({ path: resolve(OUT, 'collapse-all-expanded.png'), fullPage: true })
  console.log(JSON.stringify({ overflows }))
  expect(overflows, JSON.stringify(overflows)).toEqual([])

  await browser.close()
})
