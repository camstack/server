/**
 * PasskeyDirectLogin — `passkey-direct-login` widget (PRE-auth, PRIMARY
 * stage): usernameless sign-in via the standard WebAuthn discoverable-
 * credentials flow. No username, no password — the browser's own passkey
 * picker chooses the credential and the server resolves the owning user.
 *
 * Discovered by the login page through the PUBLIC `auth.listLoginMethods`
 * login-method channel (stage `primary`) and mounted below the
 * credentials form with a `config` carrying:
 *
 *   config = {
 *     onComplete: (token) => void,     // shell finalises the session
 *     onSecondFactor?: ({ challengeToken, factors }) => void,
 *                                      // account still owes a second
 *                                      // factor (TOTP) — shell routes
 *                                      // into its 2FA phase
 *     onError?: (message) => void,     // optional surfacing hook
 *     locale?: string,                 // shell's active UI language
 *   }
 *
 * The widget runs the full ceremony end-to-end —
 * `auth.passkeyLoginBegin` → `@simplewebauthn/browser` →
 * `auth.passkeyLoginFinish` — then hands the minted session JWT back
 * through `onComplete`, exactly like the second-factor `passkey-login`
 * widget. Session-state management stays in the shell.
 *
 * 2FA applies uniformly after any primary method: when the server
 * answers the finish leg with a CHALLENGE (the user has TOTP enrolled),
 * the widget hands `{ challengeToken, factors }` to `onSecondFactor`.
 * Backward-tolerant: a host predating that config key gets a clear
 * inline message instead (never the challenge token via `onComplete` —
 * it is not a session).
 */
import { useState } from 'react'
import { Fingerprint, Loader2 } from 'lucide-react'
import { useSystem, type WidgetProps, Button } from '@camstack/ui-library'
import { isPasskeySupported, runPasskeyAuthentication } from './passkey-ceremony'
import { useT } from '../../i18n'

/** Handed to the shell when the account still owes a second factor. */
interface PasskeySecondFactorOutcome {
  readonly challengeToken: string
  readonly factors: readonly string[]
}

interface PasskeyDirectLoginConfig {
  readonly onComplete: (token: string) => void
  readonly onSecondFactor?: (outcome: PasskeySecondFactorOutcome) => void
  readonly onError?: (message: string) => void
  readonly locale?: string
}

/** Narrow the opaque widget `config` to this widget's contract. */
function readConfig(config: WidgetProps['config']): PasskeyDirectLoginConfig | null {
  if (!config) return null
  const onComplete = config['onComplete']
  const onSecondFactor = config['onSecondFactor']
  const onError = config['onError']
  const locale = config['locale']
  if (typeof onComplete !== 'function') return null
  return {
    onComplete: onComplete as (token: string) => void,
    onSecondFactor:
      typeof onSecondFactor === 'function'
        ? (onSecondFactor as (outcome: PasskeySecondFactorOutcome) => void)
        : undefined,
    onError: typeof onError === 'function' ? (onError as (message: string) => void) : undefined,
    locale: typeof locale === 'string' ? locale : undefined,
  }
}

export function PasskeyDirectLogin(props: WidgetProps) {
  const system = useSystem()
  const cfg = readConfig(props.config)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { t } = useT(cfg?.locale)

  if (!cfg) {
    return (
      <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
        {t('directLogin.requiresCallback')}
      </div>
    )
  }

  const run = async () => {
    setError(null)
    setSubmitting(true)
    try {
      const begin = await system.passkeyLoginBegin()
      const assertion = await runPasskeyAuthentication(begin.optionsJSON)
      const result = await system.passkeyLoginFinish(assertion)
      // 2FA applies uniformly after any primary method: a non-empty
      // factor list means `result.token` is a short-lived CHALLENGE,
      // not a session — never hand it to `onComplete`.
      const factors: readonly string[] =
        result.secondFactors ?? (result.requiresTotp === true ? ['totp'] : [])
      if (factors.length > 0) {
        if (cfg.onSecondFactor) {
          cfg.onSecondFactor({ challengeToken: result.token, factors })
        } else {
          // Host predates the second-factor contract — surface a clear
          // path forward instead of silently doing nothing.
          const message = t('directLogin.secondFactorRequired')
          setError(message)
          cfg.onError?.(message)
        }
        return
      }
      cfg.onComplete(result.token)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('directLogin.failed')
      setError(message)
      cfg.onError?.(message)
    } finally {
      setSubmitting(false)
    }
  }

  if (!isPasskeySupported()) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground-subtle">
        {t('directLogin.unsupported')}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <Button
        variant="unstyled"
        type="button"
        data-testid="login-passkey-direct"
        onClick={run}
        disabled={submitting}
        className="w-full flex items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-medium text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors"
      >
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        ) : (
          <Fingerprint className="h-4 w-4 text-primary" />
        )}
        {t('directLogin.signInWithPasskey')}
      </Button>
      {error && (
        <div className="rounded-md bg-danger/10 border border-danger/20 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}
    </div>
  )
}
