import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication
} from '@playwright/test'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ARTIFACT_OUT = resolve(__dirname, 'artifacts')
const SHARED_OUT = resolve(__dirname, '../../../screenshots')

// Drives the verification follow-ups landed after the second polish batch:
//   - UX F4 on-disk redacted activity log → restart-survival
//   - Shared empty-state component visual consistency
//   - F3 retrieval pip endpoint pairing (smoke only — full flow needs LLM)
//
// The P0-C pre-drop warning + F3 auto-dismiss are covered by sidecar
// unit tests; surfacing them in a UI smoke needs simulated session
// state which the existing harness doesn't easily produce.
test('polish batch 3 — activity log restart-survival + shared empty-state', async () => {
  await mkdir(ARTIFACT_OUT, { recursive: true })
  await mkdir(SHARED_OUT, { recursive: true })
  const root = resolve(__dirname, '../..')
  const userData = await mkdtemp(join(tmpdir(), 'flist-workbench-uxtest3-'))

  // Pre-seed the on-disk activity log so the hydrate-on-startup path is
  // exercised — restart-survival is the whole point of the F4 disk
  // rotation work.
  const logLines = [
    {
      t: Math.floor(Date.now() / 1000) - 300,
      kind: 'sign-in',
      account: 'auldren-test',
      character_count: 3
    },
    {
      t: Math.floor(Date.now() / 1000) - 180,
      kind: 'pull-start',
      name: 'Lady Amber Blaise'
    },
    {
      t: Math.floor(Date.now() / 1000) - 120,
      kind: 'pull-done',
      name: 'Lady Amber Blaise',
      character_id: '12345',
      image_count: 24,
      image_failed: 0,
      status: 'complete',
      missing: 0
    },
    {
      t: Math.floor(Date.now() / 1000) - 60,
      kind: 'password-idle-clear',
      idle_seconds: 600
    }
  ]
  await writeFile(
    join(userData, 'flist-activity.log'),
    logLines.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf-8'
  )

  const app: ElectronApplication = await electron.launch({
    args: [resolve(root, 'out/main/main.js')],
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FLIST_WORKBENCH_DATA_DIR: userData
    }
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(2500)

  const dualShot = async (name: string) => {
    await window.screenshot({ path: resolve(ARTIFACT_OUT, `${name}.png`) })
    await window.screenshot({ path: resolve(SHARED_OUT, `${name}.png`) })
  }

  const clickMenu = async (label: string) => {
    await app.evaluate(({ Menu }, lbl) => {
      const menu = Menu.getApplicationMenu()
      const walk = (items: Electron.MenuItem[]): boolean => {
        for (const item of items) {
          if (item.label === lbl && item.click) {
            item.click()
            return true
          }
          if (item.submenu && walk(item.submenu.items)) return true
        }
        return false
      }
      if (menu) walk(menu.items)
    }, label)
  }

  try {
    // ---- F4 restart-survival: activity log shows hydrated events ----
    await clickMenu('F-list Activity Log…')
    const modal = window.getByTestId('flist-activity-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })
    const list = window.getByTestId('flist-activity-list')
    await expect(list).toBeVisible({ timeout: 5_000 })
    // All four pre-seeded events should be visible (sign-in, pull-start,
    // pull-done, password-idle-clear), proving hydrate_from_disk ran.
    await expect(list).toContainText('Signed in')
    await expect(list).toContainText('Pull started')
    await expect(list).toContainText('Pull done')
    await expect(list).toContainText('Cleared cached password')
    await dualShot('polish3-01-activity-log-hydrated-from-disk')
    await window.getByTestId('flist-activity-close').click()
    await expect(modal).toBeHidden({ timeout: 2_000 })

    // ---- Shared empty-state: documents empty-state still renders ----
    // Confirms the refactor didn't break F1.
    await expect(window.getByTestId('documents-empty-state')).toBeVisible()
    await expect(window.getByTestId('documents-empty-new')).toBeVisible()
    await expect(window.getByTestId('documents-empty-paste')).toBeVisible()

    // ---- Shared empty-state: RAG empty-state ----
    await clickMenu('Logs')
    await window.waitForTimeout(200)
    await clickMenu('Ask the logs…')
    await expect(window.getByTestId('chat-empty-no-index')).toBeVisible({
      timeout: 5_000
    })
    await expect(window.getByTestId('chat-empty-ingest')).toBeVisible()
    await expect(window.getByTestId('chat-empty-ai-setup')).toBeVisible()
    await dualShot('polish3-02-shared-empty-state-rag')

    // ---- Verify the on-disk log was actually written (not just hydrated) ----
    // Trigger one new event and confirm the file grows.
    await window.evaluate(async () => {
      const w = window as unknown as { workbench?: { sidecarUrl: string } }
      const url = w.workbench?.sidecarUrl ?? 'http://127.0.0.1:27384'
      try {
        await fetch(`${url}/flist/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account: 'test-bad-creds', password: 'x' })
        })
      } catch {
        // expected
      }
    })
    await window.waitForTimeout(300)
    const logFile = await readFile(
      join(userData, 'flist-activity.log'),
      'utf-8'
    )
    // Pre-seed lines (4) + sign-in-failed event (1) = at least 5 lines.
    const nonEmpty = logFile.split('\n').filter((l) => l.trim().length > 0)
    expect(nonEmpty.length).toBeGreaterThanOrEqual(5)
    expect(logFile).toContain('"kind": "sign-in-failed"')
  } finally {
    await app.close()
  }
})
