import { describe, expect, it } from 'vitest'
import {
  MAX_LETTERBOX_FRACTION,
  WIDE_THUMBNAIL_ASPECT_H,
  WIDE_THUMBNAIL_ASPECT_W,
  WIDE_THUMBNAIL_SMALL_MAX_WIDTH,
  wideCentralSquareLayout,
} from '../wide-central-square-crop.js'
import type { PixelBbox, FrameDims } from '../square-safe-crop.js'

/** Map a frame-x to canvas-x for a layout (canvas-x = frameX − frameOriginX). */
function toCanvasX(frameX: number, frameOriginX: number): number {
  return frameX - frameOriginX
}

/** Assert the subject bbox lands FULLY inside the WINDOW.
 *
 *  This is the contract, and it is weaker than it used to be on purpose. The
 *  window was previously anchored so the subject stayed in the canvas-middle
 *  square, which meant an edge subject kept lateral padding the consumer filled
 *  with a blurred band. Since 2026-07-31 the window clamps fully in-frame and
 *  the subject may sit off-centre — containment is what a best shot owes, not
 *  centring. Allows 1px of rounding slack. */
function expectSubjectInWindow(
  bbox: PixelBbox,
  layout: ReturnType<typeof wideCentralSquareLayout>,
): void {
  const leftCanvas = toCanvasX(bbox.x, layout.frameOriginX)
  const rightCanvas = toCanvasX(bbox.x + bbox.w, layout.frameOriginX)
  expect(leftCanvas).toBeGreaterThanOrEqual(-1)
  expect(rightCanvas).toBeLessThanOrEqual(layout.canvasW + 1)
}

/** Assert the window carries NO padding: the fetched slab spans the whole
 *  canvas, so `composeWideCentralSquareThumbnail` returns it verbatim and no
 *  blurred ambience is ever synthesized. */
function expectNoPadding(layout: ReturnType<typeof wideCentralSquareLayout>): void {
  expect(layout.slabOffsetX).toBeCloseTo(0, 5)
  expect(layout.slabW).toBeCloseTo(layout.canvasW, 5)
}

