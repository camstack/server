import { describe, expect, it, vi } from 'vitest'
import { RecordingIndex } from '../recording-index.js'
import { segmentRelPath } from '../segment-path.js'
import { SegmentStore, type SegmentStoreDeps } from '../segment-store.js'
import type { SegmentRow } from '../types.js'

const HOUR_MS = 3_600_000

/**
 * What the hour DIRECTORY holds — declared by the fixture, never derived from
 * `RecordingIndex`.
 *
 * Since D523 the cover test ("does this round name every file in the bucket?")
 * is asked of the very directory the `rm -rf` will take, so the fixture must be
 * able to make the directory and the resident index DISAGREE. A fixture that
 * answered from the index would make them agree by construction, and that
 * disagreement is the whole failure mode: the index knows only what this
 * process hydrated, so it answered "yes, the round covers this bucket" while
 * the directory held hundreds of files the round had never heard of.
 */
function declareHourDirectory(listing: Map<string, string[]>, rows: readonly SegmentRow[]): void {
  for (const row of rows) {
    const key = `${row.deviceId}|${row.profile}|${Math.floor(row.startMs / HOUR_MS) * HOUR_MS}`
    listing.set(key, [...(listing.get(key) ?? []), row.path])
  }
}

function fakes(overrides: Partial<SegmentStoreDeps> = {}) {
  const index = new RecordingIndex()
  const deleted: { location: string; relativePath: string }[] = []
  const moved: { from: string; to: string }[] = []
  const removedDirs: { location: string; relDir: string }[] = []
  const archive = new Map<string, string[]>()
  const deps: SegmentStoreDeps = {
    index,
    hourDirectoryPaths: async (deviceId, profile, _location, hourStartMs) =>
      archive.get(`${deviceId}|${profile}|${hourStartMs}`) ?? null,
    list: vi.fn(async () => []),
    deletePath: vi.fn(async (i) => {
      deleted.push(i)
    }),
    statBytes: vi.fn(async () => 1000),
    moveFile: vi.fn(async (from, to) => {
      moved.push({ from, to })
    }),
    removeDir: vi.fn(async (location, relDir) => {
      removedDirs.push({ location, relDir })
    }),
    // Far future: every fixture bucket-hour is safely in the past.
    now: () => Date.UTC(2100, 0, 1),
    logger: { warn: vi.fn(), info: vi.fn() },
    ...overrides,
  }
  return { index, deps, deleted, moved, removedDirs, archive }
}

