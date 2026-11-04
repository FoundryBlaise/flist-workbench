// The Settings slice: the settings the sidecar keeps, and everything
// else the Settings dialog asks of the sidecar (MCP access, extension
// pairing, the cleared Labels in the Trash, the Index, the Foreign
// profile cache). Seam: the one store, against the fake sidecar.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../../state'
import { settingsInitialState } from '../slices/settings'
import { applyWorkbenchEvent } from '../workbenchEvents'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'

const RAG = {
  embed_model: 'org/m',
  top_k: 8,
  rerank_candidates: 40,
  neighbors: 1,
  rerank_model: 'disabled',
  rerank_min_ratio: 0,
  hybrid_enabled: false,
  hybrid_bm25_candidates: 40,
  chunk_max_chars: 2000,
  chunk_soft_split_chars: 1500,
  chunk_overlap_msgs: 1
}

const SETTINGS = {
  fchat_data_dir: null,
  fchat_data_dir_effective: 'C:/fchat/data',
  fchat_data_dir_env_locked: false,
  labels: { threshold_chars: 200, defaults: { threshold_chars: 200 } },
  rag: { ...RAG, defaults: RAG },
  image_import_roots: [],
  mcp: { log_text: false },
  foreign: { cache_cap_mb: 1024, defaults: { cache_cap_mb: 1024 } }
}

let fake: FakeApi

beforeEach(() => {
  fake = installFakeApi()
  useStore.setState(settingsInitialState())
})

afterEach(() => {
  fake.restore()
})

const state = () => useStore.getState()

describe('the settings', () => {
  it('are read from the sidecar', async () => {
    fake.on('GET /settings', json(SETTINGS))

    await state().settingsLoad()

    expect(state().settings).toEqual(SETTINGS)
    expect(state().settingsStatus).toBe('ready')
    expect(state().settingsError).toBeNull()
  })

  it('say why they could not be read', async () => {
    fake.on('GET /settings', json({ code: 'internal', message: 'disk on fire', details: {} }, 500))

    await state().settingsLoad()

    expect(state().settings).toBeNull()
    expect(state().settingsStatus).toBe('error')
    expect(state().settingsError).toBe('disk on fire')
  })

  it('a setting a model changed is read again while they are shown', async () => {
    fake.once('GET /settings', json(SETTINGS))
    await state().settingsLoad()
    fake.once('GET /settings', json({ ...SETTINGS, rag: { ...SETTINGS.rag, top_k: 50 } }))

    applyWorkbenchEvent(
      {
        event: 'settings-changed',
        at: 1,
        origin: 'mcp:update_settings',
        changed: { 'rag.top_k': 50 }
      },
      state()
    )

    await expect.poll(() => state().settings?.rag.top_k).toBe(50)
    expect(fake.requestsTo('GET /settings')).toHaveLength(2)
  })

  it('nothing is read when no settings were read yet', async () => {
    state().noteSettingsChanged(['rag.top_k'])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(fake.requestsTo('GET /settings')).toHaveLength(0)
    expect(state().settings).toBeNull()
  })

  it('a save sends only what changed and keeps what the sidecar answers', async () => {
    const saved = { ...SETTINGS, labels: { ...SETTINGS.labels, threshold_chars: 300 } }
    fake.on('PUT /settings', json(saved))

    const error = await state().settingsSave({ labels: { threshold_chars: 300 } })

    expect(error).toBeNull()
    expect(fake.requestsTo('PUT /settings').map((r) => r.body)).toEqual([
      { labels: { threshold_chars: 300 } }
    ])
    expect(state().settings).toEqual(saved)
  })

  it('a refused save says why and keeps the settings as they were', async () => {
    fake.once('GET /settings', json(SETTINGS))
    await state().settingsLoad()
    fake.on('PUT /settings', json({ code: 'invalid', message: 'no such folder', details: {} }, 422))

    const error = await state().settingsSave({ fchat_data_dir: 'X:/nowhere' })

    expect(error).toBe('no such folder')
    expect(state().settings).toEqual(SETTINGS)
  })

  it('a new F-Chat data directory reads the Log characters again', async () => {
    fake.on('PUT /settings', json({ ...SETTINGS, fchat_data_dir: 'D:/fchat' }))
    fake.on('GET /logs/characters', json({ characters: [] }))

    await state().settingsSave({ fchat_data_dir: 'D:/fchat' })

    expect(fake.requestsTo('GET /logs/characters')).toHaveLength(1)
  })
})

const MCP_INFO = {
  port: 27384,
  endpoints: [
    {
      id: 'all',
      label: 'Everything',
      path: '/mcp',
      url: 'http://127.0.0.1:27384/mcp',
      tool_count: 24
    }
  ],
  auth: { required: false, token: null }
}

