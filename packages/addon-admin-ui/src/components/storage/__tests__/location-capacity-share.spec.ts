/**
 * The two figures the bar carries BESIDES the volume's own fill: CamStack's
 * share of the disk, and the cap — when one is actually in force.
 *
 * "The volume is 89% full" and "we hold half of it" are different decisions,
 * and only the second says whether the fix is ours. An unmeasurable share is
 * OMITTED, never drawn as zero (D315).
 */
import { describe, expect, it } from 'vitest'
import { type CapacityBar, resolveCapacityBar } from '../location-capacity-bar'
import { ownedBytesByLocation, resolveOwnedBytes } from '../location-owned-usage'
import { resolveSystemCap, type SystemCap } from '../location-protection'

const GB = 1024 ** 3

/** `/recordings` — 210 GB free of 1863 GB. */
const RECORDINGS = { totalBytes: 1863 * GB, availableBytes: 210 * GB }
/** `/recordings-2` — 3653 GB free of 3724 GB. */
const RECORDINGS_2 = { totalBytes: 3724 * GB, availableBytes: 3653 * GB }

function known(bar: CapacityBar) {
  if (bar.kind !== 'known') throw new Error(`expected a known bar, got ${bar.kind}`)
  return bar
}

describe("resolveCapacityBar — CamStack's own share", () => {
  it('draws the share as its own band, with the rest of the disk beside it', () => {
    const bar = known(resolveCapacityBar(RECORDINGS, null, { ownedBytes: 930 * GB }))
    expect(bar.segments.ownedPercent).toBeCloseTo(49.9, 0)
    expect(bar.labels.owned).toMatch(/930 GB of recordings \(50%\)/)
    expect(bar.summary).toMatch(/CamStack holds 930 GB of recordings/)
    // `used` is now what is on the disk BESIDE us — the two do not overlap —
    // while the summary still reports the volume's own free/total.
    expect(bar.segments.usedPercent).toBeCloseTo(38.8, 0)
    expect(bar.summary).toMatch(/210 GB free of 1.8 TB \(11% free\)/)
  })

  it('OMITS the segment when the share is not measurable — never a zero', () => {
    const unmeasurable = [{}, { ownedBytes: null }, { ownedBytes: Number.NaN }]
    for (const extras of unmeasurable) {
      const bar = known(resolveCapacityBar(RECORDINGS, null, extras))
      expect(bar.segments.ownedPercent).toBeNull()
      expect(bar.labels.owned).toBeNull()
      expect(bar.summary).not.toMatch(/CamStack holds/)
    }
  })

  it('renders a MEASURED share of zero as zero — measured is not unknown', () => {
    const bar = known(resolveCapacityBar(RECORDINGS_2, null, { ownedBytes: 0 }))
    expect(bar.segments.ownedPercent).toBe(0)
    expect(bar.labels.owned).toMatch(/0 B of recordings \(0%\)/)
  })
})

describe('resolveCapacityBar — the system-managed cap', () => {
  const LEGACY_CAP: SystemCap = { bytes: 900 * GB, reason: 'legacy' }
  const DRAIN_CAP: SystemCap = { bytes: 120 * GB, reason: 'drain' }

  it('marks NO cap when none is in force', () => {
    const bar = known(resolveCapacityBar(RECORDINGS, null, { ownedBytes: 930 * GB }))
    expect(bar.segments.capPercent).toBeNull()
    expect(bar.labels.cap).toBeNull()
    expect(bar.capBelowOwned).toBe(false)
    expect(bar.summary).not.toMatch(/cap/i)
  })

  it('marks a legacy cap and names who manages it', () => {
    const bar = known(resolveCapacityBar(RECORDINGS, null, { cap: LEGACY_CAP }))
    expect(bar.segments.capPercent).toBeCloseTo(48.3, 0)
    expect(bar.labels.cap).toMatch(/900 GB cap \(managed by CamStack\)/)
    expect(bar.capBelowOwned).toBe(false)
  })

  it('flags a cap already BELOW what is stored here', () => {
    const bar = known(
      resolveCapacityBar(RECORDINGS, null, { ownedBytes: 930 * GB, cap: LEGACY_CAP }),
    )
    expect(bar.capBelowOwned).toBe(true)
    expect(bar.summary).toMatch(/already below what is stored here/)
  })

  it('cannot claim a cap is below an UNMEASURED share', () => {
    const bar = known(resolveCapacityBar(RECORDINGS, null, { cap: DRAIN_CAP }))
    expect(bar.capBelowOwned).toBe(false)
  })

  it("names a draining location's cap as the drain target", () => {
    const bar = known(
      resolveCapacityBar(RECORDINGS, null, { ownedBytes: 200 * GB, cap: DRAIN_CAP }),
    )
    expect(bar.labels.cap).toMatch(/120 GB drain target \(managed by CamStack\)/)
    expect(bar.capBelowOwned).toBe(true)
    expect(bar.segments.capPercent).toBeCloseTo(6.4, 0)
  })
})

