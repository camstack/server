/**
 * D730 — the one face-scoped square a root face box is refined in.
 */
import { describe, expect, it } from 'vitest'
import { deriveRootFaceRefineRect, ROOT_FACE_REFINE_SCALE } from '../root-face-crop.js'

describe('deriveRootFaceRefineRect', () => {
  it('is a square of 1.6× the longer side, centred on the face', () => {
    const r = deriveRootFaceRefineRect({ x: 1000, y: 500, w: 50, h: 80 }, 3840, 2160)
    expect(r.w).toBe(80 * ROOT_FACE_REFINE_SCALE)
    expect(r.h).toBe(r.w)
    expect(r.x + r.w / 2).toBe(1025)
    expect(r.y + r.h / 2).toBe(540)
  })

  it('slides inside the frame at an edge instead of truncating', () => {
    const r = deriveRootFaceRefineRect({ x: 0, y: 0, w: 40, h: 40 }, 1920, 1080)
    expect(r).toEqual({ x: 0, y: 0, w: 64, h: 64 })
  })

  it('never exceeds the frame', () => {
    const r = deriveRootFaceRefineRect({ x: 10, y: 10, w: 300, h: 300 }, 400, 300)
    expect(r).toEqual({ x: 10, y: 0, w: 300, h: 300 })
  })
})
