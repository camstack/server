/**
 * The legend and the segments come out of ONE pass, so an entry exists exactly
 * when its band does. The pairing is the test: a band nothing names is
 * unreadable, and an entry naming a band that is not drawn is a lie — the
 * unmeasured share must be absent in BOTH.
 */
import { describe, expect, it } from 'vitest'
import {
  type CapacityBar,
  type CapacitySegmentId,
  resolveCapacityBar,
} from '../location-capacity-bar'
import type { SystemCap } from '../location-protection'

const GB = 1024 ** 3

/** `/recordings` — 210 GB free of 1863 GB. */
const RECORDINGS = { totalBytes: 1863 * GB, availableBytes: 210 * GB }

function known(bar: CapacityBar) {
  if (bar.kind !== 'known') throw new Error(`expected a known bar, got ${bar.kind}`)
  return bar
}

function segmentsOf(bar: ReturnType<typeof known>): readonly CapacitySegmentId[] {
  return bar.legend.map((entry) => entry.segment)
}

describe('the capacity legend', () => {
  it('always names the two bands that always exist', () => {
    const bar = known(resolveCapacityBar(RECORDINGS, null))
    expect(segmentsOf(bar)).toEqual(['used', 'free'])
    // With no measured share this band IS everything on the disk, and says so.
    expect(bar.legend[0]).toEqual({
      segment: 'used',
      label: 'Used',
      value: '1.6 TB (89%)',
      alarming: false,
    })
    expect(bar.legend[1]?.value).toBe('210 GB (11%)')
  })

  it('lists the bands LEFT TO RIGHT: reserve, our share, the rest, free', () => {
    const cap: SystemCap = { bytes: 900 * GB, reason: 'legacy' }
    const bar = known(resolveCapacityBar(RECORDINGS, 100 * GB, { ownedBytes: 1500 * GB, cap }))
    expect(segmentsOf(bar)).toEqual(['reserve', 'owned', 'used', 'free', 'cap'])
  })

  it('renames the remainder band once our share is measured', () => {
    const bare = known(resolveCapacityBar(RECORDINGS, null))
    const shared = known(resolveCapacityBar(RECORDINGS, null, { ownedBytes: 930 * GB }))
    expect(bare.legend.find((e) => e.segment === 'used')?.label).toBe('Used')
    expect(shared.legend.find((e) => e.segment === 'used')?.label).toBe('Other data')
  })

  it('names every band that IS drawn, and only those', () => {
    const cap: SystemCap = { bytes: 900 * GB, reason: 'legacy' }
    const bar = known(resolveCapacityBar(RECORDINGS, 186 * GB, { ownedBytes: 1500 * GB, cap }))
    expect(segmentsOf(bar)).toEqual(['reserve', 'owned', 'used', 'free', 'cap'])
  })

  it('pairs each optional entry with its segment, in both directions', () => {
    const cap: SystemCap = { bytes: 900 * GB, reason: 'legacy' }
    const cases = [
      { reserve: null, extras: {} },
      { reserve: null, extras: { ownedBytes: 1500 * GB } },
      { reserve: 186 * GB, extras: {} },
      { reserve: 0, extras: { cap } },
      { reserve: 186 * GB, extras: { ownedBytes: 1500 * GB, cap } },
    ]
    for (const testCase of cases) {
      const bar = known(resolveCapacityBar(RECORDINGS, testCase.reserve, testCase.extras))
      const named = segmentsOf(bar)
      expect(named.includes('owned')).toBe(bar.segments.ownedPercent !== null)
      expect(named.includes('cap')).toBe(bar.segments.capPercent !== null)
      expect(named.includes('reserve')).toBe(bar.segments.reservePercent > 0)
      // Nothing is named twice, and every entry carries text.
      expect(new Set(named).size).toBe(named.length)
      for (const entry of bar.legend) {
        expect(entry.label.length).toBeGreaterThan(0)
        expect(entry.value.length).toBeGreaterThan(0)
      }
    }
  })

  it('has NO legend entry for a share nobody measured', () => {
    const bar = known(resolveCapacityBar(RECORDINGS, null, { ownedBytes: null }))
    expect(segmentsOf(bar)).not.toContain('owned')
  })

  it('marks the entries that are the problem', () => {
    const overFull = { totalBytes: 100 * GB, availableBytes: 2 * GB }
    const bar = known(resolveCapacityBar(overFull, 10 * GB))
    const byId = new Map(bar.legend.map((entry) => [entry.segment, entry]))
    expect(byId.get('used')?.alarming).toBe(true)
    // The reserve could not be held: both it and what is left of free say so.
    expect(byId.get('reserve')?.alarming).toBe(true)
    expect(byId.get('free')?.alarming).toBe(true)
  })

  it('is calm on a disk with room to spare', () => {
    const bar = known(
      resolveCapacityBar({ totalBytes: 3724 * GB, availableBytes: 3653 * GB }, 372 * GB),
    )
    for (const entry of bar.legend) expect(entry.alarming).toBe(false)
  })

  it('marks a cap that already sits below what is stored here', () => {
    const cap: SystemCap = { bytes: 900 * GB, reason: 'drain' }
    const bar = known(resolveCapacityBar(RECORDINGS, null, { ownedBytes: 1500 * GB, cap }))
    const entry = bar.legend.find((e) => e.segment === 'cap')
    expect(entry?.label).toBe('Drain target')
    expect(entry?.alarming).toBe(true)
  })
})
