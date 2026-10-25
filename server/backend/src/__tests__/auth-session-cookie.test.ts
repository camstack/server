import { describe, it, expect } from 'vitest'
import {
  buildSessionCookie,
  clearSessionCookie,
  SESSION_COOKIE,
  isEmbedRedirectTarget,
  isSessionGradeJwtPayload,
  readSessionCookieFromHeader,
} from '../auth/session-cookie.js'

describe('isSessionGradeJwtPayload', () => {
  it('accepts a v2 session payload (boolean isAdmin + string userId, no kind)', () => {
    expect(isSessionGradeJwtPayload({ userId: 'u1', isAdmin: false })).toBe(true)
    expect(isSessionGradeJwtPayload({ userId: 'u1', isAdmin: true, scopes: [] })).toBe(true)
  })

  it('rejects kind-tagged bridge tokens — the 2FA-bypass vector', () => {
    // A totp-challenge token from login leg 1 verifies under the same hub
    // secret; setting it as a session cookie MUST NOT be possible, or a
    // password-only attacker skips the second factor on cookie-gated routes.
    expect(isSessionGradeJwtPayload({ userId: 'u1', isAdmin: false, kind: 'totp-challenge' })).toBe(
      false,
    )
    expect(isSessionGradeJwtPayload({ userId: 'u1', isAdmin: false, kind: 'sso-bridge' })).toBe(
      false,
    )
  })

  it('rejects payloads missing the v2 session shape', () => {
    expect(isSessionGradeJwtPayload({ userId: 'u1' })).toBe(false)
    expect(isSessionGradeJwtPayload({ isAdmin: true })).toBe(false)
    expect(isSessionGradeJwtPayload({ userId: 42, isAdmin: true })).toBe(false)
    expect(isSessionGradeJwtPayload(null)).toBe(false)
    expect(isSessionGradeJwtPayload('jwt')).toBe(false)
  })
})

describe('session cookie', () => {
  it('buildSessionCookie produces an httpOnly lax cookie carrying the token', () => {
    const c = buildSessionCookie('jwt-abc', 3600)
    expect(c.name).toBe(SESSION_COOKIE)
    expect(c.value).toBe('jwt-abc')
    expect(c.options.httpOnly).toBe(true)
    expect(c.options.sameSite).toBe('lax')
    expect(c.options.secure).toBe(true)
    expect(c.options.path).toBe('/')
    expect(c.options.maxAge).toBe(3600)
  })

  it('drops the Secure flag on plain HTTP so LAN HTTP can keep the session cookie', () => {
    const c = buildSessionCookie('jwt-abc', 3600, { secure: false })
    expect(c.options.secure).toBe(false)
  })

  it('clearSessionCookie expires the cookie', () => {
    const c = clearSessionCookie()
    expect(c.name).toBe(SESSION_COOKIE)
    expect(c.options.maxAge).toBe(0)
  })
})

describe('readSessionCookieFromHeader', () => {
  it('extracts the session cookie from a raw Cookie header', () => {
    expect(readSessionCookieFromHeader(`${SESSION_COOKIE}=jwt-abc`)).toBe('jwt-abc')
    expect(readSessionCookieFromHeader(`theme=dark; ${SESSION_COOKIE}=jwt-abc; other=1`)).toBe(
      'jwt-abc',
    )
  })

  it('URL-decodes encoded cookie values', () => {
    expect(readSessionCookieFromHeader(`${SESSION_COOKIE}=a%2Bb`)).toBe('a+b')
  })

  it('returns null for absent header, missing pair, or empty value', () => {
    expect(readSessionCookieFromHeader(undefined)).toBeNull()
    expect(readSessionCookieFromHeader('')).toBeNull()
    expect(readSessionCookieFromHeader('theme=dark')).toBeNull()
    expect(readSessionCookieFromHeader(`${SESSION_COOKIE}=`)).toBeNull()
  })

  it('does not match a cookie whose name merely contains the session name', () => {
    expect(readSessionCookieFromHeader(`x_${SESSION_COOKIE}=jwt-abc`)).toBeNull()
  })
})

describe('isEmbedRedirectTarget', () => {
  it('accepts a stream-broker embed path (with query)', () => {
    expect(isEmbedRedirectTarget('/addon/stream-broker/embed/?mode=grid')).toBe(true)
    expect(isEmbedRedirectTarget('/addon/stream-broker/embed/?mode=player&devices=7,8')).toBe(true)
    expect(isEmbedRedirectTarget('/addon/stream-broker/embed/')).toBe(true)
  })

  it('rejects open redirects (absolute / protocol-relative / backslash)', () => {
    expect(isEmbedRedirectTarget('https://evil.com/addon/stream-broker/embed/')).toBe(false)
    expect(isEmbedRedirectTarget('//evil.com')).toBe(false)
    expect(isEmbedRedirectTarget('/\\evil.com')).toBe(false)
    expect(isEmbedRedirectTarget('http://x/addon/stream-broker/embed/')).toBe(false)
  })

  it('rejects non-embed paths and path traversal', () => {
    expect(isEmbedRedirectTarget('/addon/other/embed/')).toBe(false)
    expect(isEmbedRedirectTarget('/etc/passwd')).toBe(false)
    expect(isEmbedRedirectTarget('/addon/stream-broker/embed/../../secret')).toBe(false)
    expect(isEmbedRedirectTarget('')).toBe(false)
  })
})
