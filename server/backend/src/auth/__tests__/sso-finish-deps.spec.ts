import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AuthService } from '../../core/auth/auth.service.js'
import { SESSION_COOKIE } from '../session-cookie.js'
import { sessionUserIdFromCookie, ssoBrowserBinding } from '../sso-finish-deps.js'
import { staticJwtSigningKey } from '@camstack/system'

/**
 * The link half of the SSO finish (D782) trusts ONLY a real session cookie to
 * say who is completing the link — never a bridge, challenge or forged token.
 */
function makeAuth(): AuthService {
  const store: Record<string, unknown> = {}
  return new AuthService(
    {
      get<T>(path: string): T {
        return store[path] as T
      },
      update(): void {},
    } as never,
    undefined,
    staticJwtSigningKey('cookie-secret'),
  )
}

const cookie = (token: string) => `other=1; ${SESSION_COOKIE}=${encodeURIComponent(token)}`

describe('sessionUserIdFromCookie', () => {
  const auth = makeAuth()
  // A session-shaped token, as the mint signs one.
  const session = auth.signToken({
    userId: 'u-alice',
    username: 'alice',
    isAdmin: false,
    allowedProviders: '*',
    allowedDevices: {},
  })

  it('names the user of a real session cookie', () => {
    expect(sessionUserIdFromCookie(auth, cookie(session))).toBe('u-alice')
  })

  it('ignores a missing cookie, a forged token and a non-session JWT', () => {
    expect(sessionUserIdFromCookie(auth, undefined)).toBeNull()
    expect(sessionUserIdFromCookie(auth, cookie('garbage'))).toBeNull()
    const challenge = auth.signTotpChallengeToken({
      userId: 'u-alice',
      username: 'alice',
      isAdmin: false,
    })
    expect(sessionUserIdFromCookie(auth, cookie(challenge))).toBeNull()
    const bridge = auth.signSsoBridgeToken({
      userId: 'u-alice',
      username: 'alice',
      isAdmin: false,
      provider: 'auth-oidc/authentik',
    })
    expect(sessionUserIdFromCookie(auth, cookie(bridge))).toBeNull()
  })
})

describe('ssoBrowserBinding — the hash of THIS request’s SSO state cookie', () => {
  it('hashes the state cookie value, ignoring the session cookie beside it', () => {
    const header = 'camstack_session=abc; camstack_sso_state=the-state; other=1'
    expect(ssoBrowserBinding(header)).toBe(createHash('sha256').update('the-state').digest('hex'))
  })

  it('is null without the cookie, or with an empty one', () => {
    expect(ssoBrowserBinding(undefined)).toBeNull()
    expect(ssoBrowserBinding('camstack_session=abc')).toBeNull()
    expect(ssoBrowserBinding('camstack_sso_state=')).toBeNull()
  })
})
