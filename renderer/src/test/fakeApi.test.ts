// The fake sidecar the renderer tests talk to. These cases pin the
// parts other tests lean on: what gets recorded, which reply wins, and
// that held requests settle only when — and in the order — a test says.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { installFakeApi, json, networkError, type FakeApi } from './fakeApi'

const BASE = 'http://127.0.0.1:27384'
const ORIGINAL_FETCH = globalThis.fetch
let fake: FakeApi

beforeEach(() => {
  fake = installFakeApi()
})

afterEach(() => {
  fake.restore()
})

it('records method, path, headers and parsed body of every request', async () => {
  fake.on('PUT /flist/character/7/sets/s1/payload', json({ etag: 'e2' }))

  const res = await fetch(`${BASE}/flist/character/7/sets/s1/payload`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': 'e1' },
    body: JSON.stringify({ character: { description: 'hi' } })
  })

  expect(await res.json()).toEqual({ etag: 'e2' })
  expect(fake.requests).toEqual([
    {
      method: 'PUT',
      path: '/flist/character/7/sets/s1/payload',
      headers: { 'Content-Type': 'application/json', 'If-Match': 'e1' },
      body: { character: { description: 'hi' } }
    }
  ])
})

it('serves one-shot replies in order before falling back to the standing one', async () => {
  fake.on('GET /a', json('standing'))
  fake.once('GET /a', json('first'))
  fake.once('GET /a', json('second'))

  const read = async () => (await fetch(`${BASE}/a`)).json()
  expect([await read(), await read(), await read()]).toEqual([
    'first',
    'second',
    'standing'
  ])
})

it('matches the query string only when the route names one', async () => {
  fake.on('GET /w', json('any'))
  fake.on('GET /w?create=false', json('exact'))

  expect(await (await fetch(`${BASE}/w?create=false`)).json()).toBe('exact')
  expect(await (await fetch(`${BASE}/w?x=1`)).json()).toBe('any')
})

it('carries status codes so the app sees errors', async () => {
  fake.on('GET /gone', json({ detail: 'nope' }, 404))
  const res = await fetch(`${BASE}/gone`)
  expect(res.ok).toBe(false)
  expect(res.status).toBe(404)
})

it('holds requests until the test settles them, in any order', async () => {
  fake.hold('PUT /save')
  const first = fetch(`${BASE}/save`, { method: 'PUT', body: '"one"' })
  const second = fetch(`${BASE}/save`, { method: 'PUT', body: '"two"' })

  const [p1, p2] = fake.pending('PUT /save')
  expect(p1.request.body).toBe('one')
  expect(p2.request.body).toBe('two')

  p2.resolve(json('second done'))
  expect(await (await second).json()).toBe('second done')
  expect(fake.pending()).toEqual([p1])

  p1.reject(networkError('sidecar down'))
  await expect(first).rejects.toThrow('sidecar down')
  expect(fake.pending()).toEqual([])
})

it('rejects a request nothing answers, naming it', async () => {
  await expect(fetch(`${BASE}/nowhere`, { method: 'POST' })).rejects.toThrow(
    'POST /nowhere'
  )
  expect(fake.requests.map((r) => r.path)).toEqual(['/nowhere'])
})

it('answers unrouted requests with the fallback when one is set', async () => {
  fake.fallback(json({}))
  expect(await (await fetch(`${BASE}/whatever`)).json()).toEqual({})
})

it('a reply can be computed from the request', async () => {
  fake.on(/^POST \/echo/, (req) => json({ got: req.body }))
  const res = await fetch(`${BASE}/echo`, { method: 'POST', body: '{"n":1}' })
  expect(await res.json()).toEqual({ got: { n: 1 } })
})

it('restore rejects whatever is still held and puts fetch back', async () => {
  fake.hold('GET /slow')
  const slow = fetch(`${BASE}/slow`)
  fake.restore()
  await expect(slow).rejects.toThrow(/test ended/)
  expect(globalThis.fetch).toBe(ORIGINAL_FETCH)
  fake = installFakeApi()
})
