/**
 * FrameProcessor mask wiring test — Task 5.
 *
 * Verifies that when a first-level detection carries root mask/maskWidth/maskHeight
 * fields (promoted by Task 2), `process()` decodes the base64 mask and passes it
 * as the 5th–7th arguments to `zoneEngine.splitDetectionZones`.
 *
 * The spy target moved from `annotateDetection` on 2026-07-31, when the zone
 * annotation loop switched to `splitDetectionZones` to keep the overlaps the
 * membership bar rejects. The first test caught the move by failing; the second
 * would have kept PASSING against a function the loop no longer calls, asserting
 * only that a mask never reached code that no longer runs.
 *
 * Construction mirrors `frame-processor.spec.ts` exactly — `new FrameProcessor(4)`
 * uses the internal tracker (v2, D683) which requires minHits=3 frames before
 * promoting a detection to a track. Because `maskByBbox` is keyed by the BoundingBox object
 * created in `flatDetections`, and the tracker PRESERVES that object reference
 * through match/spawn (same trick as `labelsByBbox`/`embeddingByBbox`), the mask
 * lookup on `td.bbox` will find the stored value only when the tracker returns the
 * same bbox object. We verify this by running 3 frames and asserting on frame 3.
 */
import { describe, it, expect, vi } from 'vitest'
import type { FrameResult, ObjectDetection, Zone } from '@camstack/types'
import { FrameProcessor } from '../pipeline/frame-processor.js'
import { ZoneEngine } from '../pipeline/zones/zone-engine.js'

const DEFAULT_SIZE = { width: 640, height: 480 }

function makeFrame(detections: readonly ObjectDetection[], timestamp: number): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: 4,
    timestamp,
    width: DEFAULT_SIZE.width,
    height: DEFAULT_SIZE.height,
    detections,
  }
}

describe('FrameProcessor — mask wiring', () => {
  it('passes the decoded mask into splitDetectionZones when a detection has one', () => {
    // Spy on the real ZoneEngine's splitDetectionZones so we can capture args.
    const annotate = vi.spyOn(ZoneEngine.prototype, 'splitDetectionZones')

    // Add a zone so splitDetectionZones is actually called (it iterates zones).
    const zone: Zone = {
      id: 'z1',
      name: 'zone1',
      kind: 'polygon',
      polygon: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      color: '#3b82f6',
    }

    const processor = new FrameProcessor(4)
    processor.setZones([zone])

    // 2×2 mask: 4 bytes, base64-encoded.
    const rawMask = new Uint8Array([255, 0, 0, 255])
    const mask = Buffer.from(rawMask).toString('base64')

    const det: ObjectDetection = {
      id: 'd1',
      kind: 'first-level',
      macroClass: 'person',
      score: 0.9,
      labels: [],
      bbox: { x: 10, y: 10, width: 100, height: 200 },
      mask,
      maskWidth: 2,
      maskHeight: 2,
    }

    // Run 3 frames (minHits=3) with the same detection so the tracker promotes it.
    const frame1 = makeFrame([det], 1000)
    const frame2 = makeFrame([det], 1100)
    const frame3 = makeFrame([det], 1200)

    processor.process({ timestamp: 1000, frame: frame1 })
    processor.process({ timestamp: 1100, frame: frame2 })
    annotate.mockClear() // clear calls from warm-up frames; only inspect frame 3
    processor.process({ timestamp: 1200, frame: frame3 })

    // splitDetectionZones is called at least once per tracked detection on frame 3
    // (the zone annotation loop). filterDetections still goes through
    // annotateDetection and never carries a mask, so a Uint8Array in arg 4 can
    // only have come from the annotation loop.
    expect(annotate).toHaveBeenCalled()

    // Find the call from the zone annotation loop (has mask).
    const maskCall = annotate.mock.calls.find((args) => args[4] instanceof Uint8Array)
    expect(maskCall).toBeDefined()

    // The 5th argument (index 4) must be a Uint8Array of length 4 (2×2).
    const maskArg = maskCall?.[4]
    expect(maskArg).toBeInstanceOf(Uint8Array)
    expect((maskArg as Uint8Array).length).toBe(4)

    // maskWidth and maskHeight must be passed as the 6th and 7th args.
    expect(maskCall?.[5]).toBe(2)
    expect(maskCall?.[6]).toBe(2)

    annotate.mockRestore()
  })

  it('passes undefined mask args when the detection has no mask', () => {
    const annotate = vi.spyOn(ZoneEngine.prototype, 'splitDetectionZones')

    const zone: Zone = {
      id: 'z2',
      name: 'zone2',
      kind: 'polygon',
      polygon: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      color: '#3b82f6',
    }

    const processor = new FrameProcessor(4)
    processor.setZones([zone])

    const det: ObjectDetection = {
      id: 'd2',
      kind: 'first-level',
      macroClass: 'vehicle',
      score: 0.8,
      labels: [],
      bbox: { x: 50, y: 50, width: 80, height: 60 },
    }

    const frame = (ts: number): FrameResult => makeFrame([det], ts)
    processor.process({ timestamp: 1000, frame: frame(1000) })
    processor.process({ timestamp: 1100, frame: frame(1100) })
    annotate.mockClear()
    processor.process({ timestamp: 1200, frame: frame(1200) })

    expect(annotate).toHaveBeenCalled()
    // No mask: none of the calls should have a Uint8Array as the 5th argument.
    const maskCall = annotate.mock.calls.find((args) => args[4] instanceof Uint8Array)
    expect(maskCall).toBeUndefined()

    annotate.mockRestore()
  })
})
