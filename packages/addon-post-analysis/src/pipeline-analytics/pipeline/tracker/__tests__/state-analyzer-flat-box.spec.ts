/**
 * A parked car whose box is WIDE AND FLAT is still a parked car.
 *
 * Recorded on camera "Retro" (device 1441), night of 2026-11-17/18: one real
 * parked car was re-born as a new vehicle track on every motion burst (81
 * tracks, 379 stored events) and never became a parked object — its evidence
 * candidate collected 74 agreeing votes out of 2394, because the tracker
 * called it `moving`.
 *
 * The box is about 150x53 px and the detector flips its WIDTH between ~102
 * and ~183 px, so the centre swings ~20 px sideways. The still window used to
 * judge that swing against 0.35 of the SHORT side (0.35 x 53 = 18.5 px): about
 * one window in three passed, every failing frame cleared `stationarySince`,
 * and the ten-second dwell restarted forever. The old circle stays the rule;
 * a FLAT box (median width > median height) is also still when its x-span is
 * within 0.35 of the median WIDTH and its y-span within 0.35 of the short
 * side. So the same car is still, while a car that crosses (about 1.8 widths
 * per window), a walking person, a person fidgeting in place and a person
 * wandering diagonally are still `moving` (for a box that is not flat the
 * rule is exactly the circle: `still-span.spec.ts`).
 *
 * Disarms (each alone, restored):
 *  - no flat exception (`flat = false`): the three recorded tracks and
 *    "merges: the width flipped across the gap" go RED;
 *  - the flat exception for every box (drop the flatness condition): "a
 *    person wandering diagonally" goes RED;
 *  - the window's sideways bar from the CURRENT box width instead of the
 *    window's median: cpt7vv6emv goes RED (one 102 px frame restarts its dwell);
 *  - `mergeContinuation` on the circle alone: "merges: the width flipped
 *    across the gap" goes RED.
 */
import type { ObjectState } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import { DEFAULT_STATE_ANALYZER_CONFIG, StateAnalyzer } from '../state-analyzer.js'
import { RETRO_1441_PARKED_CAR, type RecordedBox } from './scenes/retro-1441-parked-car.js'

interface FakeTrack {
  trackId: string
  trackAge: number
  class: string
  originalClass: string
  score: number
  bbox: { x: number; y: number; w: number; h: number }
  path: readonly { x: number; y: number; w: number; h: number }[]
  velocity: { dx: number; dy: number }
}

interface Step {
  readonly at: number
  readonly state: ObjectState
  readonly stationarySince: number | undefined
}

/**
 * Replays boxes through the analyzer with the velocity a real tracker emits —
 * the per-update centre delta — so the speed half of the settled test is
 * measured, not decided by a zeroed velocity.
 */
function replay(trackId: string, cls: string, boxes: readonly RecordedBox[]): Step[] {
  const analyzer = new StateAnalyzer()
  const steps: Step[] = []
  let prev: { cx: number; cy: number } | undefined
  for (const [at, x, y, w, h] of boxes) {
    const cx = x + w / 2
    const cy = y + h / 2
    const bbox = { x, y, w, h }
    const track: FakeTrack = {
      trackId,
      trackAge: 1,
      class: cls,
      originalClass: cls,
      score: 0.9,
      bbox,
      path: [bbox],
      velocity: prev ? { dx: cx - prev.cx, dy: cy - prev.cy } : { dx: 0, dy: 0 },
    }
    prev = { cx, cy }
    const [result] = analyzer.analyze([track], at)
    if (result === undefined) throw new Error('analyzer returned no state for the track')
    steps.push({
      at,
      state: result.state,
      stationarySince: result.stationarySince,
    })
  }
  return steps
}

function isSettled(state: ObjectState): boolean {
  return state === 'stationary' || state === 'loitering'
}

const DWELL_MS = DEFAULT_STATE_ANALYZER_CONFIG.stationaryThresholdSec * 1000

/**
 * The first update that may be judged at all: past the entering frames, with
 * a full still window behind it.
 */
function firstJudgeable(steps: readonly Step[]): Step | undefined {
  const t0 = steps[0]?.at ?? 0
  return steps.find(
    (s, i) =>
      i >= DEFAULT_STATE_ANALYZER_CONFIG.enteringFrames &&
      s.at - t0 >= DEFAULT_STATE_ANALYZER_CONFIG.stillWindowMs,
  )
}

