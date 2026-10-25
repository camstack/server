import { describe, expect, it } from 'vitest'
import { StorageLocationBandMonitor } from '../storage-location-band-monitor.js'

describe('StorageLocationBandMonitor', () => {
  it('stays silent on the first healthy observation', () => {
    const m = new StorageLocationBandMonitor()
    expect(m.observe([{ locationId: 'rec-a', freePercent: 80 }])).toEqual([])
  })

  it('emits low then critical then ok on the edges', () => {
    const m = new StorageLocationBandMonitor()
    expect(m.observe([{ locationId: 'rec-a', freePercent: 80 }])).toEqual([])
    const low = m.observe([{ locationId: 'rec-a', freePercent: 12 }])
    expect(low).toEqual([
      expect.objectContaining({
        locationId: 'rec-a',
        band: 'low',
        freePercent: 12,
        reason: 'free-below-warn',
        previous: 'ok',
      }),
    ])
    const critical = m.observe([{ locationId: 'rec-a', freePercent: 3 }])
    expect(critical).toEqual([
      expect.objectContaining({
        band: 'critical',
        reason: 'free-below-critical',
        previous: 'low',
      }),
    ])
    const ok = m.observe([{ locationId: 'rec-a', freePercent: 40 }])
    expect(ok).toEqual([
      expect.objectContaining({ band: 'ok', previous: 'critical', reason: 'free-ok' }),
    ])
  })

  it('a failed measurement never changes the band (D393)', () => {
    const m = new StorageLocationBandMonitor()
    // Never seen yet: a null opens no episode.
    expect(m.observe([{ locationId: 'rec-a', freePercent: null }])).toEqual([])
    m.observe([{ locationId: 'rec-a', freePercent: 50 }])
    expect(m.observe([{ locationId: 'rec-a', freePercent: null }])).toEqual([])
    // Still ok afterwards: a later low reading is an edge FROM ok.
    expect(m.observe([{ locationId: 'rec-a', freePercent: 10 }])).toEqual([
      expect.objectContaining({ band: 'low', previous: 'ok' }),
    ])
    // A null while low stays low and says nothing.
    expect(m.observe([{ locationId: 'rec-a', freePercent: null }])).toEqual([])
    expect(m.observe([{ locationId: 'rec-a', freePercent: 11 }])).toEqual([])
  })

  it('does not emit ok when a location disappears from the sweep', () => {
    const m = new StorageLocationBandMonitor()
    m.observe([{ locationId: 'rec-a', freePercent: 10 }])
    expect(m.observe([])).toEqual([])
  })
})

describe('StorageLocationBandMonitor — unmanaged hysteresis', () => {
  it('a value hovering at the critical edge emits one edge, not a flap', () => {
    const m = new StorageLocationBandMonitor()
    m.observe([{ locationId: 'bk', freePercent: 40 }])
    const edges = [4.9, 5.1, 4.9, 5.2, 4.8, 5.1].flatMap((p) =>
      m.observe([{ locationId: 'bk', freePercent: p }]),
    )
    expect(edges.map((e) => e.band)).toEqual(['critical'])
    // Leaves critical only once clear of the exit margin.
    expect(m.observe([{ locationId: 'bk', freePercent: 9 }]).map((e) => e.band)).toEqual(['low'])
  })
})

describe('StorageLocationBandMonitor — locations managed by eviction', () => {
  const GRACE_MS = 10 * 60_000
  const clock = () => {
    let t = 1_000_000
    return { now: () => t, advance: (ms: number) => (t += ms) }
  }
  const sample = (freePercent: number | null, floorPercent = 5) => ({
    locationId: 'rec-high',
    freePercent,
    floorPercent,
    freeBytes: 1,
    floorBytes: 2,
  })

  it('(a) oscillating around its floor emits no low and no critical edge', () => {
    const c = clock()
    const m = new StorageLocationBandMonitor(undefined, c.now)
    const edges = [4.99, 5.03, 4.99, 5.03, 4.7, 5.03, 4.5, 5.0].flatMap((p) => {
      c.advance(60_000)
      return m.observe([sample(p)])
    })
    expect(edges).toEqual([])
  })

  it('(b) below the floor for longer than grace is low, below the hard bound is critical', () => {
    const c = clock()
    const m = new StorageLocationBandMonitor(undefined, c.now)
    m.observe([sample(5)])
    // 3.5% = 70% of floor: below the margin, but inside the grace window.
    c.advance(60_000)
    expect(m.observe([sample(3.5)])).toEqual([])
    c.advance(GRACE_MS - 120_000)
    expect(m.observe([sample(3.5)])).toEqual([])
    c.advance(120_000)
    expect(m.observe([sample(3.5)])).toEqual([
      expect.objectContaining({
        band: 'low',
        reason: 'free-below-floor',
        previous: 'ok',
        floorPercent: 5,
      }),
    ])
    // Half the floor (2.5%) is the hard bound: the evictor is losing.
    c.advance(60_000)
    expect(m.observe([sample(2.2)])).toEqual([
      expect.objectContaining({
        band: 'critical',
        reason: 'free-below-hard-bound',
        previous: 'low',
      }),
    ])
  })

  it('a dip that recovers inside the grace window never fires', () => {
    const c = clock()
    const m = new StorageLocationBandMonitor(undefined, c.now)
    m.observe([sample(5)])
    c.advance(60_000)
    m.observe([sample(3.5)])
    c.advance(60_000)
    m.observe([sample(5)])
    c.advance(GRACE_MS)
    expect(m.observe([sample(4.9)])).toEqual([])
  })

  it('(c) hysteresis: a value hovering at the low and critical edges emits one edge per crossing', () => {
    const c = clock()
    const m = new StorageLocationBandMonitor(undefined, c.now)
    m.observe([sample(5)])
    c.advance(60_000)
    m.observe([sample(3.5)])
    c.advance(GRACE_MS)
    const bands: string[] = []
    for (const p of [3.5, 3.95, 3.6, 4.05, 3.7]) {
      c.advance(60_000)
      bands.push(...m.observe([sample(p)]).map((e) => e.band))
    }
    expect(bands).toEqual(['low'])
    for (const p of [2.45, 2.55, 2.4, 2.6, 2.3]) {
      c.advance(60_000)
      bands.push(...m.observe([sample(p)]).map((e) => e.band))
    }
    expect(bands).toEqual(['low', 'critical'])
    // Recovery: clear of the exit margin steps down once, then up to ok.
    c.advance(60_000)
    expect(m.observe([sample(4.6)]).map((e) => e.band)).toEqual(['ok'])
  })

  it('a failed measurement leaves a managed band untouched (D393)', () => {
    const c = clock()
    const m = new StorageLocationBandMonitor(undefined, c.now)
    m.observe([sample(5)])
    c.advance(1_000)
    m.observe([sample(1)])
    expect(m.observe([sample(null)])).toEqual([])
    c.advance(GRACE_MS * 3)
    expect(m.observe([sample(null)])).toEqual([])
  })
})
