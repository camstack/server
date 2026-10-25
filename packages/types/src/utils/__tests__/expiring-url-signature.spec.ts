import { describe, expect, it } from 'vitest'

import { signExpiringUrl, verifyExpiringUrl } from '../expiring-url-signature.js'

const SECRET = 'a-per-install-secret'
const NOW = 1_700_000_000_000

describe('expiring url signature', () => {
  it('round-trips a link that has not expired', () => {
    const exp = NOW + 60_000
    const sig = signExpiringUrl(SECRET, '101:240', exp)
    expect(verifyExpiringUrl({ secret: SECRET, id: '101:240', exp, sig, nowMs: NOW })).toBe(true)
  })

  it('accepts the exp as the raw query string it arrives as', () => {
    const exp = NOW + 60_000
    const sig = signExpiringUrl(SECRET, '101:240', exp)
    expect(
      verifyExpiringUrl({ secret: SECRET, id: '101:240', exp: String(exp), sig, nowMs: NOW }),
    ).toBe(true)
  })

  it('refuses an EXPIRED link even when the signature is valid', () => {
    // The property that makes a leaked URL stop working on its own. Signing is
    // still correct here — only the clock has moved.
    const exp = NOW - 1
    const sig = signExpiringUrl(SECRET, '101:240', exp)
    expect(verifyExpiringUrl({ secret: SECRET, id: '101:240', exp, sig, nowMs: NOW })).toBe(false)
  })

  it('refuses a link signed for a DIFFERENT id', () => {
    // A leaked link for one camera must not be replayable against another, and
    // must not be replayable at another width.
    const exp = NOW + 60_000
    const sig = signExpiringUrl(SECRET, '101:240', exp)
    expect(verifyExpiringUrl({ secret: SECRET, id: '102:240', exp, sig, nowMs: NOW })).toBe(false)
    expect(verifyExpiringUrl({ secret: SECRET, id: '101:960', exp, sig, nowMs: NOW })).toBe(false)
  })

  it('refuses a link whose exp was tampered with to extend it', () => {
    const exp = NOW + 60_000
    const sig = signExpiringUrl(SECRET, '101:240', exp)
    expect(
      verifyExpiringUrl({ secret: SECRET, id: '101:240', exp: exp + 3_600_000, sig, nowMs: NOW }),
    ).toBe(false)
  })

  it('refuses a link signed with a different install secret', () => {
    const exp = NOW + 60_000
    const sig = signExpiringUrl('someone-elses-secret', '101:240', exp)
    expect(verifyExpiringUrl({ secret: SECRET, id: '101:240', exp, sig, nowMs: NOW })).toBe(false)
  })

  it('refuses missing / malformed parts rather than throwing', () => {
    const exp = NOW + 60_000
    const sig = signExpiringUrl(SECRET, '101:240', exp)
    expect(
      verifyExpiringUrl({ secret: SECRET, id: '101:240', exp: undefined, sig, nowMs: NOW }),
    ).toBe(false)
    expect(
      verifyExpiringUrl({ secret: SECRET, id: '101:240', exp, sig: undefined, nowMs: NOW }),
    ).toBe(false)
    expect(
      verifyExpiringUrl({ secret: SECRET, id: '101:240', exp: 'not-a-number', sig, nowMs: NOW }),
    ).toBe(false)
    // A short signature must not blow up the length-mismatched timingSafeEqual.
    expect(verifyExpiringUrl({ secret: SECRET, id: '101:240', exp, sig: 'ab', nowMs: NOW })).toBe(
      false,
    )
  })

  it('is deterministic — the same (secret, id, exp) always yields the same tag', () => {
    const exp = NOW + 60_000
    expect(signExpiringUrl(SECRET, '101:240', exp)).toBe(signExpiringUrl(SECRET, '101:240', exp))
  })
})
