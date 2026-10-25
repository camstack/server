/**
 * The decidable half of the annotation canvas.
 *
 * The property that matters is the LETTERBOX one: the canvas renders the frame
 * `object-contain`, so the image does not fill its element and a pointer
 * converted with the element's own rectangle offsets every box on any camera
 * whose aspect ratio differs from the pane's. It is the single most likely way
 * for this page to produce a dataset full of boxes that are subtly wrong — and
 * subtly wrong is the kind nobody notices until the fine-tune is worse.
 */
import { describe, expect, it } from 'vitest'
import {
  boxAtPoint,
  boxStyle,
  displayedImageRect,
  dragToBox,
  isDrawnBox,
  pointerToNorm,
} from '../lib/retrain-boxes.js'

describe('displayedImageRect', () => {
  it('bars the TOP and BOTTOM when the container is taller than the image', () => {
    // 16:9 image in a 400×400 pane → 400×225, centred vertically.
    const rect = displayedImageRect(400, 400, 1920, 1080)!
    expect(rect.width).toBe(400)
    expect(rect.height).toBe(225)
    expect(rect.left).toBe(0)
    expect(rect.top).toBe(87.5)
  })

  it('bars the SIDES when the container is wider than the image', () => {
    const rect = displayedImageRect(400, 200, 1080, 1080)!
    expect(rect.height).toBe(200)
    expect(rect.width).toBe(200)
    expect(rect.left).toBe(100)
  })

  it('returns null on a zero dimension rather than dividing by it', () => {
    expect(displayedImageRect(0, 400, 1920, 1080)).toBeNull()
    expect(displayedImageRect(400, 400, 1920, 0)).toBeNull()
  })
})

describe('pointerToNorm', () => {
  it('accounts for the letterbox bars — the centre of the image is 0.5, 0.5', () => {
    const image = displayedImageRect(400, 400, 1920, 1080)!
    expect(pointerToNorm(200, 200, image)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('clamps a pointer dragged onto the bars to the image edge', () => {
    const image = displayedImageRect(400, 400, 1920, 1080)!
    expect(pointerToNorm(200, 10, image).y).toBe(0)
    expect(pointerToNorm(200, 390, image).y).toBe(1)
  })

  it('round-trips through boxStyle', () => {
    const image = displayedImageRect(400, 400, 1920, 1080)!
    const box = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }
    const style = boxStyle(box, image)
    expect(pointerToNorm(style.left, style.top, image)).toEqual({ x: 0.25, y: 0.25 })
  })
})

describe('dragToBox', () => {
  it('is direction-agnostic', () => {
    const down = dragToBox({ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.5 })
    const up = dragToBox({ x: 0.6, y: 0.5 }, { x: 0.2, y: 0.2 })
    expect(down).toEqual(up)
    expect(down.w).toBeCloseTo(0.4, 10)
  })

  it('a click is not a box', () => {
    expect(isDrawnBox(dragToBox({ x: 0.5, y: 0.5 }, { x: 0.502, y: 0.503 }))).toBe(false)
    expect(isDrawnBox(dragToBox({ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.6 }))).toBe(true)
  })
})

describe('boxAtPoint', () => {
  it('picks the SMALLEST box containing the point, not the outermost', () => {
    const person = { x: 0.1, y: 0.1, w: 0.6, h: 0.8 }
    const parcel = { x: 0.3, y: 0.5, w: 0.1, h: 0.1 }
    expect(boxAtPoint([person, parcel], { x: 0.35, y: 0.55 })).toBe(1)
  })

  it('reports -1 when nothing is under the point', () => {
    expect(boxAtPoint([{ x: 0, y: 0, w: 0.1, h: 0.1 }], { x: 0.9, y: 0.9 })).toBe(-1)
  })
})
