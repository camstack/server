/**
 * planDenseRanges — turn the tracks a window actually contained into the
 * two-rate render plan.
 */
import { describe, expect, it } from 'vitest'
import { DENSE_MAX_RANGES, planDenseRanges } from '../dense-ranges.js'

const WINDOW_START = 1_700_000_000_000
const HOUR = 3600_000
const WINDOW_END = WINDOW_START + HOUR

function base(
  over: Partial<Parameters<typeof planDenseRanges>[0]> = {},
): Parameters<typeof planDenseRanges>[0] {
  return {
    tracks: [],
    windowStartMs: WINDOW_START,
    windowEndMs: WINDOW_END,
    padSec: 5,
    baseCadenceSec: 30,
    ...over,
  }
}

describe('planDenseRanges', () => {
  it('produces no ranges for a window nothing happened in', () => {
    const plan = planDenseRanges(base())
    expect(plan.ranges).toEqual([])
    expect(plan.capped).toBe(false)
    expect(plan.mergedCount).toBe(0)
  })

  it('expresses a track as seconds from the WINDOW start, padded either side', () => {
    const plan = planDenseRanges(
      base({
        tracks: [{ firstSeen: WINDOW_START + 600_000, lastSeen: WINDOW_START + 620_000 }],
      }),
    )
    expect(plan.ranges).toEqual([{ fromSec: 595, toSec: 625 }])
  })

  it('coalesces two tracks separated by less than 2x the base cadence', () => {
    // 30 s cadence ⇒ gaps under 60 s merge. Padded edges are 600+25=625 and
    // 660-5=655: a 30 s gap.
    const plan = planDenseRanges(
      base({
        tracks: [
          { firstSeen: WINDOW_START + 600_000, lastSeen: WINDOW_START + 620_000 },
          { firstSeen: WINDOW_START + 660_000, lastSeen: WINDOW_START + 680_000 },
        ],
      }),
    )
    expect(plan.ranges).toEqual([{ fromSec: 595, toSec: 685 }])
    expect(plan.mergedCount).toBe(1)
  })

  it('keeps two tracks separated by MORE than 2x the base cadence apart', () => {
    const plan = planDenseRanges(
      base({
        tracks: [
          { firstSeen: WINDOW_START + 600_000, lastSeen: WINDOW_START + 620_000 },
          { firstSeen: WINDOW_START + 800_000, lastSeen: WINDOW_START + 820_000 },
        ],
      }),
    )
    expect(plan.ranges).toEqual([
      { fromSec: 595, toSec: 625 },
      { fromSec: 795, toSec: 825 },
    ])
  })

  it('clamps padding and tracks to the window — never a negative or overshooting offset', () => {
    const plan = planDenseRanges(
      base({
        tracks: [
          // Starts BEFORE the window (a track that was already open) …
          { firstSeen: WINDOW_START - 60_000, lastSeen: WINDOW_START + 10_000 },
          // … and one that outlives it.
          { firstSeen: WINDOW_END - 10_000, lastSeen: WINDOW_END + 60_000 },
        ],
      }),
    )
    expect(plan.ranges[0]?.fromSec).toBe(0)
    expect(plan.ranges.at(-1)?.toSec).toBe(HOUR / 1000)
  })

  it('drops a track that lies entirely outside the window', () => {
    const plan = planDenseRanges(
      base({
        tracks: [{ firstSeen: WINDOW_START - 600_000, lastSeen: WINDOW_START - 500_000 }],
      }),
    )
    expect(plan.ranges).toEqual([])
  })

  it('sorts out-of-order tracks before merging', () => {
    const plan = planDenseRanges(
      base({
        tracks: [
          { firstSeen: WINDOW_START + 800_000, lastSeen: WINDOW_START + 820_000 },
          { firstSeen: WINDOW_START + 600_000, lastSeen: WINDOW_START + 620_000 },
        ],
      }),
    )
    expect(plan.ranges.map((r) => r.fromSec)).toEqual([595, 795])
  })

  it('tolerates a track whose lastSeen precedes its firstSeen', () => {
    const plan = planDenseRanges(
      base({
        tracks: [{ firstSeen: WINDOW_START + 620_000, lastSeen: WINDOW_START + 600_000 }],
      }),
    )
    expect(plan.ranges).toEqual([{ fromSec: 595, toSec: 625 }])
  })

  it('DEGRADES to base cadence alone past the range ceiling — never a truncated list', () => {
    // A truncated list is a video that silently omits the end of the evening.
    // Reporting `capped` lets the caller render a uniform timelapse and SAY so.
    const tracks = Array.from({ length: DENSE_MAX_RANGES + 1 }, (_, i) => ({
      firstSeen: WINDOW_START + i * 120_000,
      lastSeen: WINDOW_START + i * 120_000 + 1000,
    }))
    const plan = planDenseRanges(base({ tracks, windowEndMs: WINDOW_START + 12 * HOUR }))
    expect(plan.capped).toBe(true)
    expect(plan.ranges).toEqual([])
    expect(plan.mergedCount).toBe(DENSE_MAX_RANGES + 1)
  })

  it('reports the seconds the dense ranges cover, for the log line', () => {
    const plan = planDenseRanges(
      base({ tracks: [{ firstSeen: WINDOW_START, lastSeen: WINDOW_START + 20_000 }] }),
    )
    expect(plan.denseSec).toBe(25)
  })
})
