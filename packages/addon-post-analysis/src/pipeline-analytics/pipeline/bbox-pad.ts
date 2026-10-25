/**
 * Pad a normalized bounding box by a fractional amount relative to its own
 * dimensions. All coordinates remain in the [0, 1] unit-square.
 *
 * Formula (before clamping):
 *   newX = x - padding * w
 *   newW = w + 2 * padding * w  (i.e. w * (1 + 2 * padding))
 *   newY = y - padding * h
 *   newH = h + 2 * padding * h
 *
 * padding === 0 is the identity operation. Pure, immutable — always returns a
 * new object.
 *
 * NOTE: clamping SHIFTS, it does not truncate — a window that overflows a
 * bound slides inward and keeps the extent that was asked for, on either side.
 * It shrinks only when the padded window is larger than the frame itself
 * would (e.g. a left-hugging box gains a bit more right-side context). This is
 * acceptable for detection crops (more context, never out of [0,1]); the
 * downstream `extractCrop` clamps to pixel bounds again regardless.
 */
export function padBbox(
  bbox: { x: number; y: number; w: number; h: number },
  padding: number,
): { x: number; y: number; w: number; h: number } {
  const rawX = bbox.x - padding * bbox.w
  const rawY = bbox.y - padding * bbox.h
  const rawW = bbox.w * (1 + 2 * padding)
  const rawH = bbox.h * (1 + 2 * padding)

  // SHIFT the window inward rather than truncating it. The clamp used to be
  // asymmetric — `max(0, rawX)` preserves the extent at the LEFT edge (the
  // window slides right) while `min(rawW, 1 - x)` cut it off at the RIGHT — so
  // a subject against the right border got LESS crop than was asked for and the
  // consumer filled the shortfall with a blurred band. Measured on device 102
  // track `d6de2a61` (`envelope.maxX = 0.999`): roughly the last 12% of the
  // best shot was that band.
  //
  // Only when the padded window is larger than the frame is shrinking correct;
  // then it collapses to the whole frame, which is the most that exists.
  const w = Math.min(rawW, 1)
  const h = Math.min(rawH, 1)
  const x = Math.min(Math.max(0, rawX), 1 - w)
  const y = Math.min(Math.max(0, rawY), 1 - h)

  return { x, y, w, h }
}
