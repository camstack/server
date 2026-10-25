import { describe, it, expect } from 'vitest'
import {
  pctForMs,
  densityRowsToBuckets,
  seekTargetForSpans,
  dayWindow,
  zoomWindowAnchoredRight,
  panWindow,
  bucketMsForSpan,
  axisTicks,
  ZOOM_LEVELS,
} from '../recording-timeline-model'
import type { EventDensityRow, DayWindow } from '../recording-timeline-model'

const BUCKET = 15 * 60 * 1000 // 15 min

describe('pctForMs', () => {
  it('maps the window start to 0 and end to 100', () => {
    expect(pctForMs(1000, 1000, 5000)).toBe(0)
    expect(pctForMs(5000, 1000, 5000)).toBe(100)
  })

  it('maps a midpoint to 50', () => {
    expect(pctForMs(3000, 1000, 5000)).toBe(50)
  })

  it('clamps out-of-range values to [0, 100]', () => {
    expect(pctForMs(0, 1000, 5000)).toBe(0)
    expect(pctForMs(9999, 1000, 5000)).toBe(100)
  })

  it('returns 0 for a zero-width window', () => {
    expect(pctForMs(1000, 1000, 1000)).toBe(0)
  })
})

describe('densityRowsToBuckets', () => {
  const WINDOW_FROM = 0

  it('maps rows to buckets with correct index / startMs / endMs / counts / total', () => {
    const rows: readonly EventDensityRow[] = [
      { bucketStart: 0, motion: 3, object: 1, audio: 0 },
      { bucketStart: BUCKET, motion: 0, object: 0, audio: 5 },
    ]
    const buckets = densityRowsToBuckets(rows, WINDOW_FROM, BUCKET)
    expect(buckets).toHaveLength(2)
    expect(buckets[0]).toMatchObject({
      index: 0,
      startMs: 0,
      endMs: BUCKET,
      counts: { motion: 3, object: 1, audio: 0 },
      total: 4,
    })
    expect(buckets[1]).toMatchObject({
      index: 1,
      startMs: BUCKET,
      endMs: BUCKET * 2,
      counts: { motion: 0, object: 0, audio: 5 },
      total: 5,
    })
  })

  it('dominant: highest count wins; object beats motion on ties', () => {
    const rows: readonly EventDensityRow[] = [
      { bucketStart: 0, motion: 2, object: 2, audio: 1 }, // motion=object tie → object wins
    ]
    const buckets = densityRowsToBuckets(rows, WINDOW_FROM, BUCKET)
    expect(buckets[0]?.dominant).toBe('object')
  })

  it('dominant: audio wins when it is the highest count', () => {
    const rows: readonly EventDensityRow[] = [{ bucketStart: 0, motion: 1, object: 2, audio: 10 }]
    const buckets = densityRowsToBuckets(rows, WINDOW_FROM, BUCKET)
    expect(buckets[0]?.dominant).toBe('audio')
  })

  it('dominant: motion wins over audio when tied and object is 0', () => {
    const rows: readonly EventDensityRow[] = [
      { bucketStart: 0, motion: 3, object: 0, audio: 3 }, // motion=audio tie → motion wins (KIND_PRECEDENCE order)
    ]
    const buckets = densityRowsToBuckets(rows, WINDOW_FROM, BUCKET)
    expect(buckets[0]?.dominant).toBe('motion')
  })

  it('returns [] for empty rows', () => {
    expect(densityRowsToBuckets([], WINDOW_FROM, BUCKET)).toEqual([])
  })

  it('skips a row whose counts are all zero', () => {
    const rows: readonly EventDensityRow[] = [
      { bucketStart: 0, motion: 0, object: 0, audio: 0 },
      { bucketStart: BUCKET, motion: 1, object: 0, audio: 0 },
    ]
    const buckets = densityRowsToBuckets(rows, WINDOW_FROM, BUCKET)
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.index).toBe(1)
  })

  it('returns buckets sorted ascending by index', () => {
    const rows: readonly EventDensityRow[] = [
      { bucketStart: BUCKET * 2, motion: 1, object: 0, audio: 0 },
      { bucketStart: 0, motion: 0, object: 1, audio: 0 },
    ]
    const buckets = densityRowsToBuckets(rows, WINDOW_FROM, BUCKET)
    expect(buckets[0]?.index).toBe(0)
    expect(buckets[1]?.index).toBe(2)
  })
})