describe('wideCentralSquareLayout', () => {
  it('produces a 16:9 canvas (canvasW/canvasH ≈ 16/9)', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    const bbox: PixelBbox = { x: 900, y: 500, w: 120, h: 200 }
    const layout = wideCentralSquareLayout(bbox, frame)
    expect(layout.canvasW / layout.canvasH).toBeCloseTo(
      WIDE_THUMBNAIL_ASPECT_W / WIDE_THUMBNAIL_ASPECT_H,
      1,
    )
    // Central square side === canvas height.
    expect(layout.centralSide).toBe(layout.canvasH)
  })

  it('CENTERED subject → subject sits in the central square, full lateral context, no padding', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    const bbox: PixelBbox = { x: 900, y: 440, w: 120, h: 200 }
    const layout = wideCentralSquareLayout(bbox, frame)
    expectSubjectInWindow(bbox, layout)
    // Whole 16:9 window is inside the frame → the fetched slab spans the full
    // canvas (no lateral letterbox padding).
    expect(layout.slabOffsetX).toBeCloseTo(0, 5)
    expect(layout.slabW).toBeCloseTo(layout.canvasW, 5)
  })

  it('subject at the LEFT edge → window slides fully in-frame, NO padding', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    // Subject hugging the left edge.
    const bbox: PixelBbox = { x: 8, y: 440, w: 120, h: 200 }
    const layout = wideCentralSquareLayout(bbox, frame)
    // The window no longer hangs off the frame — it starts AT the edge.
    expect(layout.frameOriginX).toBeCloseTo(0, 5)
    expectNoPadding(layout)
    expectSubjectInWindow(bbox, layout)
  })

  it('subject at the RIGHT edge → window slides fully in-frame, NO padding', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    const bbox: PixelBbox = { x: 1920 - 8 - 120, y: 440, w: 120, h: 200 }
    const layout = wideCentralSquareLayout(bbox, frame)
    // The window ends exactly at the right frame border.
    expect(layout.frameOriginX + layout.canvasW).toBeCloseTo(frame.W, 5)
    expectNoPadding(layout)
    expectSubjectInWindow(bbox, layout)
  })

  it('subject FLUSH against the right border → still no padding, and it is OFF-CENTRE', () => {
    // The reported case: device 102, a person exiting frame right
    // (`envelope.maxX ≈ 0.999`). The old geometry could not slide here — the
    // subject had zero slack inside the central square — so the best shot came
    // back with a blurred band over its right quarter.
    const frame: FrameDims = { W: 640, H: 360 }
    const bbox: PixelBbox = { x: 597.8, y: 261.3, w: 41.7, h: 85.8 }
    const layout = wideCentralSquareLayout(bbox, frame)
    expectNoPadding(layout)
    expectSubjectInWindow(bbox, layout)
    // And the price, stated rather than hidden: the subject is NOT centred.
    const centreCanvas = toCanvasX(bbox.x + bbox.w / 2, layout.frameOriginX)
    expect(centreCanvas).toBeGreaterThan(layout.centralX0 + layout.centralSide)
  })

  it('NARROW (4:3) frame, tall subject → window wider than frame → lateral padding, subject in central square', () => {
    const frame: FrameDims = { W: 64, H: 48 }
    // Tall subject near the middle: central square ≈ 12, window ≈ 21 (fits 64),
    // so this actually fits; use a large subject to force clamping.
    const bbox: PixelBbox = { x: 8, y: 4, w: 20, h: 40 }
    const layout = wideCentralSquareLayout(bbox, frame)
    expectSubjectInWindow(bbox, layout)
    // fetch region stays within [0,1].
    expect(layout.fetch.x).toBeGreaterThanOrEqual(0)
    expect(layout.fetch.x + layout.fetch.w).toBeLessThanOrEqual(1 + 1e-9)
    expect(layout.fetch.y).toBeGreaterThanOrEqual(0)
    expect(layout.fetch.y + layout.fetch.h).toBeLessThanOrEqual(1 + 1e-9)
  })

  it('the fetch region never exceeds the frame bounds (clamped, normalized ≤ 1)', () => {
    const frame: FrameDims = { W: 1280, H: 720 }
    for (const bbox of [
      { x: 0, y: 0, w: 40, h: 60 },
      { x: 1240, y: 660, w: 40, h: 60 },
      { x: 600, y: 300, w: 100, h: 100 },
    ] satisfies PixelBbox[]) {
      const layout = wideCentralSquareLayout(bbox, frame)
      expect(layout.fetch.x).toBeGreaterThanOrEqual(0)
      expect(layout.fetch.y).toBeGreaterThanOrEqual(0)
      expect(layout.fetch.x + layout.fetch.w).toBeLessThanOrEqual(1 + 1e-9)
      expect(layout.fetch.y + layout.fetch.h).toBeLessThanOrEqual(1 + 1e-9)
      expect(layout.slabOffsetX).toBeGreaterThanOrEqual(0)
      expectSubjectInWindow(bbox, layout)
    }
  })

  it('uses a 480 long-side cap (16:9 → 270 tall)', () => {
    expect(WIDE_THUMBNAIL_SMALL_MAX_WIDTH).toBe(480)
  })
})

// ── 2026-07-22: letterbox minimisation — slide the window in-frame ───────────
describe('wideCentralSquareLayout in-frame slide', () => {
  it('near-edge subject WITH slack → window slides fully in-frame (no padding)', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    // Subject near (not flush against) the right edge; its square has 60px of
    // lateral slack — more than the 16:9 window's ~54px overflow.
    const bbox: PixelBbox = { x: 1700, y: 440, w: 120, h: 200 }
    const layout = wideCentralSquareLayout(bbox, frame)
    expect(layout.frameOriginX).toBeGreaterThanOrEqual(0)
    expect(layout.frameOriginX + layout.canvasW).toBeLessThanOrEqual(frame.W + 1)
    expect(layout.slabOffsetX).toBeCloseTo(0, 5)
    expect(layout.slabW).toBeCloseTo(layout.canvasW, 5)
    expectSubjectInWindow(bbox, layout)
  })

  it('subject FLUSH against the frame edge → NO residual padding (this used to overflow)', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    const bbox: PixelBbox = { x: 1800, y: 440, w: 120, h: 200 }
    const layout = wideCentralSquareLayout(bbox, frame)
    // Zero slack inside the central square used to leave the window hanging off
    // the frame; it now ends exactly at the border and the slab fills the canvas.
    expect(layout.frameOriginX + layout.canvasW).toBeCloseTo(frame.W, 5)
    expectNoPadding(layout)
    expectSubjectInWindow(bbox, layout)
  })

  it('padding survives ONLY where no scene remains: a window wider than the frame', () => {
    // The one case the blurred fill still exists for — there is nothing left to
    // slide into, so it cannot be clamped away.
    const frame: FrameDims = { W: 64, H: 48 }
    const bbox: PixelBbox = { x: 8, y: 4, w: 20, h: 40 }
    const layout = wideCentralSquareLayout(bbox, frame)
    expect(layout.canvasW).toBeGreaterThan(frame.W)
    expect(layout.slabW).toBeLessThan(layout.canvasW)
  })
})

