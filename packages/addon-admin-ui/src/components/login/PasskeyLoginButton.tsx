/**
 * PasskeyLoginButton — shell-native WebAuthn ceremony button, replacing
 * the retired `passkey-direct-login` / `passkey-login` Module-Federation
 * widgets (`@camstack/addon-auth`'s `PasskeyDirectLogin.tsx` / `PasskeyLogin.tsx`).
 * `@simplewebauthn/browser` now lives directly in `addon-admin-ui` — no
 * remote code fetched pre-auth (see `docs/superpowers/specs/2026-07-15-declarative-login-passkey-design.md`
 * §2).
 *
 * Renders one component for BOTH login-page stages, ported 1:1 from the
 * two widgets it replaces:
 *   • primary (usernameless): `challengeToken` omitted — runs
 *     `auth.passkeyLoginBegin` → ceremony → `auth.passkeyLoginFinish`,
 *     mirrors `PasskeyDirectLogin.tsx` (2FA applies uniformly after any
 *     primary method — a non-empty `secondFactors` list means the
 *     returned token is a short-lived CHALLENGE, routed to
 *     `onSecondFactor`, never handed to `onComplete`).
 *   • second-factor: `challengeToken` provided (minted by the
 *     credentials leg) — runs `auth.loginBeginPasskey` → ceremony →
 *     `auth.loginVerifyPasskey`, mirrors `PasskeyLogin.tsx`.
 *
 * Visibility (browser support + origin/rpId gate) is the CALLER's
 * responsibility (`PrimaryLoginMethods` / `Login.tsx`, via
 * `passkey-gate.ts`) — this component assumes it should render.
 */
import { useState } from 'react'
import { Fingerprint, Loader2 } from 'lucide-react'
import { startAuthentication } from '@simplewebauthn/browser'
import { getSystem } from '../../lib/backend'
import { isPasskeyAuthenticationOptions } from '../../lib/passkey-wire.js'
import type { PasskeyLoginMethod } from './PrimaryLoginMethods'

/** Handed to the shell when a primary-stage passkey sign-in still owes
 *  a second factor (TOTP). Never produced by the second-factor stage —
 *  the passkey ceremony itself IS the second factor there. */
export interface PasskeySecondFactorOutcome {
  readonly challengeToken: string
  readonly factors: readonly string[]
}

export interface PasskeyLoginButtonProps {
  readonly method: PasskeyLoginMethod
  /** Second-factor stage only: the challenge token minted by the
   *  credentials leg. Omitted for the primary (usernameless) ceremony. */
  readonly challengeToken?: string
  /** The minted session: the access token, plus its refresh token and expiry. */
  readonly onComplete: (
    token: string,
    session?: { readonly refreshToken?: string; readonly expiresAt?: number },
  ) => void
  /** Primary stage only. */
  readonly onSecondFactor?: (outcome: PasskeySecondFactorOutcome) => void
  readonly onError?: (message: string) => void
}

/**
 * Run `startAuthentication` against a server-issued options JSON blob.
 * The hub serves WebAuthn options as an opaque `z.record` and expects
 * the assertion back as plain JSON — the single documented cast here is
 * that server-JSON ↔ browser-API boundary, matching addon-auth's own
 * `passkey-ceremony.ts` (the ceremony helper this ports).
 */
async function runAuthentication(
  optionsJSON: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!isPasskeyAuthenticationOptions(optionsJSON)) {
    throw new Error('passkey authentication options missing challenge')
  }
  const assertion = await startAuthentication({ optionsJSON })
  return Object.fromEntries(Object.entries(assertion))
}

export function PasskeyLoginButton({
  method,
  challengeToken,
  onComplete,
  onSecondFactor,
  onError,
}: PasskeyLoginButtonProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    setError(null)
    setSubmitting(true)
    try {
      const sys = getSystem()
      if (challengeToken) {
        // Second-factor ceremony — mirrors PasskeyLogin.tsx.
        const begin = await sys.loginBeginPasskey(challengeToken)
        const assertion = await runAuthentication(begin.optionsJSON)
        const result = await sys.loginVerifyPasskey(challengeToken, assertion, {
          refreshable: true,
        })
        onComplete(result.token, result)
        return
      }
      // Primary (usernameless) ceremony — mirrors PasskeyDirectLogin.tsx.
      const begin = await sys.passkeyLoginBegin()
      const assertion = await runAuthentication(begin.optionsJSON)
      const result = await sys.passkeyLoginFinish(assertion, { refreshable: true })
      const factors: readonly string[] =
        result.secondFactors ?? (result.requiresTotp === true ? ['totp'] : [])
      if (factors.length > 0) {
        if (onSecondFactor) {
          onSecondFactor({ challengeToken: result.token, factors })
        } else {
          // Host predates the second-factor contract — surface a clear
          // path forward instead of silently doing nothing.
          const message =
            'Additional verification is required — sign in with your password to continue.'
          setError(message)
          onError?.(message)
        }
        return
      }
      onComplete(result.token, result)
    } catch (err: unknown) {
      const fallback = challengeToken ? 'Passkey verification failed' : 'Passkey sign-in failed'
      const message = err instanceof Error ? err.message : fallback
      setError(message)
      onError?.(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        data-testid={challengeToken ? 'login-passkey' : 'login-passkey-direct'}
        onClick={() => void run()}
        disabled={submitting}
        className="w-full flex items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-medium text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors"
      >
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        ) : (
          <Fingerprint className="h-4 w-4 text-primary" />
        )}
        {method.label}
      </button>
      {error && (
        <div className="rounded-md bg-danger/10 border border-danger/20 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}
    </div>
  )
}
