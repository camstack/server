import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { RecordingIndex, type RecordingIndexBudget } from '../recording-index.js'
import { segmentRelPath } from '../segment-path.js'
import type { SegmentRow } from '../types.js'

/**
 * The RESIDENCY property, pinned.
 *
 * `RecordingIndex` used to be a structure that only ever grew: every row a
 * reader caused to be walked stayed for the life of the process, and the walked
 * hour with it. Measured locally on the production shape (26 cameras x 2
 * profiles x 1.6 M `.m4s` files — the figure in `segment-hour-ledger.ts`'s
 * header) a fully resident index is **1039 MB of heap, 681 B per row**, against
 * a recorder whose whole budget is 3072 MB of old space. Nothing in the code
 * said how much of that the index was allowed to have.
 *
 * So the deliverable here is not a refactor — it is this file. It drives a
 * synthetic archive far larger than the declared bound through the index and
 * asserts what must remain true:
 *
 *  1. the index stops at the bound, whatever it is fed;
 *  2. an hour it dropped reads back as `unknown`, never as an empty hour —
 *     a dropped row costs a `readdir`, never a lost segment;
 *  3. the live tail is never the thing that gets dropped;
 *  4. an hour somebody asked about outlives one nobody asked about;
 *  5. every drop is announced, per camera, with `tags: { deviceId }`.
 */
const HOUR_MS = 3_600_000
const SEG_MS = 10_000
/** Segments an hour holds at 10 s each — the production segment length. */
const PER_HOUR = HOUR_MS / SEG_MS

const hourPaths = (deviceId: number, profile: string, hourStartMs: number): readonly string[] =>
  Array.from({ length: PER_HOUR }, (_, i) =>
    segmentRelPath(deviceId, profile, hourStartMs + i * SEG_MS, SEG_MS, 1_200_000 + i),
  )

const budget = (over: Partial<RecordingIndexBudget> = {}): RecordingIndexBudget => ({
  residentRowBudget: 5_000,
  residentHourBudget: 500,
  evictToFraction: 0.8,
  pinnedTailHours: 2,
  ...over,
})

interface LoggedLine {
  readonly message: string
  readonly deviceId: number | undefined
}

interface LoggerSpy {
  readonly logger: IScopedLogger
  readonly lines: LoggedLine[]
}

interface LogContext {
  readonly tags?: Record<string, unknown>
}

const loggerSpy = (): LoggerSpy => {
  const lines: LoggedLine[] = []
  const record = (message: string, ctx?: LogContext): void => {
    const tag = ctx?.tags?.['deviceId']
    lines.push({ message, deviceId: typeof tag === 'number' ? tag : undefined })
  }
  const logger: IScopedLogger = {
    debug: vi.fn(record),
    info: vi.fn(record),
    warn: vi.fn(record),
    error: vi.fn(record),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  vi.mocked(logger.child).mockReturnValue(logger)
  vi.mocked(logger.withTags).mockReturnValue(logger)
  return { logger, lines }
}

/** A clock frozen at an hour boundary, so "the live tail" is unambiguous. */
const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)

