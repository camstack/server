import { describe, it, expect } from 'vitest'
import { ScrubDragStats, SCRUB_PHASE_SAMPLE_CAP, type ScrubTickSample } from '../scrub-drag-stats'

const tick = (over: Partial<ScrubTickSample> = {}): ScrubTickSample => ({
  mode: 'jump',
  dir: 'fwd',
  mapMode: null,
  velocityPxPerS: null,
  coverage: 'miss',
  locateCalls: 1,
  locateMs: 10,
  readMs: 5,
  readBytes: 1000,
  wholeSegmentRead: false,
  demuxMs: 3,
  aus: 1,
  travel: 0,
  wireBytes: 40_000,
  creditLeft: 1,
  tickMs: 20,
  ...over,
})

describe('ScrubDragStats — one drag, one summary', () => {
  it('an empty drag summarises to zero ticks and no phase percentiles', () => {
    const s = new ScrubDragStats(0)
    const f = s.toLogFields(120)
    expect(f.ticks).toBe(0)
    expect(f.dragMs).toBe(120)
    expect(f.locateCalls).toBe(0)
    expect(f.locateMsP50).toBeNull()
  })

  it('counts pushes by mode and direction and sums the wire bytes', () => {
    const s = new ScrubDragStats(0)
    s.recordTick(tick({ mode: 'jump', wireBytes: 40_000, aus: 1 }))
    s.recordTick(tick({ mode: 'sweep', dir: 'fwd', wireBytes: 900, aus: 3 }))
    s.recordTick(tick({ mode: 'sweep', dir: 'back', wireBytes: 120_000, aus: 8 }))
    const f = s.toLogFields(500)
    expect(f.ticks).toBe(3)
    expect(f.jumps).toBe(1)
    expect(f.sweeps).toBe(1)
    expect(f.backSweeps).toBe(1)
    expect(f.aus).toBe(12)
    expect(f.bytes).toBe(160_900)

    // A backward JUMP is the documented over-the-window degradation — counted
    // apart from a forward one, and never as a sweep.
    s.recordTick(tick({ mode: 'jump', dir: 'back', wireBytes: 38_000, aus: 1 }))
    const f2 = s.toLogFields(500)
    expect(f2.jumps).toBe(2)
    expect(f2.jumpsBack).toBe(1)
    expect(f2.backSweeps).toBe(1)
  })

  it('MAPPING: counts the client-reported fine/coarse mode and the velocity that decided it', () => {
    const s = new ScrubDragStats(0)
    s.recordTick(tick({ mapMode: 'fine', velocityPxPerS: 40 }))
    s.recordTick(tick({ mapMode: 'fine', velocityPxPerS: 60 }))
    s.recordTick(tick({ mapMode: 'coarse', velocityPxPerS: 900 }))
    s.recordTick(tick({ mapMode: null, velocityPxPerS: null }))
    const f = s.toLogFields(500)
    expect(f.mapFine).toBe(2)
    expect(f.mapCoarse).toBe(1)
    expect(f.mapUnknown).toBe(1)
    expect(f.velPxPerSP50).toBe(60)
    expect(f.velPxPerSMax).toBe(900)
  })

  it('LOCATE: separates coverage hits from RPC calls and times them', () => {
    const s = new ScrubDragStats(0)
    s.recordTick(tick({ coverage: 'memo', locateCalls: 0, locateMs: null }))
    s.recordTick(tick({ coverage: 'cache', locateCalls: 0, locateMs: null }))
    s.recordTick(tick({ coverage: 'miss', locateCalls: 1, locateMs: 1200 }))
    s.recordTick(tick({ coverage: 'miss', locateCalls: 2, locateMs: 40 }))
    const f = s.toLogFields(500)
    expect(f.coverMemo).toBe(1)
    expect(f.coverCache).toBe(1)
    expect(f.coverMiss).toBe(2)
    expect(f.locateCalls).toBe(3)
    expect(f.locateMsP50).toBe(40)
    expect(f.locateMsMax).toBe(1200)
  })

  it('FETCH: sums GOP bytes, times the read, and counts whole-file degradations apart', () => {
    const s = new ScrubDragStats(0)
    s.recordTick(tick({ readBytes: 41_000, readMs: 30, wholeSegmentRead: false }))
    s.recordTick(tick({ readBytes: 600_000, readMs: 400, wholeSegmentRead: true }))
    const f = s.toLogFields(500)
    expect(f.gopReads).toBe(1)
    expect(f.wholeReads).toBe(1)
    expect(f.readBytes).toBe(641_000)
    expect(f.readMsMax).toBe(400)
  })

  it('ACK: records the push→render round trip, keeping min (the best achievable rate)', () => {
    const s = new ScrubDragStats(0)
    s.recordAckRtt(80)
    s.recordAckRtt(500)
    s.recordAckRtt(140)
    const f = s.toLogFields(500)
    expect(f.acks).toBe(3)
    expect(f.ackMsMin).toBe(80)
    expect(f.ackMsP50).toBe(140)
    expect(f.ackMsMax).toBe(500)
  })

  it('counts parks, failures and the first-push latency', () => {
    const s = new ScrubDragStats(0)
    s.recordPark()
    s.recordPark()
    s.recordFailure()
    s.recordTick(tick())
    const f = s.toLogFields(500)
    expect(f.parks).toBe(2)
    expect(f.failures).toBe(1)
    expect(f.firstPushMs).toBeTypeOf('number')
  })

  it('a very long drag keeps its percentile window BOUNDED but never loses count/max', () => {
    const s = new ScrubDragStats(0)
    for (let i = 0; i < SCRUB_PHASE_SAMPLE_CAP + 500; i++) {
      s.recordAckRtt(i === SCRUB_PHASE_SAMPLE_CAP + 200 ? 9_999 : 10)
    }
    const f = s.toLogFields(1000)
    expect(f.acks).toBe(SCRUB_PHASE_SAMPLE_CAP + 500)
    expect(f.ackMsMax).toBe(9_999)
  })

  it('the summary is a FLAT record of scalars — every field is Loki-queryable', () => {
    const s = new ScrubDragStats(0)
    s.recordTick(tick())
    const f = s.toLogFields(500)
    for (const [k, v] of Object.entries(f)) {
      expect(
        v === null || typeof v === 'number' || typeof v === 'string',
        `field ${k} must be a scalar`,
      ).toBe(true)
    }
  })
})
