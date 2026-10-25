import { describe, it, expect } from 'vitest'
import type { Track } from '@camstack/types'
import { rankKeyEvents, type PeakLookup } from '../pipeline/key-event-query.js'

const peakLookup: PeakLookup = () =>
  Promise.resolve({ peakConfidence: 0.9, peakBboxAreaFrac: 0.2, bestEventId: undefined })

function track(over: Partial<Track>): Track {
  return {
    trackId: 't1',
    deviceId: 107,
    className: 'person',
    firstSeen: 1000,
    lastSeen: 5000,
    positions: [],
    snapshots: [],
    zonesVisited: [],
    totalDistance: 0.5,
    state: 'left',
    active: false,
    importance: 0.8,
    bestEventId: 'ev1',
    ...over,
  }
}

describe('rankKeyEvents — synthetic sensor tracks stay visible (#27)', () => {
  it('KEEPS source:"sensor" synthetic tracks on the key-event/gallery surface', async () => {
    const candidates: Track[] = [
      track({ trackId: 'real', className: 'person', importance: 0.7 }),
      // Synthetic sensor/control track — a legitimate event marker carrying a
      // downscaled full-frame snapshot. It MUST surface in the gallery
      // (operator decision reverting the earlier #23-B exclusion); privacy is
      // enforced at capture time (the stored frame is ~640×360, never raw 4K).
      track({
        trackId: 'pa-synth-switch',
        className: 'switch',
        source: 'sensor',
        importance: 0.95,
      }),
    ]
    const events = await rankKeyEvents(candidates, { limit: 10 }, peakLookup)
    // Ordered by importance desc → the synthetic (0.95) ranks first, then real.
    expect(events.map((e) => e.trackId)).toEqual(['pa-synth-switch', 'real'])
    expect(events.some((e) => e.trackId === 'pa-synth-switch')).toBe(true)
  })

  it('keeps pipeline tracks (source undefined / "pipeline")', async () => {
    const candidates: Track[] = [
      track({ trackId: 'legacy', source: undefined }),
      track({ trackId: 'pipe', source: 'pipeline' }),
    ]
    const events = await rankKeyEvents(candidates, { limit: 10 }, peakLookup)
    expect(events.map((e) => e.trackId).sort()).toEqual(['legacy', 'pipe'])
  })
})
