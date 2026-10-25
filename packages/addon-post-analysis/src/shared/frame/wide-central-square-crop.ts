/**
 * 16:9 central-square subject framing for the best-shot `thumbnail` /
 * `thumbnailSmall` variants (operator refinement, 2026-07-22).
 *
 * Supersedes the plain SQUARE framing ({@link squareSubjectCropRegion}) for the
 * persisted best-crop. The output is a 16:9 canvas whose CENTRAL SQUARE (the
 * middle `height × height` region) fully contains the subject, with lateral
 * scene context filling the left/right thirds:
 *
 *  - WIDE consumers (cluster / reel tiles) use the full 16:9 image as-is — the
 *    subject is centered and never cut by a cover-fit.
 *  - SQUARE consumers (modal hero / square tiles) center-crop to the middle
 *    square and are GUARANTEED never to cut the subject (it is inside it).
 *
 * The central square reuses {@link squareSubjectCropRegion} verbatim — the same
 * subject-containing, frame-clamped square that backed the old thumbnail — so
 * the "square fully contains the bbox" contract (and its edge-scale-up policy)
 * carries over unchanged. The 16:9 window then EXTENDS that square laterally to
 * `side × 16/9`; when the window would stick out of the frame it SLIDES back in
 * as far as the subject's slack inside its square allows (real lateral scene
 * beats letterbox padding — operator triage 2026-07-22), and only the residual
 * out-of-frame part is padding.
 *
 * **The containment guarantee holds wherever the central square itself fits in
 * frame** — the subject is inside the central square and padding only ever
 * appears in the lateral thirds. It is deliberately given up in ONE case: a
 * subject against the edge of the SCENE, whose square is clamped by the frame
 * border. There the slack is zero, no crop can both contain and avoid a fill,
 * and the operator ruled (2026-07-31, device 102, a pram) that real pixels
 * off-centre beat a synthesized blurred band. The full history of that bound —
 * imposed, dropped, and re-imposed with this exception on 2026-08-20 after
 * 7.7% of best shots measured mis-framed — is written at the slide itself.
 *
 * Pure geometry (no I/O) so the containment invariant is fully unit-testable.
 */

import { squareSubjectCropRegion } from './square-subject-crop.js'
import type { PixelBbox, FrameDims, NormalizedBbox } from './square-safe-crop.js'

/** Output aspect ratio (16:9). */
export const WIDE_THUMBNAIL_ASPECT_W = 16
export const WIDE_THUMBNAIL_ASPECT_H = 9

/**
 * How much of the composed picture may be synthesized fill before the canvas
 * NARROWS instead (operator directive, 2026-09-08, track a46599d5 device 3829).
 *
 * A subject flush against a frame edge for its whole life has no containable
 * frame, so `containSubject` keeps the middle square on it and pays the
 * overhang in lateral fill. On that car the bill was 225 px — 21.9% of the
 * picture, and the operator read the blurred stretch as a mirrored duplicate of
 * the scene.
 *
 * Rather than choose between an uncontained subject and a quarter of ambience,
 * the canvas gives up WIDTH: it narrows towards its own central square until
 * the fill is at most this fraction. Aspect then lands between 1:1 and 16:9 —
 * the square is never crossed, because the square is the region that is
 * guaranteed to hold the subject.
 *
 * The cost is real and it is lateral CONTEXT: a wide surface cover-fitting a
 * near-square picture crops top and bottom. That is why this is a cap and not a
 * rule — everything that already composes with a small fill keeps its 16:9.
 */
export const MAX_LETTERBOX_FRACTION = 0.1

/** Long-side cap for the batch-friendly `thumbnailSmall` variant — 480×270 at
 *  16:9. The uncapped `thumbnail` remains the high-quality evidence frame. */
export const WIDE_THUMBNAIL_SMALL_MAX_WIDTH = 480

