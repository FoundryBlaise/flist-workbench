import { test, chromium, expect } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const OUT = resolve(__dirname, 'artifacts')
const OUR_LIB = resolve(__dirname, '../../renderer/src/lib/bbcode/index.ts')
const APP_CSS = resolve(__dirname, '../../renderer/src/app.css')
const FCHAT_ENTRY = resolve(__dirname, 'fchat-vendor/render.ts')
const FCHAT_CSS = resolve(__dirname, 'fchat-vendor/flist.css')

test('ours vs F-Chat 3.0 parser, rendered side-by-side', async () => {
  await mkdir(OUT, { recursive: true })
  const bbcode = await readFile(resolve(OUT, 'lady-amber-blaise.bbcode'), 'utf-8')
  const ourCss = await readFile(APP_CSS, 'utf-8')
  const fchatCss = await readFile(FCHAT_CSS, 'utf-8')
  // Real inlines manifest captured alongside the BBCode source. Both
  // parsers need it to resolve [img=ID] tags to the hashed CDN url.
  const inlines = JSON.parse(
    await readFile(resolve(OUT, 'lady-amber-blaise.inlines.json'), 'utf-8')
  )

  const { build } = await import('esbuild')
  const [ourBundle, fchatBundle] = await Promise.all([
    build({
      entryPoints: [OUR_LIB], bundle: true, format: 'iife', globalName: 'OURS',
      write: false, platform: 'browser', target: 'es2020'
    }),
    build({
      entryPoints: [FCHAT_ENTRY], bundle: true, format: 'iife', globalName: 'FCHAT',
      write: false, platform: 'browser', target: 'es2020'
    })
  ])

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>${ourCss}</style>
<style>${fchatCss}</style>
<style>
  body { background: #181818; color: #ddd; margin: 0; padding: 0; font-family: 'Segoe UI', system-ui, sans-serif; }
  .head {
    display: grid; grid-template-columns: 1fr 1fr;
    background: #0b0b0b; border-bottom: 1px solid #333;
    position: sticky; top: 0; z-index: 5;
  }
  .head h2 {
    margin: 0; padding: 10px 16px; font-size: 12px; text-transform: uppercase;
    letter-spacing: 0.7px; color: #aaa; border-right: 1px solid #333;
  }
  .head h2:last-child { border-right: none; }
  .split { display: grid; grid-template-columns: 1fr 1fr; }
  .col { overflow: auto; border-right: 1px solid #333; min-width: 0; }
  .col:last-child { border-right: none; }
  .ours-frame { background: #1e1e1e; }
  .fchat-frame { background: var(--flist-bg, #2e2828); }
</style>
<script>${ourBundle.outputFiles[0].text}</script>
<script>${fchatBundle.outputFiles[0].text}</script>
</head>
<body>
<div class="head">
  <h2>Ours (renderer/src/lib/bbcode)</h2>
  <h2>F-Chat 3.0 (vendored, chat3client)</h2>
</div>
<div class="split">
  <section class="col ours-frame pane preview">
    <div class="pane-body preview-body" id="ours"></div>
  </section>
  <section class="col fchat-frame">
    <div id="fchat"></div>
  </section>
</div>
<script>
  const src = ${JSON.stringify(bbcode)};
  const inlines = ${JSON.stringify(inlines)};
  document.getElementById('ours').innerHTML = OURS.bbcodeToHtml(src, { inlines });
  FCHAT.renderFListBBCode(src, document.getElementById('fchat'), inlines);
</script>
</body></html>`
  const path = resolve(OUT, 'parsers-side-by-side.html')
  await writeFile(path, html, 'utf-8')

  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 2000, height: 2200 } })
  const page = await ctx.newPage()
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser error]', msg.text())
  })
  await page.goto('file://' + path)
  await page.waitForSelector('#ours', { state: 'visible' })
  await page.waitForSelector('#fchat', { state: 'visible' })
  // Force a layout pass so collapse heights / inline images settle.
  await page.waitForTimeout(300)

  const oursH = await page.locator('#ours').evaluate((el) => (el as HTMLElement).scrollHeight)
  const fchatH = await page.locator('#fchat').evaluate((el) => (el as HTMLElement).scrollHeight)
  console.log(JSON.stringify({ oursHeight: oursH, fchatHeight: fchatH }))

  await page.screenshot({ path: resolve(OUT, 'parsers-side-by-side.png'), fullPage: true })
  await browser.close()
  expect(oursH).toBeGreaterThan(100)
  expect(fchatH).toBeGreaterThan(100)
})
