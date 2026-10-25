/**
 * The box has to land on the subject, or it is a confident lie.
 *
 * Every case here is taken from device 102 on 2026-09-16: a 3840x2160
 * detection frame, a stored `keyFrameSmall` at 960x540 — a scale of 4 — and
 * the real boxes of the cars the operator marked.
 */
import { describe, expect, it } from 'vitest'

import {
  planSubjectView,
  subjectBoxSvg,
  SUBJECT_VIEW_MIN_FRAME_FRACTION,
  type ViewRect,
} from '../summary-ai-subject-view.js'

const FRAME_W = 3840
const FRAME_H = 2160
const IMG_W = 960
const IMG_H = 540

/** The parked car on 102 whose box breathes: 461x536 at x=3088 y=378. */
const CAR: ViewRect = { x: 3088, y: 378, w: 446, h: 431 }

function contains(outer: ViewRect, inner: ViewRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

describe('the view cut for the model', () => {
  it('puts the box where the subject actually is, after the 4x scale', () => {
    const v = planSubjectView(CAR, FRAME_W, FRAME_H, IMG_W, IMG_H)
    expect(v).not.toBeNull()
    if (!v) return
    // Back to image space: crop origin + box = the subject, at 1/4 scale.
    // Within ONE pixel, and the tolerance is real rather than generous: the
    // crop and the box are each rounded to whole pixels independently, so
    // their sum can sit a pixel either side of the exact value. A pixel is
    // invisible on a box; anything larger would mean the mapping is wrong.
    expect(Math.abs(v.crop.x + v.box.x - CAR.x / 4)).toBeLessThanOrEqual(1)
    expect(Math.abs(v.crop.y + v.box.y - CAR.y / 4)).toBeLessThanOrEqual(1)
    expect(Math.abs(v.box.w - CAR.w / 4)).toBeLessThanOrEqual(1)
    expect(Math.abs(v.box.h - CAR.h / 4)).toBeLessThanOrEqual(1)
  })

  it('never cuts outside the picture', () => {
    for (const bbox of [
      CAR,
      { x: 0, y: 0, w: 200, h: 200 },
      { x: 3600, y: 1900, w: 240, h: 260 },
      { x: 1900, y: 1000, w: 1900, h: 1100 },
    ]) {
      const v = planSubjectView(bbox, FRAME_W, FRAME_H, IMG_W, IMG_H)
      expect(v).not.toBeNull()
      if (!v) continue
      expect(contains({ x: 0, y: 0, w: IMG_W, h: IMG_H }, v.crop)).toBe(true)
      expect(contains({ x: 0, y: 0, w: v.crop.w, h: v.crop.h }, v.box)).toBe(true)
    }
  })

  it('keeps context around the subject rather than cutting it out', () => {
    const v = planSubjectView(CAR, FRAME_W, FRAME_H, IMG_W, IMG_H)
    if (!v) throw new Error('no view')
    // The cut is bigger than the subject on both axes — that is the context.
    expect(v.crop.w).toBeGreaterThan(v.box.w)
    expect(v.crop.h).toBeGreaterThan(v.box.h)
    // …and the subject is still the dominant thing in it.
    expect((v.box.w * v.box.h) / (v.crop.w * v.crop.h)).toBeGreaterThan(0.2)
  })

  // The phantom at the top of 102's frame: 175x91 on a 4K frame is 44x23 once
  // scaled. Padded by 60 % it is a stamp; the floor widens the view instead.
  it('widens the view for a distant subject rather than magnifying noise', () => {
    const tiny: ViewRect = { x: 2490, y: 1, w: 175, h: 91 }
    const v = planSubjectView(tiny, FRAME_W, FRAME_H, IMG_W, IMG_H)
    expect(v).not.toBeNull()
    if (!v) return
    const floor = Math.min(IMG_W, IMG_H) * SUBJECT_VIEW_MIN_FRAME_FRACTION
    expect(v.crop.w).toBeGreaterThanOrEqual(floor - 1)
    expect(v.crop.h).toBeGreaterThanOrEqual(floor - 1)
  })

  // A subject flush with an edge must not drag the crop off the canvas, and
  // its box must stop at the edge rather than being drawn beyond it.
  it('handles a subject against the frame edge', () => {
    const edge: ViewRect = { x: 0, y: 1800, w: 300, h: 360 }
    const v = planSubjectView(edge, FRAME_W, FRAME_H, IMG_W, IMG_H)
    expect(v).not.toBeNull()
    if (!v) return
    expect(v.crop.x).toBeGreaterThanOrEqual(0)
    expect(v.crop.y + v.crop.h).toBeLessThanOrEqual(IMG_H)
    expect(v.box.x).toBeGreaterThanOrEqual(0)
  })

  /**
   * Nothing honest to draw ⇒ no view, and the caller sends the picture it
   * already had. A missing box costs a hint; an invented one costs the truth.
   */
  it('refuses rather than guessing', () => {
    expect(planSubjectView(CAR, 0, 0, IMG_W, IMG_H)).toBeNull()
    expect(planSubjectView(CAR, FRAME_W, FRAME_H, 0, 0)).toBeNull()
    expect(planSubjectView({ x: 10, y: 10, w: 0, h: 0 }, FRAME_W, FRAME_H, IMG_W, IMG_H)).toBeNull()
    // A box that lies entirely off the frame is not this picture's subject.
    expect(
      planSubjectView({ x: 9000, y: 9000, w: 100, h: 100 }, FRAME_W, FRAME_H, IMG_W, IMG_H),
    ).toBeNull()
  })
})

describe('the overlay is a rectangle and nothing else', () => {
  it('draws one stroked rect inside the canvas', () => {
    const v = planSubjectView(CAR, FRAME_W, FRAME_H, IMG_W, IMG_H)
    if (!v) throw new Error('no view')
    const svg = subjectBoxSvg(v.crop, v.box)
    expect(svg.match(/<rect /g)).toHaveLength(1)
    expect(svg).toContain('fill="none"')
    expect(svg).toContain(`width="${String(v.crop.w)}"`)
  })

  /**
   * THE RULE THAT MUST NOT EROMPE. D121: a model treated text found inside an
   * image as an instruction. The overlay carries no text node, no font, no
   * label — and this is the test that stops a future "just a small caption".
   */
  it('carries no text of any kind', () => {
    const v = planSubjectView(CAR, FRAME_W, FRAME_H, IMG_W, IMG_H)
    if (!v) throw new Error('no view')
    const svg = subjectBoxSvg(v.crop, v.box)
    for (const forbidden of ['<text', '<tspan', 'font-', '<foreignObject', '<image']) {
      expect(svg).not.toContain(forbidden)
    }
  })

  it('keeps the stroke inside the canvas for an edge-hugging subject', () => {
    const v = planSubjectView({ x: 0, y: 0, w: 400, h: 400 }, FRAME_W, FRAME_H, IMG_W, IMG_H)
    if (!v) throw new Error('no view')
    const svg = subjectBoxSvg(v.crop, v.box)
    const nums = [...svg.matchAll(/(x|y|width|height)="([-\d.]+)"/g)].map((m) => Number(m[2]))
    expect(nums.every((n) => n >= 0)).toBe(true)
  })
})
