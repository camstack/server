/**
 * Computes a "square-safe 16:9" crop region that FULLY CONTAINS the detector
 * bbox in both a 16:9 view AND a 1:1 center-crop (cover) view.
 *
 * Algorithm:
 *   1. Compute bbox center: cx = x + w/2, cy = y + h/2
 *   2. base = max(w, h) * (1 + 2 * padding)
 *      Matches padBbox semantics: padding is fraction-per-side, so each side
 *      expands by padding*dim, totalling 2*padding*dim → factor (1+2*padding).
 *   3. Square side: ch = base  (bbox fully inside the square)
 *      16:9 width:  cw = ch * 16/9
 *   4. Clamp to frame:
 *      - if cw > W → cw = W; ch = W * 9/16
 *      - if ch > H → ch = H; cw = H * 16/9
 *   5. Position centered, clamped:
 *      x0 = clamp(cx − cw/2, 0, W − cw)
 *      y0 = clamp(cy − ch/2, 0, H − ch)
 *   6. Round to integer pixels.
 *
 * The output region is in PIXEL SPACE. Pass it directly to sharp after
 * extracting: left=x, top=y, width=w, height=h.
 */

export interface PixelBbox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface FrameDims {
  readonly W: number
  readonly H: number
}

/**
 * Compute a square-safe 16:9 crop region in pixel space.
 *
 * The returned region:
 * - is 16:9 (w/h ≈ 16/9) unless the frame itself forces a smaller ratio
 * - has a square center of side `base = max(bbox.w, bbox.h) * (1+2*padding)`
 *   that fully contains the detector bbox
 * - is clamped to the frame boundaries
 * - uses integer pixel coordinates
 */
export function squareSafeCropRegion(
  bbox: PixelBbox,
  frame: FrameDims,
  padding: number,
): PixelBbox {
  const { W, H } = frame

  // Step 1: center of the bbox
  const cx = bbox.x + bbox.w / 2
  const cy = bbox.y + bbox.h / 2

  // Step 2: padded square side (matches padBbox semantics: fraction-per-side)
  const longerSide = Math.max(bbox.w, bbox.h)
  const base = longerSide * (1 + 2 * padding)

  // Step 3: 16:9 region, square center of side `ch` guarantees full containment
  let ch = base
  let cw = ch * (16 / 9)

  // Step 4: clamp to frame — width first, then height
  if (cw > W) {
    cw = W
    ch = cw * (9 / 16)
  }
  if (ch > H) {
    ch = H
    cw = ch * (16 / 9)
  }

  // Step 5: center-and-clamp origin
  const rawX0 = cx - cw / 2
  const rawY0 = cy - ch / 2
  const x0 = Math.max(0, Math.min(rawX0, W - cw))
  const y0 = Math.max(0, Math.min(rawY0, H - ch))

  // Step 6: round to integer pixels
  return {
    x: Math.round(x0),
    y: Math.round(y0),
    w: Math.round(cw),
    h: Math.round(ch),
  }
}

/** A crop region expressed in NORMALIZED [0,1] frame coordinates. */
export interface NormalizedBbox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * The same square-safe 16:9 region as {@link squareSafeCropRegion}, expressed in
 * NORMALIZED [0,1]×[0,1] coordinates instead of pixels.
 *
 * A normalized box maps DIRECTLY onto a native-resolution surface of the SAME
 * aspect ratio (the native crop path downscales while preserving aspect), so the
 * region computed from the detection frame's dimensions addresses the exact same
 * ROI on the runner's retained native frame. Reuses the pixel geometry verbatim
 * (single source of truth) and divides by the frame dimensions.
 */
export function squareSafeCropRegionNormalized(
  bbox: PixelBbox,
  frame: FrameDims,
  padding: number,
): NormalizedBbox {
  const region = squareSafeCropRegion(bbox, frame, padding)
  return {
    x: region.x / frame.W,
    y: region.y / frame.H,
    w: region.w / frame.W,
    h: region.h / frame.H,
  }
}
