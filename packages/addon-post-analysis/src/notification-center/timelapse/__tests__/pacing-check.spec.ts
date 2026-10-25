/**
 * The post-render pacing check — the question nobody was asking on 2026-08-21.
 *
 * That morning the scheduler logged `timelapse produced … denseRanges=9
 * detections=13 coveragePct=91` for camera 101 and every number was true — of
 * the PLAN. The delivered file held 594 frames where the plan selected ~1250:
 * the recorder's retiming step parked the kept frames on the source's 25 fps
 * grid and `fps=12` then dropped half of them, while the HLS concat's timeline
 * drift had already moved the dense ranges ~495 s off the detections they were
 * cut for. The operator found out by watching the video ("alle 06:25 c'è stata
 * una detection chiaramente ma non rallenta affatto" [at 06:25 there was clearly a detection but it does not slow down at all]); nothing in the log could
 * have told him.
 *
 * This check compares the finished file's duration against the SAME plan the
 * render was built from — same ranges, same coverage rows, same cadences, one
 * authority — and is asserted here against the real numbers of that night.
 */
import { describe, expect, it } from 'vitest'
import {
  checkTimelapsePacing,
  type PacingCheckInput,
  SLOWDOWN_CHECK_FLOOR_FRAMES,
  SLOWDOWN_DELIVERY_FLOOR,
} from '../pacing-check.js'

const WINDOW_START = Date.UTC(2026, 7, 20, 19) // 21:00 Europe/Rome
const HOUR = 3600_000

/** A 1 h fully covered window, one 30 s detection range, the deployment's real
 *  knobs (30 s base, 1 s dense, 12 fps). */
function input(over: Partial<PacingCheckInput> = {}): PacingCheckInput {
  return {
    windowStartMs: WINDOW_START,
    windowEndMs: WINDOW_START + HOUR,
    cadenceSec: 30,
    denseEveryMs: 1000,
    outputFps: 12,
    ranges: [{ fromSec: 600, toSec: 630 }],
    subjects: [
      {
        firstSeen: WINDOW_START + 605_000,
        lastSeen: WINDOW_START + 625_000,
        className: 'person',
        trackId: 't-1',
      },
    ],
    availability: [{ startMs: WINDOW_START, endMs: WINDOW_START + HOUR }],
    // (3600 − 30)/30 base + 30 dense = 149 frames at 12 fps.
    actualDurationMs: Math.round((149 / 12) * 1000),
    ...over,
  }
}

