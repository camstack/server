/**
 * The capacity bar's geometry. Every case here has bitten this repo: a volume
 * that never answered `statfs`, a reserve bigger than what is free, no reserve
 * at all, and a filesystem claiming more free than total.
 *
 * The fixtures are the live hub's own disks.
 */
import { describe, expect, it } from 'vitest'
import { FILL_CRITICAL_FRACTION, FILL_WARN_FRACTION } from '../../recordings/storage-fill'
import { type CapacityBar, resolveCapacityBar } from '../location-capacity-bar'

const GB = 1024 ** 3

/** `/recordings` — 210 GB free of 1863 GB. */
const RECORDINGS = { totalBytes: 1863 * GB, availableBytes: 210 * GB }
/** `/recordings-2` — 3653 GB free of 3724 GB, freshly added. */
const RECORDINGS_2 = { totalBytes: 3724 * GB, availableBytes: 3653 * GB }
/** `/data/backups` — 163 GB free of 471 GB. */
const BACKUPS = { totalBytes: 471 * GB, availableBytes: 163 * GB }

function known(bar: CapacityBar) {
  if (bar.kind !== 'known') throw new Error(`expected a known bar, got ${bar.kind}`)
  return bar
}

describe('resolveCapacityBar', () => {
  it('fills the bar and names the free bytes, the percentage and the total', () => {
    const bar = known(resolveCapacityBar(BACKUPS, null))
    expect(bar.labels.free).toBe('163 GB')
    expect(bar.labels.total).toBe('471 GB')
    expect(bar.labels.freePercent).toBe('35%')
    expect(bar.segments.usedPercent).toBeCloseTo(65.4, 0)
    expect(bar.segments.freePercent).toBeCloseTo(34.6, 0)
  })

  it('takes its severity from the ONE fill derivation, not a second scale', () => {
    const ok = known(resolveCapacityBar(RECORDINGS_2, null))
    expect(ok.severity).toBe('ok')
    const warn = known(
      resolveCapacityBar(
        { totalBytes: 100 * GB, availableBytes: (1 - FILL_WARN_FRACTION) * 100 * GB },
        null,
      ),
    )
    expect(warn.severity).toBe('warn')
    const critical = known(
      resolveCapacityBar(
        { totalBytes: 100 * GB, availableBytes: (1 - FILL_CRITICAL_FRACTION) * 100 * GB },
        null,
      ),
    )
    expect(critical.severity).toBe('critical')
  })

  it('says CAPACITY UNKNOWN when the volume never answered — never an empty bar', () => {
    expect(resolveCapacityBar({ totalBytes: null, availableBytes: null }, null).kind).toBe(
      'unknown',
    )
    expect(resolveCapacityBar({ totalBytes: 100 * GB, availableBytes: null }, null).kind).toBe(
      'unknown',
    )
    expect(resolveCapacityBar({ totalBytes: null, availableBytes: 10 * GB }, null).kind).toBe(
      'unknown',
    )
    const zero = resolveCapacityBar({ totalBytes: 0, availableBytes: 0 }, null)
    expect(zero.kind).toBe('unknown')
    expect(zero.summary).toMatch(/capacity unknown/i)
  })

  /**
   * The live `backups:smb` row: its VOLUME cannot be measured from the hub —
   * it is an SMB share — but what CamStack holds on it was measured by the
   * provider that writes there (1.6 GB). Dropping that figure along with the
   * bar would hide a fact we have, which is the other half of the same
   * mistake: unknown is about the denominator, not the numerator.
   */
  it('still names the share we DID measure when the volume is unknown', () => {
    const bar = resolveCapacityBar({ totalBytes: null, availableBytes: null }, null, {
      ownedBytes: 1.6 * GB,
    })
    expect(bar.kind).toBe('unknown')
    if (bar.kind !== 'unknown') return
    expect(bar.owned).toBe('1.6 GB')
    expect(bar.summary).toMatch(/1\.6 GB/)
  })

  it('names nothing extra when the share is unmeasured too', () => {
    const bar = resolveCapacityBar({ totalBytes: null, availableBytes: null }, null)
    expect(bar.kind).toBe('unknown')
    if (bar.kind !== 'unknown') return
    expect(bar.owned).toBeNull()
  })

  it('paints the reserve as a band at the FULL end of the bar', () => {
    const bar = known(resolveCapacityBar(RECORDINGS, 186 * GB))
    expect(bar.segments.reservePercent).toBeCloseTo(10, 0)
    expect(bar.reserveExceedsFree).toBe(false)
    expect(bar.labels.reserve).toBe('186 GB kept free')
  })

  it('flags a reserve LARGER than the free space, and never draws it over other bytes', () => {
    const bar = known(resolveCapacityBar(RECORDINGS, 400 * GB))
    expect(bar.reserveExceedsFree).toBe(true)
    // The band takes what free space there IS — 210 GB of the wanted 400 — and
    // nothing is left free. It cannot eat into bytes another tenant occupies.
    expect(bar.segments.reservePercent).toBeCloseTo(11.3, 0)
    expect(bar.segments.freePercent).toBe(0)
    expect(bar.summary).toMatch(/less free than that right now/i)
  })

  it('draws NO band for a reserve of zero (and none for an absent one)', () => {
    const zero = known(resolveCapacityBar(BACKUPS, 0))
    expect(zero.segments.reservePercent).toBe(0)
    expect(zero.labels.reserve).toBeNull()
    expect(zero.reserveExceedsFree).toBe(false)
    const absent = known(resolveCapacityBar(BACKUPS, null))
    expect(absent.labels.reserve).toBeNull()
  })

  it('caps a reserve wider than the whole volume at the free space', () => {
    const bar = known(resolveCapacityBar(BACKUPS, 900 * GB))
    expect(bar.segments.reservePercent).toBeCloseTo(34.6, 0)
    expect(bar.segments.freePercent).toBe(0)
    expect(bar.reserveExceedsFree).toBe(true)
  })

  it('survives a filesystem reporting MORE free than total', () => {
    const bar = known(resolveCapacityBar({ totalBytes: 100 * GB, availableBytes: 140 * GB }, null))
    expect(bar.segments.usedPercent).toBe(0)
    expect(bar.segments.freePercent).toBe(100)
    expect(bar.labels.free).toBe('100 GB')
    expect(bar.labels.freePercent).toBe('100%')
    expect(bar.severity).toBe('ok')
  })

  it('survives a negative available reading', () => {
    const bar = known(resolveCapacityBar({ totalBytes: 100 * GB, availableBytes: -5 * GB }, null))
    expect(bar.segments.usedPercent).toBe(100)
    expect(bar.severity).toBe('critical')
  })
})

