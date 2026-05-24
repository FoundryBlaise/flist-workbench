import { test, chromium } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const OUT = resolve(__dirname, 'artifacts')

// Resolve to the renderer source so the test reflects what the actual
// app would render. We load it with a tiny harness page.
const BBCODE_LIB = resolve(__dirname, '../../renderer/src/lib/bbcode/index.ts')
const APP_CSS = resolve(__dirname, '../../renderer/src/app.css')

test('render Lady Amber Blaise BBCode through our transformer', async () => {
  await mkdir(OUT, { recursive: true })

  const bbcode = await readFile(resolve(OUT, 'lady-amber-blaise.bbcode'), 'utf-8')
  const css = await readFile(APP_CSS, 'utf-8')
  // esbuild-bundle the transformer on the fly so the browser can import it.
  const { build } = await import('esbuild')
  const bundle = await build({
    entryPoints: [BBCODE_LIB],
    bundle: true,
    format: 'iife',
    globalName: 'BB',
    write: false,
    platform: 'browser',
    target: 'es2020'
  })
  const js = bundle.outputFiles[0].text

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>${css}</style>
<style>
  body { background: var(--bg); color: var(--text); margin: 0; }
  /* mimic the app preview pane backdrop / typography so screenshots match */
  .pane.preview .pane-body { padding: 16px 24px; max-width: 989px; }
</style>
<script>${js}</script>
</head>
<body>
<section class="pane preview"><div class="pane-body preview-body" id="out"></div></section>
<script>
  const src = ${JSON.stringify(bbcode)};
  document.getElementById('out').innerHTML = BB.bbcodeToHtml(src);
</script>
</body></html>`
  const harnessPath = resolve(OUT, 'ours-harness.html')
  await writeFile(harnessPath, html, 'utf-8')

  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 2400 } })
  const page = await ctx.newPage()
  await page.goto('file://' + harnessPath)
  const body = page.locator('#out')
  await body.waitFor({ state: 'visible' })
  await body.screenshot({ path: resolve(OUT, 'ours-rendered.png') })

  const renderedHtml = await body.evaluate((el) => el.innerHTML)
  await writeFile(resolve(OUT, 'ours-rendered.html'), renderedHtml, 'utf-8')

  const bbox = await body.boundingBox()
  console.log(JSON.stringify({ height: bbox?.height, width: bbox?.width, htmlBytes: renderedHtml.length }))

  await browser.close()
})
