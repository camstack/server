/**
 * ZoneEngine — rules-driven detection filtering.
 *
 * Locks in the new contract introduced in Phase 2a: zones are
 * geometry-only, rules drive include/exclude semantics, classFilter
 * narrows rules to specific classes, multiple rules combine
 * (whitelist mode when any include rule fires, blacklist mode
 * otherwise).
 */
import { describe, it, expect } from 'vitest'
import type { Zone, ZoneRule } from '@camstack/types'
import { ZoneEngine } from '../pipeline/zones/zone-engine.js'

const FRAME_W = 1000
const FRAME_H = 1000

const driveway: Zone = {
  id: 'driveway',
  name: 'Driveway',
  kind: 'polygon',
  polygon: [
    { x: 0, y: 0 },
    { x: 0.5, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 0, y: 0.5 },
  ],
  color: '#3b82f6',
}

const porch: Zone = {
  ...driveway,
  id: 'porch',
  name: 'Porch',
  polygon: [
    { x: 0.5, y: 0.5 },
    { x: 1, y: 0.5 },
    { x: 1, y: 1 },
    { x: 0.5, y: 1 },
  ],
}

interface Det {
  readonly id: string
  readonly className: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

const detIn = (id: string, className: string, x: number, y: number, w = 50, h = 50): Det => ({
  id,
  className,
  x,
  y,
  w,
  h,
})

const getCls = (d: Det) => d.className

describe('ZoneEngine.filterDetections', () => {
  const engine = new ZoneEngine()

  it('passes everything when rules array is empty', () => {
    const dets = [detIn('a', 'person', 100, 100), detIn('b', 'car', 700, 700)]
    const res = engine.filterDetections(dets, [driveway, porch], [], FRAME_W, FRAME_H, getCls)
    expect(res.passed).toEqual(dets)
    expect(res.excluded).toEqual([])
  })

  it('exclude rule drops detections inside the targeted zone (blacklist mode)', () => {
    const rule: ZoneRule = { id: 'r-1', zoneIds: ['driveway'], mode: 'exclude', enabled: true }
    const dets = [
      detIn('inside', 'person', 100, 100), // in driveway
      detIn('outside', 'person', 700, 700), // in porch (not targeted)
    ]
    const res = engine.filterDetections(dets, [driveway, porch], [rule], FRAME_W, FRAME_H, getCls)
    expect(res.passed.map((d) => d.id)).toEqual(['outside'])
    expect(res.excluded.map((d) => d.id)).toEqual(['inside'])
  })

  it('include rule whitelists detections inside the targeted zone', () => {
    const rule: ZoneRule = { id: 'r-1', zoneIds: ['porch'], mode: 'include', enabled: true }
    const dets = [
      detIn('inside', 'person', 700, 700), // in porch
      detIn('outside', 'person', 100, 100), // in driveway (not targeted)
    ]
    const res = engine.filterDetections(dets, [driveway, porch], [rule], FRAME_W, FRAME_H, getCls)
    expect(res.passed.map((d) => d.id)).toEqual(['inside'])
    expect(res.excluded.map((d) => d.id)).toEqual(['outside'])
  })

  it('classFilter narrows the rule to specific classes', () => {
    // Exclude persons from driveway, but cars are still allowed there.
    const rule: ZoneRule = {
      id: 'r-1',
      zoneIds: ['driveway'],
      mode: 'exclude',
      classFilter: ['person'],
      enabled: true,
    }
    const dets = [
      detIn('p-in-drv', 'person', 100, 100),
      detIn('c-in-drv', 'car', 100, 200),
      detIn('p-elsewhere', 'person', 700, 700),
    ]
    const res = engine.filterDetections(dets, [driveway, porch], [rule], FRAME_W, FRAME_H, getCls)
    expect(res.passed.map((d) => d.id).toSorted()).toEqual(['c-in-drv', 'p-elsewhere'])
    expect(res.excluded.map((d) => d.id)).toEqual(['p-in-drv'])
  })

  it('multiple include rules combine (OR-set on zones)', () => {
    const rule: ZoneRule = {
      id: 'r-multi',
      zoneIds: ['driveway', 'porch'],
      mode: 'include',
      enabled: true,
    }
    const dets = [
      detIn('in-drv', 'person', 100, 100),
      detIn('in-porch', 'person', 700, 700),
      detIn('outside', 'person', 950, 100), // outside both zones
    ]
    const res = engine.filterDetections(dets, [driveway, porch], [rule], FRAME_W, FRAME_H, getCls)
    expect(res.passed.map((d) => d.id).toSorted()).toEqual(['in-drv', 'in-porch'])
    expect(res.excluded.map((d) => d.id)).toEqual(['outside'])
  })

  it('disabled rule is skipped (enabled: false)', () => {
    const rule: ZoneRule = { id: 'r-1', zoneIds: ['driveway'], mode: 'exclude', enabled: false }
    const dets = [detIn('inside', 'person', 100, 100), detIn('outside', 'person', 700, 700)]
    const res = engine.filterDetections(dets, [driveway, porch], [rule], FRAME_W, FRAME_H, getCls)
    expect(res.passed).toEqual(dets) // both pass — rule is inert
  })

  it('annotateDetection lists every zone the bbox geometrically intersects', () => {
    const memberships = engine.annotateDetection(
      { x: 480, y: 480, w: 60, h: 60 }, // straddles driveway and porch corner
      [driveway, porch],
      FRAME_W,
      FRAME_H,
    )
    const ids = memberships.map((m) => m.zoneId).toSorted()
    expect(ids).toEqual(['driveway', 'porch'])
  })

  /**
   * The bar drops a zone SILENTLY, so raising it hides the very cases it was
   * armed to measure: no stamp, no `zones` entry, and the resulting silence
   * reads as "nothing came near the zone". `splitDetectionZones` keeps the
   * rejected side so the bar stays choosable from data after it is raised.
   */
  describe('splitDetectionZones — both sides of the membership bar', () => {
    // Straddles the corner unevenly: ~39% of the box lands in porch, ~11% in
    // driveway. A bar between the two therefore splits this ONE detection
    // across both sides, which is the case that matters.
    const straddling = { x: 480, y: 480, w: 60, h: 60 }

    it('splits the zones the bar admits from the ones it rejects', () => {
      const { memberships, belowBar } = engine.splitDetectionZones(
        straddling,
        [driveway, porch],
        FRAME_W,
        FRAME_H,
        undefined,
        undefined,
        undefined,
        0.3,
      )
      expect(memberships.map((z) => z.zoneId)).toEqual(['porch'])
      expect(belowBar.map((z) => z.zoneId)).toEqual(['driveway'])
      // The rejected side carries its fraction — that IS the measurement, and
      // it has to sit below the bar without being zero.
      expect(belowBar[0]?.overlap).toBeGreaterThan(0)
      expect(belowBar[0]?.overlap).toBeLessThanOrEqual(0.3)
      expect(memberships[0]?.overlap).toBeGreaterThan(0.3)
    })

    it('never reports a zone the detection does not touch at all', () => {
      const { memberships, belowBar } = engine.splitDetectionZones(
        { x: 900, y: 100, w: 20, h: 20 }, // outside both zones
        [driveway, porch],
        FRAME_W,
        FRAME_H,
        undefined,
        undefined,
        undefined,
        0.3,
      )
      expect(memberships).toEqual([])
      expect(belowBar).toEqual([])
    })

    it('agrees with annotateDetection on the admitted side', () => {
      const bar = 0.1
      const { memberships } = engine.splitDetectionZones(
        straddling,
        [driveway, porch],
        FRAME_W,
        FRAME_H,
        undefined,
        undefined,
        undefined,
        bar,
      )
      const direct = engine.annotateDetection(
        straddling,
        [driveway, porch],
        FRAME_W,
        FRAME_H,
        undefined,
        undefined,
        undefined,
        bar,
      )
      expect(memberships).toEqual(direct)
      expect(memberships.length).toBe(2)
    })
  })
})
