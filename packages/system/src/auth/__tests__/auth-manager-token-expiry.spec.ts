import { describe, it, expect, vi } from 'vitest'
import * as jwt from 'jsonwebtoken'
import type { IScopedLogger, TokenPayload } from '@camstack/types'
import { DEFAULT_TOKEN_EXPIRY } from '@camstack/types'
import { AuthManager, type AuthConfigReader } from '../auth-manager.js'
import { staticJwtSigningKey } from '../jwt-signing-key.js'

/**
 * OUTCOME tests for the configured session lifetime.
 *
 * Every assertion here reads the SIGNED TOKEN, never the call that produced
 * it: `exp - iat` is the only thing an operator who tightens the lifetime
 * actually gets. `auth.tokenExpiry` used to be declared, editable, saved —
 * and unread, so `1h` silently meant a month.
 */
const SECRET = 'unit-test-secret'

interface CapturedWarn {
  readonly message: string
  readonly meta: Record<string, unknown> | undefined
}

function makeLogger(warns: CapturedWarn[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (message: string, ctx?: { meta?: Record<string, unknown> }) => {
      warns.push({ message, meta: ctx?.meta })
    },
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function makeAuth(
  tokenExpiry: unknown,
  warns: CapturedWarn[] = [],
): { auth: AuthManager; store: Record<string, unknown> } {
  const store: Record<string, unknown> = {}
  if (tokenExpiry !== undefined) store['auth.tokenExpiry'] = tokenExpiry
  const config: AuthConfigReader = {
    get<T>(path: string): T | undefined {
      const value = store[path]
      return value === undefined ? undefined : (value as T)
    },
    update(section: string, data: Record<string, unknown>): void {
      for (const [k, v] of Object.entries(data)) store[`${section}.${k}`] = v
    },
  }
  return { auth: new AuthManager(config, makeLogger(warns), staticJwtSigningKey(SECRET)), store }
}

const PAYLOAD: Omit<TokenPayload, 'iat' | 'exp'> = {
  userId: 'u-1',
  username: 'admin',
  isAdmin: true,
  allowedProviders: '*',
  allowedDevices: {},
}

/** The one thing that matters: how long the issued token actually lives. */
function lifetimeSeconds(token: string): number {
  const decoded = jwt.verify(token, SECRET)
  if (typeof decoded === 'string' || typeof decoded.exp !== 'number') {
    throw new Error('token carries no exp')
  }
  if (typeof decoded.iat !== 'number') throw new Error('token carries no iat')
  return decoded.exp - decoded.iat
}

describe('AuthManager.signToken — configured lifetime', () => {
  it('a configured 1h reaches the SIGNED token (not the 30d fallback)', () => {
    const { auth } = makeAuth('1h')
    expect(lifetimeSeconds(auth.signToken(PAYLOAD))).toBe(3600)
  })

  it('honours a tightened lifetime — the whole point of the control', () => {
    expect(lifetimeSeconds(makeAuth('15m').auth.signToken(PAYLOAD))).toBe(900)
    expect(lifetimeSeconds(makeAuth('2d').auth.signToken(PAYLOAD))).toBe(2 * 86400)
  })

  it('falls back to the SINGLE documented default when unset', () => {
    expect(lifetimeSeconds(makeAuth(undefined).auth.signToken(PAYLOAD))).toBe(30 * 24 * 3600)
    expect(DEFAULT_TOKEN_EXPIRY).toBe('30d')
  })

  it('picks up a change without re-constructing the manager (no restart)', () => {
    const { auth, store } = makeAuth('1h')
    expect(lifetimeSeconds(auth.signToken(PAYLOAD))).toBe(3600)
    store['auth.tokenExpiry'] = '10m'
    expect(lifetimeSeconds(auth.signToken(PAYLOAD))).toBe(600)
  })

  it('an invalid value LOGS and falls back — it does not throw and does not 500 the login', () => {
    const warns: CapturedWarn[] = []
    const { auth } = makeAuth('forever', warns)
    expect(lifetimeSeconds(auth.signToken(PAYLOAD))).toBe(30 * 24 * 3600)
    expect(warns).toHaveLength(1)
    expect(warns[0]!.message).toContain('auth.tokenExpiry REJECTED')
    expect(warns[0]!.meta).toMatchObject({ configured: 'forever', reason: 'malformed' })
  })

  it('a bare number is refused, not read as 3.6 seconds', () => {
    const warns: CapturedWarn[] = []
    const { auth } = makeAuth('3600', warns)
    expect(lifetimeSeconds(auth.signToken(PAYLOAD))).toBe(30 * 24 * 3600)
    expect(warns).toHaveLength(1)
  })

  it('an absurd lifetime is refused rather than becoming an effectively-eternal token', () => {
    const warns: CapturedWarn[] = []
    const { auth } = makeAuth('50y', warns)
    expect(lifetimeSeconds(auth.signToken(PAYLOAD))).toBe(30 * 24 * 3600)
    expect(warns[0]!.meta).toMatchObject({ reason: 'too-long' })
  })

  it('reports a bad value ONCE, then again when the operator changes it', () => {
    const warns: CapturedWarn[] = []
    const { auth, store } = makeAuth('forever', warns)
    auth.signToken(PAYLOAD)
    auth.signToken(PAYLOAD)
    auth.signToken(PAYLOAD)
    expect(warns).toHaveLength(1)
    store['auth.tokenExpiry'] = 'also-bad'
    auth.signToken(PAYLOAD)
    expect(warns).toHaveLength(2)
  })

  it('a valid value after a bad one is honoured immediately', () => {
    const warns: CapturedWarn[] = []
    const { auth, store } = makeAuth('forever', warns)
    expect(lifetimeSeconds(auth.signToken(PAYLOAD))).toBe(30 * 24 * 3600)
    store['auth.tokenExpiry'] = '45m'
    expect(lifetimeSeconds(auth.signToken(PAYLOAD))).toBe(2700)
    expect(warns).toHaveLength(1)
  })
})