/**
 * The geometry of the 16:9 central-square window, in SOURCE (frame) pixel space.
 *
 * `fetch` is the in-frame slab to request from the native surface (normalized
 * [0,1]); it is the intersection of the full 16:9 window with the frame, so its
 * aspect is ≤ 16:9 (equal when the whole window fits). `canvasW × canvasH` is the
 * full 16:9 output canvas; `slabOffsetX` is where the fetched slab lands on it
 * (the rest is lateral padding). `centralX0 / centralSide` describe the central
 * square (`[centralX0, centralX0 + centralSide]` horizontally, full height) that
 * a square consumer center-crops — the subject is guaranteed inside it.
 */
export interface WideCentralSquareLayout {
  readonly fetch: NormalizedBbox
  /** Full 16:9 canvas, source px (canvasH === centralSide). */
  readonly canvasW: number
  readonly canvasH: number
  /** Left offset of the fetched in-frame slab on the canvas, source px. */
  readonly slabOffsetX: number
  /** The fetched slab's source-px dimensions (=== fetch region in px). */
  readonly slabW: number
  readonly slabH: number
  /** Central square on the canvas, source px. */
  readonly centralX0: number
  readonly centralSide: number
  /** The frame-x that maps to canvas-x = 0 (may be negative → left padding).
   *  Exposed for tests: a frame point `fx` lands at canvas-x `fx - frameOriginX`. */
  readonly frameOriginX: number
}

/**
 * Compute the 16:9 central-square window layout for a subject bbox.
 *
 * Algorithm:
 *   1. central square `C = squareSubjectCropRegion(bbox, frame)` — the
 *      subject-containing, frame-clamped square of side `c` (its contract also
 *      handles the "subject bigger than the short edge / scale the window up"
 *      cases). `C` becomes the middle square of the output.
 *   2. canvas: `canvasW = round(c × 16/9)`, `canvasH = c`.
 *   3. anchor: place the canvas so `C` is its horizontal middle →
 *      `frameOriginX = C.x − (canvasW − c)/2` (frame-x mapping to canvas-x 0),
 *      then CLAMP the window fully inside the frame whenever it fits. The
 *      subject therefore drifts off-centre near a frame edge and the output
 *      carries no padding at all. Centring is a preference; containing the
 *      subject is the contract, and clamping cannot break it.
 *   4. in-frame slab: intersect `[frameOriginX, frameOriginX + canvasW]` with
 *      `[0, W]`; the slab is that intersection at full height `c` (C ⊆ frame ⇒
 *      the vertical extent is always in-frame). Its canvas offset is
 *      `slabOffsetX = fxa − frameOriginX ≥ 0`; anything outside is padding.
 */
/** Options for {@link wideCentralSquareLayout}. */
export interface WideCentralSquareOptions {
  /**
   * Subject-on-the-side fallback (operator directive 2026-08-21, track
   * ec0eb76d… device 108): bound the in-frame slide by the subject's REAL slack
   * inside the central square in EVERY case — including the square-clamped edge
   * case where the default policy deliberately gives containment up. The
   * delivered canvas-middle square then always contains the subject ("il
   * quadrato ancorato al bordo"), and the residual out-of-frame part of the
   * window stays lateral padding. Used ONLY when the whole track never offered
   * a containable frame — see {@link deliveredWideCentralSquareLayout}.
   */
  readonly containSubject?: boolean
}

/**
 * The 16:9 width, narrowed just enough to hold the fill under
 * {@link MAX_LETTERBOX_FRACTION}.
 *
 * The canvas is CENTRED on the square, so each side wants `(canvasW - c) / 2`
 * and gets whatever real frame lies there; the rest is fill. Solving
 * `(w - c)/2 - available <= cap * w` for `w` gives the widest canvas that
 * respects the cap on that side, and the binding side is the narrower answer.
 *
 * It is computed from the space available BEFORE the slide, which can only
 * over-estimate the fill: the slide moves the window towards real scene and
 * never away from it. So a layout that the slide would have rescued anyway may
 * come out a few percent narrower than strictly necessary — a smaller error
 * than the band it removes, and in the other direction.
 *
 * Never narrower than the square itself: below that the picture would cut the
 * one region the layout guarantees contains the subject.
 */
