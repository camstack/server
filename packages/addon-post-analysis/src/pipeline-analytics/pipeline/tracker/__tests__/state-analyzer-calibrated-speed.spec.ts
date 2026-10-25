import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STATE_ANALYZER_CONFIG,
  StateAnalyzer,
  type StateAnalyzerConfig,
} from '../state-analyzer.js'

interface Tracked {
  readonly trackId: string
  readonly trackAge: number
  readonly class: string
  readonly originalClass: string
  readonly score: number
  readonly bbox: { x: number; y: number; w: number; h: number }
  readonly path: readonly { x: number; y: number; w: number; h: number }[]
  readonly velocity: { dx: number; dy: number }
}

/** Box of a fixed size at (x, y); diagonal = hypot(60, 80) = 100 px. */
function tracked(id: string, x: number, y: number, velocity: { dx: number; dy: number }): Tracked {
  const bbox = { x, y, w: 60, h: 80 }
  return {
    trackId: id,
    trackAge: 1,
    class: 'person',
    originalClass: 'person',
    score: 0.8,
    bbox,
    path: [bbox],
    velocity,
  }
}

/**
 * Feed a track moving `pxPerStep` every `stepMs` and return the last state.
 * Long enough to clear `enteringFrames` and `stationaryThresholdSec`.
 */
function runTrack(
  config: Partial<StateAnalyzerConfig>,
  opts: { readonly pxPerStep: number; readonly stepMs: number; readonly steps: number },
): string {
  const analyzer = new StateAnalyzer(config)
  let state = 'entering'
  for (let i = 0; i < opts.steps; i++) {
    const at = i * opts.stepMs
    const velocity = { dx: opts.pxPerStep, dy: 0 }
    const out = analyzer.analyze([tracked('t', 100 + i * opts.pxPerStep, 100, velocity)], at)
    const row = out.find((r) => r.trackId === 't')
    if (row) state = row.state
  }
  return state
}

describe('StateAnalyzer — an UNCALIBRATED camera behaves exactly as today', () => {
  it('ships no calibrated bar in the default config', () => {
    expect(DEFAULT_STATE_ANALYZER_CONFIG.stillSpeedFracPerSec).toBeUndefined()
  })

  it('still judges on the absolute px-per-update velocity when no bar is set', () => {
    // 1 px/update is at/below `velocityThreshold` 2 → settled → matures to
    // `stationary` after `stationaryThresholdSec`. This is today's behaviour
    // and must not move.
    expect(runTrack({ enteringFrames: 2 }, { pxPerStep: 1, stepMs: 200, steps: 120 })).toBe(
      'stationary',
    )
    // 10 px/update is above it, and the span window never closes on a subject
    // that keeps travelling → `moving`, as today.
    expect(runTrack({ enteringFrames: 2 }, { pxPerStep: 10, stepMs: 200, steps: 120 })).toBe(
      'moving',
    )
  })
})

describe('StateAnalyzer — a calibrated camera judges on its own scale', () => {
  /**
   * 5 px every 200 ms = 25 px/s; the box diagonal is 100 px, so 0.25
   * subject-diagonals/s. Under the flat rule this is 5 px per update, above
   * `velocityThreshold` 2 → `moving` on every camera. A far camera whose own
   * subjects travel at 1.0 diagonals/s should call it settled; a close camera
   * whose subjects crawl at 0.02 should not.
   */
  const motion = { pxPerStep: 5, stepMs: 200, steps: 120 }

  it('calls a slow subject settled on a camera calibrated LOOSE', () => {
    expect(runTrack({ enteringFrames: 2, stillSpeedFracPerSec: 0.3 }, motion)).toBe('stationary')
  })

  it('keeps the same subject MOVING on a camera calibrated TIGHT', () => {
    expect(runTrack({ enteringFrames: 2, stillSpeedFracPerSec: 0.02 }, motion)).toBe('moving')
  })

  it('does not fall back to the absolute bar once a camera is calibrated', () => {
    // 1 px/update would pass the flat `velocityThreshold` 2. On a camera whose
    // own scale says that is travel (0.005 diagonals/s here against a 0.001
    // bar), it must not read as settled.
    expect(
      runTrack(
        { enteringFrames: 2, stillSpeedFracPerSec: 0.001 },
        { pxPerStep: 1, stepMs: 200, steps: 120 },
      ),
    ).toBe('moving')
  })

  it('leaves the subject-relative span window untouched — a parked box still settles', () => {
    // Zero travel: the window rule alone carries it, on any calibration.
    expect(
      runTrack(
        { enteringFrames: 2, stillSpeedFracPerSec: 0.000_001 },
        { pxPerStep: 0, stepMs: 200, steps: 120 },
      ),
    ).toBe('stationary')
  })
})