describe('seekTargetForSpans', () => {
  const spans = [
    { startMs: 1_000, endMs: 5_000 },
    { startMs: 10_000, endMs: 20_000 },
  ]

  it('plays from the click to the end of the containing span', () => {
    expect(seekTargetForSpans(3_000, spans)).toEqual({ fromMs: 3_000, toMs: 5_000 })
  })

  it('snaps a click inside a gap to the whole nearest span', () => {
    // 6_000 is closer to span[0] (gap 1_000) than span[1] (gap 4_000)
    expect(seekTargetForSpans(6_000, spans)).toEqual({ fromMs: 1_000, toMs: 5_000 })
  })

  it('snaps a click before the first span to that span', () => {
    expect(seekTargetForSpans(0, spans)).toEqual({ fromMs: 1_000, toMs: 5_000 })
  })

  it('snaps a click after the last span to that span', () => {
    expect(seekTargetForSpans(99_999, spans)).toEqual({ fromMs: 10_000, toMs: 20_000 })
  })

  it('returns null when there are no spans', () => {
    expect(seekTargetForSpans(3_000, [])).toBeNull()
  })

  it('treats a click exactly on a span end as inside that span', () => {
    expect(seekTargetForSpans(5_000, spans)).toEqual({ fromMs: 5_000, toMs: 5_000 })
  })
})

// ---------------------------------------------------------------------------
// D2 — dayWindow
// ---------------------------------------------------------------------------
describe('dayWindow', () => {
  it('returns exactly 24h span for a past day', () => {
    // Use a fixed past date: 2024-01-15
    const date = new Date(2024, 0, 15) // Jan 15 2024
    const nowMs = new Date(2024, 0, 16, 12, 0, 0).getTime() // noon the next day
    const w = dayWindow(date, nowMs)
    expect(w.toMs - w.fromMs).toBe(24 * 3600_000)
    // fromMs is local midnight of Jan 15
    const expectedFrom = new Date(2024, 0, 15, 0, 0, 0, 0).getTime()
    expect(w.fromMs).toBe(expectedFrom)
  })

  it('fromMs is local midnight of the given date', () => {
    const date = new Date(2024, 5, 10) // June 10 2024
    const nowMs = new Date(2024, 5, 11, 8, 0, 0).getTime()
    const w = dayWindow(date, nowMs)
    const expectedFrom = new Date(2024, 5, 10, 0, 0, 0, 0).getTime()
    expect(w.fromMs).toBe(expectedFrom)
  })

  it('for today, toMs <= nextMidnight and toMs approximately equals nowMs', () => {
    const now = new Date()
    const nowMs = now.getTime()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const w = dayWindow(today, nowMs)
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
    expect(w.toMs).toBeLessThanOrEqual(nextMidnight)
    // toMs should be nowMs (not next midnight) since today is the current day
    expect(w.toMs).toBe(nowMs)
  })
})

// ---------------------------------------------------------------------------
// D3 — zoom / pan / adaptive bucketing
// ---------------------------------------------------------------------------
describe('ZOOM_LEVELS', () => {
  it('are sorted descending (widest first)', () => {
    for (let i = 0; i < ZOOM_LEVELS.length - 1; i++) {
      const a = ZOOM_LEVELS[i]
      const b = ZOOM_LEVELS[i + 1]
      if (a !== undefined && b !== undefined) {
        expect(a).toBeGreaterThan(b)
      }
    }
  })
})

