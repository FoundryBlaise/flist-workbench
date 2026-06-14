import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../state'

// Hint we prepend to F-list's verbatim "Login Failed…" string so users
// have a checklist of common causes (caps lock, trailing space, signing
// in with a character name instead of the account login) instead of
// only the bare F-list error which reads as an accusation.
function friendlierAuthHint(rawError: string | null): string | null {
  if (!rawError) return null
  if (/Login Failed|Invalid account/i.test(rawError)) {
    return (
      "F-list rejected this login. Common causes: Caps Lock is on, a trailing "
      + "space, or you used a character name instead of your account login."
    )
  }
  return null
}

export function SignInModal({ onClose }: { onClose: () => void }) {
  const signIn = useStore((s) => s.flistSignIn)
  const getLastAccount = useStore((s) => s.flistGetLastAccount)
  const status = useStore((s) => s.flistSignInStatus)
  const error = useStore((s) => s.flistSignInError)
  const savedCreds = useStore((s) => s.flistSavedCreds)
  // Lazy initializer reads the saved account BEFORE first paint so the
  // focus useEffect below sees the right `value` and routes initial
  // focus to the password field when an account is pre-filled. Without
  // this, the setAccount-in-useEffect race meant focus always landed on
  // the (now-pre-filled) account field.
  const [account, setAccount] = useState(() => getLastAccount())
  const [password, setPassword] = useState('')
  // Default both checkboxes from the saved-creds state: if the user
  // already has saved creds, the toggles should reflect that on
  // re-open. Auto login implies remember, so the truth is just two
  // flags surfaced from the keychain.
  const [rememberPassword, setRememberPassword] = useState(
    () => savedCreds.hasPassword || savedCreds.autoLogin
  )
  const [autoLogin, setAutoLogin] = useState(() => savedCreds.autoLogin)
  const accountRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  // When saved creds exist, pre-fill the password input on mount so
  // the user can simply hit Enter rather than re-typing. We fetch it
  // through the same keychain bridge the auto-login path uses — no
  // password ever lands in localStorage or any other on-disk store.
  useEffect(() => {
    let cancelled = false
    if (!savedCreds.hasPassword) return
    const credsApi = window.workbench?.creds
    if (!credsApi) return
    credsApi
      .getPassword()
      .then((pw) => {
        if (cancelled || !pw) return
        setPassword(pw)
      })
      .catch(() => {
        // Pre-fill is a convenience — failing here just means the
        // user types it again; never block the modal on this.
      })
    return () => {
      cancelled = true
    }
  }, [savedCreds.hasPassword])

  // Force-uncheck "Remember password" when the user disables it, and
  // auto-set it on when they enable auto-login (the keychain entry
  // is the prerequisite).
  const onAutoLoginChange = (next: boolean) => {
    setAutoLogin(next)
    if (next) setRememberPassword(true)
  }
  const onRememberChange = (next: boolean) => {
    setRememberPassword(next)
    if (!next) setAutoLogin(false)
  }

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
    await signIn(account.trim(), password, {
      rememberPassword,
      autoLogin
    })
    // The store closes the modal on success; on failure status flips to
    // 'error' with the message in `flistSignInError`. Either way we
    // clear the password from local state — never echo a wrong password
    // back into the input.
    setPassword('')
  }

  // Pressing Enter in the account field should advance to password when
  // password is empty, rather than submitting an incomplete form.
  const onAccountKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !password) {
      e.preventDefault()
      passwordRef.current?.focus()
    }
  }

  const friendly = friendlierAuthHint(error)

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
            <ul className="flist-signin-trust" aria-label="What we do with your password">
              <li>Stays on your computer</li>
              <li>Same login flow F-Chat uses</li>
              <li>Held in memory, gone when you sign out or close the app</li>
            </ul>
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
              onKeyDown={onAccountKeyDown}
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
          <div className="flist-signin-savelogin">
            <label className="flist-signin-checkbox">
              <input
                type="checkbox"
                checked={rememberPassword}
                onChange={(e) => onRememberChange(e.target.checked)}
                disabled={!savedCreds.encryptionAvailable && !savedCreds.hasPassword}
                data-testid="flist-signin-remember"
              />
              <span>Remember password</span>
            </label>
            <label className="flist-signin-checkbox">
              <input
                type="checkbox"
                checked={autoLogin}
                onChange={(e) => onAutoLoginChange(e.target.checked)}
                disabled={!savedCreds.encryptionAvailable && !savedCreds.hasPassword}
                data-testid="flist-signin-auto-login"
              />
              <span>Auto login next time</span>
            </label>
            <small className="flist-signin-savelogin-note">
              Your password goes into your operating system's credential
              store (Windows Credential Manager / macOS Keychain /
              libsecret) — never into a file. You can remove the saved
              login any time under <strong>Settings → F-list</strong>.
            </small>
            {!savedCreds.encryptionAvailable && (
              <small className="flist-signin-savelogin-warn">
                Your OS credential store isn't reachable — saving the
                password isn't available on this system.
              </small>
            )}
          </div>
          {error && (
            <div className="flist-signin-error" role="alert" data-testid="flist-signin-error">
              {friendly && <div className="flist-signin-error-hint">{friendly}</div>}
              <div className="flist-signin-error-raw">{error}</div>
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
