import { describe, it, expect } from 'vitest'
import {
  PRUNE_MAX_SEGMENTS_PER_PASS,
  selectEvictionsByBytes,
  selectEvictionsFromArchive,
} from '../evict-select.js'
import type { ArchiveCensus, ArchiveScope, FootageArchive, SegmentRow } from '../types.js'

const GB = 1_000_000_000
const DAY = 24 * 60 * 60 * 1000
const NOW = 1_000 * DAY

function seg(startDaysAgo: number, bytes: number, i: number): SegmentRow {
  const startMs = NOW - startDaysAgo * DAY
  return {
    deviceId: 99,
    profile: 'high',
    startMs,
    durMs: 2000,
    bytes,
    path: `99/high/${startMs}-${i}.m4s`,
    locationId: 'recordings',
  }
}

/**
 * An ARCHIVE over a fixed row set: a census taken from the rows themselves and
 * an oldest-first paged stream over them.
 *
 * `pagesRead` is the point. Every selection assertion below would also pass
 * against a fake that handed the whole array over in one page — which is what
 * the array-shaped `selectEvictions` this replaces did, and what D287 makes
 * unaffordable. The counter is the only witness that the walk is bounded by the
 * CUTOFF rather than by the archive's size.
 */
interface TestArchive extends FootageArchive {
  readonly pagesRead: () => number
}

function archiveOf(rows: readonly SegmentRow[], pageSize = 2, censusFails = false): TestArchive {
  const ordered = [...rows].toSorted((a, b) => a.startMs - b.startMs)
  let pages = 0
  return {
    census: async (): Promise<ArchiveCensus | null> => {
      if (censusFails) return null
      const starts = ordered.map((r) => r.startMs)
      return {
        segments: ordered.length,
        bytes: ordered.reduce((sum, r) => sum + r.bytes, 0),
        oldestMs: starts.length > 0 ? Math.min(...starts) : null,
        newestMs: starts.length > 0 ? Math.max(...starts) : null,
      }
    },
    streamSegments: async function* (_scope: ArchiveScope): AsyncGenerator<readonly SegmentRow[]> {
      for (let i = 0; i < ordered.length; i += pageSize) {
        pages += 1
        yield ordered.slice(i, i + pageSize)
      }
    },
    pagesRead: () => pages,
  }
}

const pathsOf = (rows: readonly SegmentRow[]): readonly string[] => rows.map((r) => r.path)

