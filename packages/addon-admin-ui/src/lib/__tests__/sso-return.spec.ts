import { describe, expect, it } from 'vitest'
import { externalLinkNotice, parseSsoReturnFragment, ssoReturnErrorMessage } from '../sso-return'

/**
 * D782 — what `/api/auth/sso/finish` hands back to the browser besides a
 * session: a second-factor challenge, a refused (unlinked) OIDC login, and
 * on the profile page the outcome of a link.
 */
describe('parseSsoReturnFragment', () => {
  it('reads a second-factor challenge', () => {
    expect(
      parseSsoReturnFragment('#challenge=abc.def&factors=totp,passkey&provider=auth-oidc%2Fa'),
    ).toEqual({
      kind: 'challenge',
      challengeToken: 'abc.def',
      factors: ['totp', 'passkey'],
    })
  })

  it('drops unknown factor kinds', () => {
    expect(parseSsoReturnFragment('#challenge=t&factors=totp,sms')).toEqual({
      kind: 'challenge',
      challengeToken: 't',
      factors: ['totp'],
    })
  })

  it('reads an unlinked OIDC login', () => {
    expect(parseSsoReturnFragment('#error=sso-not-linked&provider=auth-oidc%2Fauthentik')).toEqual({
      kind: 'error',
      code: 'sso-not-linked',
      provider: 'auth-oidc/authentik',
    })
  })

  it('reads a browser-binding refusal and words it', () => {
    expect(parseSsoReturnFragment('#error=sso-state')).toEqual({
      kind: 'error',
      code: 'sso-state',
      provider: null,
    })
    expect(ssoReturnErrorMessage('sso-state', null)).toMatch(/another browser, or already used/)
  })

  it('ignores a session token fragment (the auth context owns it) and anything else', () => {
    expect(parseSsoReturnFragment('#token=xyz&provider=auth-oidc%2Fx')).toBeNull()
    expect(parseSsoReturnFragment('')).toBeNull()
    expect(parseSsoReturnFragment('#challenge=&factors=totp')).toBeNull()
  })
})

describe('ssoReturnErrorMessage', () => {
  it('names the provider and tells the user how to link', () => {
    expect(ssoReturnErrorMessage('sso-not-linked', 'Authentik')).toBe(
      'This Authentik account is not linked to a CamStack user. Sign in normally and link it from your profile.',
    )
  })

  it('falls back to a generic name', () => {
    expect(ssoReturnErrorMessage('sso-not-linked', null)).toContain(
      'This sign-in account is not linked',
    )
  })
})

describe('externalLinkNotice', () => {
  it('reports a completed link', () => {
    expect(externalLinkNotice('?linked=auth-oidc%2Fauthentik')).toEqual({
      kind: 'linked',
      provider: 'auth-oidc/authentik',
    })
  })

  it('words every refusal', () => {
    for (const reason of ['expired', 'provider', 'session', 'conflict'] as const) {
      const notice = externalLinkNotice(`?linkError=${reason}`)
      expect(notice?.kind).toBe('error')
      expect(notice?.kind === 'error' ? notice.message.length : 0).toBeGreaterThan(10)
    }
  })

  it('is null with nothing to say', () => {
    expect(externalLinkNotice('')).toBeNull()
    expect(externalLinkNotice('?linkError=whatever')).toEqual({
      kind: 'error',
      message: 'Linking the sign-in account failed. Try again.',
    })
  })
})
