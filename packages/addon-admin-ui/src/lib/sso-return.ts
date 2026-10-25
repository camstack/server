/**
 * What `/api/auth/sso/finish` hands the browser besides a session (D782).
 *
 *  - Login page fragment `#challenge=…&factors=…` — the user signed in at the
 *    IdP and still owes an enrolled second factor; the
 *    page resumes at the factor step.
 *  - Login page fragment `#error=sso-not-linked&provider=…` — an OIDC identity
 *    nobody linked; no session was minted.
 *  - Login page fragment `#error=sso-state` — the sign-in was finished in a
 *    browser other than the one that started it, or was already used.
 *  - Profile page query `?linked=…` / `?linkError=…` — the outcome of a link.
 *
 * A `#token=` fragment is the session itself and belongs to the auth context.
 */
import type { SecondFactorKind } from '@camstack/sdk'
import i18n from '../i18n/index'

export type SsoReturn =
  | {
      readonly kind: 'challenge'
      readonly challengeToken: string
      readonly factors: readonly SecondFactorKind[]
    }
  | { readonly kind: 'error'; readonly code: SsoReturnErrorCode; readonly provider: string | null }

export type SsoReturnErrorCode = 'sso-not-linked' | 'sso-state'

function isFactor(value: string): value is SecondFactorKind {
  return value === 'totp' || value === 'passkey'
}

export function parseSsoReturnFragment(hash: string): SsoReturn | null {
  if (!hash.startsWith('#')) return null
  const params = new URLSearchParams(hash.slice(1))
  const challenge = params.get('challenge')
  if (challenge !== null) {
    if (challenge.length === 0) return null
    const factors = (params.get('factors') ?? '').split(',').filter(isFactor)
    return factors.length === 0 ? null : { kind: 'challenge', challengeToken: challenge, factors }
  }
  const error = params.get('error')
  if (error === 'sso-not-linked' || error === 'sso-state') {
    return { kind: 'error', code: error, provider: params.get('provider') }
  }
  return null
}

export function ssoReturnErrorMessage(
  code: SsoReturnErrorCode,
  providerLabel: string | null,
): string {
  switch (code) {
    case 'sso-not-linked':
      return i18n.t('helpers.ssoReturn.notLinked', {
        provider: providerLabel ?? i18n.t('helpers.ssoReturn.signInFallback'),
      })
    case 'sso-state':
      return i18n.t('helpers.ssoReturn.state')
  }
}

export type ExternalLinkNotice =
  | { readonly kind: 'linked'; readonly provider: string }
  | { readonly kind: 'error'; readonly message: string }

const LINK_ERROR_KEYS: Readonly<Record<string, string>> = {
  expired: 'helpers.ssoReturn.link.expired',
  provider: 'helpers.ssoReturn.link.provider',
  session: 'helpers.ssoReturn.link.session',
  conflict: 'helpers.ssoReturn.link.conflict',
  state: 'helpers.ssoReturn.link.state',
}

export function externalLinkNotice(search: string): ExternalLinkNotice | null {
  const params = new URLSearchParams(search)
  const linked = params.get('linked')
  if (linked !== null && linked.length > 0) return { kind: 'linked', provider: linked }
  const reason = params.get('linkError')
  if (reason === null) return null
  return {
    kind: 'error',
    message: i18n.t(LINK_ERROR_KEYS[reason] ?? 'helpers.ssoReturn.link.failed'),
  }
}