describe('checkTimelapsePacing', () => {
  it('verifies a delivery that matches the plan', () => {
    const v = checkTimelapsePacing(input())
    expect(v.anomaly).toBe('none')
    expect(v.actualFrames).toBe(149)
    expect(v.expectedFrames).toBe(149)
    expect(v.baselineOnlyFrames).toBe(120)
    expect(v.expectedDenseExtraFrames).toBe(29)
    expect(v.unservedWindows).toEqual([])
  })

  it('flags a video that never slowed down — and names who was skipped', () => {
    // Uniform pacing: exactly the baseline frame count, dense never landed.
    const v = checkTimelapsePacing(input({ actualDurationMs: Math.round((120 / 12) * 1000) }))
    expect(v.anomaly).toBe('no-slowdown')
    expect(v.deliveredDenseExtraFrames).toBeLessThan(
      SLOWDOWN_DELIVERY_FLOOR * v.expectedDenseExtraFrames,
    )
    expect(v.unservedWindows).toHaveLength(1)
    expect(v.unservedWindows[0]).toMatchObject({
      fromSec: 600,
      toSec: 630,
      expectedDenseFrames: 30,
      subjects: 1,
      classes: ['person'],
      firstSeen: WINDOW_START + 605_000,
    })
  })

  /**
   * Camera 101, night of 2026-08-20→21, export `3a62ec17`, measured: 36 000 s
   * window, 32 869 s covered, 168 s of dense ranges, and a 49.5 s / 594-frame
   * file. The check must call it out — this exact case shipped silently.
   */
  it('flags the real 2026-08-21 delivery (594 frames where ~1250 were planned)', () => {
    const ranges = [
      { fromSec: 0, toSec: 18.9 },
      { fromSec: 307.4, toSec: 324 },
      { fromSec: 4778.5, toSec: 4794.3 },
      { fromSec: 5300.9, toSec: 5316.2 },
      { fromSec: 14756.2, toSec: 14780.8 },
      { fromSec: 15816.2, toSec: 15830 },
      { fromSec: 33981.6, toSec: 34012.8 },
      { fromSec: 34525.4, toSec: 34536.5 },
      { fromSec: 35979.1, toSec: 36000 },
    ]
    const v = checkTimelapsePacing(
      input({
        windowEndMs: WINDOW_START + 36_000_000,
        ranges,
        subjects: ranges.map((r) => ({
          firstSeen: WINDOW_START + r.fromSec * 1000 + 5000,
          lastSeen: WINDOW_START + r.toSec * 1000 - 5000,
          className: 'person',
        })),
        // 91.3% coverage as one head-truncated run (the real gaps are many; the
        // check only sums them, so one is enough to model the arithmetic).
        availability: [
          {
            startMs: WINDOW_START + 3_131_000,
            endMs: WINDOW_START + 36_000_000,
          },
        ],
        actualDurationMs: 49_500,
      }),
    )
    expect(v.anomaly).toBe('no-slowdown')
    expect(v.actualFrames).toBe(594)
    // Well over a thousand frames were owed.
    expect(v.expectedFrames).toBeGreaterThan(1150)
    // The delivered file sits BELOW even the no-dense baseline — the check's
    // meta is what says "frames were dropped", not just "dense missed".
    expect(v.actualFrames).toBeLessThan(v.baselineOnlyFrames)
    expect(v.unservedWindows.length).toBeGreaterThan(0)
  })

  it('does not blame a range whose footage fell in a recording gap', () => {
    // The only range sits entirely in a hole: the recorder legitimately drops
    // it (`export-dense-map.ts` reports it), so the expected count must not
    // include it — a WARN for footage that does not exist would cry wolf.
    const v = checkTimelapsePacing(
      input({
        availability: [
          { startMs: WINDOW_START, endMs: WINDOW_START + 500_000 },
          { startMs: WINDOW_START + 700_000, endMs: WINDOW_START + HOUR },
        ],
        // covered = 3400 s, all baseline: 3400/30 ≈ 113 frames.
        actualDurationMs: Math.round((3400 / 30 / 12) * 1000),
      }),
    )
    expect(v.anomaly).toBe('none')
    expect(v.expectedDenseExtraFrames).toBe(0)
    expect(v.unservedWindows).toEqual([])
  })

  it('calls a dense-less short file a frame deficit, not a missing slowdown', () => {
    const v = checkTimelapsePacing(
      input({
        ranges: [],
        subjects: [],
        denseEveryMs: null,
        actualDurationMs: Math.round((60 / 12) * 1000), // 60 frames where 120 are owed
      }),
    )
    expect(v.anomaly).toBe('frame-deficit')
  })

  it('calls out a surplus too — more video than the plan can explain', () => {
    const v = checkTimelapsePacing(input({ actualDurationMs: Math.round((400 / 12) * 1000) }))
    expect(v.anomaly).toBe('frame-surplus')
  })

  it('stays quiet when the dense plan is too small to measure', () => {
    // A 5 s pass adds ~5 frames — under the measurement floor, indistinguishable
    // from rounding. The duration check still applies; the slowdown verdict
    // must not fire on noise.
    const v = checkTimelapsePacing(
      input({
        ranges: [{ fromSec: 600, toSec: 605 }],
        actualDurationMs: Math.round((121 / 12) * 1000),
      }),
    )
    expect(v.expectedDenseExtraFrames).toBeLessThan(SLOWDOWN_CHECK_FLOOR_FRAMES)
    expect(v.anomaly).toBe('none')
  })
})
