/**
 * A parked car whose BOX breathes is not a moving car.
 *
 * Measured on device 102, tracks the operator marked "Oggetto stazionario"
 * on 2026-09-16. Track `hmt13z38ha`, 272 positions over 119 seconds:
 *
 *   centre x   3306 on EVERY position — never moves, not once
 *   centre y   575 / 104 / 650 / 680, oscillating
 *   box        461x536 → 461x416 → 461x446 → 478x536 → 446x536
 *   net travel 44 px        accumulated travel 5575 px
 *
 * And it is not the extreme. `vdscvtnqr0`: net travel **0 px**, accumulated
 * 2730. `4hp89xfch8`: net **3 px** over 37 seconds, accumulated 311. All of
 * them were reported as `state=moving`.
 *
 * The cause is that the state hangs off the SINGLE-FRAME velocity. At night a
 * dark car's lower edge flickers between the bodywork and its own shadow, the
 * box height swings 25 %, and each swing moves the centroid 60-75 px — thirty
 * times `velocityThreshold`. So the track takes the `moving` branch, which
 * ALSO clears `stationarySince`, so it can never mature the ten seconds that
 * would make it still. A gate that shuts itself on every flicker.
 *
 * The existing jitter spec does not catch this: it passes
 * `velocity: {dx: 0, dy: 0}`, so it enters the low-velocity branch and
 * exercises the escape hatch where it is nearly redundant. The branch that
 * breaks in production had no test at all.
 *
 * What the tracker must judge is NET displacement over a recent window. A
 * subject whose centroid has stayed inside a small radius for the last several
 * seconds is not moving, whatever the edges of its box are doing.
 */
import { describe, expect, it } from 'vitest'

import { StateAnalyzer } from '../state-analyzer.js'

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

/**
 * A track positioned by its CENTRE, carrying the velocity a real tracker would
 * emit for that step — the per-update centroid delta. Supplying a zeroed
 * velocity here would decide the outcome instead of measuring it.
 */
function at(
  id: string,
  cx: number,
  cy: number,
  w: number,
  h: number,
  prev: { cx: number; cy: number } | undefined,
): FakeTrack {
  const bbox = { x: cx - w / 2, y: cy - h / 2, w, h }
  return {
    trackId: id,
    trackAge: 1,
    class: 'car',
    originalClass: 'car',
    score: 0.9,
    bbox,
    path: [bbox],
    velocity: prev ? { dx: cx - prev.cx, dy: cy - prev.cy } : { dx: 0, dy: 0 },
  }
}

/** The measured 102 box cycle: height swinging, width nearly constant. */
const BREATH: readonly { w: number; h: number }[] = [
  { w: 461, h: 536 },
  { w: 461, h: 416 },
  { w: 461, h: 446 },
  { w: 478, h: 536 },
  { w: 446, h: 536 },
]

/**
 * Runs the parked car and returns the states of the LAST THIRD of the track.
 *
 * Reading only the final frame measures luck: the breath cycle has steps where
 * the height does not change, the centroid delta is 0, and the track lands in
 * the low-velocity branch by coincidence. What matters is that it is never
 * called `moving` while it sits there — that instant is what mints an event in
 * the operator's list.
 */
function runBreathingCar(seconds: number, fps = 2): readonly string[] {
  const a = new StateAnalyzer()
  const id = 'parked-102'
  const frames = Math.round(seconds * fps)
  const stepMs = 1000 / fps
  let prev: { cx: number; cy: number } | undefined
  const states: string[] = []
  let accumulated = 0
  for (let i = 0; i < frames; i++) {
    const shape = BREATH[i % BREATH.length]!
    // Top edge pinned — the car does not move; the BOTTOM edge flickers, so
    // the centre rides up and down by half the height change.
    const cx = 3306
    const cy = 382 + shape.h / 2
    if (prev) accumulated += Math.hypot(cx - prev.cx, cy - prev.cy)
    const out = a.analyze([at(id, cx, cy, shape.w, shape.h, prev)], 1_000 + i * stepMs)
    states.push(out.find((r) => r.trackId === id)?.state ?? 'entering')
    prev = { cx, cy }
  }
  // The premise of the whole fixture: lots of accumulated travel, no net
  // travel. If this stops holding, the fixture stopped reproducing the bug.
  expect(accumulated).toBeGreaterThan(1000)
  return states.slice(Math.floor((frames * 2) / 3))
}

