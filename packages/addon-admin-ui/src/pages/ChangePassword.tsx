import { useSystem, useThemeMode } from '@camstack/ui-library'
import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { TFunction } from 'i18next'
import { useAuth } from '../contexts/auth-context'
import { classifyChangePasswordError } from '../lib/change-password-error'
import { hubPath } from '../lib/mount'
import { SEED_ADMIN_PASSWORD } from '../lib/seed-admin'
import { useTranslation } from 'react-i18next'

const MIN_PASSWORD_LENGTH = 8

/**
 * The text for a failed change. Every case the hub can tell apart is named —
 * "Unknown error" is what a request whose socket closed under it looks like,
 * and an operator read it as "the change failed" when it had gone through.
 */
function changePasswordErrorText(err: unknown, t: TFunction): string {
  const failure = classifyChangePasswordError(err)
  switch (failure.kind) {
    case 'wrong-current':
      return t('changePassword.errorWrongCurrent', 'The current password is incorrect.')
    case 'session-ended':
      return t(
        'changePassword.errorSessionEnded',
        'Your session ended before the change was confirmed. Sign in again — try the new password first.',
      )
    case 'connection-lost':
      return t(
        'changePassword.errorConnectionLost',
        'The connection to the hub dropped before it confirmed the change. Sign in again — try the new password first.',
      )
    case 'rejected':
      return failure.message
  }
}

export function ChangePasswordPage() {
  const { t } = useTranslation()
  const { user, mustChangePassword, clearMustChangePassword, logout } = useAuth()
  const system = useSystem()
  const theme = useThemeMode()
  const navigate = useNavigate()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  // The caller's OWN change (`auth.changeOwnPassword`): it keeps THIS session
  // and ends the others. The admin reset (`userManagement.resetPassword`) this
  // page used to call ends every session of the user — this one too, socket
  // and all — so the request died under the operator after the new password
  // was already stored. A forced rotation knows the current password: the
  // forced state was derived from the seed default itself.
  const currentPassword = mustChangePassword ? SEED_ADMIN_PASSWORD : current

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    setError('')
    if (!user) {
      setError('Not signed in')
      return
    }
    if (!mustChangePassword && current.length === 0) {
      setError(t('changePassword.enterCurrent', 'Enter your current password'))
      return
    }
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
      return
    }
    if (next !== confirm) {
      setError('The two passwords do not match')
      return
    }
    if (next === SEED_ADMIN_PASSWORD) {
      setError('Choose a password different from the seed default')
      return
    }
    setPending(true)
    try {
      await system.changeOwnPassword({ currentPassword, newPassword: next })
      clearMustChangePassword()
      navigate('/devices', { replace: true })
    } catch (err: unknown) {
      setError(changePasswordErrorText(err, t))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <img
            src={
              theme?.resolvedMode === 'light'
                ? hubPath('/brand/logo-horizontal-light.svg')
                : hubPath('/brand/logo-horizontal-dark.svg')
            }
            alt={t('changePassword.camstackAdmin', 'CamStack Admin')}
            className="h-12"
          />
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-xl border border-border bg-surface p-6 shadow-xl shadow-black/10"
        >
          <div className="space-y-1">
            <h1 className="text-sm font-semibold text-foreground">
              {t('changePassword.setANewPassword', 'Set a new password')}
            </h1>
            <p className="text-xs text-foreground-subtle">
              {mustChangePassword
                ? t(
                    'changePassword.youMustRotateTheSeed',
                    'You must rotate the seed password before continuing.',
                  )
                : t(
                    'changePassword.chooseANewPasswordFor',
                    'Choose a new password for your account.',
                  )}
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-md bg-danger/10 border border-danger/20 px-3 py-2 text-xs text-danger"
            >
              {error}
            </div>
          )}

          {!mustChangePassword && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground-subtle">
                {t('changePassword.currentPassword', 'Current password')}
              </label>
              <input
                data-testid="change-password-current"
                type={show ? 'text' : 'password'}
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-foreground-disabled focus:border-primary focus:ring-1 focus:ring-primary/30 outline-none transition-all"
                autoFocus
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground-subtle">
              {t('changePassword.newPassword', 'New password')}
            </label>
            <div className="relative">
              <input
                data-testid="change-password-new"
                type={show ? 'text' : 'password'}
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 pr-10 text-sm text-foreground placeholder:text-foreground-disabled focus:border-primary focus:ring-1 focus:ring-primary/30 outline-none transition-all"
                autoFocus={mustChangePassword}
              />
              <button
                type="button"
                onClick={() => setShow(!show)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-foreground-subtle hover:text-foreground transition-colors"
                tabIndex={-1}
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground-subtle">
              {t('changePassword.confirmNewPassword', 'Confirm new password')}
            </label>
            <input
              data-testid="change-password-confirm"
              type={show ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-foreground-disabled focus:border-primary focus:ring-1 focus:ring-primary/30 outline-none transition-all"
            />
          </div>

          <button
            data-testid="change-password-submit"
            type="submit"
            disabled={pending || !next || !confirm}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/20 hover:shadow-lg hover:shadow-primary/30 disabled:opacity-50 disabled:shadow-none transition-all"
          >
            {pending
              ? t('changePassword.saving', 'Saving…')
              : t('changePassword.saveAndContinue', 'Save and continue')}
          </button>

          {mustChangePassword && (
            <button
              type="button"
              onClick={() => {
                logout()
                navigate('/login', { replace: true })
              }}
              className="w-full text-xs text-foreground-subtle hover:text-foreground transition-colors"
            >
              {t('changePassword.signOutInstead', 'Sign out instead')}
            </button>
          )}
        </form>
      </div>
    </div>
  )
}
