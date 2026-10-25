/**
 * Enabled locations ARE the write set (D383).
 *
 * Four properties, each one a thing that was NOT true while the class default
 * existed, and each one disarmable: revert the named source line and the named
 * test goes red.
 *
 *   1. every enabled location of a class is in the pool — two disks are used
 *      together, and neither is "the" one;
 *   2. an unplaced camera lands on the EMPTIEST enabled location of its class,
 *      not on a flagged one;
 *   3. the planner spreads the fleet by headroom share — measured with the
 *      operator's actual disks (a 1.9 TB USB disk at 89 % next to an empty
 *      4 TB SATA one);
 *   4. a DISABLED location keeps serving reads. Disabled is read-only, not
 *      gone, and a read that narrows is a silent black window (2 131 segments,
 *      2026-08-12).
 */
import type { SegmentRow } from '../../types.js'
import { describe, expect, it, vi } from 'vitest'
import { type IScopedLogger, resolveLocationMode } from '@camstack/types'
import { RecordingIndex } from '../../recording-index.js'
import type { SegmentStore } from '../../segment-store.js'
import type { RecordingConfigsState } from '../config-store.js'
import { planPlacement } from '../placement-planner.js'
import { collectRangeSegments, type RecordingProviderDeps } from '../recording-provider.js'
import {
  placementPool,
  type RecordingsLocation,
  recordingsLocationOfMode,
  resolvePlacement,
} from '../roots.js'

const GB = 1_000_000_000

/** A location as a pre-D385 row described it: the legacy flags, folded by the ONE interpreter. */
interface LocationFixture {
  readonly id: string
  readonly type?: string
  readonly enabled?: boolean
  readonly readOnly?: boolean
  readonly headroomBytes?: number
}

function location(over: LocationFixture): RecordingsLocation {
  const { enabled, readOnly, type, ...rest } = over
  return recordingsLocationOfMode(
    { type: type ?? 'recordings', root: `/mnt/${over.id}`, ...rest },
    resolveLocationMode({
      ...(enabled !== undefined ? { enabled } : {}),
      config: readOnly === true ? { readOnly: true } : {},
    }),
  )
}

describe('enabled locations are the write set', () => {
  it('puts EVERY enabled location of a class in the pool — there is no preferred one', () => {
    const locations = [
      location({ id: 'recordings:default' }),
      location({ id: 'recordings:hgst' }),
      location({ id: 'recordings:retired', enabled: false }),
    ]
    const pool = placementPool(locations)
    expect(pool.fellBackToDisabled).toBe(false)
    expect(pool.locations.map((l) => l.id)).toEqual(['recordings:default', 'recordings:hgst'])
  })

  it('falls back to every location — loudly — only when nothing is enabled', () => {
    const pool = placementPool([
      location({ id: 'recordings:default', enabled: false }),
      location({ id: 'recordings:hgst', enabled: false }),
    ])
    expect(pool.fellBackToDisabled).toBe(true)
    expect(pool.locations).toHaveLength(2)
  })

  it('places an unplaced camera on the EMPTIEST enabled location of its class', () => {
    // The operator's disks: `recordings:default` is the 1.9 TB USB drive at
    // 89 % (≈19 GB of headroom once its 10 % floor is honoured), the HGST is
    // an empty 4 TB (≈3.2 TB). The default flag used to decide this; capacity
    // does now.
    const pool = [
      location({ id: 'recordings:default', headroomBytes: 19 * GB }),
      location({ id: 'recordings:hgst', headroomBytes: 3_200 * GB }),
    ]
    expect(resolvePlacement(pool, 'high').id).toBe('recordings:hgst')
  })

  it('breaks an unmeasured tie deterministically, never by list order', () => {
    const pool = [location({ id: 'recordings:zzz' }), location({ id: 'recordings:aaa' })]
    expect(resolvePlacement(pool, 'high').id).toBe('recordings:aaa')
    expect(resolvePlacement([...pool].toReversed(), 'high').id).toBe('recordings:aaa')
  })

  it('routes a low profile to its own class, and never to a read-only member', () => {
    const pool = [
      location({ id: 'recordings:default', headroomBytes: 3_200 * GB }),
      location({ id: 'recordingsLow:ssd', type: 'recordingsLow', headroomBytes: 10 * GB }),
      location({ id: 'recordingsLow:old', type: 'recordingsLow', readOnly: true }),
    ]
    expect(resolvePlacement(pool, 'low').id).toBe('recordingsLow:ssd')
  })

  it('spreads the fleet across two enabled disks in proportion to their headroom', () => {
    const demands = Array.from({ length: 13 }, (_, i) => ({
      key: `${String(600 + i)}:high`,
      type: 'recordings',
      dailyBytes: 20 * GB,
    }))
    const plan = planPlacement({
      candidates: [
        { locationId: 'recordings:default', type: 'recordings', headroomBytes: 19 * GB },
        { locationId: 'recordings:hgst', type: 'recordings', headroomBytes: 3_200 * GB },
      ],
      demands,
      current: new Map(),
    })
    const onHgst = [...plan.assignments.values()].filter((id) => id === 'recordings:hgst').length
    // 3 200 / 3 219 ≈ 99.4 % of the weight: the new disk takes essentially the
    // whole fleet until the two disks equalise. What matters for this rule is
    // that BOTH are used and the split follows capacity — the old model gave
    // 13/13 to whichever one carried the flag, in either direction.
    expect(onHgst).toBeGreaterThanOrEqual(12)
    expect(plan.assignments.size).toBe(13)
  })

  it('keeps serving reads from a DISABLED and from a read-only location', async () => {
    const index = new RecordingIndex()
    const rows: readonly SegmentRow[] = [
      {
        deviceId: 102,
        profile: 'mid',
        startMs: 1_000,
        durMs: 4_000,
        bytes: 2_048,
        path: '102/mid/2026/06/15/08/1000-4000-2048.m4s',
        locationId: 'recordings:retired',
      },
      {
        deviceId: 102,
        profile: 'mid',
        startMs: 6_000,
        durMs: 4_000,
        bytes: 2_048,
        path: '102/mid/2026/06/15/08/6000-4000-2048.m4s',
        locationId: 'recordings:draining',
      },
    ]
    for (const row of rows) index.addSegment(row)

    // The recorder resolves locations by TYPE only — `enabled` and `readOnly`
    // never narrow this list, which is what keeps `rootById` able to resolve
    // both rows.
    const locations = [
      location({ id: 'recordings:retired', enabled: false }),
      location({ id: 'recordings:draining', readOnly: true }),
    ]
    const deps: RecordingProviderDeps = {
      index,
      segmentStore: {} as unknown as SegmentStore,
      nodeId: 'node-1',
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      } as unknown as IScopedLogger,
      configStore: {} as unknown as RecordingConfigsState,
      locations: () => locations,
      refreshLocations: async () => locations,
      capacity: async () => ({ availableBytes: null, totalBytes: null }),
      hydrateDevice: async () => {},
      dataDir: '/data',
      playbackBaseUrl: () => null,
      readFile: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
    }

    const collected = await collectRangeSegments(deps, 102, 'mid', 0, 20_000, 'playback-relative')
    expect(collected.segments).toHaveLength(2)
  })
})
