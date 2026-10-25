/**
 * package-zone-proximity — is this frame's motion NEAR the package zones?
 *
 * The `MotionSettleGovernor` opens a burst of `package-detection` runs at the
 * settle edge of a motion episode, because a parcel appears at the END of one.
 * Feeding it whole-frame motion would open that burst for a car passing at the
 * far side of the street; feeding it motion that only counts INSIDE the zone
 * would miss the courier who sets the box down at the zone's edge and whose
 * body is mostly outside it.
 *
 * So "near" is defined, measurably, as: **the motion region's box intersects
 * the package zone-union box DILATED by {@link PACKAGE_ZONE_DILATION} of its
 * own width and height on every side.** Normalised (0–1) coordinates
 * throughout, so it means the same thing on a 640×360 substream and a 4K main
 * stream — a definition tied to pixels would drift the moment a profile
 * changed.
 *
 * Everything here is pure. The caller owns the zone geometry, the caching and
 * the fail-open decision (see `motionNearPackageZone`'s contract).
 */

/** Normalised (0–1) axis-aligned box. */
export interface NormalizedBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * How much the zone-union box grows on EVERY side, as a fraction of its own
 * width / height.
 *
 * 0.5 means a doormat 271px wide on a 640px frame is approached through a
 * ~135px apron on each side — about one adult's width at that distance, which
 * is the thing being detected: a person standing next to the mat, not on it.
 * Larger and a passer-by on the pavement opens a burst; smaller and the
 * courier who never steps on the mat does not.
 */
export const PACKAGE_ZONE_DILATION = 0.5

/** Grow a box by {@link PACKAGE_ZONE_DILATION}, clamped to the frame. */
export function dilateZoneBox(box: NormalizedBox, dilation = PACKAGE_ZONE_DILATION): NormalizedBox {
  const dx = box.w * dilation
  const dy = box.h * dilation
  const x = Math.max(0, box.x - dx)
  const y = Math.max(0, box.y - dy)
  return {
    x,
    y,
    w: Math.min(1, box.x + box.w + dx) - x,
    h: Math.min(1, box.y + box.h + dy) - y,
  }
}

function intersects(a: NormalizedBox, b: NormalizedBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

export interface MotionProximityInput {
  /** This frame's motion regions in PIXEL space, as the analyzer returns them. */
  readonly regions: readonly { readonly bbox: { x: number; y: number; w: number; h: number } }[]
  readonly frameWidth: number
  readonly frameHeight: number
  /**
   * The device's package zone-union box in NORMALISED coordinates, or
   * `undefined` when the caller could not resolve it.
   */
  readonly zoneUnion: NormalizedBox | undefined
}

/**
 * Does any motion region reach the dilated package zone?
 *
 * **Fail-open on unknown geometry.** `zoneUnion === undefined` means the caller
 * has not (or could not) resolve the zones — a cold cache, a failed cap read.
 * It answers "yes, if there is any motion at all", which degrades to exactly
 * the whole-frame behaviour this replaced. The alternative — answering "no" —
 * would let one failed read silence package detection on a camera for as long
 * as the read kept failing, and be indistinguishable from a quiet doorstep.
 * That is the shape of D49, and it has cost this repo real deliveries.
 */
export function motionNearPackageZone(input: MotionProximityInput): boolean {
  if (input.regions.length === 0) return false
  if (input.zoneUnion === undefined) return true
  if (input.frameWidth <= 0 || input.frameHeight <= 0) return true
  const target = dilateZoneBox(input.zoneUnion)
  for (const region of input.regions) {
    const normalized: NormalizedBox = {
      x: region.bbox.x / input.frameWidth,
      y: region.bbox.y / input.frameHeight,
      w: region.bbox.w / input.frameWidth,
      h: region.bbox.h / input.frameHeight,
    }
    if (intersects(normalized, target)) return true
  }
  return false
}

/**
 * The bounding box of a set of normalised polygons — the package zone union.
 * Returns `undefined` when there is no usable geometry, which the caller must
 * pass through as "unknown" rather than as an empty zone.
 */
export function packageZoneUnion(
  polygons: readonly (readonly { readonly x: number; readonly y: number }[])[],
): NormalizedBox | undefined {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let sawPoint = false
  for (const polygon of polygons) {
    for (const point of polygon) {
      sawPoint = true
      if (point.x < minX) minX = point.x
      if (point.y < minY) minY = point.y
      if (point.x > maxX) maxX = point.x
      if (point.y > maxY) maxY = point.y
    }
  }
  if (!sawPoint) return undefined
  const x = Math.max(0, Math.min(1, minX))
  const y = Math.max(0, Math.min(1, minY))
  const w = Math.max(0, Math.min(1, maxX)) - x
  const h = Math.max(0, Math.min(1, maxY)) - y
  if (w <= 0 || h <= 0) return undefined
  return { x, y, w, h }
}
