import { describe, expect, it } from 'vitest'
import { reconnectDelayMs, RECONNECT_BASE_MS, RECONNECT_MAX_MS } from '../esphome-backoff.js'

describe('reconnect schedule', () => {
  it('doubles from the base without jitter', () => {
    expect(reconnectDelayMs(0, 0.5)).toBe(RECONNECT_BASE_MS)
    expect(reconnectDelayMs(1, 0.5)).toBe(RECONNECT_BASE_MS * 2)
    expect(reconnectDelayMs(2, 0.5)).toBe(RECONNECT_BASE_MS * 4)
  })

  it('is bounded by the cap no matter how many attempts failed', () => {
    expect(reconnectDelayMs(50, 0.5)).toBe(RECONNECT_MAX_MS)
    expect(reconnectDelayMs(10_000, 1)).toBeLessThanOrEqual(RECONNECT_MAX_MS * 1.2)
  })

  it('jitter stays within plus or minus 20 percent', () => {
    const low = reconnectDelayMs(3, 0)
    const high = reconnectDelayMs(3, 1)
    const mid = reconnectDelayMs(3, 0.5)
    expect(low).toBeCloseTo(mid * 0.8, 5)
    expect(high).toBeCloseTo(mid * 1.2, 5)
  })
})
