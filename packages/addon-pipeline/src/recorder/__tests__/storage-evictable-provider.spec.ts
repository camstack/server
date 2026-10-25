/**
 * StorageEvictableProvider — what it ASKS the archive, and what it deletes.
 *
 * The provider no longer holds the footage it reasons about. Both questions it
 * asks are bounded by construction (`EvictableArchive`), and the fake below
 * records every call so a regression to "fetch the archive, then sort it" shows
 * up as a different QUESTION rather than as an identical total.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { RecordingIndex } from '../recording-index.js'
import { segmentRelPath } from '../segment-path.js'
import { SegmentStore } from '../segment-store.js'
import { type EvictableArchive, StorageEvictableProvider } from '../storage-evictable-provider.js'
import type { Accounting, OldestSegments, SegmentRow } from '../types.js'

function silentLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger }
  return logger as unknown as IScopedLogger
}

/** One archive call as the provider issued it. */
interface ArchiveAsk {
  readonly method: 'accountingForLocations' | 'oldestSegments' | 'oldestSegmentsForDevices'
  readonly locationIds: readonly string[]
  readonly targetBytes?: number
  readonly deviceIds?: readonly number[]
}

/**
 * An archive over a fixed row set that answers both questions BOUNDED — and
 * refuses to hand back more than the target needs, so a caller that goes back
 * to sorting everything cannot get everything.
 */
class FakeArchive implements EvictableArchive {
  readonly asks: ArchiveAsk[] = []
  constructor(private readonly rows: readonly SegmentRow[]) {}

  async accountingForLocations(locationIds: ReadonlySet<string>): Promise<Accounting> {
    this.asks.push({ method: 'accountingForLocations', locationIds: [...locationIds] })
    const on = this.rows.filter((r) => locationIds.has(r.locationId))
    if (on.length === 0) return { bytes: 0, count: 0, oldestMs: null, newestMs: null }
    return {
      bytes: on.reduce((a, r) => a + r.bytes, 0),
      count: on.length,
      oldestMs: Math.min(...on.map((r) => r.startMs)),
      newestMs: Math.max(...on.map((r) => r.startMs)),
    }
  }

  async oldestSegments(
    locationIds: ReadonlySet<string>,
    targetBytes: number,
  ): Promise<OldestSegments> {
    this.asks.push({ method: 'oldestSegments', locationIds: [...locationIds], targetBytes })
    if (targetBytes <= 0) return { rows: [], exhausted: true }
    const stream = this.rows
      .filter((r) => locationIds.has(r.locationId))
      .toSorted((a, b) => a.startMs - b.startMs)
    const out: SegmentRow[] = []
    let covered = 0
    for (const r of stream) {
      if (covered >= targetBytes) break
      out.push(r)
      covered += r.bytes
    }
    return { rows: out, exhausted: covered < targetBytes }
  }

  async oldestSegmentsForDevices(
    locationIds: ReadonlySet<string>,
    deviceIds: ReadonlySet<number>,
    targetBytes: number,
  ): Promise<OldestSegments> {
    this.asks.push({
      method: 'oldestSegmentsForDevices',
      locationIds: [...locationIds],
      deviceIds: [...deviceIds],
      targetBytes,
    })
    if (targetBytes <= 0 || deviceIds.size === 0) return { rows: [], exhausted: true }
    const stream = this.rows
      .filter((r) => locationIds.has(r.locationId) && deviceIds.has(r.deviceId))
      .toSorted((a, b) => a.startMs - b.startMs)
    const out: SegmentRow[] = []
    let covered = 0
    for (const r of stream) {
      if (covered >= targetBytes) break
      out.push(r)
      covered += r.bytes
    }
    return { rows: out, exhausted: covered < targetBytes }
  }

  devicesWithFootage(locationIds: ReadonlySet<string>): ReadonlySet<number> {
    const out = new Set<number>()
    for (const r of this.rows) if (locationIds.has(r.locationId)) out.add(r.deviceId)
    return out
  }
}

interface Harness {
  readonly index: RecordingIndex
  readonly archive: FakeArchive
  readonly provider: StorageEvictableProvider
  readonly deleted: string[]
}

