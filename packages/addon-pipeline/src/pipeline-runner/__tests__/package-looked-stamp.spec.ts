/**
 * `FrameResult.packageLooked` — the only way post-analysis can tell "the
 * package step looked and found nothing" from "nobody looked" (D687). Both
 * arrive as a frame with no package box; only the runner knows which one the
 * governor decided.
 */
import type { FrameResult } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { PACKAGE_DETECTION_STEP_ID, withPackageLook } from '../motion-settle-governor.js'

const frame: FrameResult = {
  kind: 'frame',
  frameId: 'f-1',
  deviceId: 101,
  timestamp: 1_790_774_600_000,
  width: 3840,
  height: 2160,
  detections: [],
}

const objectStep = { addonId: 'object-detection' }
const packageStep = { addonId: PACKAGE_DETECTION_STEP_ID }

describe('withPackageLook', () => {
  it('stamps a frame the package step ran on', () => {
    expect(withPackageLook(frame, [objectStep, packageStep]).packageLooked).toBe(true)
  })

  it('does not stamp a frame the governor gated the step off', () => {
    expect(withPackageLook(frame, [objectStep]).packageLooked).toBeUndefined()
  })

  it('does not stamp a disabled package step', () => {
    const out = withPackageLook(frame, [objectStep, { ...packageStep, enabled: false }])
    expect(out.packageLooked).toBeUndefined()
  })

  it('does not stamp a SHED frame — no root ran, nobody looked', () => {
    const shed: FrameResult = { ...frame, shed: true, shedReason: 'worker-in-flight-cap' }
    expect(withPackageLook(shed, [objectStep, packageStep]).packageLooked).toBeUndefined()
  })

  it('never mutates the frame it was handed', () => {
    withPackageLook(frame, [packageStep])
    expect(frame.packageLooked).toBeUndefined()
  })
})
