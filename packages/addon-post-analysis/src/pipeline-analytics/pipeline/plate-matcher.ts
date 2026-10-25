/**
 * plate-matcher — name a plate read against the vehicle gallery by text vicinity.
 *
 * Parallel to face-matcher's `matchEmbedding`, but a plate is self-labeling:
 * distance is `plateDistance` (OCR-confusion-folded Levenshtein), not cosine.
 * There is no model-version gate (text has no embedding drift) and no ambiguity
 * `margin` (Levenshtein has no comparable normalized gap) — a tie is resolved
 * conservatively to NO match. The read's `score` weights how far it may match:
 * a high-confidence read (`score >= lowScoreFloor`) may match at `maxDistance`;
 * a low-confidence read is held to `lowScoreMaxDistance` (exact fold only).
 * "Prefer unassigned over wrong vehicle."
 */
import { plateDistance } from './plate-clustering.js'

export interface PlateGallerySample {
  readonly vehicleId: string
  readonly text: string
}

export interface PlateMatch {
  readonly vehicleId: string
  readonly distance: number
}

export interface PlateMatchOpts {
  /** Max folded edit-distance a HIGH-confidence read may match at. */
  readonly maxDistance: number
  /** OCR score at/above which the read is trusted to `maxDistance`. */
  readonly lowScoreFloor: number
  /** Max folded edit-distance a LOW-confidence read may match at (default 0). */
  readonly lowScoreMaxDistance: number
}

/** Calibration placeholders — re-tune against real OCR score distributions. */
export const DEFAULT_PLATE_MATCH_OPTS: PlateMatchOpts = {
  maxDistance: 1,
  lowScoreFloor: 0.5,
  lowScoreMaxDistance: 0,
}

export function matchPlateText(
  probe: { readonly text: string; readonly score: number },
  gallery: readonly PlateGallerySample[],
  opts: PlateMatchOpts,
): PlateMatch | null {
  const allowed = probe.score >= opts.lowScoreFloor ? opts.maxDistance : opts.lowScoreMaxDistance

  // Best (lowest) folded distance per vehicle.
  const bestByVehicle = new Map<string, number>()
  for (const s of gallery) {
    const dist = plateDistance(probe.text, s.text)
    const prev = bestByVehicle.get(s.vehicleId)
    if (prev === undefined || dist < prev) bestByVehicle.set(s.vehicleId, dist)
  }
  if (bestByVehicle.size === 0) return null

  let bestId: string | null = null
  let bestDist = Infinity
  let tie = false
  for (const [vehicleId, dist] of bestByVehicle) {
    if (dist > allowed) continue
    if (dist < bestDist) {
      bestDist = dist
      bestId = vehicleId
      tie = false
    } else if (dist === bestDist) {
      tie = true
    }
  }
  if (bestId === null || tie) return null
  return { vehicleId: bestId, distance: bestDist }
}
