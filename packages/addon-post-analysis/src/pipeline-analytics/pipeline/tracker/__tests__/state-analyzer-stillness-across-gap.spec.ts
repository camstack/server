/**
 * A still subject that L1 splits across a detection gap must keep its idle
 * dwell when L2 fuses the pieces (102 audit 2026-10-04, H1).
 *
 * Measured on device 102: parked-car ghosts with centroid span 12–19 px over
 * 30–37 s closed `state: moving`. Still-ish vehicles that stayed `idle` had
 * median max gap 1.4 s; those that closed `moving` had median max gap 8.0 s
 * — past `maxMissedMs` (4 s) but inside `LINK_MAX_GAP_MS` (10 s), so L2 fuses
 * under the earliest id.
 *
 * What goes wrong today: piece A reaches `stationary`, then a miss ends it and
 * StateAnalyzer deletes its dwell on `leaving`. Piece B starts fresh. Fusion
 * `rename(B → A)` installs B's young clock under A. The session closes before
 * B matures → the row persists as `moving`, and the ledger never agrees.
 *
 * The fused continuation must keep the stillness clock the subject already
 * earned, unless the geometry across the gap says it actually moved.
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
    score: 0.55,
    bbox,
    path: [bbox],
    velocity: prev ? { dx: cx - prev.cx, dy: cy - prev.cy } : { dx: 0, dy: 0 },
  }
}

/** 102 white-car footprint: short side ~450 px. */
const W = 454
const H = 860
const CX = 3611
const CY = 1104

function runStill(
  a: StateAnalyzer,
  id: string,
  fromMs: number,
  seconds: number,
  fps = 2,
): { readonly lastState: string; readonly endMs: number } {
  const step = 1000 / fps
  const frames = Math.round(seconds * fps)
  let prev: { cx: number; cy: number } | undefined
  let lastState = 'entering'
  let t = fromMs
  for (let i = 0; i < frames; i++) {
    // ≤ 2 px of jitter — well inside the still span, above velocityThreshold
    // so the window verdict (not the speed gate) is what settles it.
    const cx = CX + (i % 2)
    const cy = CY
    const out = a.analyze([at(id, cx, cy, W, H, prev)], t)
    lastState = out.find((r) => r.trackId === id)?.state ?? lastState
    prev = { cx, cy }
    t += step
  }
  return { lastState, endMs: t - step }
}

describe('stillness survives an L1 gap that L2 fuses', () => {
  it('keeps idle under the survivor after leave → young piece → rename (102 H1)', () => {
    const a = new StateAnalyzer()
    // Piece A: long enough for stationaryThresholdSec (10 s) past the 6 s window.
    const aRun = runStill(a, 'A', 1_000, 20)
    expect(aRun.lastState).toBe('stationary')

    // Detection gap: A is gone from the frame (tracklet expired). Today this
    // DELETES the dwell; the fix parks it for a later fusion.
    const left = a.analyze([], aRun.endMs + 500)
    expect(left.some((r) => r.trackId === 'A' && r.state === 'leaving')).toBe(true)

    // Piece B: a few seconds in the same box — not yet idle on its own clock.
    const bRun = runStill(a, 'B', aRun.endMs + 8_000, 4)
    expect(bRun.lastState).not.toBe('stationary')

    // L2 commits: B continues A under the earliest id.
    a.rename('B', 'A')
    const after = a.analyze([at('A', CX, CY, W, H, { cx: CX, cy: CY })], bRun.endMs + 500)
    const row = after.find((r) => r.trackId === 'A')
    expect(row?.state).toBe('stationary')
  })

  it('still clears idle when the fused continuation has actually moved', () => {
    const a = new StateAnalyzer()
    const aRun = runStill(a, 'A', 1_000, 20)
    expect(aRun.lastState).toBe('stationary')
    a.analyze([], aRun.endMs + 500)

    // Piece B starts 400 px away — a different place, not a still re-bind.
    let prev: { cx: number; cy: number } | undefined
    let t = aRun.endMs + 8_000
    for (let i = 0; i < 8; i++) {
      const cx = CX + 400 + i * 5
      const cy = CY
      a.analyze([at('B', cx, cy, W, H, prev)], t)
      prev = { cx, cy }
      t += 500
    }
    a.rename('B', 'A')
    const after = a.analyze([at('A', CX + 435, CY, W, H, prev)], t)
    expect(after.find((r) => r.trackId === 'A')?.state).not.toBe('stationary')
  })
})
