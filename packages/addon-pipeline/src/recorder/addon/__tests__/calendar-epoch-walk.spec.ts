/**
 * D674 — the calendar never walks, and never caches, the hours since 1970.
 *
 * 2026-09-28: pipeline-analytics asked `getAvailability({ fromMs: 0, toMs: now })`
 * per camera every ten minutes. `rangesIn` walked 497,408 hours per call and
 * cached each one — empty included — under a composite string key, in two
 * unbounded Maps: 11,937,796 keys = 24 (camera, profile) pairs × 497,408 hours,
 * ~2.2 GB, 71 % of V8's 2^24 Map limit, and an OOM at 10:21.
 *
 * What is pinned here is what the heap is made of: how many hours a from-0 ask
 * SCANS and how many it leaves in the census. The count of scans is the cost;
 * the census is the retained heap.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { CalendarIndex } from '../calendar-index.js'
import {
  ArchiveFloorReader,
  CALENDAR_MAX_WALK_HOURS,
  CalendarWindowRefusedError,
  type ArchiveFloor,
} from '../calendar-window.js'
import {
  CALENDAR_HOUR_APPROX_BYTES,
  CALENDAR_READ_AT_APPROX_BYTES,
  CALENDAR_SEGMENT_APPROX_BYTES,
} from '../calendar-hour-cache.js'
import type { HourSegment } from '../calendar-scan.js'

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as IScopedLogger

const HOUR = 3_600_000
const DAY = 86_400_000
/** Mid-hour, so "now" is inside a current hour like it is in production. */
const NOW = Date.UTC(2026, 8, 28, 10, 21, 0)
const CURRENT_HOUR = Math.floor(NOW / HOUR) * HOUR
/** Three days of archive, like the live hub held (D418: 3.3 days). */
const ARCHIVE_HOURS = 72
const OLDEST_HOUR = CURRENT_HOUR - ARCHIVE_HOURS * HOUR

interface Harness {
  readonly cal: CalendarIndex
  readonly scans: number[]
}

/** Footage in every EVEN hour of the archive span; odd hours are real gaps. */
function footageOf(hour: number): HourSegment[] {
  if (hour < OLDEST_HOUR || hour > CURRENT_HOUR) return []
  if (((hour - OLDEST_HOUR) / HOUR) % 2 === 1) return []
  return [{ startMs: hour + 1_000, durMs: 8_000, bytes: 100 }]
}

function harness(
  floor: (deviceId: number) => ArchiveFloor,
  extra: { readonly now?: () => number; readonly hourBudget?: number } = {},
): Harness {
  const scans: number[] = []
  const cal = new CalendarIndex({
    roots: () => ['/rec'],
    logger: noopLogger,
    now: extra.now ?? (() => NOW),
    archiveFloor: floor,
    ...(extra.hourBudget !== undefined
      ? {
          hourBudget: {
            hourBudget: extra.hourBudget,
            segmentBudget: 1_000_000,
            evictToFraction: 0.8,
          },
        }
      : {}),
    scanSegments: async (_root, _dev, _profile, hour) => {
      scans.push(hour)
      return footageOf(hour)
    },
  })
  return { cal, scans }
}

const knownFloor = (): ArchiveFloor => ({ known: true, oldestHourMs: OLDEST_HOUR })
const unknownFloor = (): ArchiveFloor => ({ known: false })

describe('D674 — a from-0 availability ask is clamped to the archive floor', () => {
  it('scans only the hours from the oldest ledger hour to now, not 497,408', async () => {
    const h = harness(knownFloor)
    const ranges = await h.cal.rangesIn(1, 'low', 0, NOW)
    // 72 archive hours + the current one. Before D674: every hour since 1970.
    expect(h.scans).toHaveLength(ARCHIVE_HOURS + 1)
    expect(Math.min(...h.scans)).toBe(OLDEST_HOUR)
    expect(ranges[0]?.startMs).toBe(OLDEST_HOUR + 1_000)
  })

  it('never populates an epoch hour — the census stays O(real hours)', async () => {
    const h = harness(knownFloor)
    await h.cal.rangesIn(1, 'low', 0, NOW)
    const census = h.cal.memoryCensus()
    expect(census.hourKeys + census.emptyHours).toBeLessThanOrEqual(ARCHIVE_HOURS + 1)
  })

  it('a from-0 ask over 24 (camera, profile) pairs keeps hourKeys bounded', async () => {
    // The live shape: 24 pairs, each asked from the epoch. Before D674 this
    // left 24 × 497,408 = 11,937,796 keys; bounded by the archive span now.
    const h = harness(knownFloor)
    for (let device = 1; device <= 12; device++) {
      for (const profile of ['low', 'high']) await h.cal.rangesIn(device, profile, 0, NOW)
    }
    const census = h.cal.memoryCensus()
    expect(census.hourKeys + census.emptyHours).toBeLessThanOrEqual(24 * (ARCHIVE_HOURS + 1))
    expect(census.hourKeys).toBe(24 * (ARCHIVE_HOURS / 2 + 1))
  })

  it('a floor at the live edge still walks the current and previous hour', async () => {
    // The ledger is write-behind: a camera's first segments can be on disk a
    // moment before their hour row. Its current and previous hour still count.
    const h = harness(() => ({ known: true, oldestHourMs: CURRENT_HOUR }))
    await h.cal.rangesIn(1, 'low', 0, NOW)
    expect(h.scans).toEqual([CURRENT_HOUR - HOUR, CURRENT_HOUR])
  })

  it('does not walk hours after the current one', async () => {
    const h = harness(knownFloor)
    await h.cal.rangesIn(1, 'low', CURRENT_HOUR - HOUR, NOW + 30 * DAY)
    expect(h.scans).toEqual([CURRENT_HOUR - HOUR, CURRENT_HOUR])
  })
})

