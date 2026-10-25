/**
 * The token is the ONLY thing standing between a forwarded notification and a
 * gate opening. The operator chose that model knowingly; these tests pin the
 * three properties that bound it, because nothing else does.
 */

import { describe, expect, it } from 'vitest'
import {
  buildActionUrl,
  NcActionTokenRegistry,
  type NcSequenceGrant,
  signActionToken,
  verifyActionSignature,
} from '../action-token.js'

const SECRET = 'a-per-install-secret'

const grant = (over: Partial<NcSequenceGrant> = {}): NcSequenceGrant => ({
  kind: 'sequence',
  id: 'tok1',
  ruleId: 'r1',
  ruleName: 'Gate at night',
  sequenceId: 'open-gate-id',
  deviceId: 101,
  actionId: 'open',
  expiresAt: 10_000,
  ...over,
})

describe('single use', () => {
  it('lets the first tap through and refuses the second', () => {
    const reg = new NcActionTokenRegistry(() => 0)
    reg.put(grant())
    expect(reg.claim('tok1').ok).toBe(true)
    const second = reg.claim('tok1')
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe('already-used')
  })

  it('claims ATOMICALLY — two taps in the same tick cannot both win', () => {
    // The property a physical actuator depends on. `claim` marks the record
    // spent in the same synchronous step it reads it, so there is no await for
    // a second caller to slip through.
    const reg = new NcActionTokenRegistry(() => 0)
    reg.put(grant())
    const results = [reg.claim('tok1'), reg.claim('tok1'), reg.claim('tok1')]
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })

  it('a spent token stays spent after a sweep', () => {
    const reg = new NcActionTokenRegistry(() => 0)
    reg.put(grant())
    reg.claim('tok1')
    reg.sweep()
    // Swept to 'unknown' rather than resurrected — either way it must not run.
    expect(reg.claim('tok1').ok).toBe(false)
  })
})

describe('expiry is a comparison, not a job', () => {
  it('refuses a token past its expiry even though nothing swept it', () => {
    // A reaper that failed must never leave a live button behind.
    let now = 0
    const reg = new NcActionTokenRegistry(() => now)
    reg.put(grant({ expiresAt: 10_000 }))
    now = 10_001
    const claim = reg.claim('tok1')
    expect(claim.ok).toBe(false)
    if (!claim.ok) expect(claim.reason).toBe('expired')
  })

  it('does not count an expired token as live', () => {
    let now = 0
    const reg = new NcActionTokenRegistry(() => now)
    reg.put(grant({ expiresAt: 10_000 }))
    expect(reg.liveCount).toBe(1)
    now = 10_001
    expect(reg.liveCount).toBe(0)
  })
})

describe('the signature', () => {
  it('rejects a tampered id — a token cannot be re-pointed', () => {
    const exp = 10_000
    const sig = signActionToken(SECRET, 'tok1', exp)
    expect(verifyActionSignature({ secret: SECRET, id: 'tok2', exp, sig, nowMs: 0 })).toBe(false)
  })

  it('rejects a tampered expiry — the window cannot be extended', () => {
    const sig = signActionToken(SECRET, 'tok1', 10_000)
    expect(
      verifyActionSignature({ secret: SECRET, id: 'tok1', exp: 99_999_999, sig, nowMs: 0 }),
    ).toBe(false)
  })

  it('rejects another install’s secret', () => {
    const sig = signActionToken('a-different-install', 'tok1', 10_000)
    expect(verifyActionSignature({ secret: SECRET, id: 'tok1', exp: 10_000, sig, nowMs: 0 })).toBe(
      false,
    )
  })

  it('refuses an EXPIRED link even when the signature is perfect', () => {
    const exp = 10_000
    const sig = signActionToken(SECRET, 'tok1', exp)
    expect(verifyActionSignature({ secret: SECRET, id: 'tok1', exp, sig, nowMs: 10_001 })).toBe(
      false,
    )
    expect(verifyActionSignature({ secret: SECRET, id: 'tok1', exp, sig, nowMs: 9_999 })).toBe(true)
  })

  it('rejects a non-numeric expiry instead of throwing', () => {
    const sig = signActionToken(SECRET, 'tok1', 10_000)
    expect(verifyActionSignature({ secret: SECRET, id: 'tok1', exp: NaN, sig, nowMs: 0 })).toBe(
      false,
    )
  })
})

describe('the URL a phone receives', () => {
  it('round-trips through its own verifier', () => {
    const url = buildActionUrl({
      baseUrl: 'https://camstack.example.top/',
      routePrefix: 'addon/pipeline-analytics/nc-action',
      id: 'tok1',
      secret: SECRET,
      expMs: 10_000,
    })
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/addon/pipeline-analytics/nc-action/tok1')
    expect(
      verifyActionSignature({
        secret: SECRET,
        id: 'tok1',
        exp: Number(parsed.searchParams.get('exp')),
        sig: parsed.searchParams.get('sig') ?? '',
        nowMs: 0,
      }),
    ).toBe(true)
  })

  it('does not double the slash between base and prefix', () => {
    const url = buildActionUrl({
      baseUrl: 'https://h.example/',
      routePrefix: '/addon/x/nc-action',
      id: 'a',
      secret: SECRET,
      expMs: 1,
    })
    expect(url.startsWith('https://h.example/addon/x/nc-action/a?')).toBe(true)
  })
})
