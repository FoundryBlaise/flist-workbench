import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      // electron-builder's output (electron-builder.yml), packed app included.
      'dist-electron/**',
      'release/**',
      'node_modules/**',
      'sidecar/**',
      'mockups/**',
      'playwright-report/**',
      'test-results/**',
      // Fetched by `npm run fetch:extension`, git-ignored, not our source.
      'resources/browser-extension/**',
      // Agent worktrees (scripts/agent-worktree.sh) are whole checkouts.
      '.claude/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  }
)
