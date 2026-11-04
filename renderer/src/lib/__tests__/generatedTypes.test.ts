// The window's API types come from the sidecar's OpenAPI schema
// (`npm run gen:api` writes lib/api.gen.ts). The `@ts-expect-error`
// lines are the point: `npm run typecheck` fails if any of them stops
// being an error, so a code or a field the sidecar does not have can
// never type-check.

import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  api,
  refusalCode,
  RefusalError,
  type Answer,
  type BodyOf,
  type McpInfo,
  type RefusalCode
} from '../api'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'

let fake: FakeApi

beforeEach(() => {
  fake = installFakeApi()
})

afterEach(() => {
  fake.restore()
})

it('knows a refusal by a code the sidecar schema lists', async () => {
  fake.on(
    'PUT /settings',
    json({ code: 'validation_failed', message: 'no such folder', details: {} }, 400)
  )

  const err = await api.settingsUpdate({ fchat_data_dir: '/nope' }).catch((e: unknown) => e)

  const code: RefusalCode | null = refusalCode(err)
  expect(code).toBe('validation_failed')
  // @ts-expect-error a code the sidecar never answers is not a RefusalCode
  expect(code === 'folder_missing').toBe(false)
  // @ts-expect-error nor can the window refuse with one
  expect(new RefusalError('folder_missing', 400, 'no').code).toBe('folder_missing')
})

it('reads the MCP endpoints with the fields the sidecar declares', async () => {
  const info: McpInfo = {
    port: 27384,
    endpoints: [
      { id: 'logs', label: 'Logs', path: '/mcp/logs', url: 'http://127.0.0.1:27384/mcp/logs', tool_count: 28 }
    ],
    auth: { required: false, token: null }
  }
  fake.on('GET /mcp-info', json(info))

  const read = await api.mcpInfo()

  expect(read.endpoints[0].tool_count).toBe(28)
  // @ts-expect-error McpEndpoint has no `tools` field
  expect(read.endpoints[0].tools).toBeUndefined()
})

it('types a route by what its response model declares', async () => {
  const health: Answer<'/health', 'get'> = { status: 'ok', version: '0.2.16' }
  fake.on('GET /health', json(health))

  expect(await api.health()).toEqual({ status: 'ok', version: '0.2.16' })
  // @ts-expect-error Health declares `version`
  const missing: Answer<'/health', 'get'> = { status: 'ok' }
  void missing
  // @ts-expect-error SettingsUpdate has no `theme`
  const body: BodyOf<'/settings', 'put'> = { theme: 'dark' }
  void body
  // @ts-expect-error /health serves no POST
  const posted: Answer<'/health', 'post'> = health
  void posted
})