describe('StateAnalyzer — a wide, flat parked car (Retro 1441)', () => {
  for (const track of RETRO_1441_PARKED_CAR) {
    it(`${track.trackId}: reaches stationary within its dwell and stays settled`, () => {
      const steps = replay(track.trackId, 'car', track.boxes)
      const judgeable = firstJudgeable(steps)
      if (judgeable === undefined) throw new Error(`${track.trackId} never filled its window`)
      // The dwell clock starts as soon as the car can be judged …
      expect(judgeable.stationarySince).toBe(judgeable.at)
      // … and the first update once that dwell is paid reads settled (the
      // stored positions are sparse, so "paid" is the next stored update).
      const paidAt = steps.find((s) => s.at - judgeable.at >= DWELL_MS)
      if (paidAt === undefined) throw new Error(`${track.trackId} is shorter than its dwell`)
      expect(paidAt.state).toBe('stationary')
      // From there on the car stays settled on EVERY update, under one dwell
      // clock: no window fails, so nothing restarts it. cpt7vv6emv carries the
      // hard frame (+118.9 s): the box at its narrowest, 102 px, under a
      // 38.5 px x-span — judged against the window's median width, not that
      // one narrow box.
      const after = steps.filter((s) => s.at >= judgeable.at)
      expect(new Set(after.map((s) => s.stationarySince))).toEqual(new Set([judgeable.at]))
      expect(steps.filter((s) => s.at >= paidAt.at && !isSettled(s.state))).toEqual([])
    })
  }
})

describe('StateAnalyzer — subjects that travel still read as moving', () => {
  const FRAME_MS = 140

  it('a flat car crossing the frame at ~1.8 widths per window is never settled', () => {
    // 150x53, the Retro car's own shape, crossing at 1.8 x 150 px per 6 s.
    const pxPerMs = (1.8 * 150) / DEFAULT_STATE_ANALYZER_CONFIG.stillWindowMs
    const boxes: RecordedBox[] = []
    for (let at = 0; at <= 30_000; at += FRAME_MS) {
      const w = at % (2 * FRAME_MS) === 0 ? 130 : 170
      boxes.push([at, 200 + at * pxPerMs - w / 2, 1083, w, 53])
    }
    const steps = replay('crossing-car', 'car', boxes)
    expect(steps.some((s) => isSettled(s.state))).toBe(false)
    expect(steps.at(-1)?.state).toBe('moving')
  })

  it('a person walking across at ~1.2 m/s is never settled', () => {
    // A tall 100x300 person walking ~110 px/s sideways (a long way from still:
    // 660 px per window against 0.35 x 100 px), the box height breathing.
    const boxes: RecordedBox[] = []
    for (let at = 0; at <= 30_000; at += FRAME_MS) {
      const h = at % (3 * FRAME_MS) === 0 ? 290 : 310
      boxes.push([at, 2700 + at * 0.11, 900, 100, h])
    }
    const steps = replay('walking-person', 'person', boxes)
    expect(steps.some((s) => isSettled(s.state))).toBe(false)
    expect(steps.at(-1)?.state).toBe('moving')
  })

  it('a person pacing slowly up the frame is never settled', () => {
    // Vertical travel: 30 px/s on a 100x300 box is 180 px per window against
    // 0.35 x 300 = 105 px of height — moving on the axis it travels.
    const boxes: RecordedBox[] = []
    for (let at = 0; at <= 30_000; at += FRAME_MS) {
      boxes.push([at, 2700, 1500 - at * 0.03, 100, 300])
    }
    const steps = replay('pacing-person', 'person', boxes)
    expect(steps.some((s) => isSettled(s.state))).toBe(false)
  })
})