describe('RecordingIndex residency (the bound, and what a dropped row costs)', () => {
  it('stays at the bound under an archive far larger than it', () => {
    const { logger } = loggerSpy()
    const idx = new RecordingIndex()
    idx.armResidency({ logger, now: () => NOW, budget: budget() })

    // 120 hours x 360 segments = 43 200 rows offered against a 5 000 bound.
    for (let h = 120; h >= 1; h--) {
      const hour = NOW - h * HOUR_MS
      idx.hydrateHour(101, 'recordings', hour, hourPaths(101, 'high', hour))
    }

    const census = idx.residency()
    expect(census.residentRows).toBeLessThanOrEqual(5_000)
    expect(census.evictedRows).toBeGreaterThan(30_000)
    // And it is still a usable index: the newest hour offered is still there.
    expect(idx.accounting(101).count).toBe(census.residentRows)
    expect(census.residentRows).toBeGreaterThan(0)
  })

  it('reports a dropped hour as unknown — never as an hour that held nothing', () => {
    const { logger } = loggerSpy()
    const idx = new RecordingIndex()
    idx.armResidency({ logger, now: () => NOW, budget: budget() })

    const dropped = NOW - 100 * HOUR_MS
    idx.hydrateHour(101, 'recordings', dropped, hourPaths(101, 'high', dropped))
    expect(idx.hydrationOf(101, dropped, dropped + HOUR_MS)).toBe('hydrated')

    for (let h = 99; h >= 1; h--) {
      const hour = NOW - h * HOUR_MS
      idx.hydrateHour(101, 'recordings', hour, hourPaths(101, 'high', hour))
    }

    expect(idx.segmentsStartingIn(101, 'high', dropped, dropped + HOUR_MS)).toEqual([])
    // THE property: the reader is told it does not know, so it walks the
    // directory again. An 'hydrated' verdict here would be a silent gap.
    expect(idx.hydrationOf(101, dropped, dropped + HOUR_MS)).toBe('unknown')
  })

  it('a dropped hour costs one re-hydrate and gives back the same rows', () => {
    const { logger } = loggerSpy()
    const idx = new RecordingIndex()
    idx.armResidency({ logger, now: () => NOW, budget: budget() })

    const dropped = NOW - 100 * HOUR_MS
    const paths = hourPaths(101, 'high', dropped)
    idx.hydrateHour(101, 'recordings', dropped, paths)
    const before = idx
      .segmentsStartingIn(101, 'high', dropped, dropped + HOUR_MS)
      .map((s) => s.path)

    for (let h = 99; h >= 1; h--) {
      const hour = NOW - h * HOUR_MS
      idx.hydrateHour(101, 'recordings', hour, hourPaths(101, 'high', hour))
    }
    expect(idx.hydrationOf(101, dropped, dropped + HOUR_MS)).toBe('unknown')

    idx.hydrateHour(101, 'recordings', dropped, paths)
    const after = idx.segmentsStartingIn(101, 'high', dropped, dropped + HOUR_MS).map((s) => s.path)
    expect(after).toEqual(before)
  })

  it('never drops the live tail, however cold it looks', () => {
    const { logger } = loggerSpy()
    const idx = new RecordingIndex()
    idx.armResidency({ logger, now: () => NOW, budget: budget() })

    const live = NOW
    // The live hour arrives FIRST, so pure LRU would evict it first.
    for (const path of hourPaths(101, 'high', live)) idx.addSegment(rowOf(path))
    const liveRows = idx.segmentsStartingIn(101, 'high', live, live + HOUR_MS).length
    expect(liveRows).toBe(PER_HOUR)

    for (let h = 120; h >= 1; h--) {
      const hour = NOW - h * HOUR_MS
      idx.hydrateHour(101, 'recordings', hour, hourPaths(101, 'high', hour))
    }

    expect(idx.segmentsStartingIn(101, 'high', live, live + HOUR_MS).length).toBe(PER_HOUR)
    expect(idx.residency().residentRows).toBeLessThanOrEqual(5_000)
  })

  it('keeps the hour somebody asked about and drops the one nobody did', () => {
    const { logger } = loggerSpy()
    const idx = new RecordingIndex()
    // Wide enough that the two hours below, plus the filler, fit — the only
    // thing that decides between them must be the ask.
    idx.armResidency({ logger, now: () => NOW, budget: budget({ residentRowBudget: 40_000 }) })

    const asked = NOW - 200 * HOUR_MS
    const ignored = NOW - 199 * HOUR_MS
    idx.hydrateHour(101, 'recordings', asked, hourPaths(101, 'high', asked))
    idx.hydrateHour(101, 'recordings', ignored, hourPaths(101, 'high', ignored))
    for (let h = 100; h >= 1; h--) {
      const hour = NOW - h * HOUR_MS
      idx.hydrateHour(101, 'recordings', hour, hourPaths(101, 'high', hour))
    }
    expect(idx.residency().evictedRows).toBe(0)

    // A scrub across `asked` — the only difference between the two hours.
    idx.segmentsOverlapping(101, 'high', asked, asked + HOUR_MS)

    // Now overflow, so something has to go.
    for (let h = 120; h > 100; h--) {
      const hour = NOW - h * HOUR_MS
      idx.hydrateHour(101, 'recordings', hour, hourPaths(101, 'high', hour))
    }

    expect(idx.residency().evictedRows).toBeGreaterThan(0)
    expect(idx.hydrationOf(101, ignored, ignored + HOUR_MS)).toBe('unknown')
    expect(idx.hydrationOf(101, asked, asked + HOUR_MS)).toBe('hydrated')
  })

  it('announces every drop per camera, with the deviceId tag', () => {
    const { logger, lines } = loggerSpy()
    const idx = new RecordingIndex()
    idx.armResidency({ logger, now: () => NOW, budget: budget() })

    for (let h = 120; h >= 1; h--) {
      const hour = NOW - h * HOUR_MS
      idx.hydrateHour(102, 'recordings', hour, hourPaths(102, 'high', hour))
    }

    const drops = lines.filter((l) => l.message.includes('dropped resident hours'))
    expect(drops.length).toBeGreaterThan(0)
    // A structure that silently forgets is how this class of bug hides, and
    // "why is 102 worse than 101" is the only form the question is asked in.
    for (const line of drops) expect(line.deviceId).toBe(102)
  })

  it('bounds the walked-hour map even when the hours held nothing', () => {
    const { logger } = loggerSpy()
    const idx = new RecordingIndex()
    idx.armResidency({ logger, now: () => NOW, budget: budget({ residentHourBudget: 50 }) })

    for (let h = 1_000; h >= 1; h--) idx.hydrateHour(101, 'recordings', NOW - h * HOUR_MS, [])

    expect(idx.residency().residentHours).toBeLessThanOrEqual(50)
  })

  it('an index nobody armed never drops anything — the pre-init window is honest', () => {
    const idx = new RecordingIndex()
    for (let h = 120; h >= 1; h--) {
      const hour = NOW - h * HOUR_MS
      idx.hydrateHour(101, 'recordings', hour, hourPaths(101, 'high', hour))
    }
    const census = idx.residency()
    expect(census.evictedRows).toBe(0)
    expect(census.residentRows).toBe(120 * PER_HOUR)
    expect(census.budget).toBeNull()
  })
})

/** A finalize-shaped row for a path the writer just produced. */
function rowOf(path: string): SegmentRow {
  const parts = path.split('/')
  const name = parts[parts.length - 1] ?? ''
  const [startMs, durMs, bytes] = name.replace('.m4s', '').split('-').map(Number)
  return {
    deviceId: Number(parts[0]),
    profile: parts[1] ?? '',
    startMs: startMs ?? 0,
    durMs: durMs ?? 0,
    bytes: bytes ?? 0,
    path,
    locationId: 'recordings',
  }
}
