/**
 * Whether a live track is motion inside a configured package drop-off zone.
 *
 * The stillness activity gate used to stamp ANY non-package track on the
 * camera. A walker at the far gate then "delivered" the streetlight wedge
 * on the doormat. The operator's prerequisite is motion in the drop-off
 * zone the package rule points at — the same zones `PackageDropDetector`
 * uses for the centroid gate.
 */
export function isDelivererInPackageZone(
  trackZones: readonly string[],
  packageZoneIds: ReadonlySet<string>,
): boolean {
  if (packageZoneIds.size === 0 || trackZones.length === 0) return false
  for (const z of trackZones) {
    if (packageZoneIds.has(z)) return true
  }
  return false
}

export interface PackageZoneRuleLike {
  readonly enabled?: boolean
  readonly zoneIds: readonly string[]
}

import type { PackageZoneCropRect } from './package-reference-area.js'

export interface PackageOptionRule extends PackageZoneRuleLike {
  readonly detectBySceneDifference?: boolean
  readonly confirmWithLlm?: boolean
}

/** Zone ids of enabled package rules that turned one option on. */
export function packageRuleZoneIds(
  rules: readonly PackageOptionRule[],
  flag: 'detectBySceneDifference' | 'confirmWithLlm',
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const rule of rules) {
    if (rule.enabled === false) continue
    const on =
      flag === 'detectBySceneDifference'
        ? rule.detectBySceneDifference === true
        : rule.confirmWithLlm === true
    if (!on) continue
    for (const zoneId of rule.zoneIds) ids.add(zoneId)
  }
  return ids
}

/** Zone ids referenced by enabled `package`-stage rules. Disabled rules do not count. */
export function collectPackageZoneIds(rules: readonly PackageZoneRuleLike[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const r of rules) {
    if (r.enabled === false) continue
    for (const z of r.zoneIds) ids.add(z)
  }
  return ids
}

/**
 * How much the package zone box grows on every side when asking whether motion
 * reached it. Mirrors the D144 dilation of the pipeline's burst trigger
 * (`PACKAGE_ZONE_DILATION` in addon-pipeline, not importable from here): about
 * one adult's width beside a doormat, the place a courier stands.
 */
export const PACKAGE_ZONE_MOTION_DILATION = 0.5

/**
 * A motion region covering more than this fraction of the frame is a light
 * change or the weather, not a person: it never counts as a deliverer.
 */
export const PACKAGE_ZONE_MOTION_MAX_REGION_FRAC = 0.8

export interface DelivererMotionInput {
  /** This tick's motion regions, in pixel space. */
  readonly regions: readonly {
    readonly bbox: {
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
    }
  }[]
  readonly frameWidth: number
  readonly frameHeight: number
  /** Normalised union of the package zones; null when unknown. */
  readonly zoneRect: PackageZoneCropRect | null
}

/**
 * Did analyzer motion reach the dilated package zone with a person-sized
 * region? Unknown geometry answers false: this stamp only ever BACKS the open
 * of a candidate, so failing closed keeps the light-wedge guard intact.
 */
export function delivererMotionNearPackageZone(input: DelivererMotionInput): boolean {
  const { zoneRect, frameWidth, frameHeight } = input
  if (zoneRect === null || frameWidth <= 0 || frameHeight <= 0) return false
  const dx = zoneRect.w * PACKAGE_ZONE_MOTION_DILATION
  const dy = zoneRect.h * PACKAGE_ZONE_MOTION_DILATION
  const left = Math.max(0, zoneRect.x - dx)
  const top = Math.max(0, zoneRect.y - dy)
  const right = Math.min(1, zoneRect.x + zoneRect.w + dx)
  const bottom = Math.min(1, zoneRect.y + zoneRect.h + dy)
  for (const region of input.regions) {
    const x = region.bbox.x / frameWidth
    const y = region.bbox.y / frameHeight
    const w = region.bbox.w / frameWidth
    const h = region.bbox.h / frameHeight
    if (w * h > PACKAGE_ZONE_MOTION_MAX_REGION_FRAC) continue
    if (x < right && left < x + w && y < bottom && top < y + h) return true
  }
  return false
}
