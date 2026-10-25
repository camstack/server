import { describe, it, expect } from 'vitest'
import type { Zone, ZoneRule } from '@camstack/types'
import { gateMotionRegions } from '../zone-gate.js'

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

interface Region {
  readonly id: string
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
}

const regionAt = (id: string, x: number, y: number, w = 50, h = 50): Region => ({
  id,
  bbox: { x, y, w, h },
})

describe('gateMotionRegions', () => {
  it('passes everything when rules are empty', () => {
    const regions = [regionAt('a', 100, 100), regionAt('b', 700, 700)]
    const res = gateMotionRegions(regions, [driveway, porch], [], FRAME_W, FRAME_H)
    expect(res.passed).toEqual(regions)
    expect(res.excluded).toEqual([])
  })

  it('passes everything when zones are empty', () => {
    const rule: ZoneRule = { id: 'r-1', zoneIds: ['driveway'], mode: 'exclude', enabled: true }
    const regions = [regionAt('a', 100, 100)]
    const res = gateMotionRegions(regions, [], [rule], FRAME_W, FRAME_H)
    expect(res.passed).toEqual(regions)
  })

  it('exclude rule drops regions whose center lies inside the targeted zone', () => {
    const rule: ZoneRule = { id: 'r-1', zoneIds: ['driveway'], mode: 'exclude', enabled: true }
    const regions = [
      regionAt('inside', 100, 100), // center (125, 125) → in driveway
      regionAt('outside', 700, 700), // center (725, 725) → in porch (not targeted)
    ]
    const res = gateMotionRegions(regions, [driveway, porch], [rule], FRAME_W, FRAME_H)
    expect(res.passed.map((r) => r.id)).toEqual(['outside'])
    expect(res.excluded.map((r) => r.id)).toEqual(['inside'])
  })

  it('include rule whitelists regions inside the targeted zone', () => {
    const rule: ZoneRule = { id: 'r-1', zoneIds: ['porch'], mode: 'include', enabled: true }
    const regions = [
      regionAt('in-porch', 700, 700),
      regionAt('in-drv', 100, 100),
      regionAt('outside-both', 950, 100),
    ]
    const res = gateMotionRegions(regions, [driveway, porch], [rule], FRAME_W, FRAME_H)
    expect(res.passed.map((r) => r.id)).toEqual(['in-porch'])
    expect(res.excluded.map((r) => r.id).toSorted()).toEqual(['in-drv', 'outside-both'])
  })

  it('disabled rules are skipped', () => {
    const rule: ZoneRule = { id: 'r-1', zoneIds: ['driveway'], mode: 'exclude', enabled: false }
    const regions = [regionAt('inside', 100, 100), regionAt('outside', 700, 700)]
    const res = gateMotionRegions(regions, [driveway, porch], [rule], FRAME_W, FRAME_H)
    expect(res.passed).toEqual(regions)
  })

  it('classFilter is ignored at the motion stage (motion has no class)', () => {
    // A class-restricted exclude rule still drops motion regions in the
    // zone — there is no per-region class for motion to compare against.
    const rule: ZoneRule = {
      id: 'r-1',
      zoneIds: ['driveway'],
      mode: 'exclude',
      classFilter: ['person'],
      enabled: true,
    }
    const regions = [regionAt('inside', 100, 100), regionAt('outside', 700, 700)]
    const res = gateMotionRegions(regions, [driveway, porch], [rule], FRAME_W, FRAME_H)
    expect(res.passed.map((r) => r.id)).toEqual(['outside'])
    expect(res.excluded.map((r) => r.id)).toEqual(['inside'])
  })

  it('multi-zone rule fires when center is in any of the listed zones', () => {
    const rule: ZoneRule = {
      id: 'r-multi',
      zoneIds: ['driveway', 'porch'],
      mode: 'exclude',
      enabled: true,
    }
    const regions = [
      regionAt('in-drv', 100, 100),
      regionAt('in-porch', 700, 700),
      regionAt('outside-both', 950, 100),
    ]
    const res = gateMotionRegions(regions, [driveway, porch], [rule], FRAME_W, FRAME_H)
    expect(res.passed.map((r) => r.id)).toEqual(['outside-both'])
    expect(res.excluded.map((r) => r.id).toSorted()).toEqual(['in-drv', 'in-porch'])
  })
})
