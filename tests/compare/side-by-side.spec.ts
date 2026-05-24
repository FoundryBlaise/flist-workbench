import { test, chromium } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const OUT = resolve(__dirname, 'artifacts')
const BBCODE_LIB = resolve(__dirname, '../../renderer/src/lib/bbcode/index.ts')
const APP_CSS = resolve(__dirname, '../../renderer/src/app.css')

test('side-by-side: BBCode source vs our rendered preview', async () => {
  await mkdir(OUT, { recursive: true })
  const bbcode = await readFile(resolve(OUT, 'lady-amber-blaise.bbcode'), 'utf-8')
  const css = await readFile(APP_CSS, 'utf-8')

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

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>${css}</style>
<style>
  body { background: #181818; color: var(--text); margin: 0; padding: 0; }
  .split { display: grid; grid-template-columns: 1fr 1fr; height: 100vh; }
  .col { overflow: auto; }
  .col h2 {
    margin: 0; padding: 8px 12px; font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.7px; color: var(--text-dim);
    background: var(--panel-2); border-bottom: 1px solid var(--border);
  }
  .src {
    font-family: 'Cascadia Code', Consolas, monospace; font-size: 12px;
    white-space: pre-wrap; padding: 16px 20px; color: var(--text);
  }
  .src .tag { color: #569cd6; }
  .src .close { color: #c97070; }
</style>
<script>${bundle.outputFiles[0].text}</script>
</head>
<body>
<div class="split">
  <section class="col"><h2>BBCode source</h2><pre class="src" id="src"></pre></section>
  <section class="col pane preview"><h2>Our rendered preview</h2><div class="pane-body preview-body" id="out"></div></section>
</div>
<script>
  const src = ${JSON.stringify(bbcode)};
  // Cheap colour pass: only the BBCode tag itself, no attribute parsing.
  const escaped = src.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  document.getElementById('src').innerHTML = escaped.replace(
    /\\[(\\/?)([a-zA-Z][a-zA-Z0-9]*)(=[^\\]]*)?\\]/g,
    (_, slash, name, attr) => '<span class="' + (slash ? 'close' : 'tag') + '">[' + slash + name + (attr ?? '') + ']</span>'
  );
  document.getElementById('out').innerHTML = BB.bbcodeToHtml(src);
</script>
</body></html>`
  const path = resolve(OUT, 'side-by-side.html')
  await writeFile(path, html, 'utf-8')

  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1800, height: 2600 } })
  const page = await ctx.newPage()
  await page.goto('file://' + path)
  await page.waitForSelector('#out')
  await page.screenshot({ path: resolve(OUT, 'side-by-side.png'), fullPage: true })
  await browser.close()
})
