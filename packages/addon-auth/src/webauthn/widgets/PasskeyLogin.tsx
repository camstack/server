/**
 * PasskeyLogin — `passkey-login` widget (PRE-auth, second-factor stage).
 *
 * Owned by the `auth-webauthn` addon so the login-page WebAuthn ceremony
 * (`@simplewebauthn/browser`) lives inside the addon bundle. The admin
 * shell's login page discovers this widget through the PUBLIC
 * `auth.listLoginMethods` login-method channel (the registry listing is
 * auth-gated and unusable pre-auth), loads the bundle via
 * `loadRemoteBundle`, and mounts it with a `config` carrying the login
 * challenge + a completion callback:
 *
 *   config = {
 *     challengeToken: string,          // minted by `auth.login` leg 1
 *     onComplete: (token) => void,     // shell finalises the session
 *     onError?: (message) => void,     // optional surfacing hook
 *   }
 *
 * The widget runs the full ceremony end-to-end —
 * `loginBeginPasskey` → `@simplewebauthn/browser` → `loginVerifyPasskey`
 * — then hands the session JWT back through `onComplete`. Session-state
 * management (localStorage / cookie / redirect) stays in the shell.
 */
import { useState } from 'react'
import { Fingerprint, Loader2 } from 'lucide-react'
import { useSystem, type WidgetProps, Button } from '@camstack/ui-library'
import { isPasskeySupported, runPasskeyAuthentication } from './passkey-ceremony'
import { useT } from '../../i18n'

interface PasskeyLoginConfig {
  readonly challengeToken: string
  readonly onComplete: (token: string) => void
  readonly onError?: (message: string) => void
}

/** Narrow the opaque widget `config` to this widget's contract. */
function readConfig(config: WidgetProps['config']): PasskeyLoginConfig | null {
  if (!config) return null
  const challengeToken = config['challengeToken']
  const onComplete = config['onComplete']
  const onError = config['onError']
  if (typeof challengeToken !== 'string' || typeof onComplete !== 'function') return null
  return {
    challengeToken,
    onComplete: onComplete as (token: string) => void,
    onError: typeof onError === 'function' ? (onError as (message: string) => void) : undefined,
  }
}

export function PasskeyLogin(props: WidgetProps) {
  const system = useSystem()
  const { t } = useT()
  const cfg = readConfig(props.config)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!cfg) {
    return (
      <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
        {t('login.requiresChallenge')}
      </div>
    )
  }

  const run = async () => {
    setError(null)
    setSubmitting(true)
    try {
      const begin = await system.loginBeginPasskey(cfg.challengeToken)
      const assertion = await runPasskeyAuthentication(begin.optionsJSON)
      const result = await system.loginVerifyPasskey(cfg.challengeToken, assertion)
      cfg.onComplete(result.token)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('login.verificationFailed')
      setError(message)
      cfg.onError?.(message)
    } finally {
      setSubmitting(false)
    }
  }

  if (!isPasskeySupported()) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground-subtle">
        {t('login.unsupported')}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <Button
        variant="unstyled"
        type="button"
        data-testid="login-passkey"
        onClick={run}
        disabled={submitting}
        className="w-full flex items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-surface-hover disabled:opacity-50 transition-all"
      >
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        ) : (
          <Fingerprint className="h-4 w-4 text-primary" />
        )}
        {t('login.usePasskey')}
      </Button>
      {error && (
        <div className="rounded-md bg-danger/10 border border-danger/20 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}
    </div>
  )
}