describe('SegmentStore', () => {
  it('hydrate fills the index from storage.list', async () => {
    const p1 = segmentRelPath(99, 'high', 1000, 2000, 50)
    const p2 = segmentRelPath(99, 'high', 3000, 2000, 70)
    const { index, deps } = fakes({ list: vi.fn(async () => [p1, p2]) })
    const store = new SegmentStore(deps)
    await store.hydrate(99, 'recordings')
    expect(deps.list).toHaveBeenCalledWith({ location: 'recordings', prefix: '99/' })
    expect(index.accounting(99)).toEqual({ bytes: 120, count: 2, oldestMs: 1000, newestMs: 3000 })
    expect(index.segments(99).every((s) => s.locationId === 'recordings')).toBe(true)
  })

  it('onFinalized stats, relocates with bytes in the name, and indexes', async () => {
    const { index, deps, moved } = fakes({ statBytes: vi.fn(async () => 524288) })
    const store = new SegmentStore(deps)
    const row = await store.onFinalized({
      deviceId: 99,
      profile: 'high',
      locationId: 'recordings',
      locationRoot: '/data/rec',
      flatAbsPath: '/data/rec/tmp/1781512557.m4s',
      startMs: 1781512557000,
      durMs: 2000,
    })
    const expectedRel = segmentRelPath(99, 'high', 1781512557000, 2000, 524288)
    expect(row).toEqual({
      deviceId: 99,
      profile: 'high',
      startMs: 1781512557000,
      durMs: 2000,
      bytes: 524288,
      path: expectedRel,
      locationId: 'recordings',
    })
    expect(moved[0]).toEqual({
      from: '/data/rec/tmp/1781512557.m4s',
      to: `/data/rec/${expectedRel}`,
    })
    expect(index.accounting(99).bytes).toBe(524288)
  })

  it('onFinalized returns null and does not index a 0-byte / failed stat', async () => {
    const { index, deps } = fakes({ statBytes: vi.fn(async () => 0) })
    const store = new SegmentStore(deps)
    const row = await store.onFinalized({
      deviceId: 99,
      profile: 'high',
      locationId: 'recordings',
      locationRoot: '/r',
      flatAbsPath: '/r/tmp/x.m4s',
      startMs: 1000,
      durMs: 2000,
    })
    expect(row).toBeNull()
    expect(index.accounting(99).count).toBe(0)
  })

  it('onFinalized refuses a stub too small to be a media segment (bare styp)', async () => {
    // ffmpeg opens the next segment the instant it closes the previous one, so
    // a killed writer always leaves one just-opened stub — observed as 28-byte
    // bare `styp` boxes. Indexing one paints the timeline with a nominal-length
    // segment that decodes to nothing.
    const { index, deps, moved } = fakes({ statBytes: vi.fn(async () => 28) })
    const store = new SegmentStore(deps)
    const row = await store.onFinalized({
      deviceId: 99,
      profile: 'high',
      locationId: 'recordings',
      locationRoot: '/r',
      flatAbsPath: '/r/tmp/x.m4s',
      startMs: 1000,
      durMs: 2000,
    })
    expect(row).toBeNull()
    expect(moved).toHaveLength(0)
    expect(index.accounting(99).count).toBe(0)
  })

  it('a stub is cleared from staging once and reported once, never re-found', async () => {
    // 530 identical "left in staging" warnings re-logged at every recorder boot:
    // the stub was reported and kept. Fixture: a real file set — the stat fake
    // answers from what `removeStaged` has NOT yet deleted, as a disk would.
    const onDisk = new Map<string, number>([
      ['/r/.rec-tmp/99/high/a.m4s', 28],
      ['/r/.rec-tmp/99/high/b.m4s', 28],
    ])
    const debug = vi.fn()
    const { deps } = fakes({
      statBytes: vi.fn(async (p: string) => {
        const n = onDisk.get(p)
        if (n === undefined) throw new Error('ENOENT')
        return n
      }),
      removeStaged: vi.fn(async (p: string) => {
        onDisk.delete(p)
      }),
      logger: { warn: vi.fn(), info: vi.fn(), debug },
    })
    const store = new SegmentStore(deps)
    const finalize = (flatAbsPath: string) =>
      store.onFinalized({
        deviceId: 99,
        profile: 'high',
        locationId: 'recordings',
        locationRoot: '/r',
        flatAbsPath,
        startMs: 1000,
        durMs: 2000,
      })
    for (const p of [...onDisk.keys()]) await finalize(p)

    expect(onDisk.size).toBe(0)
    expect(store.takeStubReport()).toEqual({ count: 2, bytes: 56 })
    expect(deps.logger.warn).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('too small'),
      expect.objectContaining({ tags: { deviceId: 99 } }),
    )
    // Second recovery: nothing on disk to find, nothing to report.
    expect(store.takeStubReport()).toEqual({ count: 0, bytes: 0 })
  })

  it('evict deletes via storage, de-indexes, and returns reclaimed bytes', async () => {
    const a = {
      deviceId: 99,
      profile: 'high',
      startMs: 1000,
      durMs: 2000,
      bytes: 100,
      path: segmentRelPath(99, 'high', 1000, 2000, 100),
      locationId: 'recordings',
    }
    const b = {
      deviceId: 99,
      profile: 'high',
      startMs: 3000,
      durMs: 2000,
      bytes: 200,
      path: segmentRelPath(99, 'high', 3000, 2000, 200),
      locationId: 'recordings',
    }
    // `now` inside the rows' 1970-01-01T00 bucket hour → the current-hour guard
    // routes this through the per-file path (the bucket fast path is pinned by
    // the R4 suite below).
    const deindexed: (typeof a)[] = []
    const { index, deps, deleted } = fakes({
      now: () => 2_000,
      onDeindexed: (rows) => {
        deindexed.push(...rows)
      },
    })
    index.addSegment(a)
    index.addSegment(b)
    const store = new SegmentStore(deps)
    const reclaimed = await store.evict('recordings', [a, b])
    expect(reclaimed).toBe(300)
    expect(deleted.map((d) => d.relativePath)).toEqual([a.path, b.path])
    expect(index.accounting(99).count).toBe(0)
    expect(deindexed).toEqual([a, b])
  })

  it('evict tolerates a per-file delete failure (partial reclaim, failed row kept)', async () => {
    const a = {
      deviceId: 99,
      profile: 'high',
      startMs: 1000,
      durMs: 2000,
      bytes: 100,
      path: segmentRelPath(99, 'high', 1000, 2000, 100),
      locationId: 'recordings',
    }
    const b = {
      deviceId: 99,
      profile: 'high',
      startMs: 3000,
      durMs: 2000,
      bytes: 200,
      path: segmentRelPath(99, 'high', 3000, 2000, 200),
      locationId: 'recordings',
    }
    const { index, deps } = fakes({
      // Per-file path (current-hour guard) — see the R4 suite for the fast path.
      now: () => 2_000,
      deletePath: vi.fn(async (i) => {
        if (i.relativePath === a.path) throw new Error('EACCES')
      }),
    })
    index.addSegment(a)
    index.addSegment(b)
    const store = new SegmentStore(deps)
    const reclaimed = await store.evict('recordings', [a, b])
    expect(reclaimed).toBe(200)
    expect(index.segments(99).map((s) => s.path)).toEqual([a.path])
  })
})

