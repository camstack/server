/**
 * The calendar cache. What is pinned is the COUNT of disk scans, because that
 * is the whole point: the directory reads behind a month of the date selector
 * take 8,511 ms cold on the live array (~650 ms each) and 14 ms warm. The
 * ladder makes the question answerable; the cache makes it instant.
 */
import { describe, it, expect, vi } from 'vitest'
import { CalendarIndex, hourSegmentsFromIndex, localDayStart } from '../calendar-index.js'
import { RecordingIndex } from '../../recording-index.js'
import type { SegmentRow } from '../../types.js'
import type { IScopedLogger } from '@camstack/types'

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as IScopedLogger

const DAY = 86_400_000
const D28 = Date.UTC(2026, 6, 28)
const D29 = Date.UTC(2026, 6, 29)
/** Fixed "now" well after the days under test, so none of them is "today". */
const NOW = Date.UTC(2026, 7, 15)

interface Harness {
  readonly cal: CalendarIndex
  /** One entry per DISK scan — the number this cache exists to hold down. */
  readonly scans: string[]
}

function makeIndex(byDay: Record<string, readonly number[]>, now = NOW): Harness {
  const scans: string[] = []
  const cal = new CalendarIndex({
    roots: () => ['/rec'],
    logger: noopLogger,
    now: () => now,
    scanHours: async (_root, _dev, y, m, d) => {
      const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      scans.push(key)
      return [...(byDay[key] ?? [])]
    },
  })
  return { cal, scans }
}

describe('CalendarIndex', () => {
  it('scans a past day once and answers from memory after', async () => {
    const h = makeIndex({ '2026-07-28': [3, 4] })
    expect(await h.cal.hoursOfUtcDay(1, D28)).toEqual([3, 4])
    expect(await h.cal.hoursOfUtcDay(1, D28)).toEqual([3, 4])
    expect(await h.cal.hoursOfUtcDay(1, D28)).toEqual([3, 4])
    expect(h.scans).toEqual(['2026-07-28'])
  })

  it('caches a day that turned out EMPTY, so a gap is not re-walked forever', async () => {
    // 15 of 28 day directories on the real archive hold nothing. Re-scanning
    // those on every query would cost more than the days that do.
    const h = makeIndex({})
    expect(await h.cal.hoursOfUtcDay(1, D28)).toEqual([])
    expect(await h.cal.hoursOfUtcDay(1, D28)).toEqual([])
    expect(h.scans).toHaveLength(1)
  })

  it('does NOT cache today — its last hour is still being written', async () => {
    const today = Date.UTC(2026, 6, 28, 10)
    const h = makeIndex({ '2026-07-28': [3] }, today)
    await h.cal.hoursOfUtcDay(1, D28)
    await h.cal.hoursOfUtcDay(1, D28)
    expect(h.scans).toHaveLength(2)
  })

  it('collapses a burst of queries into ONE scan', async () => {
    // A screen opening asks for the same day from several places at once; at
    // ~650 ms a cold read, doing it twice is the difference the user feels.
    const h = makeIndex({ '2026-07-28': [1] })
    await Promise.all([
      h.cal.hoursOfUtcDay(1, D28),
      h.cal.hoursOfUtcDay(1, D28),
      h.cal.hoursOfUtcDay(1, D28),
    ])
    expect(h.scans).toEqual(['2026-07-28'])
  })

  it('attributes hours to the operator LOCAL day', async () => {
    // 23:00Z on the 28th is 01:00 on the 29th in CEST — a different day in the
    // selector, and the reason this cannot be answered from UTC day names.
    const h = makeIndex({ '2026-07-28': [10, 23] })
    const days = await h.cal.localDays(1, D28, D29 + DAY, 120)
    expect(days).toEqual([
      localDayStart(D28 + 10 * 3_600_000, 120),
      localDayStart(D28 + 23 * 3_600_000, 120),
    ])
  })

  it('invalidates only the day eviction touched', async () => {
    const h = makeIndex({ '2026-07-28': [3], '2026-07-29': [4] })
    await h.cal.hoursOfUtcDay(1, D28)
    await h.cal.hoursOfUtcDay(1, D29)
    h.cal.invalidate(1, D28)
    await h.cal.hoursOfUtcDay(1, D28)
    await h.cal.hoursOfUtcDay(1, D29)
    expect(h.scans).toEqual(['2026-07-28', '2026-07-29', '2026-07-28'])
  })

  it('warming leaves nothing for the query to scan', async () => {
    const h = makeIndex({ '2026-07-28': [3], '2026-07-29': [4] })
    await h.cal.warm(1, D28, D29)
    const before = h.scans.length
    await h.cal.localDays(1, D28, D29 + DAY, 0)
    // localDays widens by a day each side, so only those edges are new.
    expect(h.scans.slice(before)).not.toContain('2026-07-28')
    expect(h.scans.slice(before)).not.toContain('2026-07-29')
  })
})

