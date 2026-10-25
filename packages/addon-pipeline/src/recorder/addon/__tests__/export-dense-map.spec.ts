/**
 * The dense overlay's coordinate translation: WALL ranges → CONCATENATED-STREAM
 * ranges.
 *
 * The bug this pins (live, 2026-08-13, export 57d14363 on camera 101): the
 * planner emitted `fromSec/toSec` as offsets from the window start in WALL
 * time, while ffmpeg's `t` runs over the concatenation of ~2,957 segment files
 * with every recording gap REMOVED. That window held 29,393 s of footage in
 * 36,000 s of wall time, so a range past the first gap was late by the
 * cumulative gap — 6,607 s by the end — and matched nothing. The delivered
 * video was uniform while the log said `denseRanges=5`.
 */

import type { ExportOptions } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  type ExportSegmentTiming,
  mapDenseRangesToStreamTime,
  withStreamTimeDenseRanges,
} from '../export-dense-map.js'

/** Wall origin of every fixture — a real epoch, so nothing passes by accident
 *  on a coordinate that happens to be zero. */
const FROM_MS = 1_786_561_200_000

/** `[startSec, durSec]` pairs, relative to {@link FROM_MS}. */
function segments(...pairs: readonly (readonly [number, number])[]): ExportSegmentTiming[] {
  return pairs.map(([startSec, durSec]) => ({
    startMs: FROM_MS + startSec * 1000,
    durMs: durSec * 1000,
  }))
}

/** Footage 0–20 s and 50–70 s of wall time: one 30 s hole in the middle. */
const GAPPED = segments([0, 10], [10, 10], [50, 10], [60, 10])

describe('mapDenseRangesToStreamTime', () => {
  it('is the identity on a window with no gaps', () => {
    const out = mapDenseRangesToStreamTime({
      ranges: [
        { fromSec: 2, toSec: 8 },
        { fromSec: 12, toSec: 18 },
      ],
      exportFromMs: FROM_MS,
      segments: segments([0, 10], [10, 10]),
    })
    expect(out.ranges).toEqual([
      { fromSec: 2, toSec: 8 },
      { fromSec: 12, toSec: 18 },
    ])
    expect(out.report).toEqual({ requested: 2, mapped: 2, dropped: [] })
  })

  it('pulls a range AFTER a gap earlier by the cumulative gap', () => {
    // Wall 55–65 sits in the second recorded block, which starts at stream
    // t=20 (the 30 s hole is not in the stream at all).
    const out = mapDenseRangesToStreamTime({
      ranges: [{ fromSec: 55, toSec: 65 }],
      exportFromMs: FROM_MS,
      segments: GAPPED,
    })
    expect(out.ranges).toEqual([{ fromSec: 25, toSec: 35 }])
    expect(out.report.dropped).toEqual([])
  })

  it('CLIPS a range spanning a gap to the recorded parts on both sides', () => {
    // Wall 15–55 holds 5 s of footage before the hole and 5 s after it. Those
    // two parts are ADJACENT in the concatenation (a gap is a point in stream
    // time), so the clip is one contiguous stream range — never two.
    const out = mapDenseRangesToStreamTime({
      ranges: [{ fromSec: 15, toSec: 55 }],
      exportFromMs: FROM_MS,
      segments: GAPPED,
    })
    expect(out.ranges).toEqual([{ fromSec: 15, toSec: 25 }])
    expect(out.report).toEqual({ requested: 1, mapped: 1, dropped: [] })
  })

  it('DROPS a range that falls entirely inside a gap, and says so', () => {
    const out = mapDenseRangesToStreamTime({
      ranges: [{ fromSec: 25, toSec: 45 }],
      exportFromMs: FROM_MS,
      segments: GAPPED,
    })
    expect(out.ranges).toEqual([])
    expect(out.report).toEqual({
      requested: 1,
      mapped: 0,
      dropped: [{ fromSec: 25, toSec: 45, reason: 'gap' }],
    })
  })

  it('DROPS a range past the end of the footage, with its own reason', () => {
    const out = mapDenseRangesToStreamTime({
      ranges: [{ fromSec: 80, toSec: 95 }],
      exportFromMs: FROM_MS,
      segments: GAPPED,
    })
    expect(out.ranges).toEqual([])
    expect(out.report.dropped).toEqual([{ fromSec: 80, toSec: 95, reason: 'past-end' }])
  })

  it('drops a range before the first segment as a gap, not as past-end', () => {
    const out = mapDenseRangesToStreamTime({
      ranges: [{ fromSec: 1, toSec: 4 }],
      exportFromMs: FROM_MS,
      // Recording starts 10 s into the export window.
      segments: segments([10, 10]),
    })
    expect(out.ranges).toEqual([])
    expect(out.report.dropped).toEqual([{ fromSec: 1, toSec: 4, reason: 'gap' }])
  })

  it('anchors t on the FIRST SEGMENT, not on the export window start', () => {
    // The first segment straddles the window start: ffmpeg is handed the whole
    // file, so t=0 is that segment's start, 8 s BEFORE `fromMs`.
    const out = mapDenseRangesToStreamTime({
      ranges: [{ fromSec: 2, toSec: 6 }],
      exportFromMs: FROM_MS,
      segments: segments([-8, 20]),
    })
    expect(out.ranges).toEqual([{ fromSec: 10, toSec: 14 }])
  })

  it('never returns more ranges than it was given', () => {
    const requested = Array.from({ length: 20 }, (_, i) => ({
      fromSec: i * 3,
      toSec: i * 3 + 2,
    }))
    const out = mapDenseRangesToStreamTime({
      ranges: requested,
      exportFromMs: FROM_MS,
      segments: GAPPED,
    })
    expect(out.ranges.length).toBeLessThanOrEqual(requested.length)
    expect(out.report.mapped + out.report.dropped.length).toBe(requested.length)
  })

  it('treats an empty playlist as no footage at all', () => {
    const out = mapDenseRangesToStreamTime({
      ranges: [{ fromSec: 1, toSec: 2 }],
      exportFromMs: FROM_MS,
      segments: [],
    })
    expect(out.ranges).toEqual([])
    expect(out.report.dropped[0]?.reason).toBe('past-end')
  })
})

