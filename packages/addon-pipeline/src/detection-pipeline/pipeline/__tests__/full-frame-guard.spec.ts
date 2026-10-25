import { describe, it, expect } from 'vitest'
import type { AbsoluteBbox } from '../crop-utils.js'
import {
  isFullFramePhantomDetection,
  FULL_FRAME_AREA_RATIO,
  FULL_FRAME_DIMENSION_RATIO,
  FULL_FRAME_MAX_CONFIDENCE,
  isFullFrameSurvivor,
} from '../full-frame-guard.js'

/**
 * Detection-stage full-frame phantom guard (operator-reported cam 101): a
 * "vehicle 52%" bbox covering the whole empty frame polluted the live overlay,
 * the tracker occupancy chip and downstream events. The guard drops a
 * near-full-frame detection UNLESS its confidence is high enough to trust a
 * genuine close-up subject (mirrors the media-stage best-thumbnail guard).
 */
const FRAME_W = 640
const FRAME_H = 360

// Helper: build an xyxy bbox from top-left + size.
const box = (x: number, y: number, w: number, h: number): AbsoluteBbox => [x, y, x + w, y + h]

describe('isFullFramePhantomDetection', () => {
  it('drops a full-frame low-confidence box (the cam-101 "vehicle 52%" phantom)', () => {
    const bbox = box(0, 0, FRAME_W, FRAME_H) // area ratio 1.0
    expect(isFullFramePhantomDetection(bbox, FRAME_W, FRAME_H, 0.52)).toBe(true)
  })

  it('keeps a full-frame HIGH-confidence box (genuine close-up subject at the lens)', () => {
    const bbox = box(0, 0, FRAME_W, FRAME_H)
    expect(isFullFramePhantomDetection(bbox, FRAME_W, FRAME_H, 0.9)).toBe(false)
  })

  it('keeps a normal subject-sized box regardless of confidence', () => {
    const bbox = box(100, 80, 120, 90) // ~4.7% area, well under any span gate
    expect(isFullFramePhantomDetection(bbox, FRAME_W, FRAME_H, 0.3)).toBe(false)
    expect(isFullFramePhantomDetection(bbox, FRAME_W, FRAME_H, 0.99)).toBe(false)
  })

  it('drops a full-COLUMN low-confidence artifact (spans frame height, ~narrow width)', () => {
    // width 40/640 = 6% area, but height 360/360 spans the full column.
    const bbox = box(120, 0, 40, FRAME_H)
    expect(isFullFramePhantomDetection(bbox, FRAME_W, FRAME_H, 0.4)).toBe(true)
  })

  it('drops a full-ROW low-confidence artifact (spans frame width, ~narrow height)', () => {
    const bbox = box(0, 150, FRAME_W, 30)
    expect(isFullFramePhantomDetection(bbox, FRAME_W, FRAME_H, 0.4)).toBe(true)
  })

  it('keeps a full-column box when confidence clears the bar', () => {
    const bbox = box(120, 0, 40, FRAME_H)
    expect(isFullFramePhantomDetection(bbox, FRAME_W, FRAME_H, FULL_FRAME_MAX_CONFIDENCE)).toBe(
      false,
    )
  })

  it('treats confidence exactly at the bar as trusted (>= bar survives)', () => {
    const bbox = box(0, 0, FRAME_W, FRAME_H)
    expect(isFullFramePhantomDetection(bbox, FRAME_W, FRAME_H, FULL_FRAME_MAX_CONFIDENCE)).toBe(
      false,
    )
    expect(
      isFullFramePhantomDetection(bbox, FRAME_W, FRAME_H, FULL_FRAME_MAX_CONFIDENCE - 0.0001),
    ).toBe(true)
  })

  it('area boundary: at/over FULL_FRAME_AREA_RATIO drops, clearly under survives (low conf)', () => {
    // Both dimensions at 0.95 → area 0.9025 (≥0.90) but each axis < 0.98 gate,
    // so the AREA gate alone is the trigger.
    const w = Math.round(FRAME_W * 0.95) // 608, below 0.98 dim gate
    const h = Math.round(FRAME_H * 0.95) // 342, area 608*342/(640*360) = 0.9026
    const at = box(0, 0, w, h)
    expect(isFullFramePhantomDetection(at, FRAME_W, FRAME_H, 0.5)).toBe(true)

    // Both dimensions at 0.7 → area 0.49, no gate crossed.
    const under = box(0, 0, Math.round(FRAME_W * 0.7), Math.round(FRAME_H * 0.7))
    expect(isFullFramePhantomDetection(under, FRAME_W, FRAME_H, 0.5)).toBe(false)
  })

  it('dimension boundary: >=0.98 of a dimension drops, just under survives (low conf)', () => {
    const wAt = Math.ceil(FRAME_W * FULL_FRAME_DIMENSION_RATIO) // >=627.2 -> 628
    const atW = box(0, 100, wAt, 40) // narrow height so area gate is not the trigger
    expect(isFullFramePhantomDetection(atW, FRAME_W, FRAME_H, 0.5)).toBe(true)

    const underW = box(0, 100, Math.floor(FRAME_W * 0.9), 40) // 576 wide, 90%
    expect(isFullFramePhantomDetection(underW, FRAME_W, FRAME_H, 0.5)).toBe(false)
  })

  it('returns false (no info) for degenerate frame dimensions', () => {
    const bbox = box(0, 0, 10, 10)
    expect(isFullFramePhantomDetection(bbox, 0, FRAME_H, 0.1)).toBe(false)
    expect(isFullFramePhantomDetection(bbox, FRAME_W, 0, 0.1)).toBe(false)
  })

  it('honours a caller-supplied confidence bar override', () => {
    const bbox = box(0, 0, FRAME_W, FRAME_H)
    // With a stricter bar of 0.95, a 0.9 full-frame box is now a phantom.
    expect(isFullFramePhantomDetection(bbox, FRAME_W, FRAME_H, 0.9, 0.95)).toBe(true)
    // With a lax bar of 0.4, the same 0.52 box survives.
    expect(isFullFramePhantomDetection(bbox, FRAME_W, FRAME_H, 0.52, 0.4)).toBe(false)
  })

  it('exposes documented constant values', () => {
    expect(FULL_FRAME_AREA_RATIO).toBe(0.9)
    expect(FULL_FRAME_DIMENSION_RATIO).toBe(0.98)
    expect(FULL_FRAME_MAX_CONFIDENCE).toBe(0.7)
  })
})

