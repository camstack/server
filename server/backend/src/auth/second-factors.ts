/**
 * The second factors a user still owes after a successful PRIMARY factor.
 * 2FA applies uniformly to every primary method — password, passkey, and
 * (D782) a linked OIDC identity:
 *
 *   • `totp` — whenever enrolled, regardless of how the user signed in.
 *   • `passkey` — ONLY when the user both has an enrolled passkey AND
 *     explicitly opted in (`getSecondFactorPreference`, default OFF —
 *     enrolling a passkey alone just enables passkey-first sign-in),
 *     and NEVER when the primary factor already WAS the passkey
 *     (re-proving the factor that just signed in adds nothing).
 *
 * Passkey introspection is resilient (missing provider / transport error ⇒
 * no passkey factor) so it can never block a login; a TOTP status failure
 * still propagates — fail-open there would silently skip an enrolled factor.
 */
import type { IUserPasskeysProvider } from '@camstack/types'
import { z } from 'zod'
import { passkeySecondFactorOptedIn, userHasPasskey } from './passkey-provider.js'

export const SecondFactorSchema = z.enum(['totp', 'passkey'])
export type SecondFactor = z.infer<typeof SecondFactorSchema>

/** How the user proved who they are before the second-factor gate. */
export type PrimaryFactor = 'password' | 'passkey' | 'sso'

export interface SecondFactorDeps {
  /** `user-management.getTotpStatus`, when the provider has it. */
  readonly getTotpStatus?: (input: { userId: string }) => Promise<{ enabled: boolean }>
  readonly passkeyProvider: () => IUserPasskeysProvider | null
}

export async function collectSecondFactors(
  deps: SecondFactorDeps,
  userId: string,
  primary: PrimaryFactor,
): Promise<SecondFactor[]> {
  const totpStatus = deps.getTotpStatus ? await deps.getTotpStatus({ userId }) : { enabled: false }
  const factors: SecondFactor[] = []
  if (totpStatus.enabled) factors.push('totp')
  if (primary !== 'passkey') {
    const provider = deps.passkeyProvider()
    const enrolled = await userHasPasskey(userId, provider)
    if (enrolled && (await passkeySecondFactorOptedIn(userId, provider))) {
      factors.push('passkey')
    }
  }
  return factors
}
