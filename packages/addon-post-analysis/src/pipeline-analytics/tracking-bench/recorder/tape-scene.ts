/**
 * Zones and detection rules as a tape carries them: geometry and class lists,
 * never a zone's or rule's NAME (a name is operator prose about a house) and
 * never a colour. Field by field, like every tape record.
 */
import type { Zone, ZoneRule } from '@camstack/types'
import type { TapeScene, TapeZone, TapeZoneRule } from '../tape-schema.js'

function tapeZone(z: Zone): TapeZone {
  return { id: z.id, kind: z.kind, polygon: z.polygon.map((p) => ({ x: p.x, y: p.y })) }
}

function tapeRule(r: ZoneRule): TapeZoneRule {
  return {
    id: r.id,
    zoneIds: [...r.zoneIds],
    mode: r.mode,
    ...(r.classFilter !== undefined ? { classFilter: [...r.classFilter] } : {}),
    ...(r.overlapThreshold !== undefined ? { overlapThreshold: r.overlapThreshold } : {}),
    ...(r.bboxInclusionPct !== undefined ? { bboxInclusionPct: r.bboxInclusionPct } : {}),
    ...(r.preferMask !== undefined ? { preferMask: r.preferMask } : {}),
    enabled: r.enabled,
  }
}

export function tapeSceneOf(
  zones: readonly Zone[],
  rules: readonly ZoneRule[],
  zoneMembershipMinOverlap: number,
  lowScoreFloor: number | null,
): TapeScene {
  return {
    zones: zones.map(tapeZone),
    rules: rules.map(tapeRule),
    zoneMembershipMinOverlap,
    lowScoreFloor,
  }
}