describe('selectEvictionsFromArchive', () => {
  it('evicts nothing when under all limits', async () => {
    const plan = await selectEvictionsFromArchive(archiveOf([seg(1, GB, 0), seg(2, GB, 1)]), 99, {
      nowMs: NOW,
      maxAgeDays: 30,
      maxSizeGb: 100,
    })
    expect(plan.victims).toEqual([])
    expect(plan.archiveSegments).toBe(2)
  })

  it('evicts segments older than maxAgeDays (oldest-first)', async () => {
    const rows = [seg(10, GB, 0), seg(2, GB, 1), seg(40, GB, 2)]
    const plan = await selectEvictionsFromArchive(archiveOf(rows), 99, {
      nowMs: NOW,
      maxAgeDays: 7,
    })
    expect(pathsOf(plan.victims)).toEqual([seg(40, GB, 2).path, seg(10, GB, 0).path])
  })

  it('evicts oldest-first to get under maxSizeGb', async () => {
    const rows = [seg(3, 2 * GB, 0), seg(2, 2 * GB, 1), seg(1, 2 * GB, 2)]
    const plan = await selectEvictionsFromArchive(archiveOf(rows), 99, {
      nowMs: NOW,
      maxSizeGb: 3,
    })
    expect(pathsOf(plan.victims)).toEqual([seg(3, 2 * GB, 0).path, seg(2, 2 * GB, 1).path])
    expect(plan.sizeLimitApplied).toBe(true)
  })

  it('treats maxSizeGb 0 / undefined as UNLIMITED — never over-prunes (regression)', async () => {
    // Historic data-loss bug: maxSizeGb:0 ("unlimited") was misread as a 0-byte
    // cap → "delete all but the newest". 0 and absent MUST mean no size limit.
    const rows = [seg(3, 5 * GB, 0), seg(2, 5 * GB, 1), seg(1, 5 * GB, 2)] // 15GB
    for (const limits of [
      { nowMs: NOW, maxSizeGb: 0 },
      { nowMs: NOW },
      { nowMs: NOW, maxAgeDays: 0, maxSizeGb: 0 },
    ]) {
      const plan = await selectEvictionsFromArchive(archiveOf(rows), 99, limits)
      expect(plan.victims).toEqual([])
    }
  })

  it('age + size combine: full eviction set, oldest-first, no duplicates', async () => {
    // total 6GB; one is age-expired
    const rows = [seg(40, 2 * GB, 0), seg(2, 2 * GB, 1), seg(1, 2 * GB, 2)]
    const plan = await selectEvictionsFromArchive(archiveOf(rows), 99, {
      nowMs: NOW,
      maxAgeDays: 7,
      maxSizeGb: 3,
    })
    const paths = pathsOf(plan.victims)
    expect(new Set(paths).size).toBe(paths.length)
    // age drops the 40-day seg (2GB); remaining 4GB > 3GB cap -> size drops the
    // next-oldest (2-day, 2GB)
    expect(paths).toEqual([seg(40, 2 * GB, 0).path, seg(2, 2 * GB, 1).path])
  })

  it('STOPS at the first surviving segment — it does not read the archive to select a prefix', async () => {
    // 40 rows, two expired. A pass that walked to the end would read all 40.
    const rows = [seg(40, GB, 0), seg(39, GB, 1)]
    for (let i = 0; i < 38; i++) rows.push(seg(1, GB, 10 + i))
    const archive = archiveOf(rows, 2)

    const plan = await selectEvictionsFromArchive(archive, 99, { nowMs: NOW, maxAgeDays: 7 })

    expect(pathsOf(plan.victims)).toEqual([seg(40, GB, 0).path, seg(39, GB, 1).path])
    // THE assertion. Removing the early stop on the first surviving row leaves
    // the victims byte-identical and turns this 2 into 20.
    expect(archive.pagesRead()).toBe(2)
    expect(plan.seen).toBeLessThan(rows.length)
  })

  it('a census that cannot be taken disables the SIZE half and says so — it never guesses a total', async () => {
    const rows = [seg(3, 5 * GB, 0), seg(2, 5 * GB, 1), seg(1, 5 * GB, 2)]
    const plan = await selectEvictionsFromArchive(archiveOf(rows, 2, true), 99, {
      nowMs: NOW,
      maxSizeGb: 1,
    })
    // A guessed total of 0 selects NOTHING; a total guessed from the page in
    // hand selects the whole archive. Neither is an answer, so the size half
    // does not run at all.
    expect(plan.victims).toEqual([])
    expect(plan.sizeLimitApplied).toBe(false)
    expect(plan.archiveSegments).toBeNull()
    // The AGE half needs no total and is unaffected.
    const aged = await selectEvictionsFromArchive(archiveOf(rows, 2, true), 99, {
      nowMs: NOW,
      maxAgeDays: 2.5,
    })
    expect(pathsOf(aged.victims)).toEqual([seg(3, 5 * GB, 0).path])
  })

  it('bounds one pass and REPORTS that it stopped short', async () => {
    const rows: SegmentRow[] = []
    for (let i = 0; i < PRUNE_MAX_SEGMENTS_PER_PASS + 5; i++) rows.push(seg(40, 100, i))
    const plan = await selectEvictionsFromArchive(archiveOf(rows, 500), 99, {
      nowMs: NOW,
      maxAgeDays: 7,
    })
    expect(plan.victims).toHaveLength(PRUNE_MAX_SEGMENTS_PER_PASS)
    expect(plan.bounded).toBe(true)
    expect(plan.archiveSegments).toBe(rows.length)
  })
})

describe('selectEvictionsByBytes', () => {
  it('selects oldest-first until cumulative bytes reach the target', () => {
    const segs = [seg(3, 100, 0), seg(2, 100, 1), seg(1, 100, 2)]
    const out = selectEvictionsByBytes(segs, 150)
    expect(out.map((s) => s.path)).toEqual([seg(3, 100, 0).path, seg(2, 100, 1).path])
  })
  it('returns all segments when target exceeds total bytes', () => {
    const segs = [seg(3, 100, 0), seg(2, 100, 1), seg(1, 100, 2)]
    const out = selectEvictionsByBytes(segs, 1000)
    expect(out.map((s) => s.path)).toEqual([
      seg(3, 100, 0).path,
      seg(2, 100, 1).path,
      seg(1, 100, 2).path,
    ])
  })
  it('selects exactly all segments when the target equals the total bytes', () => {
    const segs = [seg(3, 100, 0), seg(2, 100, 1), seg(1, 100, 2)]
    const out = selectEvictionsByBytes(segs, 300)
    expect(out.map((s) => s.path)).toEqual([
      seg(3, 100, 0).path,
      seg(2, 100, 1).path,
      seg(1, 100, 2).path,
    ])
  })
  it('returns [] for target 0 and for a negative target', () => {
    const segs = [seg(3, 100, 0), seg(2, 100, 1), seg(1, 100, 2)]
    expect(selectEvictionsByBytes(segs, 0)).toEqual([])
    expect(selectEvictionsByBytes(segs, -100)).toEqual([])
  })
  it('orders by startMs (oldest-first) regardless of input order', () => {
    const segs = [seg(1, 100, 2), seg(3, 100, 0), seg(2, 100, 1)]
    const out = selectEvictionsByBytes(segs, 300)
    // oldest-first = ascending startMs = descending startDaysAgo: seg(3) then seg(2) then seg(1)
    expect(out.map((s) => s.path)).toEqual([
      seg(3, 100, 0).path,
      seg(2, 100, 1).path,
      seg(1, 100, 2).path,
    ])
    expect(out[0]!.startMs).toBeLessThan(out[1]!.startMs)
    expect(out[1]!.startMs).toBeLessThan(out[2]!.startMs)
  })
})
