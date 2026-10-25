import { describe, expect, it } from 'vitest'
import { createRateLimiter, clientKeyFromRequest } from '../auth-rate-limit.js'

/**
 * Public-auth rate limiter — fixed window per (bucket, client-ip), pure
 * and clock-injectable. First line of defence for login / passkey /
 * redeem / exchange, which previously had NO throttling at all.
 */
describe('createRateLimiter', () => {
  it('allows up to max attempts inside the window, then blocks with retry-after', () => {
    let now = 1_000_000
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3, now: () => now })
    expect(limiter.check('ip-1').allowed).toBe(true)
    expect(limiter.check('ip-1').allowed).toBe(true)
    expect(limiter.check('ip-1').allowed).toBe(true)
    const blocked = limiter.check('ip-1')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60)
    // A different client is unaffected.
    expect(limiter.check('ip-2').allowed).toBe(true)
    // Window expiry resets the budget.
    now += 61_000
    expect(limiter.check('ip-1').allowed).toBe(true)
  })

  it('bounds its key map (attacker cannot exhaust memory with spoofed keys)', () => {
    let now = 1_000_000
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3, maxKeys: 100, now: () => now })
    for (let i = 0; i < 250; i++) limiter.check(`ip-${i}`)
    expect(limiter.size()).toBeLessThanOrEqual(100)
    now += 1
    // Still functional after eviction pressure.
    expect(limiter.check('fresh').allowed).toBe(true)
  })
})

describe('peek', () => {
  it('reports a blocked key without spending an attempt', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2, now: () => 5 })
    expect(limiter.peek('acct').allowed).toBe(true)
    limiter.check('acct')
    limiter.check('acct')
    expect(limiter.peek('acct').allowed).toBe(false)
    expect(limiter.peek('other').allowed).toBe(true)
    expect(limiter.size()).toBe(1)
  })
})

describe('clientKeyFromRequest', () => {
  const req = (peer: string, headers: Record<string, string> = {}) => ({
    headers,
    socket: { remoteAddress: peer },
  })

  it('keys a direct request on its socket peer', () => {
    expect(clientKeyFromRequest(req('10.0.0.7'))).toBe('10.0.0.7')
  })

  it('keys a TUNNELLED request on the real client, not on loopback', () => {
    expect(clientKeyFromRequest(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.20' }))).toBe(
      '203.0.113.20',
    )
    expect(clientKeyFromRequest(req('127.0.0.1', { 'cf-connecting-ip': '198.51.100.3' }))).toBe(
      '198.51.100.3',
    )
  })

  it('SECURITY: ignores a forged forwarding header from an untrusted peer', () => {
    expect(clientKeyFromRequest(req('203.0.113.66', { 'x-forwarded-for': '1.2.3.4' }))).toBe(
      '203.0.113.66',
    )
  })

  it('returns null for mesh-internal calls (no request) — caller skips limiting', () => {
    expect(clientKeyFromRequest(undefined)).toBe(null)
    expect(clientKeyFromRequest({})).toBe(null)
  })
})

describe('buckets behind the tunnel', () => {
  it('ten wrong passwords from ONE remote client do not lock out ANOTHER remote client', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 10, now: () => 1 })
    const attacker = clientKeyFromRequest({
      headers: { 'cf-connecting-ip': '203.0.113.1' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    const victim = clientKeyFromRequest({
      headers: { 'cf-connecting-ip': '198.51.100.2' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    for (let i = 0; i < 11; i++) limiter.check(`auth.login:${attacker}`)
    expect(limiter.check(`auth.login:${attacker}`).allowed).toBe(false)
    expect(limiter.check(`auth.login:${victim}`).allowed).toBe(true)
  })
})