describe('resolveSystemCap', () => {
  it('is null on the common case — no stored value, not draining', () => {
    expect(resolveSystemCap({ basePath: '/recordings' }, 'active')).toBeNull()
    expect(resolveSystemCap({ basePath: '/recordings' }, 'drain')).toBeNull()
  })

  it('reports a legacy stored value as a legacy cap', () => {
    expect(resolveSystemCap({ maxUsedGb: 900 }, 'active')).toEqual({
      bytes: 900 * GB,
      reason: 'legacy',
    })
  })

  it('reports the same value on a draining location as the drain target', () => {
    expect(resolveSystemCap({ maxUsedGb: 120 }, 'drain')).toEqual({
      bytes: 120 * GB,
      reason: 'drain',
    })
  })

  it('ignores a nonsense value rather than marking a bar at NaN', () => {
    expect(resolveSystemCap({ maxUsedGb: 'lots' }, 'drain')).toBeNull()
    expect(resolveSystemCap({ maxUsedGb: -5 }, 'active')).toBeNull()
  })
})

describe('resolveOwnedBytes', () => {
  const ROWS = [
    { locationId: 'recordings:default', locationIds: ['recordings:default'], usedBytes: 930 * GB },
    {
      locationId: 'recordingsLow:ssd',
      locationIds: ['recordingsLow:ssd', 'eventMedia:ssd'],
      usedBytes: 40 * GB,
    },
  ]

  it('reads the measured figure for a recordings location', () => {
    expect(resolveOwnedBytes({ id: 'recordings:default', type: 'recordings' }, ROWS)).toBe(930 * GB)
  })

  it('reads it through the aliases of a shared physical volume', () => {
    expect(resolveOwnedBytes({ id: 'recordingsLow:ssd', type: 'recordingsLow' }, ROWS)).toBe(
      40 * GB,
    )
  })

  it('has NO figure for a class the recorder does not account', () => {
    // The row aliasing this id counts recordings only — attributing its bytes
    // here would be a made-up number wearing a measured label.
    expect(resolveOwnedBytes({ id: 'eventMedia:ssd', type: 'eventMedia' }, ROWS)).toBeNull()
    expect(resolveOwnedBytes({ id: 'backups:nas', type: 'backups' }, ROWS)).toBeNull()
  })

  it('has no figure when no row covers the volume, or when the payload is missing', () => {
    expect(resolveOwnedBytes({ id: 'recordings:nvme', type: 'recordings' }, ROWS)).toBeNull()
    expect(
      resolveOwnedBytes({ id: 'recordings:default', type: 'recordings' }, undefined),
    ).toBeNull()
    expect(resolveOwnedBytes({ id: 'recordings:default', type: 'recordings' }, [])).toBeNull()
  })

  it('maps a whole group, leaving the unmeasurable ones OUT of the map', () => {
    const map = ownedBytesByLocation(
      [
        { id: 'recordings:default', type: 'recordings' },
        { id: 'eventMedia:ssd', type: 'eventMedia' },
      ],
      ROWS,
    )
    expect(map.get('recordings:default')).toBe(930 * GB)
    expect(map.has('eventMedia:ssd')).toBe(false)
  })
})
