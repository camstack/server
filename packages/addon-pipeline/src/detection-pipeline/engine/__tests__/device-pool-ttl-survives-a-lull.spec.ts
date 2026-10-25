import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IdlePoolReaper } from '../idle-pool-reaper.js'

/**
 * The TTL has to outlast a QUIET NIGHT, not a busy minute.
 *
 * Detection is dispatched on motion, so a camera that sees nothing stops
 * touching its device pool entirely. Under the old 120s TTL the pool was
 * evicted between events and the next motion paid a full reload of every
 * enabled step — seven models on the hub — before it could detect anything.
 * The hub log showed the loop directly: `COMPILE ×7` → shed within 7-15s →
 * `EVICT` ~2.5 min later → repeat.
 *
 * These tests pin the property that matters (a realistic lull must NOT evict)
 * rather than the constant itself, so tuning the number cannot silently
 * reintroduce the recompile cycle.
 */
describe('a device pool survives a realistic gap between motion events', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** What the provider ships. Mirrors DEVICE_POOL_IDLE_TTL_MS's default. */
  const SHIPPED_TTL_MS = 6 * 60 * 60 * 1000

  it('a 30-minute quiet spell does not evict the pool', async () => {
    const disposed: string[] = []
    const reaper = new IdlePoolReaper({
      ttlMs: SHIPPED_TTL_MS,
      dispose: async (k) => void disposed.push(k),
    })
    reaper.touch('openvino:gpu')
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(disposed).toEqual([])
  })

  it('the old 120s TTL DID evict across the same gap — this is the regression', async () => {
    const disposed: string[] = []
    const reaper = new IdlePoolReaper({
      ttlMs: 120_000,
      dispose: async (k) => void disposed.push(k),
    })
    reaper.touch('openvino:gpu')
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(disposed).toEqual(['openvino:gpu'])
  })

  it('a genuinely unused pool is still reclaimed — the guardrail survives', async () => {
    // The reaper exists so `factoriesByDevice` cannot accumulate warm pools as
    // an operator toggles device sets. Raising the TTL must not disable that.
    const disposed: string[] = []
    const reaper = new IdlePoolReaper({
      ttlMs: SHIPPED_TTL_MS,
      dispose: async (k) => void disposed.push(k),
    })
    reaper.touch('edgetpu:usb')
    await vi.advanceTimersByTimeAsync(SHIPPED_TTL_MS)
    expect(disposed).toEqual(['edgetpu:usb'])
  })
})
