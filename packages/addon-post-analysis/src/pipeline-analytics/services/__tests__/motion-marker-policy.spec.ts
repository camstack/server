import { describe, expect, it } from 'vitest'
import { decideMotionStill, type MotionStillDecisionInput } from '../motion-marker-policy.js'

const QUIET = 900_000
const T0 = 1_788_000_000_000

const base = (over: Partial<MotionStillDecisionInput> = {}): MotionStillDecisionInput => ({
  debugMediaEnabled: false,
  now: T0,
  lastDetectionAtMs: undefined,
  lastMarkerAtMs: undefined,
  quietMs: QUIET,
  ...over,
})

describe('decideMotionStill — the gate in front of the 111 GB', () => {
  it('captures nothing on a camera the detector is actively covering', () => {
    const d = decideMotionStill(base({ lastDetectionAtMs: T0 - 5_000 }))
    expect(d.capture).toBe(false)
    expect(d.reason).toBe('detection-recent')
  })

  it('captures the fallback marker when nothing has been detected for the window', () => {
    const d = decideMotionStill(base({ lastDetectionAtMs: T0 - QUIET - 1 }))
    expect(d.capture).toBe(true)
    expect(d.reason).toBe('quiet-marker')
  })

  it('a camera that has never detected anything still gets its marker', () => {
    const d = decideMotionStill(base({ lastDetectionAtMs: undefined }))
    expect(d.capture).toBe(true)
    expect(d.reason).toBe('quiet-marker')
  })

  it('emits ONE marker per window, not one per provider keepalive', () => {
    const d = decideMotionStill(
      base({ lastDetectionAtMs: T0 - QUIET - 1, lastMarkerAtMs: T0 - 1_010 }),
    )
    expect(d.capture).toBe(false)
    expect(d.reason).toBe('marker-recent')
  })

  it('a 12-hour drought keeps producing evidence — one marker per window, not one and then silence', () => {
    const d = decideMotionStill(
      base({ lastDetectionAtMs: T0 - 12 * 3600_000, lastMarkerAtMs: T0 - QUIET }),
    )
    expect(d.capture).toBe(true)
    expect(d.reason).toBe('quiet-marker')
  })

  it('debug media captures EVERY edge, drought or not', () => {
    const d = decideMotionStill(
      base({ debugMediaEnabled: true, lastDetectionAtMs: T0 - 1, lastMarkerAtMs: T0 - 1 }),
    )
    expect(d.capture).toBe(true)
    expect(d.reason).toBe('debug')
  })

  /**
   * The measured failure, replayed. Camera 103 at night: the provider's
   * keepalive lands every 1.010 s, the analyzer's per-frame `detected:false`
   * poisons the shared edge map between each pair, and every one of them reads
   * as an off→on transition. Over one hour that was 2 218 stills with ZERO
   * tracks on the camera.
   *
   * A gate that produced one still per hour would also pass an assertion of
   * "fewer than 2218", which is why this pins the exact number the policy
   * must produce: 3 600 / 900 = 4.
   */
  it('collapses an hour of 1.010 s keepalive edges into 4 markers, not 2218', () => {
    let lastMarkerAtMs: number | undefined
    let captured = 0
    let edges = 0
    for (let t = T0; t < T0 + 3600_000; t += 1_010) {
      edges += 1
      const d = decideMotionStill({
        debugMediaEnabled: false,
        now: t,
        lastDetectionAtMs: undefined,
        lastMarkerAtMs,
        quietMs: QUIET,
      })
      if (d.capture) {
        captured += 1
        lastMarkerAtMs = t
      }
    }
    expect(edges).toBeGreaterThan(3_500)
    expect(captured).toBe(4)
  })

  it('a clock that jumps backwards suppresses rather than doubling up', () => {
    const d = decideMotionStill(base({ now: T0 - 60_000, lastMarkerAtMs: T0 }))
    expect(d.capture).toBe(false)
  })
})