describe('resolveCapacityBar — the bands are disjoint', () => {
  const GB_ = GB
  const CASES = [
    { name: '/recordings, default 10% reserve', facts: RECORDINGS, reserve: 186 * GB_, extras: {} },
    {
      name: '/recordings with a measured share',
      facts: RECORDINGS,
      reserve: 186 * GB_,
      extras: { ownedBytes: 1500 * GB_ },
    },
    { name: '/recordings-2, nearly empty', facts: RECORDINGS_2, reserve: 372 * GB_, extras: {} },
    {
      name: '/data/backups, share bigger than the disk holds',
      facts: BACKUPS,
      reserve: null,
      extras: { ownedBytes: 900 * GB_ },
    },
    {
      name: 'a reserve larger than the free space',
      facts: RECORDINGS,
      reserve: 400 * GB_,
      extras: {},
    },
    { name: 'no reserve, no share', facts: BACKUPS, reserve: 0, extras: {} },
  ]

  it.each(CASES)('$name: the four bands sum to the whole volume', ({ facts, reserve, extras }) => {
    const bar = known(resolveCapacityBar(facts, reserve, extras))
    const { reservePercent, ownedPercent, usedPercent, freePercent } = bar.segments
    const total = reservePercent + (ownedPercent ?? 0) + usedPercent + freePercent
    // Four rounded widths; anything beyond rounding means two bands are
    // counting the same bytes, which is what the old overlapping pair did.
    expect(total).toBeGreaterThan(99.6)
    expect(total).toBeLessThan(100.4)
  })

  it('never counts our own bytes twice: used is what is left BESIDE our share', () => {
    const withShare = known(resolveCapacityBar(RECORDINGS, null, { ownedBytes: 930 * GB }))
    const without = known(resolveCapacityBar(RECORDINGS, null))
    expect(withShare.segments.usedPercent).toBeLessThan(without.segments.usedPercent)
    expect(withShare.segments.usedPercent + (withShare.segments.ownedPercent ?? 0)).toBeCloseTo(
      without.segments.usedPercent,
      0,
    )
  })

  it('clamps a share bigger than what is occupied instead of a negative remainder', () => {
    const bar = known(resolveCapacityBar(BACKUPS, null, { ownedBytes: 900 * GB }))
    expect(bar.segments.usedPercent).toBe(0)
    expect(bar.segments.ownedPercent).toBeCloseTo(65.4, 0)
  })
})
