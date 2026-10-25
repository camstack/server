// ---------------------------------------------------------------------------
// Current-condition resolver — layered day/night determination
// ---------------------------------------------------------------------------
//
// Day/night IR-cut transitions measurably shift CLIP embeddings, so a reference
// captured in daylight can silently stop matching at night. Each reference is
// condition-tagged; this resolver decides the CURRENT condition so matching
// selects the right set. Layered, in order (spec §"Determining the current
// condition"):
//   1. forced day-night mode (operator pinned the IR-cut) — honest, zero-cost.
//   2. sun-times from the install coordinates — deterministic, tracks ambient
//      lighting (the physical driver of the drift). Compact NOAA computation so
//      the addon stays self-contained (no `suncalc` dep exists in the repo).
//   3. coarse UTC clock split — last resort when no coordinates are configured.

import type { SceneCondition } from '@camstack/types'

export interface Coordinates {
  readonly lat: number
  readonly lng: number
}

export interface ConditionResolverInput {
  /** Operator-pinned IR-cut mode; wins outright when 'day' | 'night'. */
  readonly forcedMode?: 'day' | 'night'
  /**
   * Mean per-pixel channel spread of the live frame (0..255), from
   * `chromaSpread()` in `scene-crop.ts`. Below {@link IR_CHROMA_THRESHOLD} the
   * camera's IR-cut filter is out and the frame carries no colour.
   */
  readonly chromaSpread?: number
  /** Install coordinates — enables the sun-times layer. */
  readonly coordinates?: Coordinates
  readonly now: Date
}

const DAY: SceneCondition = 'day'
const NIGHT: SceneCondition = 'night'
const IR: SceneCondition = 'ir'
const DAWN: SceneCondition = 'dawn'
const DUSK: SceneCondition = 'dusk'
const DEG = Math.PI / 180

/**
 * Mean channel spread below which a frame is judged infrared.
 *
 * An IR frame is chromatically FLAT — every pixel's R, G and B agree, so the
 * spread collapses to sensor noise (single digits). A daylight frame measures
 * tens even on an overcast day, and a floodlit driveway at night still carries
 * real colour. 6 sits in the gap with room on both sides; it is deliberately
 * not tuned to a specific camera, because the quantity being measured is a
 * property of the IR-cut filter, not of the scene.
 */
export const IR_CHROMA_THRESHOLD = 6

/**
 * Half-width of the twilight band around sunrise and sunset.
 *
 * Dawn and dusk are their OWN conditions rather than an edge of day or night,
 * because that is precisely the light no captured reference covers: a day
 * reference scored against a half-lit frame diverges on the light, and the
 * operator is told the bin was taken at 21:40. With no reference for `dusk` the
 * scene reports `unknown` — the honest answer.
 */
const TWILIGHT_BAND_MS = 40 * 60 * 1000

/** Julian day number for a JS Date (UTC). */
function toJulian(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5
}

/** Julian day → epoch ms (UTC). */
function fromJulian(j: number): number {
  return (j - 2_440_587.5) * 86_400_000
}

/**
 * Sunrise/sunset (UTC epoch ms) for a location and date via the standard NOAA
 * sunrise equation. Returns `null` for the polar edge cases (sun never
 * rises/sets that day) so the caller can degrade to the clock split.
 */
function sunTimes(lat: number, lng: number, date: Date): { rise: number; set: number } | null {
  const jDate = toJulian(date)
  const n = Math.round(jDate - 2_451_545.0 + 0.0008)
  const jStar = n - lng / 360
  const m = (357.5291 + 0.985_600_28 * jStar) % 360
  const mRad = m * DEG
  const c = 1.9148 * Math.sin(mRad) + 0.02 * Math.sin(2 * mRad) + 0.0003 * Math.sin(3 * mRad)
  const lambda = ((m + c + 180 + 102.9372) % 360) * DEG
  const jTransit = 2_451_545.0 + jStar + 0.0053 * Math.sin(mRad) - 0.0069 * Math.sin(2 * lambda)
  const declination = Math.asin(Math.sin(lambda) * Math.sin(23.44 * DEG))
  const latRad = lat * DEG
  const cosOmega =
    (Math.sin(-0.833 * DEG) - Math.sin(latRad) * Math.sin(declination)) /
    (Math.cos(latRad) * Math.cos(declination))
  if (cosOmega > 1 || cosOmega < -1) return null // polar night / polar day
  const omega = Math.acos(cosOmega) / DEG
  const jRise = jTransit - omega / 360
  const jSet = jTransit + omega / 360
  return { rise: fromJulian(jRise), set: fromJulian(jSet) }
}

/** Coarse UTC clock split — day between 06:00 and 20:00 UTC. Deterministic
 *  last resort when no coordinates let us compute real sun-times. */
function clockCondition(now: Date): SceneCondition {
  const hour = now.getUTCHours()
  return hour >= 6 && hour < 20 ? DAY : NIGHT
}

/**
 * Resolve the current condition through the layered strategy:
 *
 *   1. operator-pinned `day-night` mode — intent wins;
 *   2. MEASURED chroma ⇒ `ir` when flat — a direct observation of the thing
 *      that shifts the embedding, and sub-millisecond on a frame already
 *      decoded for the crop;
 *   3. sun-times from the install coordinates, with a ±40 min band around
 *      sunrise/sunset ⇒ `dawn` | `dusk`, otherwise `day` | `night`;
 *   4. coarse clock split — last resort, and it is **UTC**, which is
 *      meaningfully wrong outside roughly UTC±3. Configure the coordinates.
 *
 * Layer 2 sits above layer 3 deliberately: an IR-cut can engage at any hour
 * (a covered driveway, a dark day), and the frame knows while the almanac
 * does not.
 */
export function resolveCondition(input: ConditionResolverInput): SceneCondition {
  return resolveConditionDetailed(input).condition
}

/** Which layer of {@link resolveCondition} produced the answer. */
export type ConditionSource = 'forced' | 'ir-chroma' | 'sun' | 'clock'

export interface ResolvedCondition {
  readonly condition: SceneCondition
  readonly source: ConditionSource
}

/**
 * {@link resolveCondition}, plus the layer that answered. A consumer that
 * reports a day/night split (the retrain export, D785) must be able to tell a
 * measured IR frame from an almanac or a clock guess.
 */
export function resolveConditionDetailed(input: ConditionResolverInput): ResolvedCondition {
  if (input.forcedMode === 'day' || input.forcedMode === 'night') {
    return { condition: input.forcedMode, source: 'forced' }
  }
  if (input.chromaSpread !== undefined && input.chromaSpread < IR_CHROMA_THRESHOLD) {
    return { condition: IR, source: 'ir-chroma' }
  }
  if (input.coordinates) {
    const times = sunTimes(input.coordinates.lat, input.coordinates.lng, input.now)
    if (times) {
      const t = input.now.getTime()
      if (Math.abs(t - times.rise) <= TWILIGHT_BAND_MS) return { condition: DAWN, source: 'sun' }
      if (Math.abs(t - times.set) <= TWILIGHT_BAND_MS) return { condition: DUSK, source: 'sun' }
      return { condition: t >= times.rise && t < times.set ? DAY : NIGHT, source: 'sun' }
    }
  }
  return { condition: clockCondition(input.now), source: 'clock' }
}