describe('MCP access', () => {
  it('the endpoints and token are read from the sidecar', async () => {
    fake.on('GET /mcp-info', json(MCP_INFO))

    await state().mcpLoadInfo()

    expect(state().mcpInfo).toEqual(MCP_INFO)
    expect(state().mcpError).toBeNull()
  })

  it('requiring a token issues one and reads the endpoints again', async () => {
    const required = { ...MCP_INFO, auth: { required: true, token: 't0k3n' } }
    fake.on('POST /mcp-info/token', json({ token: 't0k3n' }))
    fake.on('GET /mcp-info', json(required))

    expect(await state().mcpCreateToken()).toBeNull()

    expect(fake.requestsTo('POST /mcp-info/token')).toHaveLength(1)
    expect(state().mcpInfo).toEqual(required)
  })

  it('turning the token off drops it and reads the endpoints again', async () => {
    fake.on('DELETE /mcp-info/token', json({ required: false }))
    fake.on('GET /mcp-info', json(MCP_INFO))

    expect(await state().mcpRevokeToken()).toBeNull()

    expect(fake.requestsTo('DELETE /mcp-info/token')).toHaveLength(1)
    expect(state().mcpInfo).toEqual(MCP_INFO)
  })

  it('letting clients read Log text saves the switch and reads the tool counts again', async () => {
    fake.on('PUT /settings', json({ ...SETTINGS, mcp: { log_text: true } }))
    fake.on('GET /mcp-info', json(MCP_INFO))

    expect(await state().mcpSetLogText(true)).toBeNull()

    expect(fake.requestsTo('PUT /settings').map((r) => r.body)).toEqual([
      { mcp: { log_text: true } }
    ])
    expect(state().settings?.mcp.log_text).toBe(true)
    expect(fake.requestsTo('GET /mcp-info')).toHaveLength(1)
  })

  it('a refused switch says why and reads nothing again', async () => {
    fake.on('PUT /settings', json({ code: 'invalid', message: 'not now', details: {} }, 422))

    expect(await state().mcpSetLogText(true)).toBe('not now')
    expect(fake.requestsTo('GET /mcp-info')).toHaveLength(0)
  })
})

describe('the browser extension', () => {
  it('the pairing is checked with the sidecar', async () => {
    fake.on('GET /pairing', json({ paired: true }))

    const checking = state().extensionLoadPairing()
    expect(state().extensionPairing).toBe('checking')
    await checking

    expect(state().extensionPairing).toBe('paired')
  })

  it('an unanswered check says the pairing is unavailable', async () => {
    fake.on('GET /pairing', json({ code: 'internal', message: 'down', details: {} }, 500))

    await state().extensionLoadPairing()

    expect(state().extensionPairing).toBe('unavailable')
  })

  it('revoking the pairing drops the token and checks again', async () => {
    fake.on('DELETE /restore/token', json({ ok: true }))
    fake.on('GET /pairing', json({ paired: false }))

    expect(await state().extensionRevokePairing()).toBeNull()

    expect(fake.requestsTo('DELETE /restore/token')).toHaveLength(1)
    expect(state().extensionPairing).toBe('unpaired')
  })

  it('the version the browser runs is read from the sidecar', async () => {
    fake.on('GET /restore/extension', json({ version: '0.1.2', seen_at: 1 }))

    await state().extensionLoadRunningVersion()

    expect(state().extensionRunningVersion).toBe('0.1.2')
  })
})

const ROLLUP = { character_count: 2, total: 10, ic: 6, ooc: 2, manual: 1, unlabeled: 2 }
const TRASHED = {
  id: '1793400000-0123456789ab',
  character: 'Corin Vale',
  partner: 'Daelan Envale',
  count: 4,
  deleted_at: 1793400000,
  deleted_by: 'ui'
}

describe('Labels', () => {
  it('the coverage across every character is read from the sidecar', async () => {
    fake.on('GET /labels/rollup', json(ROLLUP))

    const loading = state().labelsLoadRollup()
    expect(state().labelsRollupStatus).toBe('loading')
    await loading

    expect(state().labelsRollup).toEqual(ROLLUP)
    expect(state().labelsRollupStatus).toBe('idle')
  })

  it('every cleared-Labels entry in the Trash is listed', async () => {
    fake.on('GET /labels/trash', json({ labels: [TRASHED] }))

    await state().labelsLoadTrash()

    expect(state().labelsTrash).toEqual([TRASHED])
    expect(state().labelsTrashError).toBeNull()
  })

  it('resetting every Label clears them, then reads the coverage and the Trash again', async () => {
    fake.on('POST /labels/clear-all', json({ labels_deleted: 10, trash_ids: [TRASHED.id] }))
    fake.on('GET /labels/rollup', json({ ...ROLLUP, ic: 0, ooc: 0, manual: 0, unlabeled: 10 }))
    fake.on('GET /labels/trash', json({ labels: [TRASHED] }))

    expect(await state().labelsClearAll()).toBeNull()

    expect(fake.requestsTo('POST /labels/clear-all')).toHaveLength(1)
    await expect.poll(() => state().labelsRollup?.unlabeled).toBe(10)
    await expect.poll(() => state().labelsTrash).toEqual([TRASHED])
  })

  it('putting cleared Labels back and deleting them for good name the entries', async () => {
    fake.on('POST /labels/trash/put-back', json({ restored: [], not_found: [] }))
    fake.on('POST /labels/trash/purge', json({ purged: [], not_found: [] }))

    await state().labelsTrashPutBack([TRASHED.id])
    await state().labelsTrashPurge([TRASHED.id])

    expect(fake.requestsTo('POST /labels/trash/put-back')[0].body).toEqual({ ids: [TRASHED.id] })
    expect(fake.requestsTo('POST /labels/trash/purge')[0].body).toEqual({ ids: [TRASHED.id] })
  })
})

