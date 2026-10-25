import { describe, expect, it } from 'vitest'
import { computeNormalizedError } from '../frame-error.js'

const FRAME = { frameWidth: 1920, frameHeight: 1080 }

describe('computeNormalizedError', () => {
  it('is zero for a box centred in the frame', () => {
    expect(computeNormalizedError({ x: 860, y: 440, width: 200, height: 200 }, FRAME)).toEqual({
      x: 0,
      y: 0,
    })
  })

  it('is +0.5 / +0.5 at the far corner and -0.5 / -0.5 at the origin', () => {
    expect(computeNormalizedError({ x: 1920, y: 1080, width: 0, height: 0 }, FRAME)).toEqual({
      x: 0.5,
      y: 0.5,
    })
    expect(computeNormalizedError({ x: 0, y: 0, width: 0, height: 0 }, FRAME)).toEqual({
      x: -0.5,
      y: -0.5,
    })
  })

  it('uses the frame the payload declares, NOT the 640x640 detection view', () => {
    // The same pixel box against a 1920x1080 frame and against a square 640
    // frame must not produce the same error. If a letterbox were being
    // discounted here a second time, this would come out equal.
    const wide = computeNormalizedError({ x: 480, y: 270, width: 0, height: 0 }, FRAME)
    const square = computeNormalizedError(
      { x: 480, y: 270, width: 0, height: 0 },
      { frameWidth: 640, frameHeight: 640 },
    )
    expect(wide).not.toEqual(square)
    expect(wide).toEqual({ x: -0.25, y: -0.25 })
  })

  it('is null — never centred — when the frame geometry is unreadable (D393)', () => {
    expect(
      computeNormalizedError(
        { x: 1, y: 1, width: 1, height: 1 },
        {
          frameWidth: 0,
          frameHeight: 1080,
        },
      ),
    ).toBeNull()
    expect(
      computeNormalizedError(
        { x: 1, y: 1, width: 1, height: 1 },
        {
          frameWidth: 1920,
          frameHeight: Number.NaN,
        },
      ),
    ).toBeNull()
  })

  it('is null when the box itself is not finite', () => {
    expect(computeNormalizedError({ x: Number.NaN, y: 0, width: 10, height: 10 }, FRAME)).toBeNull()
  })
})
