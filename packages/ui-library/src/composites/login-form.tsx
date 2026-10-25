import { useUiText } from '../contexts/ui-text'
import { type SyntheticEvent, useState, type JSX } from 'react'
import { cn } from '../lib/cn'

export interface LoginFormProps {
  onLogin: (username: string, password: string) => Promise<void>
  serverUrl?: string
  logoSrc?: string
  error?: string
  className?: string
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </svg>
  )
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

export function LoginForm({
  onLogin,
  serverUrl,
  logoSrc,
  error: externalError,
  className,
}: LoginFormProps): JSX.Element {
  const t = useUiText()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [internalError, setInternalError] = useState<string | null>(null)

  const error = externalError ?? internalError

  const handleSubmit = async (e: SyntheticEvent) => {
    e.preventDefault()
    if (submitting) return

    setInternalError(null)
    setSubmitting(true)

    try {
      await onLogin(username, password)
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('uiLibrary.loginForm.failed', 'Login failed. Please try again.')
      setInternalError(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className={cn('flex min-h-screen items-center justify-center bg-background p-4', className)}
    >
      <div className="w-full max-w-sm">
        {logoSrc && (
          <div className="flex justify-center mb-8">
            <img src={logoSrc} alt={t('uiLibrary.loginForm.logo', 'Logo')} className="h-12" />
          </div>
        )}

        {serverUrl && (
          <p className="mb-4 text-center text-xs text-foreground-subtle truncate">{serverUrl}</p>
        )}

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-xl border border-border bg-surface p-6 shadow-xl shadow-black/10"
        >
          {error && (
            <div className="rounded-md bg-danger/10 border border-danger/20 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground-subtle">
              {t('uiLibrary.loginForm.username', 'Username')}
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground-subtle">
              {t('uiLibrary.loginForm.password', 'Password')}
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 pr-10 text-sm text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-foreground-subtle hover:text-foreground"
                tabIndex={-1}
              >
                {showPassword ? (
                  <EyeOffIcon className="h-4 w-4" />
                ) : (
                  <EyeIcon className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
          >
            {submitting && <SpinnerIcon className="h-4 w-4 animate-spin" />}
            {submitting
              ? t('uiLibrary.loginForm.submitting', 'Logging in...')
              : t('uiLibrary.loginForm.submit', 'Log in')}
          </button>
        </form>
      </div>
    </div>
  )
}
