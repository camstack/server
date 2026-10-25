/**
 * Unit tests for `resolvePackageCropBbox` — the pure zone-union → absolute
 * crop-bbox resolver that feeds the executor's `crop-zone` frame prep.
 */
import { describe, it, expect } from 'vitest'
import type { Zone, ZoneRule } from '@camstack/types'
import { resolvePackageCropBbox } from '../crop-zone.js'

const FRAME_W = 1000
const FRAME_H = 500

function zone(id: string, points: readonly [number, number][]): Zone {
  return {
    id,
    name: id,
    kind: 'polygon',
    polygon: points.map(([x, y]) => ({ x, y })),
    color: '#fff',
  }
}

function rule(zoneIds: readonly string[], overrides: Partial<ZoneRule> = {}): ZoneRule {
  return {
    id: `rule-${zoneIds.join('-')}`,
    zoneIds: [...zoneIds],
    mode: 'include',
    enabled: true,
    ...overrides,
  }
}

describe('resolvePackageCropBbox', () => {
  it('scales a single normalized zone polygon to absolute pixel coords', () => {
    const zones = [
      zone('z1', [
        [0.1, 0.2],
        [0.3, 0.2],
        [0.3, 0.6],
        [0.1, 0.6],
      ]),
    ]
    const bbox = resolvePackageCropBbox(zones, [rule(['z1'])], FRAME_W, FRAME_H)
    expect(bbox).toEqual([0.1 * FRAME_W, 0.2 * FRAME_H, 0.3 * FRAME_W, 0.6 * FRAME_H])
  })

  it('unions multiple zones referenced by enabled rules', () => {
    const zones = [
      zone('a', [
        [0.1, 0.1],
        [0.2, 0.1],
        [0.2, 0.2],
        [0.1, 0.2],
      ]),
      zone('b', [
        [0.5, 0.4],
        [0.8, 0.4],
        [0.8, 0.9],
        [0.5, 0.9],
      ]),
    ]
    const bbox = resolvePackageCropBbox(zones, [rule(['a', 'b'])], FRAME_W, FRAME_H)
    // Union spans a.minX..b.maxX / a.minY..b.maxY.
    expect(bbox).toEqual([0.1 * FRAME_W, 0.1 * FRAME_H, 0.8 * FRAME_W, 0.9 * FRAME_H])
  })

  it('ignores soft-disabled rules', () => {
    const zones = [
      zone('z1', [
        [0.1, 0.1],
        [0.4, 0.4],
      ]),
    ]
    const bbox = resolvePackageCropBbox(zones, [rule(['z1'], { enabled: false })], FRAME_W, FRAME_H)
    expect(bbox).toBeNull()
  })

  it('returns null when there are no package rules', () => {
    const zones = [
      zone('z1', [
        [0.1, 0.1],
        [0.4, 0.4],
      ]),
    ]
    expect(resolvePackageCropBbox(zones, [], FRAME_W, FRAME_H)).toBeNull()
  })

  it('returns null when a rule references a missing / empty zone', () => {
    const zones = [
      zone('other', [
        [0.1, 0.1],
        [0.4, 0.4],
      ]),
    ]
    expect(resolvePackageCropBbox(zones, [rule(['ghost'])], FRAME_W, FRAME_H)).toBeNull()
    expect(resolvePackageCropBbox([zone('z', [])], [rule(['z'])], FRAME_W, FRAME_H)).toBeNull()
  })

  it('clamps out-of-range normalized coords to the frame', () => {
    const zones = [
      zone('z1', [
        [-0.2, -0.1],
        [1.5, 1.4],
      ]),
    ]
    const bbox = resolvePackageCropBbox(zones, [rule(['z1'])], FRAME_W, FRAME_H)
    expect(bbox).toEqual([0, 0, FRAME_W, FRAME_H])
  })

  it('returns null for a degenerate (zero-area) zone', () => {
    const zones = [
      zone('z1', [
        [0.5, 0.5],
        [0.5, 0.5],
      ]),
    ]
    expect(resolvePackageCropBbox(zones, [rule(['z1'])], FRAME_W, FRAME_H)).toBeNull()
  })

  it('returns null for a non-positive frame size', () => {
    const zones = [
      zone('z1', [
        [0.1, 0.1],
        [0.4, 0.4],
      ]),
    ]
    expect(resolvePackageCropBbox(zones, [rule(['z1'])], 0, FRAME_H)).toBeNull()
  })
})
