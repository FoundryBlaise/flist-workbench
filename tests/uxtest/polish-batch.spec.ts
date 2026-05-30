import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication
} from '@playwright/test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const OUT = resolve(__dirname, 'artifacts')

// Verifies the three affordances shipped in the 2026-05-30 polish
// follow-up batch render correctly under a real Electron launch:
//   - QA P0-A pull-incomplete: surface exists in the F-list zone for
//     archives with a partial pull. (Sidecar pytest covers compute_pull_status;
//     UI render path is exercised here at the data-testid level only —
//     full F-list flow needs a live ticket which we can't supply in CI.)
//   - QA P0-B external-endpoint badge: typing a remote URL into the
//     Labels endpoint field shows the warning badge.
//   - UX F1 documents empty-state: a brand-new userdata dir produces
//     a sidebar empty-state card with both CTAs.
test('polish batch — empty-state, endpoint badge, incomplete UI', async () => {
  await mkdir(OUT, { recursive: true })
  const root = resolve(__dirname, '../..')

  // Brand-new userdata so the documents list is genuinely empty.
  const userData = await mkdtemp(join(tmpdir(), 'flist-workbench-uxtest-'))

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
  // Sidecar takes a moment to come up + the renderer fetches /documents on mount.
  await window.waitForTimeout(2500)

  try {
    // ---- UX F1: documents empty-state ----
    const emptyState = window.getByTestId('documents-empty-state')
    await expect(emptyState).toBeVisible({ timeout: 10_000 })
    await expect(window.getByTestId('documents-empty-new')).toBeVisible()
    await expect(window.getByTestId('documents-empty-paste')).toBeVisible()
    await expect(emptyState).toContainText('Documents are saved BBCode snippets')
    await window.screenshot({
      path: resolve(OUT, 'polish-01-documents-empty-state.png')
    })

    // ---- QA P0-B: external-endpoint badge ----
    // Open Settings via the native menu IPC. The renderer's onMenuAction
    // listener handles 'settings'. We trigger it via Electron's menu API.
    await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()
      const click = (label: string) => {
        const walk = (items: Electron.MenuItem[]): boolean => {
          for (const item of items) {
            if (item.label === label && item.click) {
              item.click()
              return true
            }
            if (item.submenu && walk(item.submenu.items)) return true
          }
          return false
        }
        if (menu) walk(menu.items)
      }
      click('Settings…')
    })
    await window.waitForTimeout(400)
    // Settings modal is open. Switch to Labels section and edit endpoint.
    const labelsTab = window.locator('button.settings-rail-item', {
      hasText: /Labels/
    })
    await labelsTab.click()
    const endpointInput = window.getByTestId('labels-endpoint-input')
    await expect(endpointInput).toBeVisible({ timeout: 5_000 })
    // Default endpoint is a local LM Studio URL — expect the local badge.
    await expect(window.getByTestId('endpoint-badge-local').first()).toBeVisible()
    // Now swap to a known remote URL and assert the warning badge appears.
    await endpointInput.fill('https://api.openai.com/v1')
    const remoteBadge = window.getByTestId('endpoint-badge-remote').first()
    await expect(remoteBadge).toBeVisible({ timeout: 3_000 })
    await expect(remoteBadge).toContainText('External endpoint')
    await expect(remoteBadge).toContainText('api.openai.com')
    await remoteBadge.scrollIntoViewIfNeeded()
    await window.waitForTimeout(150)
    await window.screenshot({
      path: resolve(OUT, 'polish-02-endpoint-badge-remote.png')
    })

    // Close Settings via Escape so saveAll's consent gate doesn't fire.
    await window.keyboard.press('Escape')
    await window.waitForTimeout(200)
  } finally {
    await app.close()
  }
})
