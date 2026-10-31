/**
 * My access → Sign-in & security: the caller's own password, two-factor
 * authentication and passkey enrollment.
 *
 * Self-service mutations call `auth.changeOwnPassword` / `auth.setupOwnTotp` /
 * `auth.confirmOwnTotp` / `auth.disableOwnTotp` — these bind to `ctx.user.id`
 * server-side so a non-admin user can manage their own credentials without an
 * admin gate.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertCircle, CheckCircle, Copy, KeyRound, Loader2, Lock, Smartphone } from 'lucide-react'
import { Button, useSystem, useWidgetMetadata, WidgetSlot, Input } from '@camstack/ui-library'
import { Trans, useTranslation } from 'react-i18next'

import { TotpQrCode } from './TotpQrCode'
import { useReauthPrompt } from '../auth/ReauthDialog'

// ── Change password ──────────────────────────────────────────────────

export function ChangePasswordSection(): ReactElement {
  const { t } = useTranslation()
  const system = useSystem()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null)

  const mutation = useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      system.changeOwnPassword(input),
    onSuccess: () => {
      setFeedback({ kind: 'success', msg: 'Password updated.' })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    },
    onError: (err: unknown) => {
      setFeedback({ kind: 'error', msg: err instanceof Error ? err.message : 'Update failed' })
    },
  })

  const mismatch =
    newPassword.length > 0 && confirmPassword.length > 0 && newPassword !== confirmPassword
  const tooShort = newPassword.length > 0 && newPassword.length < 8
  const ready =
    currentPassword.length >= 1 && newPassword.length >= 8 && newPassword === confirmPassword

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        <KeyRound className="h-3.5 w-3.5 text-foreground-subtle" />
        <div className="text-xs font-semibold text-foreground">
          {t('systemPage.myAccess.changePassword', 'Change password')}
        </div>
      </div>
      <div className="p-4 space-y-3">
        <PasswordField
          label={t('systemPage.myAccess.currentPassword', 'Current password')}
          value={currentPassword}
          onChange={setCurrentPassword}
          autoComplete="current-password"
        />
        <PasswordField
          label={t('systemPage.myAccess.newPassword', 'New password')}
          value={newPassword}
          onChange={setNewPassword}
          autoComplete="new-password"
          hint={t('systemPage.myAccess.atLeast8Characters', 'At least 8 characters.')}
        />
        <PasswordField
          label={t('systemPage.myAccess.confirmNewPassword', 'Confirm new password')}
          value={confirmPassword}
          onChange={setConfirmPassword}
          autoComplete="new-password"
        />
        {(mismatch || tooShort) && (
          <div className="text-[11px] text-danger">
            {mismatch
              ? t('systemPage.myAccess.passwordsDoNotMatch', 'Passwords do not match.')
              : t(
                  'systemPage.myAccess.newPasswordMustBeAt',
                  'New password must be at least 8 characters.',
                )}
          </div>
        )}
        {feedback && (
          <div
            className={`text-[11px] flex items-center gap-1 ${feedback.kind === 'success' ? 'text-success' : 'text-danger'}`}
          >
            {feedback.kind === 'success' ? (
              <CheckCircle className="h-3 w-3" />
            ) : (
              <AlertCircle className="h-3 w-3" />
            )}
            {feedback.msg}
          </div>
        )}
        <div className="flex justify-end">
          <Button
            onClick={() => {
              setFeedback(null)
              mutation.mutate({ currentPassword, newPassword })
            }}
            disabled={!ready || mutation.isPending}
          >
            {mutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Lock className="h-3 w-3" />
            )}
            {t('systemPage.myAccess.updatePassword', 'Update password')}
          </Button>
        </div>
      </div>
    </div>
  )
}

interface PasswordFieldProps {
  readonly label: string
  readonly value: string
  readonly onChange: (v: string) => void
  readonly autoComplete: string
  readonly hint?: string
}

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  hint,
}: PasswordFieldProps): ReactElement {
  return (
    <div className="space-y-1">
      <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">{label}</label>
      <Input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
      />
      {hint && <div className="text-[10px] text-foreground-subtle">{hint}</div>}
    </div>
  )
}

// ── Two-factor authentication (self) ─────────────────────────────────

interface TotpSectionProps {
  readonly username: string
}

export function TotpSection({ username }: TotpSectionProps): ReactElement {
  const { t } = useTranslation()
  const system = useSystem()
  const statusQuery = useQuery({
    queryKey: ['auth', 'getOwnTotpStatus'],
    queryFn: () => system.getOwnTotpStatus(),
  })
  const status = statusQuery.data

  const [setupResult, setSetupResult] = useState<{ secret: string; otpauthUrl: string } | null>(
    null,
  )
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const setupMutation = useMutation({
    mutationFn: () => system.setupOwnTotp(),
    onSuccess: (r) => {
      setSetupResult({ secret: r.secret, otpauthUrl: r.otpauthUrl })
      setCode('')
      setError(null)
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Setup failed'),
  })
  const confirmMutation = useMutation({
    mutationFn: (input: { code: string }) => system.confirmOwnTotp(input),
    onSuccess: () => {
      setSetupResult(null)
      setCode('')
      setError(null)
      void statusQuery.refetch()
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'Confirmation failed — code did not match'),
  })
  // Turning 2FA off needs a fresh proof (password or passkey), not just the session.
  const reauth = useReauthPrompt('Turning off two-factor authentication')
  const disableMutation = useMutation({
    mutationFn: async () => {
      const reauthToken = await reauth.requestProof()
      if (reauthToken === null) return null
      return system.disableOwnTotp({ reauthToken })
    },
    onSuccess: () => {
      setError(null)
      void statusQuery.refetch()
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Disable failed'),
  })

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const phase = useMemo<'loading' | 'not_enrolled' | 'setup_in_progress' | 'enrolled'>(() => {
    if (statusQuery.isLoading) return 'loading'
    if (setupResult) return 'setup_in_progress'
    if (status?.enabled) return 'enrolled'
    return 'not_enrolled'
  }, [statusQuery.isLoading, status?.enabled, setupResult])

  const copySecret = (): void => {
    if (!setupResult) return
    void navigator.clipboard.writeText(setupResult.secret).then(() => setCopied(true))
  }

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      {reauth.dialog}
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        <Smartphone className="h-3.5 w-3.5 text-foreground-subtle" />
        <div className="text-xs font-semibold text-foreground">
          {t('systemPage.myAccess.twoFactorAuthentication', 'Two-factor authentication')}
        </div>
      </div>
      <div className="p-4 space-y-3">
        {phase === 'loading' && (
          <div className="flex items-center gap-2 text-xs text-foreground-subtle">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('systemPage.myAccess.checkingStatus', 'Checking status…')}
          </div>
        )}

        {phase === 'not_enrolled' && (
          <>
            <div className="text-xs text-foreground-subtle">
              {t(
                'systemPage.myAccess.2faIsnTActiveOn',
                "2FA isn't active on your account. Enable it to require a 6-digit code from your authenticator app at every login.",
              )}
            </div>
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  setError(null)
                  setupMutation.mutate()
                }}
                disabled={setupMutation.isPending}
              >
                {setupMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Smartphone className="h-3 w-3" />
                )}
                {t('systemPage.myAccess.enable2fa', 'Enable 2FA')}
              </Button>
            </div>
          </>
        )}

        {phase === 'setup_in_progress' && setupResult && (
          <>
            <div className="text-[11px] text-foreground-subtle">
              <Trans
                i18nKey="systemPage.myAccess.scanQr"
                values={{ username }}
                components={{ mono: <span className="font-mono" /> }}
              />
            </div>
            <div className="flex flex-col items-center gap-3">
              {/* ui-check-ok: a QR code needs a white quiet zone in both themes to scan */}
              <div className="rounded-lg border border-border bg-white p-3">
                <TotpQrCode value={setupResult.otpauthUrl} size={180} />
              </div>
              <div className="w-full">
                <div className="text-[10px] uppercase tracking-wide text-foreground-subtle mb-1">
                  {t('systemPage.myAccess.secretManualEntry', 'Secret (manual entry)')}
                </div>
                <div className="flex items-center gap-2 rounded border border-border bg-surface-hover/30 px-2 py-1.5">
                  <code className="text-[11px] font-mono text-foreground break-all flex-1">
                    {setupResult.secret}
                  </code>
                  <Button variant="ghost" onClick={copySecret}>
                    {copied ? (
                      <CheckCircle className="h-3 w-3 text-success" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    {copied ? t('systemPage.myAccess.copied', 'Copied') : t('common.copy', 'Copy')}
                  </Button>
                </div>
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
                6-digit code
              </label>
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-center text-lg font-mono tracking-widest text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            {error && (
              <div className="text-[11px] text-danger flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setSetupResult(null)
                  setError(null)
                  setCode('')
                }}
              >
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                onClick={() => {
                  setError(null)
                  confirmMutation.mutate({ code })
                }}
                disabled={confirmMutation.isPending || code.length !== 6}
              >
                {confirmMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <CheckCircle className="h-3 w-3" />
                )}
                {t('common.confirm', 'Confirm')}
              </Button>
            </div>
          </>
        )}

        {phase === 'enrolled' && status && (
          <>
            <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2.5 flex items-start gap-2.5">
              <CheckCircle className="h-4 w-4 mt-0.5 text-success shrink-0" />
              <div className="text-xs text-foreground space-y-0.5">
                <div className="font-medium">
                  {t('systemPage.myAccess.2faIsActive', '2FA is active')}
                </div>
                <div className="text-foreground-subtle">
                  {t('common.enrolledOn', {
                    when: status.confirmedAt ? new Date(status.confirmedAt).toLocaleString() : '—',
                  })}
                </div>
              </div>
            </div>
            {error && (
              <div className="text-[11px] text-danger flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {error}
              </div>
            )}
            <div className="flex justify-end">
              <Button
                variant="danger"
                onClick={() => {
                  setError(null)
                  disableMutation.mutate()
                }}
                disabled={disableMutation.isPending}
              >
                {disableMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Smartphone className="h-3 w-3" />
                )}
                {t('systemPage.myAccess.disable2fa', 'Disable 2FA')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Passkeys (self) ──────────────────────────────────────────────────
//
// Self-service WebAuthn enrollment lives ENTIRELY in the `auth-webauthn`
// addon's `passkey-enrollment` Module-Federation widget — the whole
// browser ceremony (`@simplewebauthn/browser`) ships inside the addon,
// never the shell. The section is cap-driven: it renders only when the
// widget is registered (i.e. an `auth-webauthn` / `user-passkeys`
// provider is installed), which the widget registry reports. The
// `widgetId` string is the sole well-known identifier the shell
// references; the provider stays fully pluggable behind the cap.

export function PasskeySection(): ReactElement | null {
  const meta = useWidgetMetadata('auth-webauthn/passkey-enrollment')
  if (!meta) return null
  return <WidgetSlot widgetId="auth-webauthn/passkey-enrollment" host="dashboard" />
}