describe('the Index', () => {
  it('its status is read and kept, or why it could not be read', async () => {
    const status = {
      embed_model: 'org/m',
      embed_dimension: 768,
      last_ingest_at: null,
      busy: false,
      job: null,
      chunk_count: 12
    }
    fake.once('GET /rag/status', json(status))
    fake.once(
      'GET /rag/status',
      json({ code: 'index_unreadable', message: 'The Index could not be read', details: {} }, 500)
    )

    await state().indexLoadStatus()
    expect(state().indexStatus).toEqual(status)
    expect(state().indexStatusError).toBeNull()

    await state().indexLoadStatus()
    expect(state().indexStatusError).toBe('The Index could not be read')
  })

  it('a test embedding runs with the model named', async () => {
    const result = { ok: true, elapsed_ms: 12, dimension: 768, model: 'org/m', error: null }
    fake.on('POST /rag/test-embedding', json(result))

    expect(await state().indexTestEmbedding('org/m')).toEqual(result)
    expect(fake.requestsTo('POST /rag/test-embedding')[0].body).toEqual({ embed_model: 'org/m' })
  })

  it('a test embedding the sidecar refused fails with its words', async () => {
    fake.on(
      'POST /rag/test-embedding',
      json({ code: 'internal', message: 'model missing', details: {} }, 500)
    )

    expect(await state().indexTestEmbedding('org/m')).toEqual({
      ok: false,
      elapsed_ms: 0,
      dimension: null,
      model: 'org/m',
      error: 'model missing'
    })
  })

  it('wiping and rebuilding the keyword search go to the sidecar', async () => {
    fake.on('POST /rag/wipe', json({ wiped: true }))
    fake.on('POST /rag/lexical/rebuild', json({ indexed: 321 }))

    expect(await state().indexWipe()).toBeNull()
    expect(await state().indexRebuildLexical()).toEqual({ indexed: 321 })
    expect(fake.requestsTo('POST /rag/wipe')).toHaveLength(1)
  })

  it('a refused rebuild says why', async () => {
    fake.on(
      'POST /rag/lexical/rebuild',
      json({ code: 'busy', message: 'ingest running', details: {} }, 409)
    )

    expect(await state().indexRebuildLexical()).toEqual({ error: 'ingest running' })
  })
})

const MB = 1024 * 1024

describe('the Foreign profile cache', () => {
  it('its size and cap are read from the sidecar', async () => {
    fake.on('GET /foreign/cache', json({ bytes: 5 * MB, profiles: 3, cap_bytes: 1024 * MB }))

    await state().foreignCacheLoad()

    expect(state().foreignCacheUsage).toEqual({ bytes: 5 * MB, profiles: 3, cap_bytes: 1024 * MB })
    expect(state().foreignCacheError).toBeNull()
  })

  it('a new cap is saved, then the profiles left after eviction are read', async () => {
    fake.on(
      'PUT /settings',
      json({ ...SETTINGS, foreign: { ...SETTINGS.foreign, cache_cap_mb: 100 } })
    )
    fake.on('GET /foreign/cache', json({ bytes: 90 * MB, profiles: 2, cap_bytes: 100 * MB }))

    expect(await state().foreignCacheSetCap(100)).toBeNull()

    expect(fake.requestsTo('PUT /settings')[0].body).toEqual({ foreign: { cache_cap_mb: 100 } })
    expect(state().settings?.foreign.cache_cap_mb).toBe(100)
    expect(state().foreignCacheUsage?.profiles).toBe(2)
  })

  it('clearing it keeps the size the sidecar reports after', async () => {
    fake.on(
      'DELETE /foreign/cache',
      json({ removed: 4, bytes: 0, profiles: 0, cap_bytes: 1024 * MB })
    )

    expect(await state().foreignCacheClear()).toBeNull()

    expect(state().foreignCacheUsage).toMatchObject({ bytes: 0, profiles: 0 })
  })

  it('a cache that cannot be read says why', async () => {
    fake.on('GET /foreign/cache', json({ code: 'internal', message: 'locked', details: {} }, 500))

    await state().foreignCacheLoad()

    expect(state().foreignCacheError).toBe('locked')
  })
})
