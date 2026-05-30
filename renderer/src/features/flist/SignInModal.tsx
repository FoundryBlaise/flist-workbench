import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../state'

export function SignInModal({ onClose }: { onClose: () => void }) {
  const signIn = useStore((s) => s.flistSignIn)
  const getLastAccount = useStore((s) => s.flistGetLastAccount)
  const status = useStore((s) => s.flistSignInStatus)
  const error = useStore((s) => s.flistSignInError)
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const accountRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setAccount(getLastAccount())
  }, [getLastAccount])

  // Focus the first empty field on mount. requestAnimationFrame lets
  // the modal mount before we steal focus from whatever opened it.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const target = (accountRef.current?.value ? passwordRef : accountRef).current
      target?.focus()
      target?.select()
    })
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (status === 'submitting') return
    if (!account.trim() || !password) return
    await signIn(account.trim(), password)
    // The store closes the modal on success; on failure status flips to
    // 'error' with the message in `flistSignInError`. Either way we
    // clear the password from local state — never echo a wrong password
    // back into the input.
    setPassword('')
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal flist-signin-modal">
        <header className="modal-head">
          <div>
            <h2 className="modal-title">Sign in to F-list</h2>
            <p className="modal-subtitle">
              Used only to pull your character profiles. Workbench holds the
              session in memory until you sign out — your password is never
              written to disk.
            </p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <form className="modal-body flist-signin-body" onSubmit={onSubmit}>
          <label className="flist-signin-field">
            <span>F-list account name</span>
            <input
              ref={accountRef}
              type="text"
              autoComplete="username"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              spellCheck={false}
              data-testid="flist-signin-account"
            />
            <small>Your login, not a character name.</small>
          </label>
          <label className="flist-signin-field">
            <span>Password</span>
            <input
              ref={passwordRef}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="flist-signin-password"
            />
          </label>
          {error && (
            <div className="flist-signin-error" role="alert" data-testid="flist-signin-error">
              {error}
            </div>
          )}
          <footer className="modal-foot">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onClose}
              disabled={status === 'submitting'}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={
                status === 'submitting' || !account.trim() || !password
              }
              data-testid="flist-signin-submit"
            >
              {status === 'submitting' ? 'Signing in…' : 'Sign in'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
