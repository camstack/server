/**
 * The protection criterion, in two units — and the ONE GB unit the whole repo
 * now speaks.
 */
import { STORAGE_BYTES_PER_GB } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { resolveMinFreePercent } from '../location-protection.js'

const TB = 1024 ** 4

describe('the GB unit is binary, everywhere', () => {
  it('is 1024³ — the unit the persisted values were entered against', () => {
    // Pinned because the repo shipped BOTH: the orchestrator's `maxUsedGb` cap
    // used 1024³ and the recorder's placement headroom used 10⁹ for the same
    // stored key, so a location with a cap set was 7.4% off on one side.
    expect(STORAGE_BYTES_PER_GB).toBe(1_073_741_824)
    expect(STORAGE_BYTES_PER_GB).not.toBe(1_000_000_000)
  })
})

describe('resolveMinFreePercent', () => {
  it('converts minFreeGb against the volume total', () => {
    const notice = vi.fn()
    // 100 GB free on a 1 TB volume is 9.765625%.
    const percent = resolveMinFreePercent(
      { minFreeGb: 100 },
      10,
      { totalBytes: TB, availableBytes: 0 },
      notice,
    )
    expect(percent).toBeCloseTo(9.765625, 6)
    expect(notice).not.toHaveBeenCalled()
  })

  it('minFreeGb WINS over minFreePercent, and the redundancy is logged once', () => {
    const notice = vi.fn()
    const percent = resolveMinFreePercent(
      { minFreeGb: 100, minFreePercent: 25 },
      10,
      { totalBytes: TB, availableBytes: 0 },
      notice,
    )
    expect(percent).toBeCloseTo(9.765625, 6)
    expect(notice).toHaveBeenCalledTimes(1)
  })

  it('falls back to the percentage when the volume total is unknown', () => {
    const notice = vi.fn()
    expect(resolveMinFreePercent({ minFreeGb: 100, minFreePercent: 25 }, 10, null, notice)).toBe(25)
    // Two notices: the redundancy, and the failed conversion. Both are real.
    expect(notice).toHaveBeenCalledTimes(2)
  })

  it('falls back to the PROVIDER default when neither key is set', () => {
    const notice = vi.fn()
    expect(resolveMinFreePercent({}, 10, { totalBytes: TB, availableBytes: 0 }, notice)).toBe(10)
    expect(notice).not.toHaveBeenCalled()
  })

  it('a garbage value is not a capacity limit', () => {
    const notice = vi.fn()
    const capacity = { totalBytes: TB, availableBytes: 0 }
    expect(resolveMinFreePercent({ minFreeGb: 'lots' }, 10, capacity, notice)).toBe(10)
    expect(resolveMinFreePercent({ minFreeGb: Number.NaN }, 10, capacity, notice)).toBe(10)
    expect(resolveMinFreePercent({ minFreeGb: -5 }, 10, capacity, notice)).toBe(10)
  })

  it('a floor larger than the disk clamps at 100%, it does not run away', () => {
    const notice = vi.fn()
    expect(
      resolveMinFreePercent(
        { minFreeGb: 4_000 },
        10,
        { totalBytes: 500 * STORAGE_BYTES_PER_GB, availableBytes: 0 },
        notice,
      ),
    ).toBe(100)
  })
})