function cappedCanvasWidth(c: number, centralX: number, frameW: number): number {
  const full = Math.round((c * WIDE_THUMBNAIL_ASPECT_W) / WIDE_THUMBNAIL_ASPECT_H)
  const denominator = 0.5 - MAX_LETTERBOX_FRACTION
  if (denominator <= 0) return full
  const widest = (available: number): number => (c / 2 + Math.max(0, available)) / denominator
  const bound = Math.min(widest(centralX), widest(frameW - (centralX + c)))
  if (!Number.isFinite(bound) || bound >= full) return full
  return Math.max(c, Math.round(bound))
}

/**
 * The layout at a GIVEN canvas width. `wideCentralSquareLayout` runs it twice:
 * once at the full 16:9 width, and — only when that leaves more fill than
 * {@link MAX_LETTERBOX_FRACTION} — once at the narrowed width. Two passes
 * rather than one predictive formula because the slide's result is what
 * decides, and computing the fill after the slide is exact where predicting it
 * is not.
 */
function layoutAtWidth(
  bbox: PixelBbox,
  frame: FrameDims,
  options: WideCentralSquareOptions,
  central: PixelBbox,
  canvasW: number,
): WideCentralSquareLayout {
  const c = central.w // square: w === h
  const centralX0 = Math.round((canvasW - c) / 2)

  const anchorX = central.x - (canvasW - c) / 2
  let frameOriginX = anchorX
  if (canvasW <= frame.W) {
    // ── Letterbox minimisation, and its LIMIT ────────────────────────────
    //
    // Three decisions live in these lines, in the order they were taken.
    //
    // **2026-07-22.** When the 16:9 window sticks out of the frame, SLIDE it
    // back in — but only as far as the subject still fits the canvas-middle
    // central square. Shifting the window by δ moves the square's frame-region
    // to `[central.x+δ, central.x+c+δ]`, so the subject bbox bounds δ. Real
    // lateral scene beats black padding wherever the subject has slack.
    //
    // **2026-07-31 (operator directive, device 102, a person crossing with a
    // pram).** That bound left a subject FLUSH against a frame edge — where the
    // slack is zero — with a blurred band over a quarter of its best shot. The
    // directive: the fill must NEVER be applied; push the body against the edge
    // and accept that it is not centred. So the bound was dropped entirely and
    // the window clamped fully in-frame.
    //
    // **2026-08-20 (data, then operator confirmation).** Dropping the bound
    // ENTIRELY broke the containment promise this file's own header still
    // makes. A subject whose square fits in frame — genuinely centred in it,
    // with a real framing to preserve — was slid clean out of the central
    // square, and every square consumer (modal hero, square tile) cut it.
    // Measured: 7.7% of best shots mis-framed. The operator confirmed the
    // amendment to his own directive: LIMIT the slide again — but only where
    // there is something to protect.
    //
    // The limit is therefore inert exactly where 31/07 spoke: when the central
    // SQUARE is itself clamped against a frame edge, the subject is against the
    // edge of the SCENE, its slack there is zero, no better crop exists, and
    // sliding fully is strictly an improvement. Everywhere else — the square
    // fully in frame — the slide stops at the subject's slack and the residual
    // (small, because the square fits) stays padding.
    // **2026-08-21 (operator directive, track ec0eb76d… device 108).** The
    // 08-20 exception delivered a SQUARE view with no subject in it at all: a
    // person glued to the right frame edge for a track's whole life has a
    // frame-clamped square, the window slides fully, and the canvas middle
    // square — the region `makeSquareThumb` center-crops — lands on empty
    // scene. `containSubject` (the delivery fallback for tracks that NEVER had
    // a containable frame) applies the slack bound in every case, so the
    // delivered middle square is the frame-clamped square itself ("il quadrato
    // ancorato al bordo") and the residual stays lateral padding. The slack
    // expressions are also per-direction CORRECT now: sliding right evicts the
    // subject through the square's LEFT edge (bound `bbox.x − central.x`),
    // sliding left through its RIGHT edge (bound `central.x+c − (bbox.x+w)`).
    // The old code had the two swapped — inert by symmetry (an unclamped
    // square centres its subject, so the slacks are equal ±1px of rounding,
    // and the clamped case bypassed the bound) but wrong exactly where
    // containSubject needs it.
    const containSubject = options.containSubject === true
    const slidFully = Math.min(Math.max(0, anchorX), frame.W - canvasW)
    const delta = slidFully - anchorX
    if (delta > 0) {
      // Sliding RIGHT (the window hung off the LEFT): the central square's
      // frame-region moves right and the subject exits via its LEFT edge.
      // Inert when the square is already clamped at the left frame edge —
      // unless containSubject demands the bound everywhere.
      const squareClampedLeft = central.x <= 0
      const slack = bbox.x - central.x
      const boundInert = !containSubject && (squareClampedLeft || slack <= 0)
      frameOriginX = boundInert ? slidFully : anchorX + Math.min(delta, Math.max(0, slack))
    } else if (delta < 0) {
      // Sliding LEFT (the window hung off the RIGHT): the subject exits via
      // the square's RIGHT edge. Inert when the square is already clamped at
      // the right frame edge — unless containSubject demands the bound.
      const squareClampedRight = central.x + c >= frame.W
      const slack = central.x + c - (bbox.x + bbox.w)
      const boundInert = !containSubject && (squareClampedRight || slack <= 0)
      frameOriginX = boundInert ? slidFully : anchorX + Math.max(delta, -Math.max(0, slack))
    }
  } else {
    // Window wider than the whole frame: centre it (padding on both sides).
    frameOriginX = (frame.W - canvasW) / 2
  }
  const fxa = Math.max(0, frameOriginX)
  const fxb = Math.min(frame.W, frameOriginX + canvasW)
  const slabW = fxb - fxa
  const slabOffsetX = fxa - frameOriginX

  return {
    fetch: {
      x: fxa / frame.W,
      y: central.y / frame.H,
      w: slabW / frame.W,
      h: c / frame.H,
    },
    canvasW,
    canvasH: c,
    slabOffsetX,
    slabW,
    slabH: c,
    centralX0,
    centralSide: c,
    frameOriginX,
  }
}