function timelapseOptions(ranges: readonly { fromSec: number; toSec: number }[]): ExportOptions {
  return {
    includeAudio: false,
    maxLifeMs: 1,
    deleteAfterDownload: false,
    timelapse: { everyMs: 30_000, outputFps: 12, dense: { everyMs: 1000, ranges: [...ranges] } },
  }
}

describe('withStreamTimeDenseRanges', () => {
  it('rewrites the dense ranges in place and reports the mapping', () => {
    const out = withStreamTimeDenseRanges({
      options: timelapseOptions([{ fromSec: 55, toSec: 65 }]),
      fromMs: FROM_MS,
      segments: GAPPED,
    })
    expect(out.options.timelapse?.dense).toEqual({
      everyMs: 1000,
      ranges: [{ fromSec: 25, toSec: 35 }],
    })
    expect(out.options.timelapse?.everyMs).toBe(30_000)
    expect(out.options.timelapse?.outputFps).toBe(12)
    expect(out.report).toEqual({ requested: 1, mapped: 1, dropped: [] })
  })

  it('DROPS the whole overlay when nothing maps — never an empty range list', () => {
    // `ExportDenseSchema` refuses `ranges: []`, and `selectPredicate` would
    // emit `if(,…)`: a filter ffmpeg rejects, which fails the render outright.
    const out = withStreamTimeDenseRanges({
      options: timelapseOptions([{ fromSec: 25, toSec: 45 }]),
      fromMs: FROM_MS,
      segments: GAPPED,
    })
    expect(out.options.timelapse?.dense).toBeUndefined()
    expect(out.options.timelapse?.everyMs).toBe(30_000)
    expect(out.report?.mapped).toBe(0)
  })

  it('leaves an export with no dense overlay untouched, and reports nothing', () => {
    const options: ExportOptions = {
      includeAudio: false,
      maxLifeMs: 1,
      deleteAfterDownload: false,
      timelapse: { everyMs: 30_000 },
    }
    const out = withStreamTimeDenseRanges({ options, fromMs: FROM_MS, segments: GAPPED })
    expect(out.options).toBe(options)
    expect(out.report).toBeNull()
  })

  it('leaves a non-timelapse export untouched', () => {
    const options: ExportOptions = {
      speed: 4,
      includeAudio: true,
      maxLifeMs: 1,
      deleteAfterDownload: false,
    }
    const out = withStreamTimeDenseRanges({ options, fromMs: FROM_MS, segments: GAPPED })
    expect(out.options).toBe(options)
    expect(out.report).toBeNull()
  })
})
