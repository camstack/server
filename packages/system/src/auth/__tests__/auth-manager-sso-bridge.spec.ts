import { describe, it, expect, beforeEach } from 'vitest'
import * as jwt from 'jsonwebtoken'
import { AuthManager } from '../auth-manager.js'
import { staticJwtSigningKey } from '../jwt-signing-key.js'

/**
 * SSO bridge token roundtrip + tamper-resistance tests.
 *
 * Covers `AuthManager.signSsoBridgeToken` + `verifySsoBridgeToken`, the
 * cryptographic gateway that lets `/api/auth/sso/finish` trust the
 * post-callback claims coming from an `auth-provider` addon (OIDC,
 * SAML, magic-link, …). The pre-bridge version of the endpoint trusted
 * plain query params (`?isAdmin=1`) — these tests pin the new behaviour
 * so that regression can't slip back in.
 */
type ConfigStore = Record<string, unknown>
function makeAuth(secret: string = 'unit-test-secret'): AuthManager {
  const store: ConfigStore = {}
  const config = {
    get<T>(path: string): T {
      return store[path] as T
    },
    update(section: string, data: Record<string, unknown>): void {
      for (const [k, v] of Object.entries(data)) store[`${section}.${k}`] = v
    },
  }
  return new AuthManager(config, undefined, staticJwtSigningKey(secret))
}