describe('zoomWindowAnchoredRight', () => {
  // Today: [midnight, now]; "now" is 16h into the day.
  const nowMs = 16 * 3600_000
  const dayBounds: DayWindow = { fromMs: 0, toMs: nowMs }

  it('keeps "now" (the right edge) in view when zooming in', () => {
    const levelMs = 6 * 3600_000
    const w = zoomWindowAnchoredRight(dayBounds, levelMs, nowMs)
    expect(w.toMs).toBe(nowMs) // right edge stays at now
    expect(w.fromMs).toBe(nowMs - levelMs)
    expect(w.toMs - w.fromMs).toBe(levelMs)
    // The window contains now — the reported bug (midday-centred range) is fixed.
    expect(nowMs).toBeGreaterThanOrEqual(w.fromMs)
    expect(nowMs).toBeLessThanOrEqual(w.toMs)
  })

  it('anchors on the current right edge after the user has panned back', () => {
    const rightEdge = 10 * 3600_000 // panned back to 10:00
    const levelMs = 3600_000
    const w = zoomWindowAnchoredRight(dayBounds, levelMs, rightEdge)
    expect(w.toMs).toBe(rightEdge)
    expect(w.fromMs).toBe(rightEdge - levelMs)
  })

  it('never starts before the day begins (right edge too early for the width)', () => {
    const levelMs = 6 * 3600_000
    const w = zoomWindowAnchoredRight(dayBounds, levelMs, 2 * 3600_000)
    expect(w.fromMs).toBe(0)
    expect(w.toMs).toBe(levelMs)
  })

  it('returns dayBounds when levelMs >= day span (little elapsed time)', () => {
    const early: DayWindow = { fromMs: 0, toMs: 1 * 3600_000 } // 1h elapsed
    expect(zoomWindowAnchoredRight(early, 6 * 3600_000, 1 * 3600_000)).toEqual(early)
  })
})

describe('panWindow', () => {
  const dayBounds: DayWindow = { fromMs: 0, toMs: 24 * 3600_000 }

  it('shifts the window by deltaMs preserving width', () => {
    const win: DayWindow = { fromMs: 6 * 3600_000, toMs: 12 * 3600_000 }
    const shifted = panWindow(win, dayBounds, 3600_000) // +1h
    expect(shifted.fromMs).toBe(7 * 3600_000)
    expect(shifted.toMs).toBe(13 * 3600_000)
    expect(shifted.toMs - shifted.fromMs).toBe(6 * 3600_000)
  })

  it('clamps at day start', () => {
    const win: DayWindow = { fromMs: 1 * 3600_000, toMs: 7 * 3600_000 }
    const shifted = panWindow(win, dayBounds, -3 * 3600_000) // pan left past start
    expect(shifted.fromMs).toBe(0)
    expect(shifted.toMs - shifted.fromMs).toBe(6 * 3600_000)
  })

  it('clamps at day end', () => {
    const win: DayWindow = { fromMs: 18 * 3600_000, toMs: 22 * 3600_000 }
    const shifted = panWindow(win, dayBounds, 5 * 3600_000) // pan right past end
    expect(shifted.toMs).toBe(24 * 3600_000)
    expect(shifted.toMs - shifted.fromMs).toBe(4 * 3600_000)
  })
})

describe('bucketMsForSpan', () => {
  it('returns a larger bucket for a wider span', () => {
    expect(bucketMsForSpan(24 * 3600_000)).toBeGreaterThan(bucketMsForSpan(3600_000))
  })

  it('returns a positive value for all ZOOM_LEVELS', () => {
    for (const level of ZOOM_LEVELS) {
      expect(bucketMsForSpan(level)).toBeGreaterThan(0)
    }
  })

  it('is deterministic (same input → same output)', () => {
    const span = 6 * 3600_000
    expect(bucketMsForSpan(span)).toBe(bucketMsForSpan(span))
  })
})

// ---------------------------------------------------------------------------
// D4 — axisTicks
// ---------------------------------------------------------------------------
describe('axisTicks', () => {
  const fromMs = 0
  const toMs = 24 * 3600_000

  it('returns exactly count ticks', () => {
    const ticks = axisTicks(fromMs, toMs, 5)
    expect(ticks).toHaveLength(5)
  })

  it('first tick pct is 0 and last is 100', () => {
    const ticks = axisTicks(fromMs, toMs, 5)
    expect(ticks[0]?.pct).toBe(0)
    expect(ticks[4]?.pct).toBe(100)
  })

  it('labels match HH:MM / h:MM AM/PM format', () => {
    const ticks = axisTicks(fromMs, toMs, 5)
    for (const tick of ticks) {
      expect(tick.label).toMatch(/\d{1,2}:\d{2}/)
    }
  })

  it('works with count=1 (single tick at pct=0)', () => {
    const ticks = axisTicks(fromMs, toMs, 1)
    expect(ticks).toHaveLength(1)
    expect(ticks[0]?.pct).toBe(0)
  })
})
