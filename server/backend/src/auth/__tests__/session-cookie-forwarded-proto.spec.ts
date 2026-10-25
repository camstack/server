/**
 * The session cookie behind a reverse proxy.
 *
 * Home Assistant's relay reaches the hub over HTTPS while the browser reached
 * Home Assistant over plain HTTP, so the hub marked the cookie `Secure` and the
 * browser discarded it without a word. The login worked, the session existed,
 * and only the surfaces that can authenticate by cookie alone — a plain `<img>`
 * — came back 401. That is what these cases pin.
 */
import { describe, expect, it } from 'vitest'
import { sessionCookieIsSecure } from '../session-cookie.js'

const PREFIX_HEADER = 'x-forwarded-prefix'
const RELAYED = { [PREFIX_HEADER]: '/api/camstack/p/grant' }

describe('sessionCookieIsSecure', () => {
  it('keeps Secure for a direct HTTPS browser hit', () => {
    expect(sessionCookieIsSecure('https', {}, PREFIX_HEADER)).toBe(true)
  })

  it('never sets Secure on a plain HTTP leg', () => {
    expect(sessionCookieIsSecure('http', {}, PREFIX_HEADER)).toBe(false)
  })

  it('drops Secure when the relay says the BROWSER used http', () => {
    const headers = { ...RELAYED, 'x-forwarded-proto': 'http' }
    expect(sessionCookieIsSecure('https', headers, PREFIX_HEADER)).toBe(false)
  })

  it('keeps Secure when the relay says the browser used https', () => {
    const headers = { ...RELAYED, 'x-forwarded-proto': 'https' }
    expect(sessionCookieIsSecure('https', headers, PREFIX_HEADER)).toBe(true)
  })

  it('reads the FIRST hop of a comma list — the browser is the leftmost', () => {
    const headers = { ...RELAYED, 'x-forwarded-proto': 'http, https' }
    expect(sessionCookieIsSecure('https', headers, PREFIX_HEADER)).toBe(false)
  })

  it('ignores the proto header without the relay prefix — a direct caller cannot downgrade', () => {
    const headers = { 'x-forwarded-proto': 'http' }
    expect(sessionCookieIsSecure('https', headers, PREFIX_HEADER)).toBe(true)
  })

  it('can only downgrade: an http leg claiming https stays insecure', () => {
    const headers = { ...RELAYED, 'x-forwarded-proto': 'https' }
    expect(sessionCookieIsSecure('http', headers, PREFIX_HEADER)).toBe(false)
  })

  it('keeps Secure when the relay sends no proto at all', () => {
    expect(sessionCookieIsSecure('https', RELAYED, PREFIX_HEADER)).toBe(true)
  })
})
