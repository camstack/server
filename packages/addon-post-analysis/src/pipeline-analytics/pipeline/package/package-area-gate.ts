/**
 * Package area gate — the size ceiling applied BEFORE a package sighting may
 * open (or refresh) a stillness candidate.
 *
 * ## Why a ceiling, when a floor already exists
 *
 * `packageDropMinBboxAreaFrac` rejects far-field specks. Nothing rejected the
 * other end, and the other end is where device 101's ONE real false positive
 * lives: the streetlight's light wedge on the granite paving, detected as
 * `package` at 7.96–9.47% of the frame, up to 0.877 confidence, 348 of 350
 * false detections over 21 days (2026-08-21 analysis, scratchpad/_pkg).
 * Confidence cannot separate it — the one true parcel measured scored 0.885 —
 * but AREA separates it cleanly: real parcels measured 1.14% and 1.72% of the
 * frame, the wedge never below 7.96%.
 *
 * The verdict is computed per SIGHTING, before candidate association, so the
 * wedge never even opens a candidate — the delivered/picked-up flicker loop
 * (~23 false notifications a night) is cut at the source rather than at the
 * event gate.
 *
 * Pure function; the caller owns settings resolution and logging (a rejected
 * sighting is DROPPED WORK and must be logged with `tags: { deviceId }`).
 */

import type { StationaryBbox } from '../stationary/stationary-types.js'

export interface PackageAreaGateInput {
  readonly bbox: StationaryBbox
  readonly frameWidth: number
  readonly frameHeight: number
  /** `packageDropMaxBboxAreaFrac` for this device. */
  readonly maxAreaFrac: number
}

export interface PackageAreaVerdict {
  /** `true` = small enough to be a parcel; `false` = over the ceiling. */
  readonly ok: boolean
  /** bbox area as a fraction of the frame (0 when dimensions are unknown). */
  readonly areaFrac: number
}

/**
 * Decide whether a package-class box is plausibly parcel-sized.
 *
 * Unknown frame dimensions never reject: this gate exists to kill one known
 * oversize artefact, and `PackageDropDetector`'s size gate already owns the
 * "frame dimensions unknown" case with its own logged branch.
 */
export function packageAreaVerdict(input: PackageAreaGateInput): PackageAreaVerdict {
  const frameArea = input.frameWidth * input.frameHeight
  if (frameArea <= 0) return { ok: true, areaFrac: 0 }
  const areaFrac = (input.bbox.w * input.bbox.h) / frameArea
  return { ok: areaFrac <= input.maxAreaFrac, areaFrac }
}