/**
 * Score-independent hard-area cut.
 *
 * Measured on device 101, 2026-07-30: SIX `vehicle` detections with a box at
 * 94.4% of the frame area and 99.6% of its width — the exact shape this guard
 * exists for — scored 0.710, 0.716, 0.731, 0.734, 0.760 and 0.787, all above
 * the 0.70 bar, and all survived. Each was then stamped with every zone it
 * touched, so it could satisfy any zone-scoped notification rule.
 *
 * Raising the score bar is not the fix: the module's own note puts genuine
 * close-ups at 0.65-0.85, so a higher bar trades real subjects for phantoms.
 * On an overhead courtyard camera a box covering ~the whole frame is never a
 * subject AT ANY SCORE; on a doorbell it might be. So the cut is per-camera and
 * DISABLED by default.
 */
describe('hard area cut (score-independent)', () => {
  const FW = 640
  const FH = 360
  /** The real 2026-07-30 phantom: 637.2 x 341.4 on 640x360. */
  const phantom: AbsoluteBbox = [0, 0, 637.2, 341.4]

  it('is DISABLED by default — a high-score full-frame box still survives', () => {
    expect(isFullFramePhantomDetection(phantom, FW, FH, 0.787)).toBe(false)
  })

  it('drops the observed phantom at any of its six real scores once armed', () => {
    for (const score of [0.71, 0.716, 0.731, 0.7344, 0.76, 0.787]) {
      expect(isFullFramePhantomDetection(phantom, FW, FH, score, undefined, 0.92)).toBe(true)
    }
  })

  it('still drops it via the SCORE path when the score is low and the cut is off', () => {
    expect(isFullFramePhantomDetection(phantom, FW, FH, 0.52)).toBe(true)
  })

  it('leaves a normal subject alone even with the cut armed', () => {
    const person: AbsoluteBbox = [280, 150, 340, 260] // ~2.9% of frame
    expect(isFullFramePhantomDetection(person, FW, FH, 0.9, undefined, 0.92)).toBe(false)
    expect(isFullFramePhantomDetection(person, FW, FH, 0.4, undefined, 0.92)).toBe(false)
  })

  it('does not fire below the configured area, whatever the score', () => {
    // 0.85 of the frame — under a 0.92 cut, and above the 0.70 score bar.
    const big: AbsoluteBbox = [0, 0, 640, 306]
    expect((640 * 306) / (FW * FH)).toBeCloseTo(0.85, 2)
    expect(isFullFramePhantomDetection(big, FW, FH, 0.9, undefined, 0.92)).toBe(false)
  })

  it('ignores a nonsense cut instead of dropping everything', () => {
    const person: AbsoluteBbox = [280, 150, 340, 260]
    expect(isFullFramePhantomDetection(person, FW, FH, 0.9, undefined, 0)).toBe(false)
    expect(isFullFramePhantomDetection(person, FW, FH, 0.9, undefined, Number.NaN)).toBe(false)
  })
})

describe('isFullFrameSurvivor — the ones worth counting', () => {
  const FW = 640
  const FH = 360
  const phantom: AbsoluteBbox = [0, 0, 637.2, 341.4] // the real 2026-07-30 box

  it('flags a full-frame box that cleared the score bar', () => {
    for (const score of [0.71, 0.7344, 0.787]) {
      expect(isFullFrameSurvivor(phantom, FW, FH, score)).toBe(true)
    }
  })

  it('does NOT flag one the guard already dropped — it never survived', () => {
    expect(isFullFrameSurvivor(phantom, FW, FH, 0.52)).toBe(false)
  })

  it('does NOT flag an ordinary subject at any score', () => {
    const person: AbsoluteBbox = [280, 150, 340, 260]
    expect(isFullFrameSurvivor(person, FW, FH, 0.95)).toBe(false)
    expect(isFullFrameSurvivor(person, FW, FH, 0.4)).toBe(false)
  })

  it('flags a full-COLUMN artifact too, not only a full-area one', () => {
    const column: AbsoluteBbox = [300, 0, 340, 360] // 6% area, 100% height
    expect(isFullFrameSurvivor(column, FW, FH, 0.9)).toBe(true)
  })
})
