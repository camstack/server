import { describe, expect, it } from 'vitest'
import { StateAnalyzer } from '../state-analyzer.js'

function box(x: number, y: number): { x: number; y: number; w: number; h: number } {
  return { x, y, w: 40, h: 30 }
}

function track(
  id: string,
  x: number,
  y: number,
  velocity: { dx: number; dy: number },
): {
  trackId: string
  trackAge: number
  class: string
  originalClass: string
  score: number
  bbox: { x: number; y: number; w: number; h: number }
  path: readonly { x: number; y: number; w: number; h: number }[]
  velocity: { dx: number; dy: number }
} {
  const bbox = box(x, y)
  return {
    trackId: id,
    trackAge: 1,
    class: 'car',
    originalClass: 'car',
    score: 0.8,
    bbox,
    path: [bbox],
    velocity,
  }
}

/**
 * `stationary` COSTS the dwell — there is no shortcut for a track that never
 * moved.
 *
 * The never-moved shortcut (a58da617) labelled a jitter-free track stationary
 * the moment its net travel was ~0 after the entering window, "without waiting
 * 10 s". That label was the stationary ledger's evidence of a parked object,
 * and on device 102 it was how a scene flicker voted: vehicle detections at
 * the top of the frame living 1 to 6 seconds, identical boxes under different
 * ids, all `stationary` from their sixth frame, minted a parked-object entry on
 * ten agreements against 773 and 1565 for the two real cars (D508).
 *
 * The first fix was a second clock in the ledger, a copy of this one kept in
 * step by hand. This is the one clock: `stationaryThresholdSec`, per device.
 */
describe('StateAnalyzer — a never-moved track waits the dwell like every other', () => {
  // The seven measured flickers: 1, 2, 3, 3, 3, 5 and 6 seconds at 8 fps.
  it('never calls a 1-6 second flicker stationary — the 102 phantom', () => {
    for (const seconds of [1, 2, 3, 3, 3, 5, 6]) {
      const a = new StateAnalyzer()
      const id = `flicker-${seconds}`
      const frames = seconds * 8
      const states: string[] = []
      for (let i = 0; i < frames; i++) {
        const out = a.analyze([track(id, 2490, 1, { dx: 0, dy: 0 })], 1_000 + i * 125)
        states.push(out.find((r) => r.trackId === id)?.state ?? 'entering')
      }
      expect(states).not.toContain('stationary')
      expect(states).not.toContain('loitering')
    }
  })

  it('calls the same box stationary once the dwell has elapsed — the real car', () => {
    const a = new StateAnalyzer()
    const id = 'parked'
    let state = 'entering'
    // 22 s at 8 fps: the shortest re-detection of a real parked car measured
    // on 102 that morning.
    for (let i = 0; i < 22 * 8; i++) {
      const out = a.analyze([track(id, 100, 100, { dx: 0, dy: 0 })], 1_000 + i * 125)
      state = out.find((r) => r.trackId === id)?.state ?? state
    }
    expect(state).toBe('stationary')
  })

  it('holds the line at the configured dwell, not near it', () => {
    const run = (seconds: number): string => {
      const a = new StateAnalyzer({ stationaryThresholdSec: 10, enteringFrames: 1 })
      let state = 'entering'
      const frames = Math.round(seconds * 10) + 1
      for (let i = 0; i < frames; i++) {
        const out = a.analyze([track('x', 100, 100, { dx: 0, dy: 0 })], 1_000 + i * 100)
        state = out.find((r) => r.trackId === 'x')?.state ?? state
      }
      return state
    }
    // The dwell clock starts on the first settled frame AFTER the entering
    // window (frame 2 here), so 10 s of dwell needs 10 s past that frame.
    expect(run(9.9)).toBe('moving')
    expect(run(10.2)).toBe('stationary')
  })

  // A jitter-walk that never left birth (1e073359) used to be granted the
  // label by the shortcut too; it now waits like everything else, and is not
  // called moving in the meantime by the single-frame velocity either — the
  // window verdict (see `state-analyzer-breathing-box.spec.ts`) covers it.
  it('a jitter-walk that never left birth is stationary after the dwell, not before', () => {
    const a = new StateAnalyzer()
    const id = 'jitter'
    const path = [
      { x: 100, y: 40 },
      { x: 102, y: 41 },
      { x: 99, y: 39 },
      { x: 100.4, y: 40.2 },
      { x: 101, y: 40 },
      { x: 100.5, y: 40.1 },
      { x: 100.2, y: 40 },
      { x: 100.4, y: 40.2 },
    ]
    const states: string[] = []
    for (let i = 0; i < 12 * 8; i++) {
      const p = path[i % path.length]!
      const out = a.analyze([track(id, p.x, p.y, { dx: 0, dy: 0 })], 1_000 + i * 125)
      states.push(out.find((r) => r.trackId === id)?.state ?? 'entering')
    }
    expect(states.slice(0, 8 * 8)).not.toContain('stationary')
    expect(states[states.length - 1]).toBe('stationary')
  })

  it('keeps a genuinely moving subject as moving', () => {
    const a = new StateAnalyzer()
    const id = 'drive'
    let state = 'entering'
    for (let i = 0; i < 8; i++) {
      const out = a.analyze([track(id, 100 + i * 20, 100, { dx: 10, dy: 0 })], 1_000 + i * 200)
      state = out.find((r) => r.trackId === id)?.state ?? state
    }
    expect(state).toBe('moving')
  })
})
