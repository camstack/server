/**
 * One camera, one root detector — and a stored value never makes a camera
 * un-attachable.
 *
 * Two roots on one camera was a capability nobody asked for and it was never
 * free: both planes feed the SAME per-device stationary registry, both can
 * promote the same parked object, and the two detectors disagree about the
 * same box by construction — the disagreement D505 had to arbitrate. Removing
 * the case removes the arbitration.
 *
 * The array shape survives on purpose. Stored settings and attach payloads
 * speak it on every camera of every fleet, and a cap input that suddenly
 * refuses a stored value makes the camera un-attachable: a fail-closed in the
 * one direction that costs an operator their cameras.
 */
import { describe, expect, it } from 'vitest'

import { DetectionSourcesSchema } from '../pipeline-runner.cap.js'

describe('DetectionSourcesSchema — exactly one root', () => {
  it('accepts the one root a camera runs', () => {
    expect(DetectionSourcesSchema.parse(['pipeline'])).toEqual(['pipeline'])
    expect(DetectionSourcesSchema.parse(['onboard'])).toEqual(['onboard'])
  })

  // THE COMPATIBILITY CASE. A legacy two-root value is NORMALISED, never
  // refused: refusing it fails the attach and the camera goes dark.
  it('truncates a legacy two-root value instead of refusing it', () => {
    expect(DetectionSourcesSchema.parse(['pipeline', 'onboard'])).toEqual(['pipeline'])
    expect(DetectionSourcesSchema.parse(['onboard', 'pipeline'])).toEqual(['onboard'])
  })

  // AT MOST one, not exactly one. An EMPTY list is a legal, deliberate pick —
  // a camera an operator left with no root detector — and inventing one for
  // them is how a default acts without anybody choosing it. Tightening this to
  // `length(1)` broke it, and the suite is what caught it.
  it('keeps the empty pick legal — no root detector is a choice', () => {
    expect(DetectionSourcesSchema.parse([])).toEqual([])
  })

  it('refuses a source that is not a root detector', () => {
    expect(DetectionSourcesSchema.safeParse(['audio']).success).toBe(false)
  })
})
