/**
 * rankKeyEvents unit tests — ordering, limit, minImportance/class filters,
 * compute-on-read for legacy rows, and empty input.
 */
import { describe, it, expect } from 'vitest'
import type { Track } from '@camstack/types'
import { rankKeyEvents, type PeakLookup } from '../key-event-query.js'

function track(partial: Partial<Track> & { trackId: string }): Track {
  return {
    trackId: partial.trackId,
    deviceId: partial.deviceId ?? 4,
    className: partial.className ?? 'person',
    firstSeen: partial.firstSeen ?? 1000,
    lastSeen: partial.lastSeen ?? 2000,
    positions: partial.positions ?? [],
    snapshots: [],
    zonesVisited: partial.zonesVisited ?? [],
    totalDistance: partial.totalDistance ?? 0,
    state: 'idle',
    active: false,
    ...(partial.label !== undefined ? { label: partial.label } : {}),
    ...(partial.subLabel !== undefined ? { subLabel: partial.subLabel } : {}),
    ...(partial.importance !== undefined ? { importance: partial.importance } : {}),
    ...(partial.bestEventId !== undefined ? { bestEventId: partial.bestEventId } : {}),
    ...(partial.importanceReason !== undefined
      ? { importanceReason: partial.importanceReason }
      : {}),
    ...(partial.audioLabels !== undefined ? { audioLabels: partial.audioLabels } : {}),
  }
}

// Peak lookup that fails the test if ever called (used when all rows are scored).
const failPeak: PeakLookup = () => {
  throw new Error('peakLookup should not be called for scored rows')
}

