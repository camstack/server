import { describe, it, expect } from 'vitest'
import { DeviceTryMemory, NO_TRY_HISTORY } from '../try-climb.js'
import { HoldLogGate } from '../climb-hold.js'
import { deliveryMeterStart } from '../delivery-meter.js'
import { ADAPTIVE_CONFIG } from '../adaptive-config.js'

describe('DeviceTryMemory — the try backoff survives a NEW viewer session (I4)', () => {
  const failed = {
    failures: 2,
    notBefore: 70_000,
    lastRevert: { tier: 'mid' as const, deliveryRatio: 0.6, stalled: false, at: 10_000 },
    trialFrom: 'low' as const,
  }
  it('a new session of the device inherits failures and backoff — never the trial itself', () => {
    const m = new DeviceTryMemory(600_000)
    m.set(104, failed, 10_000)
    expect(m.get(104, 20_000)).toEqual({ ...failed, trialFrom: null })
    expect(m.get(591, 20_000)).toBeNull()
  })
  it('forgets a device not refreshed within its TTL', () => {
    const m = new DeviceTryMemory(600_000)
    m.set(104, failed, 10_000)
    expect(m.get(104, 610_000)).not.toBeNull()
    expect(m.get(104, 610_001)).toBeNull()
  })
  it('a clean history is simply stored as clean', () => {
    const m = new DeviceTryMemory(600_000)
    m.set(104, failed, 0)
    m.set(104, NO_TRY_HISTORY, 1)
    expect(m.get(104, 2)).toEqual(NO_TRY_HISTORY)
  })
})

describe('HoldLogGate — a line per hold CHANGE, with hysteresis (m3)', () => {
  it('logs a new code, not a repeat, and not a code seen within the quiet window', () => {
    const g = new HoldLogGate(60_000)
    expect(g.shouldLog('delivery', 0)).toBe(true)
    expect(g.shouldLog('delivery', 2_000)).toBe(false)
    expect(g.shouldLog('try-unclean', 4_000)).toBe(true)
    // Cycling back within 60 s: silent — a link hovering at 0.90–0.95 used to
    // log every 4–8 s for ever.
    expect(g.shouldLog('delivery', 8_000)).toBe(false)
    expect(g.shouldLog('try-unclean', 12_000)).toBe(false)
    expect(g.shouldLog('delivery', 61_000)).toBe(true)
  })
  it('never logs progress (warming, trial)', () => {
    const g = new HoldLogGate(60_000)
    expect(g.shouldLog('warming', 0)).toBe(false)
    expect(g.shouldLog('trial', 0)).toBe(false)
  })
})

describe('deliveryMeterStart — a tier-change session measures nothing from its own dead air (I1)', () => {
  it('a first session measures from now; a re-offer from now + the change blackout', () => {
    expect(deliveryMeterStart(1_000, false, ADAPTIVE_CONFIG.waitAfterChangeMs)).toBe(1_000)
    expect(deliveryMeterStart(1_000, true, ADAPTIVE_CONFIG.waitAfterChangeMs)).toBe(9_000)
  })
})
