// The sidecar answers every refusal as `{code, message}` (#28). These
// cases pin that the window shows the sidecar's reason, and gets its
// code, rather than a bare HTTP status.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { api, RefusalError } from '../../lib/api'
import { useStore } from '../../state'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'

let fake: FakeApi

beforeEach(() => {
  fake = installFakeApi()
  useStore.setState({ messagesStatus: {}, messagesError: {} })
})

afterEach(() => {
  fake.restore()
})

it('shows the reason a Log was refused', async () => {
  fake.on(
    'GET /logs/messages',
    json({ code: 'log_not_found', message: 'no such log' }, 404)
  )

  await useStore.getState().loadMessages('me', 'stranger')

  const errors = Object.values(useStore.getState().messagesError)
  expect(errors).toEqual(['HTTP 404: no such log'])
})

it('hands the refusal code to the caller', async () => {
  fake.on(
    'GET /flist/character/7/zip-backups/bad.zip/payload',
    json({ code: 'invalid_file_name', message: 'invalid backup filename' }, 400)
  )

  const err = await api.flistZipBackupPayload('7', 'bad.zip').catch((e: unknown) => e)

  expect(err).toBeInstanceOf(RefusalError)
  expect((err as RefusalError).message).toBe('HTTP 400: invalid backup filename')
  expect((err as RefusalError).code).toBe('invalid_file_name')
  expect((err as RefusalError).status).toBe(400)
})

it('still reads a message the sidecar nests in `detail`', async () => {
  fake.on(
    'GET /foreign/character/Nobody',
    json({ detail: { code: 'not_found', message: 'no such character' } }, 404)
  )

  const err = await api.foreignProfile('Nobody').catch((e: unknown) => e)

  expect(err).toBeInstanceOf(RefusalError)
  expect((err as RefusalError).message).toBe('HTTP 404: no such character')
  expect((err as RefusalError).code).toBe('not_found')
})
