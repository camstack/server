/**
 * The plate-OCR crop margin.
 *
 * The margin belongs to the DETECTOR's box. `yolov8n-plate` clipped the leading
 * glyph of an oblique plate and needed +15% to put it back; `yolox-tiny-plate`
 * (D719) draws bigger boxes, and on them +15% shrank the plate in the reader's
 * tile and cost ~8 readings, while +5% reached parity. These tests pin the
 * shipped margin, the arithmetic and the two ways it must NOT misbehave: it
 * must never move the box for a reader that asked for no margin, and it must
 * never leave the frame.
 */
import { describe, expect, it } from 'vitest'
import type { AbsoluteBbox } from '../crop-utils.js'
import { expandBbox, resolvePlateOcrCropPolicy } from '../plate-ocr-crop-policy.js'

const FRAME_W = 3840
const FRAME_H = 2160

describe('expandBbox', () => {
  it('grows by the fraction of the box size on each side', () => {
    const bbox: AbsoluteBbox = [1000, 500, 1200, 600]
    // 200 wide, 100 tall → +30 / +15 on each side at 0.15.
    expect(expandBbox(bbox, 0.15, FRAME_W, FRAME_H)).toEqual([970, 485, 1230, 615])
  })

  it('is a no-op at margin 0 — the CTC reader keeps its exact pixels', () => {
    const bbox: AbsoluteBbox = [1000, 500, 1200, 600]
    expect(expandBbox(bbox, 0, FRAME_W, FRAME_H)).toEqual([1000, 500, 1200, 600])
  })

  it('clamps to the frame instead of producing negative or out-of-frame edges', () => {
    // A plate against the left edge: the margin must be TAKEN, not invented.
    const bbox: AbsoluteBbox = [10, 5, 110, 55]
    expect(expandBbox(bbox, 0.15, FRAME_W, FRAME_H)).toEqual([0, 0, 125, 62.5])
  })

  it('clamps against the right/bottom edge too', () => {
    const bbox: AbsoluteBbox = [FRAME_W - 100, FRAME_H - 50, FRAME_W, FRAME_H]
    expect(expandBbox(bbox, 0.15, FRAME_W, FRAME_H)).toEqual([
      FRAME_W - 115,
      FRAME_H - 57.5,
      FRAME_W,
      FRAME_H,
    ])
  })

  it('leaves a degenerate box alone rather than inventing area for it', () => {
    const degenerate: AbsoluteBbox = [100, 100, 100, 100]
    expect(expandBbox(degenerate, 0.15, FRAME_W, FRAME_H)).toEqual([100, 100, 100, 100])
  })

  it('ignores a negative margin instead of shrinking the box', () => {
    const bbox: AbsoluteBbox = [1000, 500, 1200, 600]
    expect(expandBbox(bbox, -0.15, FRAME_W, FRAME_H)).toEqual([1000, 500, 1200, 600])
  })
})

describe('resolvePlateOcrCropPolicy', () => {
  it('pads the slot reader by 5% — sized for the yolox-tiny-plate box (D719)', () => {
    expect(resolvePlateOcrCropPolicy('plate-slots')).toEqual({
      marginFraction: 0.05,
      rectify: false,
      minLongSidePx: 70,
    })
  })

  it('never returns a policy for a non-plate postprocessor', () => {
    // The executor applies the margin, the floor AND the rectify decision from
    // this one lookup, so a stray match would re-frame face and package crops.
    for (const postprocessor of ['yolo', 'scrfd', 'arcface', 'clip', 'softmax'] as const) {
      expect(resolvePlateOcrCropPolicy(postprocessor)).toBeNull()
    }
  })

  it('never pairs a margin with the rectifier', () => {
    // Both readers exist because their pixels are incompatible: rectifying a
    // padded tile finds the plate blob inside a bigger field and produces a
    // strip neither reader was measured on.
    for (const postprocessor of ['ctc', 'plate-slots'] as const) {
      const policy = resolvePlateOcrCropPolicy(postprocessor)
      expect(policy).not.toBeNull()
      expect(policy && policy.marginFraction > 0 && policy.rectify).toBe(false)
    }
  })
})