describe('StateAnalyzer — a flat parked car split by a detection gap', () => {
  const STEP_MS = 500
  const Y = 1083

  /** Feeds one piece of a 53 px-tall box, left edge fixed, for `seconds`. */
  function piece(
    a: StateAnalyzer,
    id: string,
    fromMs: number,
    seconds: number,
    left: number,
    w: number,
  ): { readonly lastState: ObjectState | undefined; readonly endMs: number } {
    let prev: { cx: number; cy: number } | undefined
    let lastState: ObjectState | undefined
    let t = fromMs
    for (let i = 0; i < seconds * (1000 / STEP_MS); i++) {
      const bbox = { x: left, y: Y, w, h: 53 }
      const cx = left + w / 2
      const cy = Y + 26.5
      const track: FakeTrack = {
        trackId: id,
        trackAge: 1,
        class: 'car',
        originalClass: 'car',
        score: 0.6,
        bbox,
        path: [bbox],
        velocity: prev ? { dx: cx - prev.cx, dy: cy - prev.cy } : { dx: 0, dy: 0 },
      }
      prev = { cx, cy }
      lastState = a.analyze([track], t).find((r) => r.trackId === id)?.state
      t += STEP_MS
    }
    return { lastState, endMs: t - STEP_MS }
  }

  it('merges: the width flipped across the gap, the car did not move', () => {
    const a = new StateAnalyzer()
    const before = piece(a, 'A', 0, 20, 1350, 150)
    expect(before.lastState).toBe('stationary')
    a.analyze([], before.endMs + 500)
    // The detector's wide box: same left edge, centre 20 px to the right —
    // over 0.35 x 53 = 18.5 px of short side, inside 0.35 x 190 of width.
    const after = piece(a, 'B', before.endMs + 8_000, 4, 1350, 190)
    expect(after.lastState).not.toBe('stationary')
    a.rename('B', 'A')
    // B alone is 4 s old; only the survivor's kept dwell makes this stationary.
    const resumed = piece(a, 'A', after.endMs + STEP_MS, 0.5, 1350, 190)
    expect(resumed.lastState).toBe('stationary')
  })

  it('does not merge: a car one width further along is a different place', () => {
    const a = new StateAnalyzer()
    const before = piece(a, 'A', 0, 20, 1350, 150)
    expect(before.lastState).toBe('stationary')
    a.analyze([], before.endMs + 500)
    const after = piece(a, 'B', before.endMs + 8_000, 4, 1500, 150)
    a.rename('B', 'A')
    const resumed = piece(a, 'A', after.endMs + STEP_MS, 0.5, 1500, 150)
    expect(resumed.lastState).not.toBe('stationary')
  })
})

describe('StateAnalyzer — a tall subject keeps the short-side vertical bar', () => {
  // Only the SIDEWAYS bar follows the width (the flat car's flicker is
  // horizontal). Vertically a subject is judged on its short side, as before:
  // a 50x150 person's y-span may reach 0.35 x 50 = 17.5 px, not 0.35 x 150.
  const FRAME_MS = 140

  function fidget(swingPx: number): RecordedBox[] {
    const boxes: RecordedBox[] = []
    for (let at = 0; at <= 40_000; at += FRAME_MS) {
      const jitter = ((at / FRAME_MS) % 2) * 4
      boxes.push([at, 1000 + jitter, 500 + (swingPx / 2) * Math.sin(at / 1500), 50, 150])
    }
    return boxes
  }

  it('a standing person whose centre swings 36 px up and down never settles', () => {
    const steps = replay('fidget-person', 'person', fidget(36))
    expect(steps.filter((s) => isSettled(s.state))).toEqual([])
  })

  it('a swing just over the short-side bar (20 px > 17.5) never settles', () => {
    const steps = replay('fidget-20', 'person', fidget(20))
    expect(steps.filter((s) => isSettled(s.state))).toEqual([])
  })

  it('a person wandering diagonally (15 px right and 15 px down) never settles', () => {
    // Each axis alone is inside 17.5 px; together the wander is 21.2 px. A
    // tall box is judged on the old circle, so per-axis room cannot add up.
    const boxes: RecordedBox[] = []
    for (let at = 0; at <= 40_000; at += FRAME_MS) {
      const k = Math.floor(at / 700) % 2
      boxes.push([at, 1000 + 15 * k, 500 + 15 * k, 50, 150])
    }
    const steps = replay('diag-person', 'person', boxes)
    expect(steps.filter((s) => isSettled(s.state))).toEqual([])
  })

  it('a swing just under the short-side bar (16 px < 17.5) settles', () => {
    const steps = replay('fidget-16', 'person', fidget(16))
    expect(steps.at(-1)?.state).toBe('stationary')
  })
})