describe('D674 — a window still too wide after the clamp is REFUSED, never truncated', () => {
  it('refuses a from-0 ask when no floor is known, and scans nothing', async () => {
    const h = harness(unknownFloor)
    await expect(h.cal.rangesIn(1, 'low', 0, NOW)).rejects.toBeInstanceOf(
      CalendarWindowRefusedError,
    )
    expect(h.scans).toHaveLength(0)
    expect(h.cal.memoryCensus().hourKeys + h.cal.memoryCensus().emptyHours).toBe(0)
  })

  it('refuses an over-cap window even with a floor, and scans nothing', async () => {
    const floor = CURRENT_HOUR - (CALENDAR_MAX_WALK_HOURS + 10) * HOUR
    const h = harness(() => ({ known: true, oldestHourMs: floor }))
    const refusal = h.cal.rangesIn(1, 'low', 0, NOW)
    await expect(refusal).rejects.toMatchObject({
      name: 'CalendarWindowRefusedError',
      maxHours: CALENDAR_MAX_WALK_HOURS,
      floorKnown: true,
    })
    expect(h.scans).toHaveLength(0)
  })

  it('answers a normal window with no floor known — the cap, not the floor, bounds it', async () => {
    const h = harness(unknownFloor)
    await h.cal.rangesIn(1, 'low', CURRENT_HOUR - 24 * HOUR, NOW)
    expect(h.scans).toHaveLength(25)
  })

  it('the day rung is clamped the same way', async () => {
    const days: string[] = []
    const cal = new CalendarIndex({
      roots: () => ['/rec'],
      logger: noopLogger,
      now: () => NOW,
      archiveFloor: knownFloor,
      pickProfile: async () => 'low',
      scanHours: async (_r, _d, y, m, d) => {
        days.push(`${y}-${m}-${d}`)
        return []
      },
    })
    await cal.localDays(1, 0, NOW, 0)
    // Three days of archive plus the partial ones at either end — not 20,634.
    expect(days.length).toBeLessThanOrEqual(5)
    await expect(
      new CalendarIndex({
        roots: () => ['/rec'],
        logger: noopLogger,
        now: () => NOW,
        archiveFloor: unknownFloor,
        scanHours: async () => [],
      }).localDays(1, 0, NOW, 0),
    ).rejects.toBeInstanceOf(CalendarWindowRefusedError)
  })
})

