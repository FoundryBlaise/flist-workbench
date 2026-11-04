// A refused sign-in: the modal adds its checklist of common causes when
// the sidecar's code says F-list turned the login down, however F-list
// words it, and not for a sign-in that failed for another reason.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useStore } from '../../../state'
import { SignInModal } from '../SignInModal'
import { installFakeApi, json, type FakeApi } from '../../../test/fakeApi'

const HINT = /F-list rejected this login/

let fake: FakeApi

beforeEach(() => {
  fake = installFakeApi()
  useStore.setState({
    flistSignInOpen: true,
    flistSignInAttempt: { status: 'idle' }
  })
})

afterEach(() => {
  cleanup()
  fake.restore()
  vi.restoreAllMocks()
})

async function signInRefused(code: string, message: string, status: number) {
  fake.on('POST /flist/session', json({ code, message, details: {} }, status))
  render(<SignInModal onClose={() => {}} />)
  fireEvent.change(screen.getByTestId('flist-signin-account'), {
    target: { value: 'Quill Account' }
  })
  fireEvent.change(screen.getByTestId('flist-signin-password'), { target: { value: 'wrong' } })
  fireEvent.click(screen.getByTestId('flist-signin-submit'))
  await waitFor(() => expect(useStore.getState().flistSignInAttempt.status).toBe('error'))
}

it('explains a login F-list turned down, whatever F-list said', async () => {
  await signInRefused('sign_in_failed', 'The password does not match this account.', 401)

  expect(screen.getByText('The password does not match this account.')).toBeTruthy()
  expect(screen.getByText(HINT)).toBeTruthy()
})

it('gives no login checklist when F-list could not be reached', async () => {
  await signInRefused('flist_error', 'Invalid account data from upstream', 502)

  expect(screen.getByText('Invalid account data from upstream')).toBeTruthy()
  expect(screen.queryByText(HINT)).toBeNull()
})
