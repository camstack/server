/**
 * The evidence half of the stillness input, built from the executor's frame
 * (fix round 1, review H3/H4): the look comes from `packageLooked`, an absence
 * is judged against the package step's RAW boxes, and the camera's early
 * switch reaches the tracker.
 */
import type { FrameResult } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { packageLookEvidence } from '../package-look-evidence.js'

const PACKAGES = new Set(['package'])
const frame: FrameResult = {
  kind: 'frame',
  frameId: 'f',
  deviceId: 101,
  timestamp: 1,
  width: 3840,
  height: 2160,
  detections: [
    {
      id: 'd0',
      kind: 'first-level',
      macroClass: 'package',
      score: 0.9,
      labels: [],
      bbox: { x: 1814, y: 1289, width: 613, height: 307 },
    },
    {
      id: 'd1',
      kind: 'first-level',
      macroClass: 'person',
      score: 0.8,
      labels: [],
      bbox: { x: 2174, y: 1290, width: 1131, height: 804 },
    },
  ],
  discarded: [
    { bbox: [10, 20, 110, 70], macroClass: 'package', score: 0.2, reason: 'below-threshold' },
    { bbox: [0, 0, 5, 5], macroClass: 'vehicle', score: 0.2, reason: 'below-threshold' },
  ],
}

describe('packageLookEvidence', () => {
  it('reads the look from FrameResult.packageLooked', () => {
    const base = { tracked: [], packageClasses: PACKAGES, earlyPickupEnabled: false }
    expect(packageLookEvidence({ ...base, frame: { ...frame, packageLooked: true } }).looked).toBe(
      true,
    )
    expect(packageLookEvidence({ ...base, frame }).looked).toBe(false)
  })

  it("takes the step's RAW package boxes, kept and discarded, whatever the tracker did", () => {
    const out = packageLookEvidence({
      frame,
      tracked: [],
      packageClasses: PACKAGES,
      earlyPickupEnabled: false,
    })
    expect(out.rawPackageBoxes).toEqual([
      { x: 1814, y: 1289, w: 613, h: 307 },
      { x: 10, y: 20, w: 100, h: 50 },
    ])
  })

  it('takes occluders from the tracked non-package boxes', () => {
    const out = packageLookEvidence({
      frame,
      tracked: [
        { className: 'person', bbox: { x: 1, y: 2, w: 3, h: 4 } },
        { className: 'package', bbox: { x: 9, y: 9, w: 9, h: 9 } },
      ],
      packageClasses: PACKAGES,
      earlyPickupEnabled: false,
    })
    expect(out.occluders).toEqual([{ x: 1, y: 2, w: 3, h: 4 }])
  })

  it("passes the camera's early pick-up switch through", () => {
    const base = { frame, tracked: [], packageClasses: PACKAGES }
    expect(packageLookEvidence({ ...base, earlyPickupEnabled: true }).earlyPickup).toBe(true)
    expect(packageLookEvidence({ ...base, earlyPickupEnabled: false }).earlyPickup).toBe(false)
  })
})
