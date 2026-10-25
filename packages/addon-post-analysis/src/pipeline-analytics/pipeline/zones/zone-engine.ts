import type { Zone, ZoneRule } from '@camstack/types'
import { normalizeToPixel, type BboxRect } from './geometry.js'
import { bboxPolygonOverlap, maskPolygonOverlap } from './overlap.js'

/**
 * Default overlap threshold applied when a rule omits both
 * `bboxInclusionPct` and the legacy `overlapThreshold`. Aligned with
 * the operator-friendly default of 85% on the schema — historically
 * this was 10% but that rarely matched intent (a person standing
 * with one foot inside a zone would count as fully inside).
 */
const DEFAULT_OVERLAP_THRESHOLD = 0.85

/**
 * Membership annotation is a DIFFERENT semantic from rule firing: it
 * answers "which zones does this detection geometrically touch" (for UI
 * overlay tags + per-event zone labels), not "is it sufficiently inside
 * to trigger an include/exclude rule". Any positive overlap counts —
 * decoupled from {@link DEFAULT_OVERLAP_THRESHOLD} so the operator-facing
 * 85% rule default doesn't silently drop membership tags.
 */
const MEMBERSHIP_MIN_OVERLAP = 0

/**
 * Resolve the effective 0–1 overlap threshold for a rule, preferring
 * the operator-facing `bboxInclusionPct` (0–100) when it diverges from
 * the schema default, falling back to the legacy `overlapThreshold`
 * (0–1) when present, and finally to the engine default.
 */
function resolveRuleThreshold(rule: {
  readonly bboxInclusionPct?: number
  readonly overlapThreshold?: number
}): number {
  if (typeof rule.bboxInclusionPct === 'number') return rule.bboxInclusionPct / 100
  if (typeof rule.overlapThreshold === 'number') return rule.overlapThreshold
  return DEFAULT_OVERLAP_THRESHOLD
}

/**
 * Membership annotation produced by the engine when a detection
 * intersects a zone above threshold. Carried back to consumers so
 * the live UI overlay + per-event payloads can display zone tags.
 */
export interface DetectionZoneMembership {
  readonly zoneId: string
  readonly zoneName: string
  /** Overlap fraction (0–1). */
  readonly overlap: number
}

/**
 * Both sides of the membership bar for one detection.
 *
 * Raising `zoneMembershipMinOverlap` makes the stamping log go QUIET for the
 * very cases it was armed to measure — a zone dropped by the bar produces no
 * `zones` entry, and an event with no zones is not logged at all. Silence then
 * reads as "no traffic" when it means "every zone was rejected". Keeping the
 * rejected overlaps is what lets the bar be re-chosen from data after it has
 * been raised, instead of only before.
 */
export interface ZoneMembershipSplit {
  /** Zones the detection overlapped by MORE than the bar — these are stamped. */
  readonly memberships: readonly DetectionZoneMembership[]
  /** Zones it touched but not enough. Never stamped; measurement only. */
  readonly belowBar: readonly DetectionZoneMembership[]
}

export interface FilterResult<T> {
  readonly passed: readonly T[]
  readonly excluded: readonly T[]
  /** Per-detection zone memberships (every zone the bbox geometrically
   *  intersects, regardless of include/exclude verdict or rule threshold). */
  readonly annotations: ReadonlyMap<T, readonly DetectionZoneMembership[]>
}

interface ResolvedRule {
  readonly rule: ZoneRule
  readonly threshold: number
  readonly zonesById: ReadonlyMap<string, Zone>
}

/**
 * Pure zone engine — accepts a zone catalogue + a rule set and
 * decides which detections pass for a stage.
 *
 * Stage gating semantics:
 *   - any active `include` rule fires ⇒ whitelist mode: a detection
 *     passes iff it satisfies at least one include rule
 *   - otherwise ⇒ blacklist mode: a detection passes iff no exclude
 *     rule fires for it
 *
 * Inactive rules (`enabled: false`) are skipped before the gate is
 * evaluated so a partially-toggled rule set behaves intuitively.
 *
 * Rule satisfaction is decided per-rule:
 *   1. If the rule has a non-empty `classFilter` and the detection's
 *      class isn't in it, the rule is skipped for this detection.
 *   2. Otherwise the engine tests overlap against every zone the
 *      rule references; the rule fires if ANY of those overlaps
 *      meets `rule.overlapThreshold` (or the engine default).
 */
export class ZoneEngine {
  /**
   * Annotate a single detection with its zone memberships — every zone whose
   * polygon the detection overlaps by MORE than `minOverlap` (0–1 fraction of
   * the detection's own area).
   *
   * The previous version of this comment claimed memberships were returned
   * "above any active rule's threshold"; they were not — the threshold was
   * hardcoded to {@link MEMBERSHIP_MIN_OVERLAP} (zero) and no rule was ever
   * consulted. Read the parameter, not this paragraph.
   *
   * `minOverlap` matters because membership is what lands on an event as
   * `zones`, and a notification rule's `zones` condition is a plain set test
   * over that field — so this, not the zone-RULE threshold, is what decides
   * whether a zone-scoped notification fires. At the default of 0 a subject
   * clipping a zone by one pixel counts as inside it (measured 2026-07-30: a
   * dog overlapping `Aiuola` by 4.8% would have been stamped as in it).
   */
  annotateDetection(
    bbox: BboxRect,
    zones: readonly Zone[],
    frameWidth: number,
    frameHeight: number,
    mask?: Uint8Array,
    maskWidth?: number,
    maskHeight?: number,
    minOverlap: number = MEMBERSHIP_MIN_OVERLAP,
  ): DetectionZoneMembership[] {
    return [
      ...this.splitDetectionZones(
        bbox,
        zones,
        frameWidth,
        frameHeight,
        mask,
        maskWidth,
        maskHeight,
        minOverlap,
      ).memberships,
    ]
  }