// ── R4: bucket-granular eviction ─────────────────────────────────────────────
function rowAt(startMs: number, bytes: number, profile = 'high') {
  return {
    deviceId: 99,
    profile,
    startMs,
    durMs: 2000,
    bytes,
    path: segmentRelPath(99, profile, startMs, 2000, bytes),
    locationId: 'recordings',
  }
}

describe('SegmentStore.evict — bucket-granular deletes', () => {
  it('drops a FULLY-evicted hour bucket with ONE removeDir and zero per-file deletes', async () => {
    // Two rows, both in the 1970-01-01T00 UTC hour bucket — and they are ALL
    // the indexed segments of that bucket.
    const a = rowAt(1_000, 100)
    const b = rowAt(5_000, 200)
    const { index, deps, deleted, removedDirs, archive } = fakes()
    index.addSegment(a)
    index.addSegment(b)
    declareHourDirectory(archive, [a, b])
    const store = new SegmentStore(deps)

    const reclaimed = await store.evict('recordings', [a, b])

    expect(reclaimed).toBe(300)
    expect(removedDirs).toEqual([{ location: 'recordings', relDir: '99/high/1970/01/01/00' }])
    expect(deleted).toEqual([]) // no per-file storage deletes
    expect(index.accounting(99).count).toBe(0) // index cleared
  })

  it('falls back to per-file deletes when the bucket still has surviving segments', async () => {
    const victim = rowAt(1_000, 100)
    const survivor = rowAt(5_000, 200)
    const { index, deps, deleted, removedDirs, archive } = fakes()
    index.addSegment(victim)
    index.addSegment(survivor)
    declareHourDirectory(archive, [victim, survivor])
    const store = new SegmentStore(deps)

    const reclaimed = await store.evict('recordings', [victim])

    expect(reclaimed).toBe(100)
    expect(removedDirs).toEqual([])
    expect(deleted.map((d) => d.relativePath)).toEqual([victim.path])
    expect(index.segments(99).map((s) => s.path)).toEqual([survivor.path])
  })

  it('never removeDirs the CURRENT hour bucket (relocates may still land there)', async () => {
    const nowMs = Date.UTC(2026, 6, 3, 12, 30, 0)
    const a = rowAt(Date.UTC(2026, 6, 3, 12, 1, 0), 100)
    const b = rowAt(Date.UTC(2026, 6, 3, 12, 2, 0), 200)
    const { index, deps, deleted, removedDirs, archive } = fakes({ now: () => nowMs })
    index.addSegment(a)
    index.addSegment(b)
    declareHourDirectory(archive, [a, b])
    const store = new SegmentStore(deps)

    const reclaimed = await store.evict('recordings', [a, b])

    expect(reclaimed).toBe(300)
    expect(removedDirs).toEqual([])
    expect(deleted.map((d) => d.relativePath)).toEqual([a.path, b.path])
  })

  it('falls back to per-file deletes when removeDir itself fails', async () => {
    const a = rowAt(1_000, 100)
    const { index, deps, deleted, archive } = fakes({
      removeDir: vi.fn(async () => {
        throw new Error('EACCES')
      }),
    })
    index.addSegment(a)
    declareHourDirectory(archive, [a])
    const store = new SegmentStore(deps)

    const reclaimed = await store.evict('recordings', [a])

    expect(reclaimed).toBe(100)
    expect(deleted.map((d) => d.relativePath)).toEqual([a.path])
    expect(index.accounting(99).count).toBe(0)
  })
})