describe('a still object whose box breathes', () => {
  it('is never called moving — 102, two minutes of a parked car at night', () => {
    expect(runBreathingCar(120)).not.toContain('moving')
  })

  it('has actually settled, not merely been excused', () => {
    const tail = runBreathingCar(120)
    expect(tail.every((s) => s === 'stationary' || s === 'loitering')).toBe(true)
  })

  // 37 seconds was enough for `4hp89xfch8` to be called moving. The verdict
  // must not need two minutes to arrive.
  it('settles within the shorter track the operator also marked', () => {
    expect(runBreathingCar(37)).not.toContain('moving')
  })

  // THE CONTROL, and the one that must never be sacrificed to the above: a car
  // that really drives across the frame is moving, and stays moving.
  it('still calls a car crossing the frame moving', () => {
    const a = new StateAnalyzer()
    const id = 'drive'
    let prev: { cx: number; cy: number } | undefined
    let state = 'entering'
    for (let i = 0; i < 40; i++) {
      const cx = 300 + i * 70
      const cy = 800
      const out = a.analyze([at(id, cx, cy, 461, 470, prev)], 1_000 + i * 500)
      state = out.find((r) => r.trackId === id)?.state ?? state
      prev = { cx, cy }
    }
    expect(state).toBe('moving')
  })

  // A car that drives in, parks, and sits there: moving first, then still.
  // This is the case `neverMoved` cannot reach, because it measures against
  // the position the track was BORN at.
  it('follows a car that arrives and then parks', () => {
    const a = new StateAnalyzer()
    const id = 'arrive-park'
    let prev: { cx: number; cy: number } | undefined
    const seen: string[] = []
    for (let i = 0; i < 80; i++) {
      const driving = i < 20
      const cx = driving ? 300 + i * 70 : 300 + 19 * 70
      const shape = BREATH[i % BREATH.length]!
      const cy = driving ? 800 : 382 + shape.h / 2
      const out = a.analyze(
        [at(id, cx, cy, driving ? 461 : shape.w, driving ? 470 : shape.h, prev)],
        1_000 + i * 500,
      )
      seen.push(out.find((r) => r.trackId === id)?.state ?? 'entering')
      prev = { cx, cy }
    }
    expect(seen[15]).toBe('moving')
    expect(seen.slice(60)).not.toContain('moving')
  })
})

/**
 * The window must be FULL before it may answer.
 *
 * A subject that has only just appeared has not gone anywhere YET, and a span
 * measured over a fraction of a second is small for everything — including a
 * car crossing the frame. Answering from a half-filled window turns "not known
 * yet" into "still", which is the exact failure the rest of this file is about,
 * pointed the other way.
 *
 * The case that bites is a subject moving SLOWLY relative to its own size, on
 * a camera analysed often: at 10 fps a car covering 50 px/s moves 5 px between
 * frames, nothing at all against a 400 px box — until six seconds of it add up
 * to 300 px, and they do.
 *
 * NOTE, so nobody reads more into this than it says: with the shipped
 * `stationaryThresholdSec` of 10 s the guard's effect is MASKED — a subject
 * must hold "settled" for ten continuous seconds before the state changes, and
 * the window fills long before that. Removing the guard changes no shipped
 * behaviour today. It is written at `stationaryThresholdSec: 0` here so the
 * guard answers for itself rather than being vouched for by a threshold that
 * happens to sit above it. That is the whole reason this spec passes a config.
 */
describe('a verdict is not given before the window has filled', () => {
  /** 10 fps, 5 px per frame — 50 px/s across a 400 px subject. */
  function slowCrossing(config: { stationaryThresholdSec: number }): readonly string[] {
    const a = new StateAnalyzer(config)
    let prev: { cx: number; cy: number } | undefined
    const seen: string[] = []
    for (let i = 0; i < 100; i++) {
      const cx = 500 + i * 5
      const cy = 900
      const out = a.analyze([at('slow-crossing', cx, cy, 400, 420, prev)], 1_000 + i * 100)
      seen.push(out.find((r) => r.trackId === 'slow-crossing')?.state ?? 'entering')
      prev = { cx, cy }
    }
    return seen.slice(6)
  }

  it('never calls a slow crossing car still, even with no dwell to hide behind', () => {
    const seen = slowCrossing({ stationaryThresholdSec: 0 })
    expect(seen).not.toContain('stationary')
    expect(seen).not.toContain('loitering')
  })

  it('and not with the shipped dwell either', () => {
    const seen = slowCrossing({ stationaryThresholdSec: 10 })
    expect(seen).not.toContain('stationary')
    expect(seen).not.toContain('loitering')
  })
})