function harness(rows: readonly SegmentRow[], options: HarnessOptions = {}): Harness {
  const index = new RecordingIndex()
  for (const r of rows) index.addSegment(r)
  const deleted: string[] = []
  const store = new SegmentStore({
    index,
    list: async () => [],
    deletePath: async ({ relativePath }) => {
      if (relativePath === options.failPath) throw new Error('delete failed')
      deleted.push(relativePath)
    },
    statBytes: async () => 0,
    moveFile: async () => {},
    removeDir: async () => {},
    logger: { warn: () => {}, info: () => {} },
  })
  const archive = new FakeArchive(rows)
  const provider = new StorageEvictableProvider({
    archive: () => archive,
    logger: silentLogger(),
    store,
    // A fleet where every camera holding footage still exists — so the
    // dead-device tier is armed, answers "nothing here is gone", and every
    // property below is about the oldest-first policy alone.
    deviceRegistry: async () => ({
      status: 'answered',
      deviceIds: new Set(rows.map((r) => r.deviceId)),
    }),
    ...(options.domain ? { resolveDomain: () => options.domain! } : {}),
    ...(options.isEvictionFrozen ? { isEvictionFrozen: options.isEvictionFrozen } : {}),
  })
  return { index, archive, provider, deleted }
}

interface HarnessOptions {
  readonly domain?: ReadonlySet<string>
  readonly isEvictionFrozen?: (locationId: string) => boolean
  readonly failPath?: string
}

function row(startMs: number, bytes: number, locationId = 'recordings', deviceId = 99): SegmentRow {
  return {
    deviceId,
    profile: 'high',
    startMs,
    durMs: 2_000,
    bytes,
    path: segmentRelPath(deviceId, 'high', startMs, 2_000, bytes),
    locationId,
  }
}

const three = [row(1_000, 100), row(3_000, 100), row(5_000, 100)]

describe('StorageEvictableProvider — usage', () => {
  it('answers with ONE aggregation over the domain, and reads no rows', async () => {
    const h = harness(three)
    expect(await h.provider.getEvictableUsage({ locationId: 'recordings' })).toEqual({ bytes: 300 })
    // The sweep asks this per location every 60 s. It must be a total, never a
    // read of the footage the total is about.
    expect(h.archive.asks).toEqual([
      { method: 'accountingForLocations', locationIds: ['recordings'] },
    ])
  })

  it('is 0 for a location with no footage', async () => {
    const h = harness([])
    expect(await h.provider.getEvictableUsage({ locationId: 'recordings' })).toEqual({ bytes: 0 })
  })

  it('sums the whole domain in one ask, regardless of which alias is asked', async () => {
    const domain = new Set(['recordings:default', 'recordingsLow:default'])
    const h = harness(
      [
        row(1_000, 100, 'recordingsLow:default'),
        row(2_000, 100, 'recordingsLow:default'),
        row(9_000, 100, 'recordings:default'),
      ],
      { domain },
    )
    expect(await h.provider.getEvictableUsage({ locationId: 'recordings:default' })).toEqual({
      bytes: 300,
    })
    expect(await h.provider.getEvictableUsage({ locationId: 'recordingsLow:default' })).toEqual({
      bytes: 300,
    })
    // Both asks carried BOTH ids: one disk, one question.
    for (const ask of h.archive.asks) {
      expect(ask.locationIds.toSorted()).toEqual(['recordings:default', 'recordingsLow:default'])
    }
  })

  it('reports 0 evictable — out loud — when there is no archive to measure', async () => {
    const warns: string[] = []
    const index = new RecordingIndex()
    const store = new SegmentStore({
      index,
      list: async () => [],
      deletePath: async () => {},
      statBytes: async () => 0,
      moveFile: async () => {},
      removeDir: async () => {},
      logger: { warn: () => {}, info: () => {} },
    })
    const logger = {
      debug: () => {},
      info: () => {},
      error: () => {},
      warn: (m: string) => warns.push(m),
      child: () => logger,
    } as unknown as IScopedLogger
    const provider = new StorageEvictableProvider({
      archive: () => null,
      logger,
      store,
      deviceRegistry: async () => ({ status: 'answered', deviceIds: new Set([99]) }),
    })
    expect(await provider.getEvictableUsage({ locationId: 'recordings' })).toEqual({ bytes: 0 })
    expect(await provider.evict({ locationId: 'recordings', targetBytes: 1_000 })).toEqual({
      reclaimedBytes: 0,
      exhausted: true,
    })
    expect(warns).toHaveLength(2)
  })
})