describe('localDayStart', () => {
  it('returns the instant of LOCAL midnight, not of UTC midnight', () => {
    // 23:30Z on the 28th is 01:30 on the 29th in CEST, so its day starts at
    // 22:00Z on the 28th — an instant, which is what the cap returns.
    expect(localDayStart(Date.UTC(2026, 6, 28, 23, 30), 120)).toBe(Date.UTC(2026, 6, 28, 22))
    expect(localDayStart(Date.UTC(2026, 6, 29, 0, 30), -120)).toBe(Date.UTC(2026, 6, 28, 2))
  })
})

describe('CalendarIndex — the exact rung', () => {
  const HOUR = 3_600_000
  function makeExact(byHour: Record<number, ReadonlyArray<{ startMs: number; durMs: number }>>): {
    cal: CalendarIndex
    scans: number[]
  } {
    const scans: number[] = []
    const cal = new CalendarIndex({
      roots: () => ['/rec'],
      logger: noopLogger,
      now: () => NOW,
      scanSegments: async (_r, _d, _p, hourStartMs) => {
        scans.push(hourStartMs)
        return (byHour[hourStartMs] ?? []).map((seg) => ({ ...seg, bytes: 0 }))
      },
    })
    return { cal, scans }
  }

  it('merges an hour of back-to-back segments into ONE range', async () => {
    // Recorded durations under-cover the span to the next start by a few ms.
    // Without the tolerance every segment becomes its own range.
    const h = makeExact({
      [D28 + 3 * HOUR]: [
        { startMs: D28 + 3 * HOUR, durMs: 7989 },
        { startMs: D28 + 3 * HOUR + 8000, durMs: 7989 },
        { startMs: D28 + 3 * HOUR + 16000, durMs: 7989 },
      ],
    })
    const ranges = await h.cal.dayRanges(1, 'low', D28)
    expect(ranges).toHaveLength(1)
    expect(ranges[0]).toEqual({ startMs: D28 + 3 * HOUR, endMs: D28 + 3 * HOUR + 23989 })
  })

  it('keeps a real gap — the 17-minute hole must not be merged away', async () => {
    const h = makeExact({
      [D28 + 3 * HOUR]: [{ startMs: D28 + 3 * HOUR, durMs: 8000 }],
      [D28 + 4 * HOUR]: [{ startMs: D28 + 4 * HOUR, durMs: 8000 }],
    })
    expect(await h.cal.dayRanges(1, 'low', D28)).toHaveLength(2)
  })

  it('scans each hour once across repeated day queries', async () => {
    const h = makeExact({ [D28 + 3 * HOUR]: [{ startMs: D28 + 3 * HOUR, durMs: 8000 }] })
    await h.cal.dayRanges(1, 'low', D28)
    await h.cal.dayRanges(1, 'low', D28)
    expect(h.scans).toHaveLength(24)
  })

  it('scans only the hours a window overlaps — not the other 22 of the UTC day', async () => {
    // Live 2026-08-22 15:50Z: opening the theater called getAvailability which
    // ran dayRanges (24 readdirs) AND warmAdjacent (48 more) on the same FUSE
    // share the scrub feeder was reading. locate was 3 ms (RAM) but the .m4s
    // read hit `segment read timeout` (8 s). A 2-hour window is two hours.
    const h = makeExact({
      [D28 + 10 * HOUR]: [{ startMs: D28 + 10 * HOUR, durMs: 8000 }],
      [D28 + 11 * HOUR]: [{ startMs: D28 + 11 * HOUR, durMs: 8000 }],
    })
    const ranges = await h.cal.rangesIn(1, 'low', D28 + 10 * HOUR, D28 + 12 * HOUR)
    expect(h.scans).toHaveLength(2)
    expect(ranges).toHaveLength(2)
  })

  it('eviction drops the exact ranges too, not just the hour list', async () => {
    // Dropping only the hour list would leave the timeline drawing a bar over
    // footage that has just been deleted.
    const h = makeExact({ [D28 + 3 * HOUR]: [{ startMs: D28 + 3 * HOUR, durMs: 8000 }] })
    await h.cal.dayRanges(1, 'low', D28)
    const before = h.scans.length
    h.cal.invalidate(1, D28)
    await h.cal.dayRanges(1, 'low', D28)
    expect(h.scans.length).toBeGreaterThan(before)
  })
})

