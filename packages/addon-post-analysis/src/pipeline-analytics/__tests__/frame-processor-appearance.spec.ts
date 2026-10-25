/**
 * The descriptor rides the flatten step onto the tracker's input (D683 §8.1).
 *
 * Disarm: remove the `appearance` mirror in the flatten — the test fails.
 */
import { APPEARANCE_BIN_COUNT, type FrameResult } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { FrameProcessor } from '../pipeline/frame-processor.js'

describe('FrameProcessor flatten', () => {
  it('mirrors ObjectDetection.appearance onto the tracker input', () => {
    const p = new FrameProcessor(1, { minHits: 1 })
    const appearance = {
      version: 1 as const,
      bins: new Array<number>(APPEARANCE_BIN_COUNT).fill(3),
      gray: false,
    }
    const frame: FrameResult = {
      kind: 'frame',
      frameId: 'f',
      deviceId: 1,
      timestamp: 1000,
      width: 640,
      height: 360,
      detections: [
        {
          id: 'p',
          kind: 'first-level',
          macroClass: 'person',
          score: 0.9,
          labels: [],
          bbox: { x: 10, y: 10, width: 100, height: 200 },
          appearance,
        },
      ],
    }
    const out = p.process({ timestamp: 1000, frame })
    expect(out.rawTrackedDetections[0]?.appearance).toEqual(appearance)
  })
})
