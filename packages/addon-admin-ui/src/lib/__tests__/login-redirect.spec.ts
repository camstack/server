// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseLoginRedirect,
  buildAppCallbackUrl,
  rememberLoginRedirect,
  consumeLoginRedirect,
  resolveLoginRedirect,
  parseLoginNext,
  rememberLoginNext,
  consumeLoginNext,
  resolveLoginNext,
} from '../login-redirect.js'

describe('parseLoginRedirect', () => {
  it('accepts relative in-app paths', () => {
    expect(parseLoginRedirect('/viewer/camstack/')).toEqual({
      kind: 'path',
      path: '/viewer/camstack/',
    })
    expect(parseLoginRedirect('/dashboard')).toEqual({ kind: 'path', path: '/dashboard' })
    expect(parseLoginRedirect('/viewer/camstack/?a=1')).toEqual({
      kind: 'path',
      path: '/viewer/camstack/?a=1',
    })
  })

  it('accepts ONLY the allowlisted app callback schemes', () => {
    expect(parseLoginRedirect('camstack://auth-callback')).toEqual({
      kind: 'app-callback',
      url: 'camstack://auth-callback',
    })
    expect(parseLoginRedirect('camstack.dev://auth-callback')).toEqual({
      kind: 'app-callback',
      url: 'camstack.dev://auth-callback',
    })
    // Riders and lookalikes are rejected.
    expect(parseLoginRedirect('camstack://auth-callback?x=1')).toBeNull()
    expect(parseLoginRedirect('camstack://other')).toBeNull()
    expect(parseLoginRedirect('evil://auth-callback')).toBeNull()
  })

  it('canonicalizes the empty-host triple-slash form expo-linking produces', () => {
    // Linking.createURL('auth-callback') in a standalone app yields
    // `camstack:///auth-callback` (empty host). It must be accepted and
    // normalized to the canonical 2-slash form the code bounce uses.
    expect(parseLoginRedirect('camstack:///auth-callback')).toEqual({
      kind: 'app-callback',
      url: 'camstack://auth-callback',
    })
    expect(parseLoginRedirect('camstack.dev:///auth-callback')).toEqual({
      kind: 'app-callback',
      url: 'camstack.dev://auth-callback',
    })
    expect(parseLoginRedirect('camstack://auth-callback/')).toEqual({
      kind: 'app-callback',
      url: 'camstack://auth-callback',
    })
    // Still exact on the path — no riders through the normalizer.
    expect(parseLoginRedirect('camstack:///auth-callback?x=1')).toBeNull()
    expect(parseLoginRedirect('camstack:////auth-callback')).toBeNull()
  })

  it('rejects open-redirect shapes', () => {
    expect(parseLoginRedirect('https://evil.com/')).toBeNull()
    expect(parseLoginRedirect('http://evil.com')).toBeNull()
    expect(parseLoginRedirect('//evil.com')).toBeNull()
    expect(parseLoginRedirect('/\\evil.com')).toBeNull()
    expect(parseLoginRedirect('/a/../../etc')).toBeNull()
    expect(parseLoginRedirect('javascript:alert(1)')).toBeNull()
    expect(parseLoginRedirect('/ok/..%2f')).toBeNull()
  })

  it('rejects empty / oversized / login-loop targets', () => {
    expect(parseLoginRedirect(null)).toBeNull()
    expect(parseLoginRedirect(undefined)).toBeNull()
    expect(parseLoginRedirect('')).toBeNull()
    expect(parseLoginRedirect('/' + 'a'.repeat(600))).toBeNull()
    expect(parseLoginRedirect('/login')).toBeNull()
    expect(parseLoginRedirect('/login?redirect=/x')).toBeNull()
  })
})

describe('buildAppCallbackUrl', () => {
  it('appends the code as a query param', () => {
    expect(buildAppCallbackUrl('camstack://auth-callback', 'chc_ab+c')).toBe(
      'camstack://auth-callback?code=chc_ab%2Bc',
    )
  })
})

describe('remember/consume login redirect (sessionStorage parking)', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('round-trips a valid target and clears it on consume', () => {
    rememberLoginRedirect('/viewer/camstack/')
    expect(consumeLoginRedirect()).toEqual({ kind: 'path', path: '/viewer/camstack/' })
    // One-shot: the second consume finds nothing.
    expect(consumeLoginRedirect()).toBeNull()
  })

  it('never parks an invalid target', () => {
    rememberLoginRedirect('https://evil.com/')
    expect(consumeLoginRedirect()).toBeNull()
  })

  it('expires a stale parked redirect', () => {
    const t0 = 1_000_000
    rememberLoginRedirect('camstack://auth-callback', t0)
    expect(consumeLoginRedirect(t0 + 11 * 60_000)).toBeNull()
  })

  it('survives the round-trip within the validity window', () => {
    const t0 = 1_000_000
    rememberLoginRedirect('camstack://auth-callback', t0)
    expect(consumeLoginRedirect(t0 + 5 * 60_000)).toEqual({
      kind: 'app-callback',
      url: 'camstack://auth-callback',
    })
  })

  it('ignores corrupted storage payloads', () => {
    window.sessionStorage.setItem('camstack:login-redirect', 'not-json')
    expect(consumeLoginRedirect()).toBeNull()
    window.sessionStorage.setItem('camstack:login-redirect', '{"raw":42,"at":"x"}')
    expect(consumeLoginRedirect()).toBeNull()
  })
})