describe('CalendarIndex — the profile is resolved once, not per day', () => {
  it('does not re-derive the availability profile for every day scanned', async () => {
    // Measured on the live hub: letting each day re-derive it added ~90 reads
    // to a month and left a FULLY WARM date-selector query at 1,624 ms.
    let picks = 0
    const cal = new CalendarIndex({
      roots: () => ['/rec'],
      logger: noopLogger,
      now: () => NOW,
      pickProfile: async () => {
        picks++
        return 'low'
      },
      scanHours: async () => [3],
    })
    await cal.localDays(1, D28 - 20 * DAY, D28, 0)
    expect(picks).toBe(1)
  })
})

describe('CalendarIndex — the live edge', () => {
  const HOUR = 3_600_000
  it('reuses the current hour briefly instead of re-reading it on every poll', async () => {
    // The timeline polls. Re-reading the live hour each time made a 65 ms query
    // spike to 2,405 ms whenever that read met a contended moment on the array.
    let t = Date.UTC(2026, 6, 28, 10, 0, 0)
    let scans = 0
    const cal = new CalendarIndex({
      roots: () => ['/rec'],
      logger: noopLogger,
      now: () => t,
      pickProfile: async () => 'low',
      scanSegments: async () => {
        scans++
        return []
      },
    })
    const hour = Date.UTC(2026, 6, 28, 10)
    await cal.segmentsOf(1, 'low', hour)
    t += 1000
    await cal.segmentsOf(1, 'low', hour)
    expect(scans).toBe(1)
  })

  it('re-reads the current hour once the reuse window passes', async () => {
    // Segments land every 8–12 s; the window must be short enough that a whole
    // one cannot hide behind it.
    let t = Date.UTC(2026, 6, 28, 10, 0, 0)
    let scans = 0
    const cal = new CalendarIndex({
      roots: () => ['/rec'],
      logger: noopLogger,
      now: () => t,
      pickProfile: async () => 'low',
      scanSegments: async () => {
        scans++
        return []
      },
    })
    const hour = Date.UTC(2026, 6, 28, 10)
    await cal.segmentsOf(1, 'low', hour)
    t += 5000
    await cal.segmentsOf(1, 'low', hour)
    expect(scans).toBe(2)
  })

  it('keeps a PAST hour indefinitely — it cannot change but by eviction', async () => {
    let scans = 0
    const cal = new CalendarIndex({
      roots: () => ['/rec'],
      logger: noopLogger,
      now: () => NOW,
      pickProfile: async () => 'low',
      scanSegments: async () => {
        scans++
        return []
      },
    })
    await cal.segmentsOf(1, 'low', D28 + 3 * HOUR)
    await cal.segmentsOf(1, 'low', D28 + 3 * HOUR)
    expect(scans).toBe(1)
  })
})