describe('rankKeyEvents', () => {
  it('orders by importance descending and maps fields', async () => {
    const out = await rankKeyEvents(
      [
        track({
          trackId: 'lo',
          importance: 0.2,
          bestEventId: 'e-lo',
          firstSeen: 100,
          lastSeen: 700,
        }),
        track({
          trackId: 'hi',
          importance: 0.9,
          bestEventId: 'e-hi',
          firstSeen: 200,
          lastSeen: 500,
        }),
        track({ trackId: 'mid', importance: 0.5, bestEventId: 'e-mid' }),
      ],
      { limit: 10 },
      failPeak,
    )
    expect(out.map((k) => k.trackId)).toEqual(['hi', 'mid', 'lo'])
    const hi = out[0]!
    expect(hi.id).toBe('e-hi')
    expect(hi.bestEventId).toBe('e-hi')
    expect(hi.timestamp).toBe(200)
    expect(hi.windowMs).toBe(300)
    expect(hi.importance).toBeCloseTo(0.9, 9)
  })

  it('respects limit after ordering', async () => {
    const out = await rankKeyEvents(
      [
        track({ trackId: 'a', importance: 0.1 }),
        track({ trackId: 'b', importance: 0.8 }),
        track({ trackId: 'c', importance: 0.5 }),
      ],
      { limit: 2 },
      failPeak,
    )
    expect(out.map((k) => k.trackId)).toEqual(['b', 'c'])
  })

  it('filters by minImportance', async () => {
    const out = await rankKeyEvents(
      [track({ trackId: 'a', importance: 0.1 }), track({ trackId: 'b', importance: 0.8 })],
      { limit: 10, minImportance: 0.5 },
      failPeak,
    )
    expect(out.map((k) => k.trackId)).toEqual(['b'])
  })

  it('filters by classFilter', async () => {
    const out = await rankKeyEvents(
      [
        track({ trackId: 'p', className: 'person', importance: 0.5 }),
        track({ trackId: 'c', className: 'car', importance: 0.9 }),
      ],
      { limit: 10, classFilter: 'person' },
      failPeak,
    )
    expect(out.map((k) => k.trackId)).toEqual(['p'])
  })

  it('computes importance on read for legacy rows (no persist)', async () => {
    const peak: PeakLookup = async (trackId) => {
      expect(trackId).toBe('legacy')
      return {
        peakConfidence: 1,
        peakBboxAreaFrac: 0,
        bestEventId: 'e-legacy',
      }
    }
    const out = await rankKeyEvents(
      // firstSeen === lastSeen → zero dwell term, isolating class + confidence.
      [
        track({
          trackId: 'legacy',
          className: 'person',
          firstSeen: 1000,
          lastSeen: 1000,
        }),
      ],
      { limit: 10 },
      peak,
    )
    expect(out).toHaveLength(1)
    // person(0.2) + confidence full(0.3) = 0.5
    expect(out[0]!.importance).toBeCloseTo(0.5, 6)
    expect(out[0]!.bestEventId).toBe('e-legacy')
    expect(out[0]!.id).toBe('e-legacy')
  })

  it('falls back to trackId for id AND bestEventId when no best event exists', async () => {
    const peak: PeakLookup = async () => ({
      peakConfidence: 0,
      peakBboxAreaFrac: 0,
      bestEventId: undefined,
    })
    const out = await rankKeyEvents([track({ trackId: 'noevt' })], { limit: 10 }, peak)
    expect(out[0]!.id).toBe('noevt')
    // bestEventId must NOT be empty — it falls back to the trackId so the
    // event-media plane can resolve the track's own thumbnail (a track whose
    // only object event is a degenerate zero-area 'left' departure still has
    // §5-cadence track media). An empty bestEventId renders a blank card.
    expect(out[0]!.bestEventId).toBe('noevt')
  })

  it('returns [] for empty candidates', async () => {
    expect(await rankKeyEvents([], { limit: 10 }, failPeak)).toEqual([])
  })

  it('carries audioLabels when the track has confident episodes (D189)', async () => {
    const labels = [
      { label: 'speech', peakScore: 0.9, count: 2, firstAt: 1000, lastAt: 1500 },
    ] as const
    const out = await rankKeyEvents(
      [
        track({
          trackId: 'aud',
          className: 'audio',
          importance: 0.7,
          bestEventId: 'e-aud',
          audioLabels: [...labels],
        }),
      ],
      { limit: 10 },
      failPeak,
    )
    expect(out[0]!.audioLabels).toEqual([...labels])
  })

  it('omits audioLabels when the track has none', async () => {
    const out = await rankKeyEvents(
      [track({ trackId: 'silent', importance: 0.4, bestEventId: 'e-s' })],
      { limit: 10 },
      failPeak,
    )
    expect(out[0]!).not.toHaveProperty('audioLabels')
  })

  /**
   * On-read scoring of a legacy row goes through the SAME two-tier contract as
   * the close path. A parked vehicle whose only label is the classifier's
   * tier-1 "Car" must still be demoted; only a tier-2 plate/face exempts it.
   */
  describe('static gate reads the identity tier, not the sub-class', () => {
    const PARKED = {
      positions: [
        {
          x: 500,
          y: 500,
          timestamp: 1000,
          bbox: { x: 480, y: 480, w: 40, h: 40 },
        },
        {
          x: 500,
          y: 500,
          timestamp: 2000,
          bbox: { x: 480, y: 480, w: 40, h: 40 },
        },
      ],
    }
    const peak: PeakLookup = async () => ({
      peakConfidence: 0.9,
      peakBboxAreaFrac: 0.2,
      bestEventId: 'ev-1',
    })

    it('demotes a motionless track carrying only a tier-1 sub-class', async () => {
      const subclassOnly = await rankKeyEvents(
        [
          track({
            trackId: 'a',
            className: 'vehicle',
            label: 'Car',
            ...PARKED,
          }),
        ],
        { limit: 10 },
        peak,
      )
      const identified = await rankKeyEvents(
        [
          track({
            trackId: 'b',
            className: 'vehicle',
            label: 'Car',
            subLabel: 'AB123CD',
            ...PARKED,
          }),
        ],
        { limit: 10 },
        peak,
      )
      expect(subclassOnly[0]!.importance).toBeLessThan(identified[0]!.importance * 0.5)
    })
  })
})
