/**
 * PasskeyEnrollment — `passkey-enrollment` widget (POST-auth).
 *
 * Owned by the `auth-webauthn` addon so the whole WebAuthn browser
 * ceremony (`@simplewebauthn/browser`) lives inside the addon bundle, not
 * the admin shell. Mounted by admin-ui's "My access" page via
 * `<WidgetSlot widgetId="auth-webauthn/passkey-enrollment" />`. The
 * section only appears when a `user-passkeys` provider is installed —
 * that gate is the widget registry itself (no widget ⇒ WidgetSlot renders
 * nothing meaningful), which is driven by THIS addon registering its
 * `addon-widgets-source` provider.
 *
 * Self-service: drives entirely off the cap-backed `auth.*OwnPasskey*`
 * procedures (server-bound to `ctx.user.id`) exposed on the SDK `System`.
 */
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertCircle, Fingerprint, KeyRound, Loader2, Trash2 } from 'lucide-react'
import { useSystem, type WidgetProps, Button, Input } from '@camstack/ui-library'
import type { PasskeySummary } from '@camstack/types'
import { runPasskeyAuthentication, runPasskeyRegistration } from './passkey-ceremony'
import { useT } from '../../i18n'

export function PasskeyEnrollment(_props: WidgetProps) {
  const system = useSystem()
  const { t, lang } = useT()
  const listQuery = useQuery({
    queryKey: ['auth', 'listOwnPasskeys'],
    queryFn: () => system.listOwnPasskeys(),
  })
  const passkeys: readonly PasskeySummary[] = listQuery.data ?? []

  const [label, setLabel] = useState('')
  const [enrolling, setEnrolling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Second-factor preference (opt-in, default OFF). Only meaningful —
  // and only shown — once at least one passkey is enrolled.
  const prefQuery = useQuery({
    queryKey: ['auth', 'getOwnPasskeySecondFactorPreference'],
    queryFn: () => system.getOwnPasskeySecondFactorPreference(),
    enabled: passkeys.length > 0,
  })
  const prefEnabled = prefQuery.data?.enabled ?? false
  const prefMutation = useMutation({
    mutationFn: (enabled: boolean) => system.setOwnPasskeySecondFactorPreference({ enabled }),
    onSuccess: () => {
      setError(null)
      void prefQuery.refetch()
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : t('enrollment.preferenceFailed')),
  })

  const enroll = async () => {
    setError(null)
    setEnrolling(true)
    try {
      const begin = await system.beginOwnPasskeyRegistration()
      const attestation = await runPasskeyRegistration(begin.optionsJSON)
      await system.finishOwnPasskeyRegistration({
        response: attestation,
        label: label.trim() || t('enrollment.unnamedDevice'),
      })
      setLabel('')
      void listQuery.refetch()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('enrollment.enrollFailed'))
    } finally {
      setEnrolling(false)
    }
  }

  // Removing a passkey needs a fresh proof — the password or ANOTHER
  // passkey — not just the session (the hub refuses it otherwise).
  const [confirming, setConfirming] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const removeMutation = useMutation({
    mutationFn: async (input: {
      credentialId: string
      proof: { password: string } | { passkey: true }
    }) => {
      let reauthToken: string
      if ('password' in input.proof) {
        reauthToken = (await system.reauthenticate({ password: input.proof.password })).reauthToken
      } else {
        const { optionsJSON } = await system.reauthBeginPasskey()
        const passkeyResponse = await runPasskeyAuthentication(optionsJSON)
        reauthToken = (await system.reauthenticate({ passkeyResponse })).reauthToken
      }
      return system.removeOwnPasskey({ credentialId: input.credentialId, reauthToken })
    },
    onSuccess: () => {
      setError(null)
      setConfirming(null)
      setPassword('')
      void listQuery.refetch()
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : t('enrollment.removeFailed')),
  })

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        <Fingerprint className="h-3.5 w-3.5 text-foreground-subtle" />
        <div className="text-xs font-semibold text-foreground">{t('enrollment.title')}</div>
      </div>
      <div className="p-4 space-y-3">
        <div className="text-xs text-foreground-subtle">{t('enrollment.intro')}</div>

        {listQuery.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-foreground-subtle">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('enrollment.loading')}
          </div>
        ) : passkeys.length > 0 ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {passkeys.map((p) => (
              <li key={p.credentialId} className="flex items-center gap-3 px-3 py-2 text-xs">
                <KeyRound className="h-3.5 w-3.5 text-foreground-subtle shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-foreground truncate">{p.label}</div>
                  <div className="text-[10px] text-foreground-subtle">
                    {p.lastUsedAt
                      ? t('enrollment.addedUsed', {
                          added: new Date(p.createdAt).toLocaleDateString(lang),
                          used: new Date(p.lastUsedAt).toLocaleDateString(lang),
                        })
                      : t('enrollment.addedNever', {
                          added: new Date(p.createdAt).toLocaleDateString(lang),
                        })}
                  </div>
                </div>
                {confirming === p.credentialId ? (
                  <form
                    className="flex items-center gap-1.5"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (password.length > 0) {
                        removeMutation.mutate({ credentialId: p.credentialId, proof: { password } })
                      }
                    }}
                  >
                    <Input
                      type="password"
                      autoComplete="current-password"
                      aria-label={t('enrollment.currentPassword')}
                      placeholder={t('enrollment.passwordToConfirm')}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-36 rounded border border-border bg-background px-2 py-1 text-[11px]"
                    />
                    <Button
                      variant="unstyled"
                      type="submit"
                      disabled={password.length === 0 || removeMutation.isPending}
                      className="rounded px-2 py-1 text-[11px] text-danger hover:bg-danger/10 disabled:opacity-50"
                    >
                      {t('enrollment.remove')}
                    </Button>
                    <Button
                      variant="unstyled"
                      type="button"
                      disabled={removeMutation.isPending}
                      onClick={() =>
                        removeMutation.mutate({
                          credentialId: p.credentialId,
                          proof: { passkey: true },
                        })
                      }
                      className="rounded px-2 py-1 text-[11px] text-foreground-subtle hover:bg-surface-hover disabled:opacity-50"
                    >
                      {t('enrollment.usePasskey')}
                    </Button>
                  </form>
                ) : (
                  <Button
                    variant="unstyled"
                    onClick={() => {
                      setError(null)
                      setPassword('')
                      setConfirming(p.credentialId)
                    }}
                    disabled={removeMutation.isPending}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-danger hover:bg-danger/10 disabled:opacity-50"
                  >
                    <Trash2 className="h-3 w-3" />
                    {t('enrollment.remove')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-[11px] text-foreground-subtle">{t('enrollment.none')}</div>
        )}

        {passkeys.length > 0 && (
          <div className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground">
                {t('enrollment.secondFactorTitle')}
              </div>
              <div className="text-[10px] text-foreground-subtle mt-0.5">
                {t('enrollment.secondFactorHint')}
              </div>
            </div>
            <Button
              variant="unstyled"
              type="button"
              role="switch"
              aria-checked={prefEnabled}
              aria-label={t('enrollment.secondFactorTitle')}
              onClick={() => prefMutation.mutate(!prefEnabled)}
              disabled={prefQuery.isLoading || prefMutation.isPending}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                prefEnabled ? 'bg-primary' : 'bg-foreground-subtle/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                  prefEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                }`}
              />
            </Button>
          </div>
        )}

        {error && (
          <div className="text-[11px] text-danger flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            {error}
          </div>
        )}

        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
              {t('enrollment.passkeyName')}
            </label>
            <Input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('enrollment.namePlaceholder')}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <Button
            variant="unstyled"
            onClick={enroll}
            disabled={enrolling}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {enrolling ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('enrollment.enrolling')}
              </>
            ) : (
              <>
                <Fingerprint className="h-3.5 w-3.5" />
                {t('enrollment.addPasskey')}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
