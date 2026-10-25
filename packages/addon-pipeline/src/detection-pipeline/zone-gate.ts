/**
 * Source-level zone-rule gate — the pure half of
 * `DetectionPipelineProvider.gateDetectionsByZoneRules` (the provider keeps
 * only the DeviceProxy lookup). Drops first-level detections whose center
 * lies in an `exclude` rule's zones (or, in whitelist mode, isn't in any
 * `include` rule's zones), and any `detail` children whose `parentId`
 * references a dropped first-level.
 *
 * This gate runs AFTER the executor built the FrameResult — its drops are
 * invisible to the pipeline trace's counts, which is exactly why the
 * discard trail must record them here, unconditionally: without it a
 * zone-gated box is the one discard an operator can never see (the
 * 2026-07-31 "rule unable to fire for 15h" class of invisibility).
 *
 * Coordinate space: survivors carry `{x, y, width, height}` pixel bboxes;
 * `DiscardedDetection.bbox` is the `[x1, y1, x2, y2]` pixel tuple — the
 * conversion happens here so every discard on the wire shares one shape.
 */
import type {
  DiscardedDetection,
  FrameResult,
  ObjectDetection,
  Zone,
  ZoneRule,
} from '@camstack/types'
import { evaluateZoneRules } from '@camstack/types'

export function applyZoneRuleGate(
  result: FrameResult,
  zones: readonly Zone[],
  rules: readonly ZoneRule[],
): FrameResult {
  if (result.detections.length === 0) return result
  if (zones.length === 0 || rules.length === 0) return result
  const frameW = result.width
  const frameH = result.height
  if (frameW === 0 || frameH === 0) return result

  // Partition first-level detections; details follow their parent.
  const firstLevel = result.detections.filter((d): d is ObjectDetection => d.kind === 'first-level')
  const details = result.detections.filter((d) => d.kind === 'detail')
  const { passed, excluded } = evaluateZoneRules(
    firstLevel,
    zones,
    rules,
    (det) => ({
      x: (det.bbox.x + det.bbox.width / 2) / frameW,
      y: (det.bbox.y + det.bbox.height / 2) / frameH,
    }),
    (det) => det.macroClass,
  )
  if (passed.length === firstLevel.length) return result
  const passedIds = new Set(passed.map((d) => d.id))
  const filteredDetails = details.filter((d) => {
    const parentId = d.parentId
    return parentId === undefined || passedIds.has(parentId)
  })

  // Discard trail: only FIRST-LEVEL drops are recorded — a detail
  // (face/plate) dies purely because its parent did, and a second
  // ghost box on the same spot would double-count the one decision.
  const zoneDiscards: readonly DiscardedDetection[] = excluded.map((d) => ({
    bbox: [d.bbox.x, d.bbox.y, d.bbox.x + d.bbox.width, d.bbox.y + d.bbox.height] as const,
    macroClass: d.macroClass,
    score: d.score,
    reason: 'zone-gate' as const,
  }))
  const mergedDiscarded = [...(result.discarded ?? []), ...zoneDiscards]

  return {
    ...result,
    detections: [...passed, ...filteredDetails],
    ...(mergedDiscarded.length > 0 ? { discarded: mergedDiscarded } : {}),
  }
}
