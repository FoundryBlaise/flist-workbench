// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, resolve } from 'node:path'

// What the Windows build ships, checked from the files `npm run pack:win`
// reads. electron-builder copies every package in `dependencies` into the
// app archive, while the renderer bundle already contains whatever the
// renderer imports; a renderer library left in `dependencies` ships twice.

const ROOT = resolve(__dirname, '..')

function packageJson(): {
  dependencies: Record<string, string>
  scripts: Record<string, string>
} {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
}

/** The package a bare import specifier names: `@scope/name` or `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** Packages the main process and preload load at run time. */
function packagesTheMainProcessLoads(): Set<string> {
  const builtins = new Set(builtinModules)
  const found = new Set<string>()
  const sources = readdirSync(join(ROOT, 'electron')).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts')
  )
  const specifiers = /(?:from|import\(|require\()\s*['"]([^'"]+)['"]/g
  for (const name of sources) {
    const text = readFileSync(join(ROOT, 'electron', name), 'utf8')
    for (const [, specifier] of text.matchAll(specifiers)) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
      const pkg = packageOf(specifier)
      // Electron itself is the runtime, not a package the app carries.
      if (pkg === 'electron' || builtins.has(pkg)) continue
      found.add(pkg)
    }
  }
  return found
}

describe('the packaged app', () => {
  it('carries as dependencies only the packages the main process loads', () => {
    const dependencies = Object.keys(packageJson().dependencies).sort()
    expect(dependencies).toEqual([...packagesTheMainProcessLoads()].sort())
  })
})

describe('the sidecar build', () => {
  it('leaves out every test package of the sidecar dev group', () => {
    const pyproject = readFileSync(join(ROOT, 'sidecar', 'pyproject.toml'), 'utf8')
    const devGroup = pyproject.match(/^dev = \[([\s\S]*?)^\]/m)?.[1] ?? ''
    const testPackages = [...devGroup.matchAll(/^\s*"(pytest[\w-]*)/gm)].map(([, name]) =>
      name.replaceAll('-', '_')
    )
    expect(testPackages).toContain('pytest')

    const excluded = [
      ...packageJson().scripts['pack:sidecar'].matchAll(/--exclude-module (\S+)/g)
    ].map(([, module]) => module)
    // pytest's implementation lives in `_pytest`; `pytest` is only its front.
    for (const module of [...testPackages, '_pytest']) {
      expect(excluded).toContain(module)
    }
  })
})
