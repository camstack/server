import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  LOCATION_HISTORY_MIN_INTERVAL_MS,
  type LocationHistoryClient,
  type LocationHistoryPoint,
  LocationHistoryRecorder,
} from '../location-history-recorder.js'

function logger(): IScopedLogger {
  const noop = vi.fn()
  const l: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => l,
    withTags: () => l,
  }
  return l
}

function client(): LocationHistoryClient & { points: () => readonly LocationHistoryPoint[] } {
  const record = vi.fn(async (input: { points: readonly LocationHistoryPoint[] }) => ({
    accepted: input.points.length,
    refused: [],
  }))
  return {
    declareSeries: vi.fn(async (input: { name: string }) => ({
      key: `addon:storage-orchestrator/${input.name}`,
    })),
    record,
    points: () => record.mock.calls.flatMap((c) => c[0].points),
  }
}

const GIB = 1024 ** 3

describe('LocationHistoryRecorder', () => {
  it('records used %, free bytes and held bytes per location, scoped by location id', async () => {
    const c = client()
    const rec = new LocationHistoryRecorder({ deviceHistory: c, logger: logger() })
    await rec.record(
      [
        {
          locationId: 'recordings:default',
          nodeId: 'hub',
          capacity: { totalBytes: 100 * GIB, availableBytes: 25 * GIB },
          ownedBytes: 40 * GIB,
        },
      ],
      1000,
    )
    expect(c.points().map((p) => [p.key, p.scope, p.value])).toEqual([
      ['addon:storage-orchestrator/location-used-percent', 'recordings:default', 75],
      ['addon:storage-orchestrator/location-free-bytes', 'recordings:default', 25 * GIB],
      ['addon:storage-orchestrator/location-owned-bytes', 'recordings:default', 40 * GIB],
    ])
    expect(c.points().every((p) => p.subject.nodeId === 'hub')).toBe(true)
  })

  it('an unknown figure is no point, never 0 (D393)', async () => {
    const c = client()
    const rec = new LocationHistoryRecorder({ deviceHistory: c, logger: logger() })
    await rec.record(
      [
        { locationId: 'recordings:nas', nodeId: 'hub', capacity: null, ownedBytes: undefined },
        { locationId: 'events:a', nodeId: 'hub', capacity: null, ownedBytes: 5 },
      ],
      1000,
    )
    expect(c.points().map((p) => [p.scope, p.key.split('/')[1], p.value])).toEqual([
      ['events:a', 'location-owned-bytes', 5],
    ])
  })

  it('writes one reading per location per minute at most', async () => {
    const c = client()
    const rec = new LocationHistoryRecorder({ deviceHistory: c, logger: logger() })
    const reading = {
      locationId: 'events:a',
      nodeId: 'hub',
      capacity: { totalBytes: 10, availableBytes: 5 },
      ownedBytes: undefined,
    }
    await rec.record([reading], 1000)
    await rec.record([reading], 1000 + LOCATION_HISTORY_MIN_INTERVAL_MS - 1)
    await rec.record([reading], 1000 + LOCATION_HISTORY_MIN_INTERVAL_MS)
    expect(new Set(c.points().map((p) => p.ts))).toEqual(
      new Set([1000, 1000 + LOCATION_HISTORY_MIN_INTERVAL_MS]),
    )
  })
})
