/**
 * Zoom and pan as a normalised viewport. The property that matters: a point
 * on screen and a point on the frame convert through ONE pair of functions
 * that account for the letterbox AND the zoom, so a box drawn at 6x lands
 * exactly where it was drawn.
 */
import { describe, expect, it } from 'vitest'
import {
  FULL_VIEWPORT,
  MAX_ZOOM,
  normToPixel,
  panBy,
  pixelToNorm,
  viewportImageRect,
  zoomAt,
  zoomLevel,
} from '../lib/retrain-zoom.js'

const image = { left: 0, top: 50, width: 400, height: 300 }

describe('pixel <-> norm through the viewport', () => {
  it('is the plain letterbox conversion at full view', () => {
    expect(pixelToNorm(200, 200, image, FULL_VIEWPORT)).toEqual({ x: 0.5, y: 0.5 })
    expect(normToPixel({ x: 0.5, y: 0.5 }, image, FULL_VIEWPORT)).toEqual({ x: 200, y: 200 })
  })

  it('round-trips at any zoom', () => {
    const vp = zoomAt(FULL_VIEWPORT, { x: 0.3, y: 0.7 }, 4)
    const px = normToPixel({ x: 0.31, y: 0.69 }, image, vp)
    const back = pixelToNorm(px.x, px.y, image, vp)
    expect(back.x).toBeCloseTo(0.31)
    expect(back.y).toBeCloseTo(0.69)
  })

  it('places the zoomed image so the viewport fills the letterboxed rect', () => {
    const vp = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }
    expect(viewportImageRect(image, vp)).toEqual({ left: -200, top: -100, width: 800, height: 600 })
  })
})

describe('zoomAt', () => {
  it('keeps the point under the pointer still', () => {
    const anchor = { x: 0.8, y: 0.2 }
    const before = normToPixel(anchor, image, FULL_VIEWPORT)
    const vp = zoomAt(FULL_VIEWPORT, anchor, 2)
    const after = normToPixel(anchor, image, vp)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(zoomLevel(vp)).toBeCloseTo(2)
  })

  it('never zooms out past the whole frame, nor in past the maximum', () => {
    expect(zoomAt(FULL_VIEWPORT, { x: 0.5, y: 0.5 }, 0.2)).toEqual(FULL_VIEWPORT)
    expect(zoomLevel(zoomAt(FULL_VIEWPORT, { x: 0.5, y: 0.5 }, 1000))).toBeCloseTo(MAX_ZOOM)
  })
})

describe('panBy', () => {
  it('moves the viewport and stops at the frame edge', () => {
    const vp = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }
    expect(panBy(vp, 0.1, -0.1)).toEqual({ x: 0.35, y: 0.15, w: 0.5, h: 0.5 })
    expect(panBy(vp, 5, 5)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
    expect(panBy(FULL_VIEWPORT, 0.3, 0.3)).toEqual(FULL_VIEWPORT)
  })
})