/** Synthesized fill as a fraction of the composed picture. */
function letterboxFraction(layout: WideCentralSquareLayout, frame: FrameDims): number {
  const left = Math.max(0, -layout.frameOriginX)
  const right = Math.max(0, layout.frameOriginX + layout.canvasW - frame.W)
  return layout.canvasW <= 0 ? 0 : Math.max(left, right) / layout.canvasW
}

export function wideCentralSquareLayout(
  bbox: PixelBbox,
  frame: FrameDims,
  options: WideCentralSquareOptions = {},
): WideCentralSquareLayout {
  const central = squareSubjectCropRegion(bbox, frame)
  const c = central.w
  const full = Math.round((c * WIDE_THUMBNAIL_ASPECT_W) / WIDE_THUMBNAIL_ASPECT_H)
  const wide = layoutAtWidth(bbox, frame, options, central, full)
  // Everything that already composes within the cap keeps its 16:9 EXACTLY —
  // including the (rare) window wider than the whole frame, where there is no
  // scene anywhere to narrow towards. The narrowing exists for one picture: the
  // one paying a fifth of itself in blurred ambience.
  if (full > frame.W || letterboxFraction(wide, frame) <= MAX_LETTERBOX_FRACTION) return wide
  const narrowed = cappedCanvasWidth(c, central.x, frame.W)
  return narrowed >= full ? wide : layoutAtWidth(bbox, frame, options, central, narrowed)
}

/**
 * Threshold below which the delivered SQUARE view no longer meaningfully shows
 * the subject. Shared by the best-frame ranking (a frame under it is strongly
 * penalized so best-seen "waits" for a containable frame) and by
 * {@link deliveredWideCentralSquareLayout} (when the whole track never offered
 * one, delivery falls back to the contained layout). Measured 2026-08-21 over
 * 48h / 2133 tracks: 3.4% of best shots fell under this line, 23% on the worst
 * camera (102) — and the operator-reported track carried 6.8%.
 */
