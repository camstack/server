/**
 * The operator's gate runs on BOTH roots, or the recorder was right to refuse.
 *
 * `enabledMacroClasses` and the `minConfidence<Macro>` floors are the whole
 * contract between what an operator sets in the UI and what the system acts
 * on. They were applied by the executor — and the camera's own firmware never
 * enters the executor.
 *
 * That is why `object-trigger.ts` refused every onboard detection with
 * `not-pipeline`: acting on an ungated box would have made the sliders
 * describe one detection while the recording followed another. The refusal was
 * right, and its cost was total — measured on device 106 on 2026-09-15, the
 * operator walked in front of the camera, the firmware saw `person` for ~100 s,
 * and 11 detections out of 11 were refused. No recording at all, on the only
 * camera on this fleet with the onboard root enabled.
 *
 * So the premise is removed rather than worked around: the firmware's boxes go
 * through the SAME gate, asked of the same authority, at the point where they
 * enter. What arrives downstream has passed the operator's own settings, and
 * the refusal has nothing left to protect.
 *
 * Second thing this buys, and it is not small: until now the firmware's boxes
 * reached the tracker ungated. On 640 that meant a "vehicle" at 0.30 spanning
 * the whole frame, reported on every frame — ~280 `score-floor` discards in one
 * minute, surviving only because a tracker floor happened to catch it.
 */
import type { CameraNativeDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import { makeCameraNativeDetection } from '../../__tests__/support/camera-native-detection.js'
import { onboardRootDetections } from '../detection-source-plan.js'

const FRAME = { timestamp: 1_000, width: 3840, height: 2160 }

function slot(...detections: readonly CameraNativeDetection[]) {
  return { at: 1_000, detections } as Parameters<typeof onboardRootDetections>[0]
}

const person = (confidence: number): CameraNativeDetection =>
  makeCameraNativeDetection({
    class: 'person',
    confidence,
    bbox: [0.1, 0.1, 0.2, 0.4],
  })
const vehicle = (confidence: number): CameraNativeDetection =>
  makeCameraNativeDetection({
    class: 'vehicle',
    confidence,
    bbox: [0, 0, 0.9, 0.9],
  })

describe('the onboard root obeys the operator', () => {
  // The default a camera has always had: no root-step settings, everything
  // passes. An absent gate must never mute a camera.
  it('passes everything when the operator set nothing', () => {
    const out = onboardRootDetections(slot(person(0.3), vehicle(0.3)), FRAME)
    expect(out.kind).toBe('paired')
    expect(out.kind === 'paired' && out.detections).toHaveLength(2)
  })

  it('drops a class the operator did not enable', () => {
    const out = onboardRootDetections(slot(person(0.9), vehicle(0.9)), FRAME, {
      enabledMacroClasses: ['person'],
    })
    expect(out.kind).toBe('paired')
    expect(out.kind === 'paired' && out.detections.map((d) => d.macroClass)).toEqual(['person'])
  })

  it('drops a box under the operator’s floor for ITS OWN class', () => {
    const out = onboardRootDetections(slot(person(0.9), vehicle(0.3)), FRAME, {
      minConfidencePerson: 0.5,
      minConfidenceVehicle: 0.45,
    })
    expect(out.kind === 'paired' && out.detections.map((d) => d.macroClass)).toEqual(['person'])
  })

  // An empty list is the legacy "all allowed" and must stay that way: widening
  // it into "none allowed" would silently mute every camera whose operator
  // never opened the checklist.
  it('an EMPTY class list means all, not none', () => {
    const out = onboardRootDetections(slot(person(0.9)), FRAME, { enabledMacroClasses: [] })
    expect(out.kind).toBe('paired')
  })

  // A camera muted by its own settings is not an idle camera, and the two must
  // not log as one — that is the D391 branch that accepts work and drops it.
  it('every box refused is `gated`, which is not `none`', () => {
    const out = onboardRootDetections(slot(person(0.2), vehicle(0.2)), FRAME, {
      minConfidencePerson: 0.9,
      minConfidenceVehicle: 0.9,
    })
    expect(out.kind).toBe('gated')
    expect(out.kind === 'gated' && out.refused).toBe(2)
  })

  it('a partial refusal says how many it dropped', () => {
    const out = onboardRootDetections(slot(person(0.9), vehicle(0.1)), FRAME, {
      minConfidenceVehicle: 0.9,
    })
    expect(out.kind === 'paired' && out.refused).toBe(1)
  })
})
