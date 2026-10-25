/**
 * Motion-stage zone gating — thin wrapper over the canonical
 * {@link evaluateZoneRules} helper in `@camstack/types/utils`.
 * Translates a motion region's pixel-space bbox into the normalised
 * (0–1) center the shared evaluator expects, and returns the
 * passed/excluded partition.
 *
 * Motion has no per-region class — the shared evaluator treats a
 * missing className as "every classFilter matches", which is the
 * intended semantics for the motion stage (operators using
 * `classFilter` on a motion rule typically do so by mistake; the
 * evaluator stays permissive instead of silently dropping motion
 * with no class).
 */

import type { Zone, ZoneRule, ZoneRuleEvalResult } from '@camstack/types'
import { evaluateZoneRules } from '@camstack/types'

export interface MotionRegionLike {
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
}

export type GateResult<T extends MotionRegionLike> = ZoneRuleEvalResult<T>

export function gateMotionRegions<T extends MotionRegionLike>(
  regions: readonly T[],
  zones: readonly Zone[],
  rules: readonly ZoneRule[],
  frameWidth: number,
  frameHeight: number,
): GateResult<T> {
  if (frameWidth === 0 || frameHeight === 0) {
    return { passed: regions, excluded: [] }
  }
  return evaluateZoneRules(regions, zones, rules, (region) => ({
    x: (region.bbox.x + region.bbox.w / 2) / frameWidth,
    y: (region.bbox.y + region.bbox.h / 2) / frameHeight,
  }))
}
