import { describe, it, expect, beforeEach } from 'vitest'
import { AuthManager } from '../auth-manager.js'
import { staticJwtSigningKey } from '../jwt-signing-key.js'
import type { TokenScope } from '@camstack/types'

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

const SCOPES: TokenScope[] = [{ type: 'category', target: 'device', access: ['view', 'create'] }]

describe('SsoBridgeClaims scopes round-trip', () => {
  let auth: AuthManager

  beforeEach(() => {
    auth = makeAuth()
  })

  it('round-trips a token that carries scopes', () => {
    const claims = {
      userId: 'oidc:scoped-user',
      username: 'scoped@example.com',
      isAdmin: false,
      provider: 'auth-oidc',
      scopes: SCOPES,
    }
    const token = auth.signSsoBridgeToken(claims)
    const decoded = auth.verifySsoBridgeToken(token)
    expect(decoded).not.toBeNull()
    expect(decoded!.scopes).toEqual(SCOPES)
  })

  it('returns scopes undefined when a token was signed without scopes', () => {
    const claims = {
      userId: 'oidc:no-scopes',
      username: 'plain@example.com',
      isAdmin: false,
      provider: 'auth-oidc',
    }
    const token = auth.signSsoBridgeToken(claims)
    const decoded = auth.verifySsoBridgeToken(token)
    expect(decoded).not.toBeNull()
    expect(decoded!.scopes).toBeUndefined()
  })

  it('round-trips multiple scope grants faithfully', () => {
    const multiScopes: TokenScope[] = [
      { type: 'category', target: 'device', access: ['view'] },
      { type: 'capability', target: 'stream-broker', access: ['view', 'create'] },
      { type: 'addon', target: 'addon-analytics-suite', access: ['view'] },
    ]
    const claims = {
      userId: 'oidc:multi',
      username: 'multi@example.com',
      isAdmin: false,
      provider: 'auth-oidc',
      scopes: multiScopes,
    }
    const token = auth.signSsoBridgeToken(claims)
    const decoded = auth.verifySsoBridgeToken(token)
    expect(decoded!.scopes).toEqual(multiScopes)
  })
})