describe('D674 — the exact rung stores no absence as a segment key, and is bounded', () => {
  it('re-reads a closed hour even after ANOTHER hour of the pair was read in between (review M4)', async () => {
    const hourH = CURRENT_HOUR - HOUR
    let t = hourH + 30 * 60_000
    const h = harness(knownFloor, { now: () => t })
    await h.cal.segmentsOf(1, 'low', hourH)
    // H+1 opens; a short live-edge window touches only the new hour.
    t = CURRENT_HOUR + 60_000
    await h.cal.rangesIn(1, 'low', t - 60_000, t)
    await h.cal.segmentsOf(1, 'low', hourH)
    expect(h.scans.filter((x) => x === hourH)).toHaveLength(2)
  })

  it('an empty hour leaves no hour key — only a bounded negative-cache marker', async () => {
    const h = harness(knownFloor)
    await h.cal.rangesIn(1, 'low', OLDEST_HOUR, OLDEST_HOUR + 4 * HOUR)
    const census = h.cal.memoryCensus()
    // Hours 0 and 2 hold footage; 1 and 3 are gaps.
    expect(census.hourKeys).toBe(2)
    expect(census.emptyHours).toBe(2)
    expect(census.hourSegments).toBe(2)
    // …and the gap is still not re-read on the next ask.
    await h.cal.rangesIn(1, 'low', OLDEST_HOUR, OLDEST_HOUR + 4 * HOUR)
    expect(h.scans).toHaveLength(4)
  })

  it('holds the bound under a walk of twice the budget', async () => {
    const budget = 100
    const h = harness(unknownFloor, { hourBudget: budget })
    await h.cal.rangesIn(1, 'low', CURRENT_HOUR - 2 * budget * HOUR, CURRENT_HOUR)
    const census = h.cal.memoryCensus()
    expect(census.hourKeys + census.emptyHours).toBeLessThanOrEqual(budget)
    expect(census.evictedHours).toBeGreaterThan(0)
  })

  it('invalidate clears the current-hour read stamp with the hour', async () => {
    const h = harness(knownFloor)
    await h.cal.segmentsOf(1, 'low', CURRENT_HOUR)
    expect(h.cal.memoryCensus().segsReadAtKeys).toBe(1)
    h.cal.invalidate(1, CURRENT_HOUR)
    expect(h.cal.memoryCensus().segsReadAtKeys).toBe(0)
  })

  it('invalidateAll clears the read stamps too', async () => {
    const h = harness(knownFloor)
    await h.cal.segmentsOf(1, 'low', CURRENT_HOUR)
    await h.cal.segmentsOf(2, 'low', CURRENT_HOUR)
    h.cal.invalidateAll()
    expect(h.cal.memoryCensus().segsReadAtKeys).toBe(0)
  })

  it('stamps only the CURRENT hour — a past hour carries no read stamp', async () => {
    const h = harness(knownFloor)
    await h.cal.rangesIn(1, 'low', OLDEST_HOUR, NOW)
    expect(h.cal.memoryCensus().segsReadAtKeys).toBe(1)
  })

  it('re-reads an hour once after it closes, so its last minutes are not lost', async () => {
    let t = CURRENT_HOUR + 40 * 60_000
    const h = harness(knownFloor, { now: () => t })
    await h.cal.segmentsOf(1, 'low', CURRENT_HOUR)
    t = CURRENT_HOUR + HOUR + 5 * 60_000
    await h.cal.segmentsOf(1, 'low', CURRENT_HOUR)
    await h.cal.segmentsOf(1, 'low', CURRENT_HOUR)
    expect(h.scans).toEqual([CURRENT_HOUR, CURRENT_HOUR])
  })

  it('reports an estimated byte total for the calendar', async () => {
    const h = harness(knownFloor)
    await h.cal.rangesIn(1, 'low', OLDEST_HOUR, NOW)
    const c = h.cal.memoryCensus()
    expect(c.approxBytes).toBe(
      (c.hourKeys + c.emptyHours) * CALENDAR_HOUR_APPROX_BYTES +
        c.hourSegments * CALENDAR_SEGMENT_APPROX_BYTES +
        c.segsReadAtKeys * CALENDAR_READ_AT_APPROX_BYTES,
    )
    expect(c.approxBytes).toBeGreaterThan(0)
  })
})

describe('D674 — ArchiveFloorReader', () => {
  it('knows no floor until the ledger is COMPLETE, retries it, and folds once per TTL', () => {
    let complete = false
    let folds = 0
    let retries = 0
    let t = 0
    const reader = new ArchiveFloorReader(
      () => ({
        isComplete: () => complete,
        retryLoadIfUnanswered: () => {
          retries++
        },
        oldestHourByDevice: () => {
          folds++
          return new Map([[104, OLDEST_HOUR]])
        },
      }),
      () => t,
    )
    expect(reader.floorOf(104)).toEqual({ known: false })
    expect(retries).toBe(1)
    complete = true
    expect(reader.floorOf(104)).toEqual({ known: true, oldestHourMs: OLDEST_HOUR })
    expect(folds).toBe(1)
    t = 60_000
    reader.floorOf(104)
    expect(folds).toBe(2)
  })

  it('a camera ABSENT from a complete ledger is UNKNOWN, never a known "no" (review M3)', async () => {
    const reader = new ArchiveFloorReader(() => ({
      isComplete: () => true,
      retryLoadIfUnanswered: () => {},
      oldestHourByDevice: () => new Map([[104, OLDEST_HOUR]]),
    }))
    expect(reader.floorOf(101)).toEqual({ known: false })
    // …so its from-0 ask is refused rather than answered as an empty `read`,
    // and a day window is walked unclamped.
    const h = harness((d) => reader.floorOf(d))
    await expect(h.cal.rangesIn(101, 'low', 0, NOW)).rejects.toBeInstanceOf(
      CalendarWindowRefusedError,
    )
    await h.cal.rangesIn(101, 'low', OLDEST_HOUR - 24 * HOUR, OLDEST_HOUR)
    expect(h.scans).toHaveLength(24)
  })

  it('knows no floor when the node has no ledger', () => {
    expect(new ArchiveFloorReader(() => null).floorOf(104)).toEqual({ known: false })
  })
})