describe('CalendarIndex — RAM index preferred over a directory scan', () => {
  const HOUR = 3_600_000

  it('does not scan disk when indexHour already knows the hour', async () => {
    // Live 2026-08-22: getAvailability readdir of the current hour (TTL 3 s)
    // queued behind FUSE and made scrub's locateSegment miss its 8 s budget
    // (`scrub-feeder:tick-failed` / `segment read timeout` on 104/low).
    let scans = 0
    const hour = D28 + 3 * HOUR
    const fromIndex = [{ startMs: hour, durMs: 8000, bytes: 100 }]
    const cal = new CalendarIndex({
      roots: () => ['/rec'],
      logger: noopLogger,
      now: () => NOW,
      scanSegments: async () => {
        scans++
        return [{ startMs: 1, durMs: 1, bytes: 1 }]
      },
      indexHour: () => fromIndex,
    })
    expect(await cal.segmentsOf(1, 'low', hour)).toEqual(fromIndex)
    expect(scans).toBe(0)
  })

  it('falls through to a directory scan when indexHour returns null', async () => {
    let scans = 0
    const hour = D28 + 3 * HOUR
    const cal = new CalendarIndex({
      roots: () => ['/rec'],
      logger: noopLogger,
      now: () => NOW,
      indexHour: () => null,
      scanSegments: async () => {
        scans++
        return [{ startMs: hour, durMs: 4000, bytes: 50 }]
      },
    })
    const segs = await cal.segmentsOf(1, 'low', hour)
    expect(scans).toBe(1)
    expect(segs).toEqual([{ startMs: hour, durMs: 4000, bytes: 50 }])
  })

  it('serves the current hour from the RAM index after the reuse window — no second directory read', async () => {
    let t = Date.UTC(2026, 6, 28, 10, 0, 0)
    let scans = 0
    const hour = Date.UTC(2026, 6, 28, 10)
    const live = [{ startMs: hour, durMs: 8000, bytes: 10 }]
    const cal = new CalendarIndex({
      roots: () => ['/rec'],
      logger: noopLogger,
      now: () => t,
      scanSegments: async () => {
        scans++
        return []
      },
      indexHour: () => live,
    })
    await cal.segmentsOf(1, 'low', hour)
    t += 5000
    await cal.segmentsOf(1, 'low', hour)
    expect(scans).toBe(0)
  })
})

describe('hourSegmentsFromIndex', () => {
  const HOUR = 3_600_000
  const currentHour = Date.UTC(2026, 7, 15, 10)
  const pastHour = Date.UTC(2026, 7, 14, 10)

  function row(startMs: number, profile = 'low'): SegmentRow {
    return {
      deviceId: 1,
      profile,
      startMs,
      durMs: 8000,
      bytes: 100,
      path: `1/${profile}/${startMs}-8000-100.m4s`,
      locationId: 'loc',
    }
  }

  it('returns a hydrated hour including a known-empty one', () => {
    const index = new RecordingIndex()
    index.markHydrated(1, pastHour, pastHour + HOUR)
    expect(hourSegmentsFromIndex(index, 1, 'low', pastHour)).toEqual([])
    index.addSegment(row(pastHour + 1_000))
    expect(hourSegmentsFromIndex(index, 1, 'low', pastHour)).toEqual([
      { startMs: pastHour + 1_000, durMs: 8000, bytes: 100 },
    ])
  })

  it('does not treat live write-through rows as a walked hour', () => {
    // A recorder respawned at 11:04 only has post-restart finalizes in RAM.
    // Claiming that set as the whole hour would hide 11:00–11:04 on the
    // timeline until the deferred walk (deploy gap, 2026-08-22).
    const index = new RecordingIndex()
    index.addSegment(row(currentHour + 2_000))
    expect(index.hydrationOf(1, currentHour, currentHour + HOUR)).toBe('unknown')
    expect(hourSegmentsFromIndex(index, 1, 'low', currentHour)).toBeNull()
  })

  it('once the hour is walked, later finalizes appear without another walk', () => {
    const index = new RecordingIndex()
    index.markHydrated(1, currentHour, currentHour + HOUR)
    index.addSegment(row(currentHour + 2_000))
    expect(hourSegmentsFromIndex(index, 1, 'low', currentHour)).toEqual([
      { startMs: currentHour + 2_000, durMs: 8000, bytes: 100 },
    ])
  })

  it('returns null for a past hour that was never walked — even if a live row leaked in', () => {
    const index = new RecordingIndex()
    index.addSegment(row(pastHour + 1_000))
    expect(hourSegmentsFromIndex(index, 1, 'low', pastHour)).toBeNull()
  })
})
