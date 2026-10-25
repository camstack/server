/**
 * A login session's `client` is the raw User-Agent it signed in with. The
 * lists show a friendly label from simple heuristics and fall back to the raw
 * string, truncated, when nothing matches.
 */
import { describe, expect, it } from 'vitest'
import { describeClient, describeMethod } from '../session-client'

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const FIREFOX_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0'
const EDGE_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0'
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'

describe('describeClient', () => {
  it.each([
    [CHROME_MAC, 'Chrome on macOS'],
    [SAFARI_IPHONE, 'Safari on iPhone'],
    [FIREFOX_WIN, 'Firefox on Windows'],
    [EDGE_WIN, 'Edge on Windows'],
    [CHROME_ANDROID, 'Chrome on Android'],
    ['camstack/42 CFNetwork/1568.100.1 Darwin/24.0.0', 'CamStack app on iOS'],
    ['okhttp/4.12.0', 'CamStack app on Android'],
    ['node', 'Script (Node.js)'],
    ['curl/8.7.1', 'curl'],
  ])('%s → %s', (ua, label) => {
    expect(describeClient(ua).label).toBe(label)
  })

  it('an unknown client is shown raw, truncated', () => {
    const raw = 'SomeVeryCustomHttpClient/1.0 (with a lot of extra detail that goes on and on)'
    const { label } = describeClient(raw)
    expect(label.length).toBeLessThanOrEqual(41)
    expect(label.endsWith('…')).toBe(true)
    expect(raw.startsWith(label.slice(0, -1))).toBe(true)
  })

  it('no client at all is an unknown device', () => {
    expect(describeClient(null).label).toBe('Unknown device')
  })
})

describe('describeMethod', () => {
  it('words the known sign-in methods and passes others through', () => {
    expect(describeMethod('password')).toBe('Password')
    expect(describeMethod('passkey')).toBe('Passkey')
    expect(describeMethod('sso')).toBe('Single sign-on')
    expect(describeMethod('something-new')).toBe('something-new')
  })
})