describe('resolveLoginRedirect (parked value → live param fallback)', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('prefers the parked target and consumes it', () => {
    rememberLoginRedirect('/viewer/camstack/')
    expect(resolveLoginRedirect('camstack://auth-callback')).toEqual({
      kind: 'path',
      path: '/viewer/camstack/',
    })
    // Parked value is one-shot; the NEXT resolve falls back to the param.
    expect(resolveLoginRedirect('camstack://auth-callback')).toEqual({
      kind: 'app-callback',
      url: 'camstack://auth-callback',
    })
  })

  it('falls back to the live ?redirect param when nothing is parked (post-remount retry)', () => {
    // The interactive-login teardown/remount cycle can consume the parked
    // value on a doomed first attempt; the login URL still carries the
    // param, so the retry must resolve from it.
    expect(resolveLoginRedirect('camstack://auth-callback')).toEqual({
      kind: 'app-callback',
      url: 'camstack://auth-callback',
    })
  })

  it('validates the fallback param exactly like a fresh parse', () => {
    expect(resolveLoginRedirect('https://evil.com/')).toBeNull()
    expect(resolveLoginRedirect(null)).toBeNull()
  })

  it('ignores an expired parked value and still falls back to the param', () => {
    const t0 = 1_000_000
    rememberLoginRedirect('/viewer/camstack/', t0)
    expect(resolveLoginRedirect('camstack://auth-callback', t0 + 11 * 60_000)).toEqual({
      kind: 'app-callback',
      url: 'camstack://auth-callback',
    })
  })
})

/**
 * `next` — the server-side login bounce. `/api/oauth2/authorize` (and the
 * `authenticated` addon-route catch-all) 302 an unauthenticated browser to
 * `/login?next=<the whole original url>`. The query string IS the request, so
 * the round trip must be byte-exact.
 */
const AUTHORIZE_NEXT =
  '/api/oauth2/authorize?response_type=code&integration=homeassistant' +
  '&redirect_uri=https%3A%2F%2Fmy.home-assistant.io%2Fredirect%2Foauth&state=abc'

describe('parseLoginNext', () => {
  it('returns a same-origin path with its query INTACT — never just the pathname', () => {
    expect(parseLoginNext(AUTHORIZE_NEXT)).toBe(AUTHORIZE_NEXT)
    expect(parseLoginNext('/addon/foo/page?a=1&b=2#frag')).toBe('/addon/foo/page?a=1&b=2#frag')
  })

  it('refuses anything that could leave this origin', () => {
    // This was live: `next` reached location.assign with no validation at all.
    expect(parseLoginNext('https://evil.example/steal')).toBeNull()
    expect(parseLoginNext('//evil.example/steal')).toBeNull()
    expect(parseLoginNext('camstack://auth-callback')).toBeNull()
    expect(parseLoginNext('/a/..\\/b')).toBeNull()
    expect(parseLoginNext('dashboard')).toBeNull()
    expect(parseLoginNext('')).toBeNull()
    expect(parseLoginNext(null)).toBeNull()
  })

  it('refuses a bounce back into the login page itself', () => {
    expect(parseLoginNext('/login')).toBeNull()
    expect(parseLoginNext('/login?next=%2Fx')).toBeNull()
  })

  it('bounds the length', () => {
    expect(parseLoginNext(`/x?q=${'a'.repeat(2049)}`)).toBeNull()
  })
})

describe('next parking (survives a login leg that leaves the page)', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('round-trips the authorize url byte for byte', () => {
    rememberLoginNext(AUTHORIZE_NEXT)
    expect(consumeLoginNext()).toBe(AUTHORIZE_NEXT)
  })

  it('is one-shot', () => {
    rememberLoginNext(AUTHORIZE_NEXT)
    expect(consumeLoginNext()).toBe(AUTHORIZE_NEXT)
    expect(consumeLoginNext()).toBeNull()
  })

  it('never parks a value it would refuse', () => {
    rememberLoginNext('https://evil.example/steal')
    expect(consumeLoginNext()).toBeNull()
  })

  it('does not haunt a later login', () => {
    const t0 = 1_000_000
    rememberLoginNext(AUTHORIZE_NEXT, t0)
    expect(consumeLoginNext(t0 + 11 * 60_000)).toBeNull()
  })

  it('resolves from the live param when nothing is parked', () => {
    expect(resolveLoginNext(AUTHORIZE_NEXT)).toBe(AUTHORIZE_NEXT)
    expect(resolveLoginNext('https://evil.example/')).toBeNull()
  })

  it('keeps `next` and `redirect` in separate slots', () => {
    rememberLoginNext(AUTHORIZE_NEXT)
    rememberLoginRedirect('/viewer/camstack/')
    expect(consumeLoginNext()).toBe(AUTHORIZE_NEXT)
    expect(consumeLoginRedirect()).toEqual({ kind: 'path', path: '/viewer/camstack/' })
  })
})