describe('SegmentStore.evict — a directory that exists means footage', () => {
  /**
   * The invariant the date selector wants to rely on. Hours were already
   * removed when fully evicted; DAYS were not — measured on the live archive,
   * 15 of 28 day directories held nothing at all while only 1 of 261 hour
   * directories did. Those shells are the reason the cheapest question in the
   * product ("which days have footage") could not be answered by reading
   * `.../YYYY/MM/` and taking the names.
   */
  function harness(): {
    store: SegmentStore
    index: RecordingIndex
    pruned: string[]
    removedDirs: string[]
    /** Directories the fake filesystem still considers non-empty. */
    nonEmpty: Set<string>
  } {
    const index = new RecordingIndex()
    const pruned: string[] = []
    const removedDirs: string[] = []
    const nonEmpty = new Set<string>()
    const store = new SegmentStore({
      index,
      list: async () => [],
      deletePath: async () => {},
      statBytes: async () => 0,
      moveFile: async () => {},
      removeDir: async (_location: string, dir: string) => {
        removedDirs.push(dir)
      },
      removeDirIfEmpty: async (_location: string, dir: string) => {
        if (nonEmpty.has(dir)) throw new Error('ENOTEMPTY')
        pruned.push(dir)
      },
      now: () => Date.UTC(2026, 7, 1),
      logger: { warn: () => {}, info: () => {} },
    } as unknown as ConstructorParameters<typeof SegmentStore>[0])
    return { store, index, pruned, removedDirs, nonEmpty }
  }

  const row = (hour: string): SegmentRow => ({
    deviceId: 7,
    profile: 'low',
    startMs: Date.UTC(2026, 6, 28, Number(hour)),
    durMs: 8000,
    bytes: 1000,
    path: `7/low/2026/07/28/${hour}/${Date.UTC(2026, 6, 28, Number(hour))}-8000-1000.m4s`,
    locationId: 'loc-a',
  })

  it('removes the day once its last hour is gone', async () => {
    const h = harness()
    await h.store.evict('loc-a', [row('03')])
    expect(h.pruned).toContain('7/low/2026/07/28')
  })

  it('keeps a day that still holds another hour', async () => {
    // The guard is `rmdir` failing on a non-empty directory — never a check we
    // could get wrong, and never a recursive delete that could take footage.
    const h = harness()
    h.nonEmpty.add('7/low/2026/07/28')
    await h.store.evict('loc-a', [row('03')])
    expect(h.pruned).not.toContain('7/low/2026/07/28')
  })

  it('stops pruning at the profile level', async () => {
    const h = harness()
    await h.store.evict('loc-a', [row('03')])
    expect(h.pruned).not.toContain('7/low')
    expect(h.pruned).not.toContain('7')
  })

  it('climbs past the day to month and year when they empty too', async () => {
    const h = harness()
    await h.store.evict('loc-a', [row('03')])
    expect(h.pruned).toEqual(['7/low/2026/07/28', '7/low/2026/07', '7/low/2026'])
  })
})

/**
 * The silent 100%-CPU phase of 2026-08-14 (D160).
 *
 * The D148 staging recovery indexed ~123 000 previously-invisible segments, and
 * the retention sweep that followed made them all evictable in ONE round —
 * ~8 900 sparse hour-buckets across six weeks, where a normal round touches a
 * handful at the retention edge. `evict` answered "is this bucket fully
 * covered?" by copying and scanning the whole (device, profile) archive PER
 * BUCKET, and told the calendar cache PER ROW. Measured on that shape (1.63 M
 * live rows, 122 400 victims): 182 596 ms and 15 285 ms of uninterrupted
 * main-thread CPU, and not one log line while it ran.
 */