// ── 2026-08-20: the slide is LIMITED where there is framing to preserve ──────
describe('wideCentralSquareLayout — limited slide (2026-08-20)', () => {
  /** The subject must land fully inside the canvas' CENTRAL SQUARE — the
   *  "central third" a square consumer center-crops to. 1px rounding slack. */
  function expectSubjectInCentralSquare(
    bbox: PixelBbox,
    layout: ReturnType<typeof wideCentralSquareLayout>,
  ): void {
    const leftCanvas = toCanvasX(bbox.x, layout.frameOriginX)
    const rightCanvas = toCanvasX(bbox.x + bbox.w, layout.frameOriginX)
    expect(leftCanvas).toBeGreaterThanOrEqual(layout.centralX0 - 1)
    expect(rightCanvas).toBeLessThanOrEqual(layout.centralX0 + layout.centralSide + 1)
  }

  /**
   * The 7.7% measured on 2026-08-20. The subject's SQUARE is fully in frame —
   * so the subject is genuinely centred in it and there IS a framing worth
   * preserving — but the 16:9 window around it hangs off the frame by more than
   * the subject's slack. The 31/07 rule slid the whole way regardless, which
   * walked the subject clean out of the central square: every square consumer
   * (modal hero, square tile) then CUT it, while the file's own docblock still
   * promised containment.
   */
  it('a subject whose SQUARE fits in frame stays inside the central square', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    const bbox: PixelBbox = { x: 150, y: 300, w: 200, h: 400 }
    const layout = wideCentralSquareLayout(bbox, frame)
    expectSubjectInCentralSquare(bbox, layout)
  })

  it('the same, mirrored on the right edge', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    const bbox: PixelBbox = { x: 1920 - 350, y: 300, w: 200, h: 400 }
    const layout = wideCentralSquareLayout(bbox, frame)
    expectSubjectInCentralSquare(bbox, layout)
  })

  /**
   * The pram case (device 102, 2026-07-31) is UNCHANGED. Its square is itself
   * clamped against the frame edge — the subject is against the edge of the
   * SCENE, not of a window we chose — so there is no framing to preserve and no
   * better crop to fall back to. The limit stays inert and the window still
   * slides fully in: real pixels off-centre beat a synthesized blurred band.
   */
  it('a subject whose SQUARE is clamped at the frame edge still slides fully (31/07 intact)', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    const bbox: PixelBbox = { x: 0, y: 300, w: 200, h: 400 }
    const layout = wideCentralSquareLayout(bbox, frame)
    expect(layout.frameOriginX).toBeCloseTo(0, 5)
    expectNoPadding(layout)
  })

  it('and mirrored: flush against the right border, still no fill', () => {
    const frame: FrameDims = { W: 640, H: 360 }
    const bbox: PixelBbox = { x: 597.8, y: 261.3, w: 41.7, h: 85.8 }
    const layout = wideCentralSquareLayout(bbox, frame)
    expectNoPadding(layout)
  })

  it('a centred subject is untouched by the limit', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    const bbox: PixelBbox = { x: 900, y: 400, w: 120, h: 200 }
    const layout = wideCentralSquareLayout(bbox, frame)
    expectNoPadding(layout)
    expectSubjectInCentralSquare(bbox, layout)
  })

  it('the limit never introduces MORE padding than the un-slid anchor would have', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    for (const bbox of [
      { x: 0, y: 300, w: 200, h: 400 },
      { x: 150, y: 300, w: 200, h: 400 },
      { x: 400, y: 300, w: 200, h: 400 },
      { x: 1920 - 350, y: 300, w: 200, h: 400 },
      { x: 1920 - 200, y: 300, w: 200, h: 400 },
    ] satisfies PixelBbox[]) {
      const layout = wideCentralSquareLayout(bbox, frame)
      // Never worse than the pure anchor (no slide at all).
      const anchorOrigin = layout.centralX0 // symmetric anchor ⇒ padding (canvasW - centralSide)/2
      expect(layout.slabOffsetX).toBeLessThanOrEqual(anchorOrigin + 1)
      // And always still contains the subject in the WINDOW.
      expectSubjectInWindow(bbox, layout)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Subject-on-the-side (2026-08-21): the central-square containment FRACTION,
// the containSubject layout mode, and the delivered-layout chooser.
//
// Case anatomy (track ec0eb76d…, device 108): a person flush against the
// RIGHT frame edge for the track's whole life. The square is frame-clamped,
// the 31/07-08/20 rule slides the window fully in-frame, and the canvas
// middle square — the region every square consumer center-crops — no longer
// contains the subject at all: the operator saw a bed and a doorway, no
// person. The wide 16:9 raster contains him; the delivered SQUARE does not.
// ─────────────────────────────────────────────────────────────────────────
import {
  CENTRAL_SQUARE_CONTAINMENT_MIN,
  centralSquareContainmentFraction,
  deliveredWideCentralSquareLayout,
} from '../wide-central-square-crop.js'

describe('centralSquareContainmentFraction', () => {
  // Real geometry of track ec0eb76d… in detection space (640×360).
  const frame: FrameDims = { W: 640, H: 360 }
  const edgeBbox: PixelBbox = { x: 545.6, y: 87.5, w: 94, h: 189 }
  const centeredBbox: PixelBbox = { x: 280, y: 90, w: 90, h: 180 }

  it('a centred subject sits fully inside the delivered central square (fraction 1)', () => {
    expect(centralSquareContainmentFraction(centeredBbox, frame)).toBeCloseTo(1, 5)
  })

  it('the edge subject is substantially EVICTED by the default full-slide layout', () => {
    const frac = centralSquareContainmentFraction(edgeBbox, frame)
    expect(frac).toBeLessThan(CENTRAL_SQUARE_CONTAINMENT_MIN)
    // The ec0eb76d… signature: the subject is nearly ABSENT, not merely cut.
    expect(frac).toBeLessThan(0.2)
  })

  it('accepts a precomputed layout and measures THAT layout', () => {
    const layout = wideCentralSquareLayout(edgeBbox, frame, { containSubject: true })
    expect(centralSquareContainmentFraction(edgeBbox, frame, layout)).toBeGreaterThanOrEqual(0.98)
  })
})

describe('wideCentralSquareLayout — containSubject mode', () => {
  const frame: FrameDims = { W: 640, H: 360 }
  const edgeBbox: PixelBbox = { x: 545.6, y: 87.5, w: 94, h: 189 }

  it('keeps the edge subject inside the central square, paying with lateral padding', () => {
    const layout = wideCentralSquareLayout(edgeBbox, frame, { containSubject: true })
    expect(centralSquareContainmentFraction(edgeBbox, frame, layout)).toBeGreaterThanOrEqual(0.98)
    // The price is REAL and bounded: padding only in the lateral third.
    expect(layout.slabW).toBeLessThan(layout.canvasW)
  })

  it('is inert for a subject whose slack already lets the slide keep containment', () => {
    const bbox: PixelBbox = { x: 150, y: 300, w: 200, h: 400 }
    const wide: FrameDims = { W: 1920, H: 1080 }
    expect(wideCentralSquareLayout(bbox, wide, { containSubject: true })).toEqual(
      wideCentralSquareLayout(bbox, wide),
    )
  })
})

describe('deliveredWideCentralSquareLayout', () => {
  const frame: FrameDims = { W: 640, H: 360 }
  const edgeBbox: PixelBbox = { x: 545.6, y: 87.5, w: 94, h: 189 }
  const centeredBbox: PixelBbox = { x: 280, y: 90, w: 90, h: 180 }

  it('keeps the default (full-slide, no padding) layout wherever containment holds', () => {
    expect(deliveredWideCentralSquareLayout(centeredBbox, frame)).toEqual(
      wideCentralSquareLayout(centeredBbox, frame),
    )
  })

  it('falls back to the contained layout when the default would evict the subject', () => {
    const layout = deliveredWideCentralSquareLayout(edgeBbox, frame)
    expect(centralSquareContainmentFraction(edgeBbox, frame, layout)).toBeGreaterThanOrEqual(
      CENTRAL_SQUARE_CONTAINMENT_MIN,
    )
  })
})

describe('wideCentralSquareLayout — the canvas narrows instead of padding (2026-09-08)', () => {
  const frame: FrameDims = { W: 3840, H: 2160 }
  /** The operator-reported track a46599d5 (device 3829): a car flush against the
   *  LEFT frame edge for its whole 242 ms life. Both its positions had x = 0. */
  const carAtTheEdge: PixelBbox = { x: 0, y: 405.6, w: 187.2, h: 549.6 }

  function padFraction(layout: ReturnType<typeof wideCentralSquareLayout>): number {
    const left = Math.max(0, -layout.frameOriginX)
    const right = Math.max(0, layout.frameOriginX + layout.canvasW - frame.W)
    return Math.max(left, right) / layout.canvasW
  }

  it('holds the fill under the cap where it used to be 22% of the picture', () => {
    const layout = wideCentralSquareLayout(carAtTheEdge, frame, { containSubject: true })
    expect(padFraction(layout)).toBeLessThanOrEqual(MAX_LETTERBOX_FRACTION + 0.001)
    // And the subject is STILL in the middle square — the narrowing buys the
    // reduction out of lateral CONTEXT, never out of containment.
    expect(centralSquareContainmentFraction(carAtTheEdge, frame, layout)).toBeGreaterThanOrEqual(
      0.98,
    )
  })

  it('never narrows past the central square itself', () => {
    // The square IS the subject's guaranteed region; a canvas narrower than it
    // would cut the thing the whole layout exists to contain.
    const layout = wideCentralSquareLayout(carAtTheEdge, frame, { containSubject: true })
    expect(layout.canvasW).toBeGreaterThanOrEqual(layout.centralSide)
  })

  it('leaves a layout that needs no fill exactly as it was', () => {
    // Everything that already composes without padding must be byte-identical:
    // this change is only allowed to touch the pictures that were paying for a
    // blurred band.
    const centred: PixelBbox = { x: 1800, y: 800, w: 200, h: 400 }
    const before = wideCentralSquareLayout(centred, frame)
    expect(before.canvasW).toBe(Math.round((before.centralSide * 16) / 9))
    expect(padFraction(before)).toBe(0)
  })

  it('keeps 16:9 when the fill is already small enough to live with', () => {
    // A subject NEAR (not against) the edge pays 6.6% here — under the cap, so
    // it keeps every pixel of lateral scene. Narrowing that would trade real
    // context for nothing.
    const nearEdge: PixelBbox = { x: 120, y: 900, w: 180, h: 420 }
    const layout = wideCentralSquareLayout(nearEdge, frame, { containSubject: true })
    expect(layout.canvasW).toBe(Math.round((layout.centralSide * 16) / 9))
    expect(padFraction(layout)).toBeGreaterThan(0)
    expect(padFraction(layout)).toBeLessThan(MAX_LETTERBOX_FRACTION)
  })

  it('over-narrows rather than under-narrows when the slide would have helped', () => {
    // Documented conservatism: the cap is computed from the space available
    // BEFORE the slide, so a subject with a little slack (x=40, 2.7% fill after
    // narrowing) comes out narrower than the cap strictly required. The error
    // is in the direction that removes fill, never the one that adds it.
    const slightSlack: PixelBbox = { x: 40, y: 900, w: 180, h: 420 }
    const layout = wideCentralSquareLayout(slightSlack, frame, { containSubject: true })
    expect(layout.canvasW).toBeLessThan(Math.round((layout.centralSide * 16) / 9))
    expect(padFraction(layout)).toBeLessThanOrEqual(MAX_LETTERBOX_FRACTION)
  })
})
