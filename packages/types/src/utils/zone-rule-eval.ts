/**
 * Pure rules-driven zone evaluator. Shared between every consumer
 * that gates items (motion regions, detections, future audio events,
 * …) by `(zones, rules)` pairs. Lives in `@camstack/types/utils` so
 * addon-motion-wasm + addon-detection-pipeline share one canonical
 * implementation.
 *
 * Semantics — match the analytics zone-engine introduced in Phase 2a:
 *   - any active include rule fires ⇒ whitelist mode (only items
 *     satisfying at least one include rule pass)
 *   - otherwise ⇒ blacklist mode (items in any exclude rule are
 *     dropped, the rest pass)
 *   - inactive rules (`enabled: false`) are skipped before the gate
 *   - a rule's `classFilter` narrows it to the listed classes; an
 *     item whose class isn't in the filter is invisible to that rule
 *
 * Test point: each item provides a normalised (0–1) center via the
 * `getCenter` accessor; rules fire when the center lies inside any
 * of the rule's referenced zone polygons (ray-cast point-in-polygon).
 * Bbox-area overlap would be marginally more intuitive on tiny
 * items but doubles the per-frame cost; the center test keeps the
 * hot path cheap and matches the operator's intuition for
 * "where is the activity centered".
 */
import type { Zone } from '../capabilities/zones.cap.js'
import type { ZoneRule } from '../capabilities/schemas/zone-rule.js'

export interface ZoneRuleEvalResult<T> {
  readonly passed: readonly T[]
  readonly excluded: readonly T[]
}

/**
 * Evaluate `rules` against `items`. Returns the items partitioned
 * into `passed` (kept by the gate) and `excluded` (dropped). When
 * `rules` is empty or `zones` is empty everything passes — the gate
 * is "off" without explicit configuration.
 *
 * `getCenter` returns the item's normalised (0–1) center point.
 * `getClassName` is optional — when omitted, every rule's
 * `classFilter` is treated as matching all classes (motion-stage
 * semantics). Provide it for object detections so per-class rules
 * narrow correctly.
 */
export function evaluateZoneRules<T>(
  items: readonly T[],
  zones: readonly Zone[],
  rules: readonly ZoneRule[],
  getCenter: (item: T) => { readonly x: number; readonly y: number },
  getClassName?: (item: T) => string | undefined,
): ZoneRuleEvalResult<T> {
  if (rules.length === 0 || zones.length === 0) {
    return { passed: items, excluded: [] }
  }
  const activeRules = rules.filter((r) => r.enabled !== false)
  const includeRules = activeRules.filter((r) => r.mode === 'include')
  const excludeRules = activeRules.filter((r) => r.mode === 'exclude')
  const whitelistMode = includeRules.length > 0
  const zonesById = new Map(zones.map((z) => [z.id, z]))

  const passed: T[] = []
  const excluded: T[] = []

  for (const item of items) {
    const center = getCenter(item)
    const className = getClassName?.(item)
    const inInclude = includeRules.some((r) => ruleApplies(r, center, className, zonesById))
    const inExclude = excludeRules.some((r) => ruleApplies(r, center, className, zonesById))
    if (whitelistMode) {
      if (inInclude && !inExclude) passed.push(item)
      else excluded.push(item)
    } else {
      if (inExclude) excluded.push(item)
      else passed.push(item)
    }
  }
  return { passed, excluded }
}

function ruleApplies(
  rule: ZoneRule,
  center: { readonly x: number; readonly y: number },
  className: string | undefined,
  zonesById: ReadonlyMap<string, Zone>,
): boolean {
  // Class narrowing — when className is undefined (motion stage),
  // we treat the filter as matching everything. When the item has a
  // class, missing it from the filter excludes the rule.
  if (rule.classFilter && rule.classFilter.length > 0) {
    if (className !== undefined && !rule.classFilter.includes(className)) return false
  }
  for (const zoneId of rule.zoneIds) {
    const zone = zonesById.get(zoneId)
    if (!zone) continue
    if (pointInPolygon(center, zone.polygon)) return true
  }
  return false
}

/**
 * Standard ray-casting point-in-polygon. Polygon vertices are
 * normalised (0–1); the test point is too — frame-resolution-
 * agnostic. Boundary points count as inside (treats `<` as `<=` on
 * the y-edge crossing).
 */
function pointInPolygon(
  point: { readonly x: number; readonly y: number },
  polygon: ReadonlyArray<{ readonly x: number; readonly y: number }>,
): boolean {
  if (polygon.length < 3) return false
  let inside = false
  const { x, y } = point
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!
    const b = polygon[j]!
    const intersect =
      a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x
    if (intersect) inside = !inside
  }
  return inside
}