describe('SegmentStore.evict — cost does not scale with the archive (D160)', () => {
  const NOW = Date.UTC(2026, 7, 14, 12)

  /** `buckets` hour-buckets of `perBucket` segments each, plus `noise` rows of
   *  OTHER footage that must never be re-scanned per bucket. */
  function seeded(buckets: number, perBucket: number, noise: number) {
    const index = new RecordingIndex()
    const victims: SegmentRow[] = []
    const mk = (startMs: number): SegmentRow => ({
      deviceId: 7,
      profile: 'low',
      startMs,
      durMs: 10_000,
      bytes: 1000,
      path: segmentRelPath(7, 'low', startMs, 10_000, 1000),
      locationId: 'loc-a',
    })
    for (let b = 0; b < buckets; b++) {
      const hourStart = NOW - (b + 2) * 3_600_000
      for (let i = 0; i < perBucket; i++) {
        const r = mk(hourStart + i * 10_000)
        index.addSegment(r)
        victims.push(r)
      }
    }
    // Untouched footage on the same (device, profile), far in the past.
    for (let i = 0; i < noise; i++) index.addSegment(mk(NOW - 400 * 3_600_000 - i * 10_000))
    const archive = new Map<string, string[]>()
    declareHourDirectory(archive, victims)
    return { index, victims, archive }
  }

  function storeOver(
    index: RecordingIndex,
    over: Partial<SegmentStoreDeps> = {},
    archive: Map<string, string[]> = new Map(),
  ) {
    const evicted: { deviceId: number; atMs: number }[] = []
    const yields: number[] = []
    const info = vi.fn()
    const store = new SegmentStore({
      index,
      list: async () => [],
      deletePath: async () => {},
      statBytes: async () => 0,
      moveFile: async () => {},
      removeDir: async () => {},
      removeDirIfEmpty: async () => {},
      hourDirectoryPaths: async (deviceId, profile, _location, hourStartMs) =>
        archive.get(`${deviceId}|${profile}|${hourStartMs}`) ?? null,
      onEvicted: (deviceId, atMs) => {
        evicted.push({ deviceId, atMs })
      },
      yieldBetween: async () => {
        yields.push(1)
      },
      now: () => NOW,
      logger: { warn: () => {}, info },
      ...over,
    })
    return { store, evicted, yields, info }
  }

  it('never reads the RESIDENT archive to decide a bucket, at any cost', async () => {
    const { index, victims, archive } = seeded(40, 3, 5_000)
    const segments = vi.spyOn(index, 'segments')
    const { store } = storeOver(index, {}, archive)

    await store.evict('loc-a', victims)

    // Two defects in one assertion. `segments(...).filter(startsWith)` PER
    // BUCKET was a full archive copy + scan each time — the shape that burned
    // three minutes of CPU per round on the live archive. And any resident read
    // here is wrong on top of being slow: the index knows only the hours this
    // process hydrated, so it answers "yes, the round covers this bucket" for a
    // directory holding hundreds of files nobody enumerated. The cover test
    // belongs to the directory the `rm -rf` will take (D523).
    expect(segments).not.toHaveBeenCalled()
  })

  it('still removes a fully-covered bucket, and still refuses a partial one', async () => {
    const { index, victims, archive } = seeded(2, 3, 0)
    const removedDirs: string[] = []
    const deleted: string[] = []
    const { store } = storeOver(
      index,
      {
        removeDir: async (_loc: string, dir: string) => {
          removedDirs.push(dir)
        },
        deletePath: async (i: { location: string; relativePath: string }) => {
          deleted.push(i.relativePath)
        },
      },
      archive,
    )

    // Bucket 0 fully, bucket 1 partially (one of its three segments survives).
    const bucketOf = (r: SegmentRow): string => r.path.slice(0, r.path.lastIndexOf('/'))
    const first = bucketOf(victims[0]!)
    const round = victims.filter((r) => bucketOf(r) === first || r === victims[3])

    await store.evict('loc-a', round)

    expect(removedDirs).toEqual([first])
    expect(deleted).toEqual([victims[3]!.path])
  })

  it('tells the calendar cache once per (device, UTC day), not once per row', async () => {
    // 48 buckets = two UTC days, 3 rows each = 144 rows.
    const { index, victims } = seeded(48, 3, 0)
    const { store, evicted } = storeOver(index)

    await store.evict('loc-a', victims)

    expect(victims.length).toBe(144)
    const days = new Set(evicted.map((e) => Math.floor(e.atMs / 86_400_000)))
    expect(evicted.length).toBe(days.size)
    expect(evicted.length).toBeLessThanOrEqual(3)
  })

  it('hands the event loop back while it works through the buckets', async () => {
    const { index, victims } = seeded(60, 1, 0)
    const { store, yields } = storeOver(index, { evictChunkSize: 10 })

    await store.evict('loc-a', victims)

    // 60 buckets at 10 per chunk. Without the yield the whole round is one
    // uninterrupted stretch and a queued cap request waits for all of it.
    expect(yields.length).toBe(6)
  })

  it('reports the round it just spent minutes on', async () => {
    const { index, victims, archive } = seeded(5, 2, 0)
    const { store, info } = storeOver(index, {}, archive)

    await store.evict('loc-a', victims)

    expect(info).toHaveBeenCalledWith(
      'recorder: eviction round complete',
      expect.objectContaining({
        meta: expect.objectContaining({ rows: 10, buckets: 5, bucketsRemoved: 5, removed: 10 }),
      }),
    )
  })
})
