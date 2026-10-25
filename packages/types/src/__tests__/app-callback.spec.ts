import { describe, expect, it } from 'vitest'
import { APP_AUTH_CALLBACK_URLS, hasUrlScheme, parseAppAuthCallback } from '../auth/app-callback.js'

/** D801 — the one list of app callbacks a hub flow may return a browser to. */
describe('parseAppAuthCallback', () => {
  it('accepts the production and dev app callbacks, canonicalised', () => {
    expect(APP_AUTH_CALLBACK_URLS).toEqual([
      'camstack://auth-callback',
      'camstack.dev://auth-callback',
    ])
    expect(parseAppAuthCallback('camstack://auth-callback')).toBe('camstack://auth-callback')
    expect(parseAppAuthCallback('camstack:///auth-callback')).toBe('camstack://auth-callback')
    expect(parseAppAuthCallback('camstack.dev://auth-callback/')).toBe(
      'camstack.dev://auth-callback',
    )
  })

  it('refuses riders, other schemes, web URLs and oversize input', () => {
    for (const raw of [
      'camstack://auth-callback?x=1',
      'camstack://auth-callback#x',
      'evil://auth-callback',
      'https://camstack/auth-callback',
      'camstack:////auth-callback',
      `camstack://auth-callback${'/'.repeat(600)}`,
      '',
      null,
    ]) {
      expect(parseAppAuthCallback(raw), String(raw)).toBeNull()
    }
  })
})

describe('hasUrlScheme', () => {
  it('tells a scheme URL from a hub path', () => {
    expect(hasUrlScheme('camstack://auth-callback?link=x')).toBe(true)
    expect(hasUrlScheme('/system/my-access')).toBe(false)
  })
})