export const CENTRAL_SQUARE_CONTAINMENT_MIN = 0.5

/**
 * Fraction of the subject bbox's area that lands inside the CENTRAL SQUARE a
 * square consumer center-crops from the composed 16:9 canvas — i.e. how much
 * of the subject the SQUARE view actually delivers. 1 = fully contained;
 * ~0 = the square view shows scene, not subject (the ec0eb76d… signature).
 * Measures the DEFAULT layout unless one is supplied. Pure geometry.
 */
export function centralSquareContainmentFraction(
  bbox: PixelBbox,
  frame: FrameDims,
  layout: WideCentralSquareLayout = wideCentralSquareLayout(bbox, frame),
): number {
  const area = bbox.w * bbox.h
  if (area <= 0) return 0
  const sqX0 = layout.frameOriginX + layout.centralX0
  const sqY0 = layout.fetch.y * frame.H
  const side = layout.centralSide
  const ix = Math.max(0, Math.min(bbox.x + bbox.w, sqX0 + side) - Math.max(bbox.x, sqX0))
  const iy = Math.max(0, Math.min(bbox.y + bbox.h, sqY0 + side) - Math.max(bbox.y, sqY0))
  return (ix * iy) / area
}

/**
 * The layout the persisted `thumbnail` / `thumbnailSmall` are actually cut
 * with — the ONE policy every delivery path shares (live native crop, raster
 * fallback, close-time keyFrame derive).
 *
 * Default first: the full-slide layout (31/07 — real lateral scene beats
 * padding) wherever the subject still lands ≥ {@link CENTRAL_SQUARE_CONTAINMENT_MIN}
 * inside the delivered central square. Only when it does NOT — the
 * subject-on-the-side case, where the square view would show no subject at all
 * — fall back to the contained layout: the subject MUST be in the delivered
 * media (operator, 2026-08-21), and a padding band in the lateral third
 * is the price of the only crop that still shows it.
 */
export function deliveredWideCentralSquareLayout(
  bbox: PixelBbox,
  frame: FrameDims,
): WideCentralSquareLayout {
  const layout = wideCentralSquareLayout(bbox, frame)
  if (centralSquareContainmentFraction(bbox, frame, layout) >= CENTRAL_SQUARE_CONTAINMENT_MIN) {
    return layout
  }
  return wideCentralSquareLayout(bbox, frame, { containSubject: true })
}

/**
 * Fraction of the DELIVERED 16:9 canvas that is NOT real pixels — the lateral
 * fill the composer synthesizes because the window ran off a frame edge. 0 =
 * the whole canvas is scene; 0.21 = a fifth of the delivered image is fill.
 *
 * Measured on {@link deliveredWideCentralSquareLayout} — the layout the
 * persisted `thumbnail` is actually cut with — because the operator complains
 * about the image they were SHOWN, not about a hypothetical centred window.
 * The two differ exactly where it matters: the default layout slides fully
 * in-frame and carries no fill at all, while the delivery fallback re-imposes
 * the subject's slack bound (so the square still shows the subject) and pays
 * for it in padding.
 *
 * Upper bound: a window that can only show its central square delivers
 * `1 − 9/16 = 0.4375` fill; nothing can exceed that while the square itself is
 * in frame.
 *
 * Pure geometry (no I/O). Feeds the best-frame ranking as a BOUNDED
 * within-tier factor — see `edge-clear.ts#CANVAS_FILL_MAX_PENALTY` for why it
 * is deliberately not a tier.
 */
export function canvasFillFraction(
  bbox: PixelBbox,
  frame: FrameDims,
  layout: WideCentralSquareLayout = deliveredWideCentralSquareLayout(bbox, frame),
): number {
  if (layout.canvasW <= 0) return 0
  return Math.max(0, Math.min(1, (layout.canvasW - layout.slabW) / layout.canvasW))
}