  /**
   * {@link annotateDetection}, keeping the zones the bar REJECTED as well as
   * the ones it admitted. Same geometry, one pass — see
   * {@link ZoneMembershipSplit} for why the rejected side has to survive.
   */
  splitDetectionZones(
    bbox: BboxRect,
    zones: readonly Zone[],
    frameWidth: number,
    frameHeight: number,
    mask?: Uint8Array,
    maskWidth?: number,
    maskHeight?: number,
    minOverlap: number = MEMBERSHIP_MIN_OVERLAP,
  ): ZoneMembershipSplit {
    const memberships: DetectionZoneMembership[] = []
    const belowBar: DetectionZoneMembership[] = []
    for (const zone of zones) {
      const pixelPolygon = zone.polygon.map((p) => normalizeToPixel(p, frameWidth, frameHeight))
      const overlap =
        mask && maskWidth && maskHeight
          ? maskPolygonOverlap(
              mask,
              maskWidth,
              maskHeight,
              bbox,
              pixelPolygon,
              frameWidth,
              frameHeight,
            )
          : bboxPolygonOverlap(bbox, pixelPolygon)
      const entry: DetectionZoneMembership = {
        zoneId: zone.id,
        zoneName: zone.name,
        overlap,
      }
      // A zero-overlap zone is not "rejected by the bar", it is simply
      // elsewhere in the frame — recording it would drown the signal.
      if (overlap > minOverlap) memberships.push(entry)
      else if (overlap > 0) belowBar.push(entry)
    }
    return { memberships, belowBar }
  }

  /**
   * Filter detections through a zone-rule set. `zones` provides the
   * geometry catalogue; `rules` decides include / exclude behaviour.
   * Pass an empty `rules` array to short-circuit (everything passes).
   */
  filterDetections<T extends BboxRect>(
    detections: readonly T[],
    zones: readonly Zone[],
    rules: readonly ZoneRule[],
    frameWidth: number,
    frameHeight: number,
    getClassName?: (d: T) => string | undefined,
    getMask?: (d: T) => { mask: Uint8Array; width: number; height: number } | undefined,
  ): FilterResult<T> {
    const annotations = new Map<T, DetectionZoneMembership[]>()
    if (rules.length === 0 || zones.length === 0) {
      for (const det of detections) {
        annotations.set(det, this.annotateDetection(det, zones, frameWidth, frameHeight))
      }
      return { passed: detections, excluded: [], annotations }
    }

    const zonesById = new Map(zones.map((z) => [z.id, z]))
    const activeRules: ResolvedRule[] = rules
      .filter((r) => r.enabled !== false)
      .map((rule) => ({
        rule,
        threshold: resolveRuleThreshold(rule),
        zonesById,
      }))

    const includeRules = activeRules.filter((r) => r.rule.mode === 'include')
    const excludeRules = activeRules.filter((r) => r.rule.mode === 'exclude')
    const whitelistMode = includeRules.length > 0

    const passed: T[] = []
    const excluded: T[] = []

    for (const det of detections) {
      const memberships = this.annotateDetection(det, zones, frameWidth, frameHeight)
      annotations.set(det, memberships)

      const className = getClassName?.(det)
      const maskInfo = getMask?.(det)

      const inIncludeRule = includeRules.some((r) =>
        ruleApplies(r, det, className, maskInfo, zones, frameWidth, frameHeight),
      )
      const inExcludeRule = excludeRules.some((r) =>
        ruleApplies(r, det, className, maskInfo, zones, frameWidth, frameHeight),
      )

      if (whitelistMode) {
        if (inIncludeRule && !inExcludeRule) {
          passed.push(det)
        } else {
          excluded.push(det)
        }
      } else {
        if (inExcludeRule) {
          excluded.push(det)
        } else {
          passed.push(det)
        }
      }
    }

    return { passed, excluded, annotations }
  }
}

function ruleApplies<T extends BboxRect>(
  resolved: ResolvedRule,
  det: T,
  className: string | undefined,
  maskInfo: { mask: Uint8Array; width: number; height: number } | undefined,
  _zones: readonly Zone[],
  frameWidth: number,
  frameHeight: number,
): boolean {
  const { rule, threshold, zonesById } = resolved
  if (rule.classFilter && rule.classFilter.length > 0) {
    if (!className || !rule.classFilter.includes(className)) return false
  }
  for (const zoneId of rule.zoneIds) {
    const zone = zonesById.get(zoneId)
    if (!zone) continue
    const pixelPolygon = zone.polygon.map((p) => normalizeToPixel(p, frameWidth, frameHeight))
    const overlap =
      rule.preferMask && maskInfo
        ? maskPolygonOverlap(
            maskInfo.mask,
            maskInfo.width,
            maskInfo.height,
            det,
            pixelPolygon,
            frameWidth,
            frameHeight,
          )
        : bboxPolygonOverlap(det, pixelPolygon)
    if (overlap >= threshold) return true
  }
  return false
}
