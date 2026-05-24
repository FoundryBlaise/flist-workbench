import { test, expect, chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const OUT = resolve(__dirname, 'artifacts')
const CHAR = 'Lady Amber Blaise'

test('capture F-list rendering for ' + CHAR, async () => {
  await mkdir(OUT, { recursive: true })

  const browser = await chromium.launch()
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 2400 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
  })
  await ctx.addCookies([
    {
      name: 'warning',
      value: '1',
      domain: 'www.f-list.net',
      path: '/',
      httpOnly: false,
      secure: false
    }
  ])

  const page = await ctx.newPage()
  const url = `https://www.f-list.net/c/${encodeURIComponent(CHAR)}/`
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })

  const block = page.locator('.FormattedBlock').first()
  await expect(block).toBeVisible({ timeout: 15_000 })

  // FormattedBlock contains raw BBCode with <br> markers for newlines —
  // textContent would lose them, so walk the DOM and substitute \n.
  const rawBBCode = await block.evaluate((el) => {
    const parts: string[] = []
    const walker = el.ownerDocument!.createTreeWalker(el, NodeFilter.SHOW_ALL)
    let n: Node | null = walker.currentNode
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) parts.push(n.nodeValue ?? '')
      else if ((n as Element).tagName === 'BR') parts.push('\n')
    }
    return parts.join('')
  })
  await writeFile(resolve(OUT, 'lady-amber-blaise.bbcode'), rawBBCode, 'utf-8')

  await block.screenshot({ path: resolve(OUT, 'flist-raw.png') })

  const renderedHtml = await block.evaluate((el) => el.innerHTML)
  await writeFile(resolve(OUT, 'flist-raw.html'), renderedHtml, 'utf-8')

  const bbox = await block.boundingBox()
  console.log(JSON.stringify({
    bytes: rawBBCode.length,
    htmlBytes: renderedHtml.length,
    height: bbox?.height,
    width: bbox?.width
  }))

  await browser.close()
})