describe('StorageEvictableProvider — eviction asks for THE OLDEST, not the archive', () => {
  it('issues one bounded oldest-first read carrying the target, and never an accounting', async () => {
    // 500 segments. A 150-byte target must not cause 500 rows to be fetched,
    // copied and sorted — which is precisely what the removed
    // `segmentsOnLocations` did on 7.1 M rows.
    const rows = Array.from({ length: 500 }, (_, i) => row(1_000 + i * 2_000, 100))
    const h = harness(rows)

    const res = await h.provider.evict({ locationId: 'recordings', targetBytes: 150 })

    expect(h.archive.asks).toEqual([
      { method: 'oldestSegments', locationIds: ['recordings'], targetBytes: 150 },
    ])
    expect(res).toEqual({ reclaimedBytes: 200, exhausted: false })
    expect(h.deleted).toHaveLength(2)
    expect(h.deleted).toEqual([rows[0]!.path, rows[1]!.path])
  })

  it('reports exhausted when the stream ends and every row it returned was taken', async () => {
    const h = harness(three)
    const res = await h.provider.evict({ locationId: 'recordings', targetBytes: 99_999 })
    expect(res.reclaimedBytes).toBe(300)
    expect(res.exhausted).toBe(true)
  })

  it('counts only successfully-deleted bytes when one delete fails', async () => {
    const rows = [row(1_000, 100), row(3_000, 100)]
    const h = harness(rows, { failPath: rows[0]!.path })
    const res = await h.provider.evict({ locationId: 'recordings', targetBytes: 99_999 })
    expect(res.reclaimedBytes).toBe(100)
    expect(res.exhausted).toBe(true)
    expect(h.index.hasSegment(99, rows[0]!.path)).toBe(true) // failed delete stays indexed
  })

  it('an empty location reclaims nothing and is exhausted', async () => {
    const h = harness([])
    expect(await h.provider.evict({ locationId: 'recordings', targetBytes: 1_000 })).toEqual({
      reclaimedBytes: 0,
      exhausted: true,
    })
  })

  // ── Physical-root eviction domain (age-partition data-loss regression) ──────
  // Two location ids over ONE disk. The OLD footage carries `recordingsLow:default`,
  // the LIVE footage `recordings:default`. Byte relief on EITHER alias must reclaim
  // the OLDEST across BOTH — never the newest of one age-partitioned subset.
  const domain = new Set(['recordings:default', 'recordingsLow:default'])
  const partitioned = [
    row(1_000, 100, 'recordingsLow:default'), // OLDEST
    row(2_000, 100, 'recordingsLow:default'),
    row(9_000, 100, 'recordings:default'), // NEWEST
  ]

  it('asks for ONE stream over the whole domain — never one read per alias', async () => {
    const h = harness(partitioned, { domain })

    await h.provider.evict({ locationId: 'recordings:default', targetBytes: 150 })

    // THE constraint. One ask, both ids. Two asks (one per alias) merged in JS
    // would produce the same rows here and the wrong ones the moment the two
    // aliases hold different age ranges — which is the shape production has.
    expect(h.archive.asks).toHaveLength(1)
    expect(h.archive.asks[0]?.locationIds.toSorted()).toEqual([
      'recordings:default',
      'recordingsLow:default',
    ])
  })

  it('evict on the live alias reclaims the OLDEST across both aliases, never the newest', async () => {
    const h = harness(partitioned, { domain })
    const res = await h.provider.evict({ locationId: 'recordings:default', targetBytes: 150 })
    expect(res.reclaimedBytes).toBe(200)
    expect(h.deleted).toEqual([partitioned[0]!.path, partitioned[1]!.path])
    // The newest (live) segment survives.
    expect(h.index.segmentsOnLocation('recordings:default').map((s) => s.startMs)).toEqual([9_000])
  })

  it('drains the whole domain oldest-first when the target exceeds the total', async () => {
    const h = harness(partitioned, { domain })
    const res = await h.provider.evict({
      locationId: 'recordingsLow:default',
      targetBytes: 99_999,
    })
    expect(res).toEqual({ reclaimedBytes: 300, exhausted: true })
    expect(h.deleted).toHaveLength(3)
  })

  it('a read-only domain member contributes no evictable bytes and loses no footage', async () => {
    const h = harness(partitioned, {
      domain,
      // The draining alias holds the OLD footage — pressure relief must not
      // touch it (the mover empties it), only the writable alias evicts.
      isEvictionFrozen: (id) => id === 'recordingsLow:default',
    })
    expect(await h.provider.getEvictableUsage({ locationId: 'recordings:default' })).toEqual({
      bytes: 100,
    })
    await h.provider.evict({ locationId: 'recordings:default', targetBytes: 1 })
    // Victims come ONLY from the writable alias — which holds the NEWEST row.
    // The read-only alias's older rows survive even though a domain-wide
    // oldest-first pick would have taken them first.
    expect(h.deleted).toEqual([partitioned[2]!.path])
    // And the narrowed set is what reached the archive.
    for (const ask of h.archive.asks) expect(ask.locationIds).toEqual(['recordings:default'])
  })
})
