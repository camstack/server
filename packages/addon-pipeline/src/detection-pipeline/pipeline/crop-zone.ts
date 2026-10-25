/**
 * crop-zone.ts — resolve the inference crop bbox for a `crop-zone` root
 * detector (the `package-detection` step).
 *
 * A `crop-zone` root's INPUT is the device's drawn `package`-stage zone-rules
 * polygons, not the full frame (design ADDENDUM 2026-07-17). This module turns
 * the device's zones + enabled package rules into a single absolute-pixel crop
 * bounding box (the UNION of every referenced polygon), which the executor then
 * crops the frame to before running inference. Detections found inside that
 * crop are re-projected back to full-frame coordinates by the executor, so the
 * zone / notifier logic downstream is unaffected.
 *
 * Pure + zero I/O — the caller supplies the zones + rules (read off the
 * device-state mirror) and the frame dimensions.
 */
import type { Zone, ZoneRule } from '@camstack/types'
import { type AbsoluteBbox, isBboxDegenerate } from './crop-utils.js'

/**
 * Resolve the absolute-pixel crop bbox for a `crop-zone` root detector: the
 * bounding box of the UNION of every polygon referenced by the device's
 * ENABLED `package`-stage zone rules. Zone polygons are normalized (0..1); the
 * union is clamped to [0,1] then scaled to the frame's pixel dimensions.
 *
 * Returns `null` when there is nothing usable to crop to — no enabled rules, no
 * referenced geometry, or a degenerate result — in which case the caller falls
 * back to full-frame inference (behaviour identical to before the crop-zone
 * plumbing).
 */
export function resolvePackageCropBbox(
  zones: readonly Zone[],
  packageRules: readonly ZoneRule[],
  frameWidth: number,
  frameHeight: number,
): AbsoluteBbox | null {
  if (frameWidth <= 0 || frameHeight <= 0) return null

  // A soft-disabled rule (`enabled: false`) contributes no crop geometry.
  const enabledRules = packageRules.filter((r) => r.enabled !== false)
  if (enabledRules.length === 0) return null

  const zoneIds = new Set<string>()
  for (const rule of enabledRules) {
    for (const id of rule.zoneIds) zoneIds.add(id)
  }
  if (zoneIds.size === 0) return null

  const zoneById = new Map(zones.map((z) => [z.id, z]))

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let sawPoint = false

  for (const id of zoneIds) {
    const zone = zoneById.get(id)
    if (!zone || zone.polygon.length === 0) continue
    for (const point of zone.polygon) {
      sawPoint = true
      if (point.x < minX) minX = point.x
      if (point.y < minY) minY = point.y
      if (point.x > maxX) maxX = point.x
      if (point.y > maxY) maxY = point.y
    }
  }
  if (!sawPoint) return null

  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))
  const bbox: AbsoluteBbox = [
    clamp01(minX) * frameWidth,
    clamp01(minY) * frameHeight,
    clamp01(maxX) * frameWidth,
    clamp01(maxY) * frameHeight,
  ]
  if (isBboxDegenerate(bbox)) return null
  return bbox
}
