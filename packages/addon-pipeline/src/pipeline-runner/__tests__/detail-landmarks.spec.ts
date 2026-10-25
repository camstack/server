/**
 * A face detail's five landmarks survive the detail-plane wire, in the SAME
 * frame space as its bbox (D644). Post-analysis stores them beside the face's
 * source frame so a future alignment can be re-derived exactly; reprojecting
 * the box but not the points would put the points on the crop's pixels.
 */
import type { ObjectDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type CropSource, toDetailResult } from '../detail-subtree.js'

// A 200×100 crop cut at (1000, 500) from a frame, 2× downscaled into the crop.
const CROP: Pick<CropSource, 'width' | 'height' | 'frameSpace'> = {
  width: 200,
  height: 100,
  frameSpace: { x: 1000, y: 500, w: 400, h: 200 },
}

function face(landmarks?: ObjectDetection['landmarks']): ObjectDetection {
  return {
    id: 'f',
    kind: 'first-level',
    macroClass: 'face',
    score: 0.9,
    labels: [],
    bbox: { x: 10, y: 20, width: 30, height: 40 },
    ...(landmarks !== undefined ? { landmarks } : {}),
  }
}

describe('toDetailResult — landmarks', () => {
  it('reprojects every landmark onto the frame exactly like the bbox', () => {
    const d = toDetailResult(
      face([
        { x: 10, y: 20 },
        { x: 40, y: 60 },
      ]),
      'face-detection',
      CROP,
    )
    expect(d.bbox).toEqual({ x: 1020, y: 540, w: 60, h: 80 })
    expect(d.landmarks).toEqual([
      { x: 1020, y: 540 },
      { x: 1080, y: 620 },
    ])
  })

  it('sends none when the detector reported none — never invents points', () => {
    expect(toDetailResult(face(), 'face-detection', CROP).landmarks).toBeUndefined()
  })
})
