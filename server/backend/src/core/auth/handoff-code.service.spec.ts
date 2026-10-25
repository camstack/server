import { describe, it, expect } from 'vitest'
import {
  HandoffCodeService,
  HANDOFF_CODE_PREFIX,
  HANDOFF_CODE_TTL_MS,
  HANDOFF_CODE_MAX_PENDING,
} from './handoff-code.service.js'

/** Deterministic clock the tests can advance. */
function makeClock(start = 1_000_000) {
  const state = { now: start }
  return {
    now: () => state.now,
    advance: (ms: number) => {
      state.now += ms
    },
  }
}

describe('HandoffCodeService', () => {
  it('mints a prefixed code with the 60s TTL and redeems it exactly once', () => {
    const clock = makeClock()
    const service = new HandoffCodeService(clock.now)

    const minted = service.create('u-1')
    expect(minted.code.startsWith(HANDOFF_CODE_PREFIX)).toBe(true)
    expect(minted.expiresAt).toBe(clock.now() + HANDOFF_CODE_TTL_MS)

    // First redeem wins…
    expect(service.redeem(minted.code)).toEqual({ userId: 'u-1', purpose: 'renew' })
    // …the second (replay) is dead.
    expect(service.redeem(minted.code)).toBeNull()
  })

  it('rejects an expired code (and still consumes it)', () => {
    const clock = makeClock()
    const service = new HandoffCodeService(clock.now)
    const minted = service.create('u-1')

    clock.advance(HANDOFF_CODE_TTL_MS + 1)
    expect(service.redeem(minted.code)).toBeNull()
    expect(service.pendingCount).toBe(0)
  })

  it('redeems right at the TTL boundary but not beyond', () => {
    const clock = makeClock()
    const service = new HandoffCodeService(clock.now)
    const minted = service.create('u-1')

    clock.advance(HANDOFF_CODE_TTL_MS)
    expect(service.redeem(minted.code)).toEqual({ userId: 'u-1', purpose: 'renew' })
  })

  it('rejects an unknown / forged code', () => {
    const service = new HandoffCodeService()
    expect(service.redeem(`${HANDOFF_CODE_PREFIX}${'0'.repeat(64)}`)).toBeNull()
    expect(service.redeem('')).toBeNull()
    expect(service.redeem('not-a-code')).toBeNull()
  })

  it('binds each code to its own user', () => {
    const service = new HandoffCodeService()
    const a = service.create('u-a')
    const b = service.create('u-b')
    expect(service.redeem(b.code)).toEqual({ userId: 'u-b', purpose: 'renew' })
    expect(service.redeem(a.code)).toEqual({ userId: 'u-a', purpose: 'renew' })
  })

  it('prunes expired entries on mint and enforces the pending bound', () => {
    const clock = makeClock()
    const service = new HandoffCodeService(clock.now)

    service.create('u-old')
    clock.advance(HANDOFF_CODE_TTL_MS + 1)
    service.create('u-new')
    // The expired entry was pruned by the second mint.
    expect(service.pendingCount).toBe(1)

    // Fill to the cap → the next mint fails fast.
    for (let i = service.pendingCount; i < HANDOFF_CODE_MAX_PENDING; i++) {
      service.create(`u-${i}`)
    }
    expect(() => service.create('u-overflow')).toThrow(/Too many pending handoff codes/)
  })
})
