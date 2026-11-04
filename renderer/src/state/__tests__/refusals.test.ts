// The sidecar answers every error as `{code, message, details}` (#28,
// #69). These cases pin that the window shows the sidecar's reason, and
// gets its code and details, rather than a bare HTTP status.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { api, errorDetail, HttpError, RefusalError, refusalCode } from '../../lib/api'
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
    json({ code: 'log_not_found', message: 'no such log', details: {} }, 404)
  )

  await useStore.getState().loadMessages('me', 'stranger')

  const errors = Object.values(useStore.getState().messagesError)
  expect(errors).toEqual(['HTTP 404: no such log'])
})

it('hands the refusal code to the caller', async () => {
  fake.on(
    'GET /flist/character/7/zip-backups/bad.zip/payload',
    json({ code: 'invalid_file_name', message: 'invalid backup filename', details: {} }, 400)
  )

  const err = await api.flistZipBackupPayload('7', 'bad.zip').catch((e: unknown) => e)

  expect(err).toBeInstanceOf(RefusalError)
  expect((err as RefusalError).message).toBe('HTTP 400: invalid backup filename')
  expect((err as RefusalError).code).toBe('invalid_file_name')
  expect((err as RefusalError).status).toBe(400)
})

it('takes no code the sidecar schema does not list for a refusal code', async () => {
  fake.on('GET /logs/characters', json({ code: 'busy', message: 'try later', details: {} }, 409))

  const err = await api.characters().catch((e: unknown) => e)

  expect(err).toBeInstanceOf(HttpError)
  expect(err).not.toBeInstanceOf(RefusalError)
  expect(refusalCode(err)).toBeNull()
  expect(errorDetail(err)).toBe('try later')
})

it('hands the details to the caller', async () => {
  fake.on(
    'PUT /settings',
    json(
      {
        code: 'validation_failed',
        message: 'fchat_data_dir: directory does not exist: X:\nowhere',
        details: { field: 'fchat_data_dir', reason: 'directory does not exist: X:\nowhere' }
      },
      400
    )
  )

  const err = await api.settingsUpdate({ fchat_data_dir: 'X:\nowhere' }).catch((e: unknown) => e)

  expect(err).toBeInstanceOf(RefusalError)
  expect((err as RefusalError).code).toBe('validation_failed')
  expect((err as RefusalError).details.field).toBe('fchat_data_dir')
})

it('no longer reads a reason nested in the retired `detail` field', async () => {
  fake.on(
    'GET /foreign/character/Nobody',
    json({ detail: { code: 'not_found', message: 'no such character' } }, 404)
  )

  const err = await api.foreignProfile('Nobody').catch((e: unknown) => e)

  expect(err).toBeInstanceOf(Error)
  expect(err).not.toBeInstanceOf(RefusalError)
  expect((err as Error).message).not.toContain('no such character')
})
