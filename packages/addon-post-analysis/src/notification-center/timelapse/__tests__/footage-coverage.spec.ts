/**
 * footageCoverage — how much of the window the recording actually holds.
 *
 * The number exists so a short video is REPORTED short. A timelapse of a
 * six-hour night assembled from ninety minutes of footage looks exactly like a
 * timelapse of a quiet night, and the operator has no way to tell the two
 * apart from the video alone.
 */
import { describe, expect, it } from 'vitest'
import { footageCoverage } from '../footage-coverage.js'

const START = 1_700_000_000_000
const HOUR = 3600_000
const END = START + 4 * HOUR

describe('footageCoverage', () => {
  it('is 1 when one range spans the whole window', () => {
    const c = footageCoverage([{ startMs: START - HOUR, endMs: END + HOUR }], START, END)
    expect(c.fraction).toBe(1)
    expect(c.complete).toBe(true)
    expect(c.coveredMs).toBe(4 * HOUR)
  })

  it('is 0 when there is no footage at all', () => {
    const c = footageCoverage([], START, END)
    expect(c.fraction).toBe(0)
    expect(c.complete).toBe(false)
  })

  it('sums disjoint ranges and clamps them to the window', () => {
    const c = footageCoverage(
      [
        { startMs: START - HOUR, endMs: START + HOUR },
        { startMs: START + 2 * HOUR, endMs: START + 3 * HOUR },
      ],
      START,
      END,
    )
    expect(c.fraction).toBe(0.5)
    expect(c.complete).toBe(false)
  })

  it('never double-counts overlapping ranges (two profiles of the same hour)', () => {
    // `recording.getAvailability` returns one row PER PROFILE. Adding them up
    // naively reports 200% coverage on a camera with two assigned profiles.
    const c = footageCoverage(
      [
        { startMs: START, endMs: START + 2 * HOUR },
        { startMs: START + HOUR, endMs: START + 3 * HOUR },
      ],
      START,
      END,
    )
    expect(c.fraction).toBe(0.75)
  })

  it('merges ranges that touch exactly', () => {
    const c = footageCoverage(
      [
        { startMs: START, endMs: START + 2 * HOUR },
        { startMs: START + 2 * HOUR, endMs: END },
      ],
      START,
      END,
    )
    expect(c.fraction).toBe(1)
  })

  it('treats a rounding-close fraction as complete rather than shouting about 99.97%', () => {
    // Segment boundaries mean the last segment rarely lands exactly on the
    // window edge. A body that says "97% of the window" for a full night is
    // noise the operator learns to ignore — which is how a genuinely short
    // video gets ignored too.
    const c = footageCoverage([{ startMs: START, endMs: END - 4000 }], START, END)
    expect(c.complete).toBe(true)
    expect(c.fraction).toBeLessThan(1)
  })

  it('is 0 for a degenerate window rather than dividing by zero', () => {
    expect(footageCoverage([{ startMs: START, endMs: END }], START, START).fraction).toBe(0)
  })

  it('reports a whole-percent figure for the notification body', () => {
    const c = footageCoverage([{ startMs: START, endMs: START + HOUR }], START, END)
    expect(c.percent).toBe(25)
  })
})
