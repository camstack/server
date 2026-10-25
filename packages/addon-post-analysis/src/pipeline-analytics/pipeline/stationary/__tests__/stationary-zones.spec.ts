import { describe, it, expect } from 'vitest'
import type { Zone } from '@camstack/types'
import { ZoneEngine } from '../../zones/zone-engine.js'
import { computeStationaryEntryZones } from '../stationary-zones.js'

// A unit square zone covering the top-left quadrant (0..0.5, 0..0.5).
const topLeft: Zone = {
  id: 'top-left',
  name: 'Top Left',
  kind: 'polygon',
  polygon: [
    { x: 0, y: 0 },
    { x: 0.5, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 0, y: 0.5 },
  ],
  color: '#3b82f6',
}

// Bottom-right quadrant (0.5..1, 0.5..1).
const bottomRight: Zone = {
  ...topLeft,
  id: 'bottom-right',
  name: 'Bottom Right',
  polygon: [
    { x: 0.5, y: 0.5 },
    { x: 1, y: 0.5 },
    { x: 1, y: 1 },
    { x: 0.5, y: 1 },
  ],
}

const FRAME = { frameWidth: 960, frameHeight: 540 } as const

describe('computeStationaryEntryZones', () => {
  it('matches a zone the bbox overlaps above minOverlap (same as ZoneEngine)', () => {
    // Box fully inside top-left; centroid would also match, but membership is overlap.
    const entry = { bbox: { x: 200, y: 100, w: 80, h: 70 }, ...FRAME }
    const zones = computeStationaryEntryZones(entry, [topLeft, bottomRight], 0)
    expect(zones).toEqual(['top-left'])
    const live = new ZoneEngine().annotateDetection(
      entry.bbox,
      [topLeft, bottomRight],
      FRAME.frameWidth,
      FRAME.frameHeight,
      undefined,
      undefined,
      undefined,
      0,
    )
    expect(live.map((m) => m.zoneId)).toEqual(zones)
  })

  it('returns every zone that clears the bar (count-in-each)', () => {
    const overlapping: Zone = {
      ...topLeft,
      id: 'whole-frame',
      polygon: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
    }
    const zones = computeStationaryEntryZones(
      { bbox: { x: 220, y: 120, w: 40, h: 30 }, ...FRAME },
      [topLeft, overlapping],
      0,
    )
    expect([...zones].sort()).toEqual(['top-left', 'whole-frame'])
  })

  it('honours minOverlap — a grazing box whose centroid is inside can still fail the bar', () => {
    // Large box, centroid in top-left (~0.47, 0.46) but only ~30% of its area
    // overlaps the zone. Old centroid-PIP stamped it; the live bar rejects it.
    const entry = { bbox: { x: 100, y: 50, w: 700, h: 400 }, ...FRAME }
    expect(computeStationaryEntryZones(entry, [topLeft], 0)).toEqual(['top-left'])
    expect(computeStationaryEntryZones(entry, [topLeft], 0.5)).toEqual([])
  })

  it('returns empty when the bbox does not meet the overlap bar', () => {
    // Fully in bottom-right (y ≥ 0.5) — no overlap with top-left.
    const entry = { bbox: { x: 700, y: 320, w: 40, h: 30 }, ...FRAME }
    expect(computeStationaryEntryZones(entry, [topLeft, bottomRight], 0)).toEqual(['bottom-right'])
    expect(computeStationaryEntryZones(entry, [topLeft], 0)).toEqual([])
  })

  it('returns empty when the entry has no usable frame dims', () => {
    expect(
      computeStationaryEntryZones(
        { bbox: { x: 200, y: 100, w: 80, h: 70 }, frameWidth: 0, frameHeight: 0 },
        [topLeft],
        0,
      ),
    ).toEqual([])
  })

  it('returns empty for a zone with a degenerate polygon', () => {
    const empty: Zone = { ...topLeft, id: 'empty', polygon: [] }
    expect(
      computeStationaryEntryZones({ bbox: { x: 200, y: 100, w: 80, h: 70 }, ...FRAME }, [empty], 0),
    ).toEqual([])
  })
})