describe('AuthManager.signSsoBridgeToken / verifySsoBridgeToken', () => {
  let auth: AuthManager

  beforeEach(() => {
    auth = makeAuth()
  })

  it('roundtrips a minimal viewer claim set', () => {
    const claims = {
      userId: 'oidc:abc-123',
      username: 'alice',
      isAdmin: false,
      provider: 'auth-oidc',
    }
    const token = auth.signSsoBridgeToken(claims)
    const decoded = auth.verifySsoBridgeToken(token)
    expect(decoded).toEqual(claims)
  })

  it('roundtrips a link intent handle (D782)', () => {
    const claims = {
      userId: 'oidc:authentik:sub-1',
      username: 'alice',
      isAdmin: false,
      provider: 'auth-oidc/authentik',
      linkIntent: 'li_0123456789abcdefghijkl',
      issuer: 'https://idp.example/',
    }
    expect(auth.verifySsoBridgeToken(auth.signSsoBridgeToken(claims))).toEqual(claims)
  })

  it('roundtrips the full admin claim set including optional email + displayName', () => {
    const claims = {
      userId: 'oidc:42',
      username: 'admin@example.com',
      isAdmin: true,
      provider: 'auth-oidc',
      email: 'admin@example.com',
      displayName: 'Admin User',
    }
    const token = auth.signSsoBridgeToken(claims)
    const decoded = auth.verifySsoBridgeToken(token)
    expect(decoded).toEqual(claims)
  })

  it('rejects a tampered token (signature mismatch)', () => {
    const token = auth.signSsoBridgeToken({
      userId: 'oidc:1',
      username: 'alice',
      isAdmin: false,
      provider: 'auth-oidc',
    })
    // Flip a character in the signature segment (the last `.`-delimited part).
    const parts = token.split('.')
    const sig = parts[2]!
    const tamperedSig = sig.startsWith('A') ? `B${sig.slice(1)}` : `A${sig.slice(1)}`
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`
    expect(auth.verifySsoBridgeToken(tampered)).toBeNull()
  })

  it('rejects a token signed with a different secret', () => {
    const other = makeAuth('different-secret')
    const token = other.signSsoBridgeToken({
      userId: 'oidc:1',
      username: 'mallory',
      isAdmin: true,
      provider: 'auth-oidc',
    })
    expect(auth.verifySsoBridgeToken(token)).toBeNull()
  })

  it('rejects an expired bridge token', async () => {
    const token = auth.signSsoBridgeToken(
      {
        userId: 'oidc:1',
        username: 'alice',
        isAdmin: false,
        provider: 'auth-oidc',
      },
      1,
    ) // 1 second TTL
    // jsonwebtoken's exp is second-granular, so we need to wait past the
    // boundary. Two seconds is a safe upper bound for the exp check.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(auth.verifySsoBridgeToken(token)).toBeNull()
  })

  it('rejects a token with the wrong kind (regular session token reused as bridge)', () => {
    // Mint a normal session token and try to consume it as a bridge token.
    // The kind claim is missing, so verifySsoBridgeToken must reject.
    const sessionToken = auth.signToken({
      userId: 'u-1',
      username: 'alice',
      isAdmin: true,
      allowedProviders: '*',
      allowedDevices: {},
    })
    expect(auth.verifySsoBridgeToken(sessionToken)).toBeNull()
  })

  it('rejects a token whose payload was hand-rolled with kind missing', () => {
    // Same secret, but no `kind: 'sso-bridge'` claim. Useful guarantee
    // for the case where someone signs claims directly with jwt.sign(...).
    const handRolled = jwt.sign(
      { userId: 'oidc:1', username: 'alice', isAdmin: true, provider: 'oidc' },
      'unit-test-secret',
      { expiresIn: '5m' },
    )
    expect(auth.verifySsoBridgeToken(handRolled)).toBeNull()
  })

  it('rejects a token whose userId is non-string (type confusion)', () => {
    const handRolled = jwt.sign(
      { kind: 'sso-bridge', userId: 123, username: 'alice', isAdmin: true, provider: 'oidc' },
      'unit-test-secret',
      { expiresIn: '5m' },
    )
    expect(auth.verifySsoBridgeToken(handRolled)).toBeNull()
  })

  it('rejects a token whose isAdmin is non-boolean', () => {
    const handRolled = jwt.sign(
      { kind: 'sso-bridge', userId: 'oidc:1', username: 'alice', isAdmin: 'yes', provider: 'oidc' },
      'unit-test-secret',
      { expiresIn: '5m' },
    )
    expect(auth.verifySsoBridgeToken(handRolled)).toBeNull()
  })

  it('uses the default 5-minute TTL when ttlSec is omitted', () => {
    const token = auth.signSsoBridgeToken({
      userId: 'oidc:1',
      username: 'alice',
      isAdmin: false,
      provider: 'auth-oidc',
    })
    const decoded = jwt.decode(token) as { exp: number; iat: number }
    expect(decoded.exp - decoded.iat).toBe(300)
  })

  it('honors the operator-provided ttlSec override', () => {
    const token = auth.signSsoBridgeToken(
      {
        userId: 'oidc:1',
        username: 'alice',
        isAdmin: false,
        provider: 'auth-oidc',
      },
      60,
    )
    const decoded = jwt.decode(token) as { exp: number; iat: number }
    expect(decoded.exp - decoded.iat).toBe(60)
  })

  it('returns garbage for verify("")', () => {
    expect(auth.verifySsoBridgeToken('')).toBeNull()
  })

  it('returns null for malformed input (not a JWT)', () => {
    expect(auth.verifySsoBridgeToken('not.a.jwt')).toBeNull()
    expect(auth.verifySsoBridgeToken('garbage')).toBeNull()
  })
  describe('the native-app claim (D858)', () => {
    const base = {
      userId: 'oidc:acme:1',
      username: 'a',
      isAdmin: false,
      provider: 'auth-oidc/acme',
    }
    const app = {
      codeChallenge: 'c'.repeat(43),
      state: 'st',
      purpose: 'step-up' as const,
      redirect: 'camstack://auth-callback',
    }

    it('survives the roundtrip: an app bridge must stay an app bridge', () => {
      expect(auth.verifySsoBridgeToken(auth.signSsoBridgeToken({ ...base, app }))?.app).toEqual(app)
      expect(auth.verifySsoBridgeToken(auth.signSsoBridgeToken(base))?.app).toBeUndefined()
    })

    it('a malformed app claim refuses the token rather than downgrading it to a web bridge', () => {
      const forged = jwt.sign(
        { kind: 'sso-bridge', ...base, app: { purpose: 'admin' } },
        'unit-test-secret',
      )
      expect(auth.verifySsoBridgeToken(forged)).toBeNull()
    })
  })
})
