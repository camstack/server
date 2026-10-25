/**
 * key-event-scoring — the SINGLE deterministic "importance" scorer for a
 * completed track. A value in [0,1] the viewer sorts events by (events page)
 * and a future reels feature pulls highlights from.
 *
 * PURE + DETERMINISTIC: no Date.now / no random. Time enters ONLY as the
 * precomputed `durationMs` (the caller already knows a track's dwell). Given
 * the same `ScoringInput`, `computeImportance` always returns the same
 * `{ importance, reason }`.
 *
 * The score is a weighted sum of seven independent, individually-saturated
 * signals. Every weight and knee is a NAMED EXPORT so the formula is auditable
 * and the tests can assert exact wiring. The weights sum to exactly 1.0, so an
 * all-signals-maxed track scores exactly 1.0 (the clamp is then a no-op) and an
 * all-zero track scores 0.
 */

// ── Weights (sum === 1.0) ───────────────────────────────────────────────
export const WEIGHT_CONFIDENCE = 0.3
export const WEIGHT_CLASS = 0.2
export const WEIGHT_DWELL = 0.2
export const WEIGHT_PROXIMITY = 0.12
export const WEIGHT_TRAVEL = 0.08
export const WEIGHT_ZONE = 0.05
export const WEIGHT_IDENTITY = 0.05

// ── Saturation knees (value at which a signal reaches its full weight) ───
/** Dwell (ms) that saturates the dwell term. */
export const DWELL_FULL_MS = 60_000
/** Peak bbox area (as a fraction of frame area) that saturates the size term. */
export const SIZE_FULL = 0.15
/** Cumulative normalized travel (in frame-widths) that saturates travel. */
export const TRAVEL_FULL = 2.0

// ── Static-track suppression (ghost / stationary-object gate) ────────────
/** A track whose net centroid displacement stays below this fraction of the
 *  frame diagonal over its whole life counts as stationary on the net signal. */
export const STATIC_DISPLACEMENT_FRAC = 0.02
/** ...and whose entire centroid path fits within this fraction of the frame
 *  diagonal counts as stationary on the span signal. Both must hold. */
export const STATIC_SPAN_FRAC = 0.04
/** Importance multiplier applied to a stationary track that has NO resolved
 *  identity — strongly demotes "ghost" detections on static objects (a pile of
 *  clothes read as a person, a kitchen object read as an animal) below the
 *  key-event threshold. Identified tracks (face/plate) are never suppressed. */
export const STATIC_IMPORTANCE_MULTIPLIER = 0.1

// ── Class ranking ───────────────────────────────────────────────────────
export const CLASS_RANK_PERSON = 1.0
export const CLASS_RANK_VEHICLE = 0.8
export const CLASS_RANK_ANIMAL = 0.5
export const CLASS_RANK_DEFAULT = 0.25

const PERSON_CLASSES: ReadonlySet<string> = new Set(['person', 'face'])
const VEHICLE_CLASSES: ReadonlySet<string> = new Set(['vehicle', 'car', 'truck', 'bus'])
const ANIMAL_CLASSES: ReadonlySet<string> = new Set(['animal', 'dog', 'cat'])

/** Importance sub-signal that carried the largest weighted term for a track. */
export type ImportanceReason =
  | 'identity'
  | 'dwell'
  | 'proximity'
  | 'class'
  | 'confidence'
  | 'travel'
  | 'zone'

export interface ScoringInput {
  /** Highest detector confidence observed for the track (0..1). */
  readonly peakConfidence: number
  /** Track class label (e.g. 'person', 'car'). Case-insensitive. */
  readonly className: string
  /** Track lifetime in ms (lastSeen - firstSeen). Precomputed by the caller. */
  readonly durationMs: number
  /** Peak bbox area as a fraction of frame area (0..1). */
  readonly peakBboxAreaFrac: number
  /** Cumulative normalized distance travelled (frame-widths). */
  readonly totalDistance: number
  /** Zones the track entered at least once. */
  readonly zonesVisited: readonly string[]
  /**
   * The DISPLAY label — the finest thing known about the subject, whichever
   * tier it came from (`subLabel ?? label`). Drives the identity WEIGHT only:
   * a track somebody could name is worth a nudge over one nothing described.
   */
  readonly label?: string
  /**
   * TIER 2 ONLY — a recognised FACE or a read PLATE. The one thing that exempts
   * a stationary track from {@link STATIC_IMPORTANCE_MULTIPLIER}.
   *
   * Separate from {@link label} because the two answer different questions, and
   * collapsing them cost real salience. The gate used to read `displayLabel()`
   * (`subLabel ?? label`), which after the 4g tiering returns the TIER-1
   * SUB-CLASS whenever no identity exists — so the vehicle classifier writing
   * "Car" onto a parked car told the gate the car was identified, and the
   * demotion never fired. Measured on the fleet 2026-08-20: 68 tracks/day kept
   * 10x the importance they had earned, all of them scenery.
   *
   * A sub-class says WHAT it is; only tier 2 says WHO it is. Only the second
   * one is worth surfacing a motionless object for.
   */
  readonly identityLabel?: string
  /** Net centroid displacement over the track's life, as a fraction of the
   *  frame diagonal. Omitted when track geometry is unavailable → static gate
   *  stays inert (score unchanged). */
  readonly netDisplacementFrac?: number
  /** Diagonal of the track's centroid bounding box, as a fraction of the frame
   *  diagonal. Omitted when unavailable → static gate stays inert. */
  readonly pathSpanFrac?: number
}

export interface ImportanceResult {
  readonly importance: number
  readonly reason: ImportanceReason
}

/** Clamp to [0,1]. */
export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

/**
 * Rank a class name into [0,1] by how event-worthy it is. Case-insensitive.
 *
 * `audio` falls through to {@link CLASS_RANK_DEFAULT} on purpose — a sound is
 * not a subject in frame. Before D189 an audio episode carried the HEARD class
 * here, so `dog`/`cat`/`animal` landed in {@link ANIMAL_CLASSES} and a bark
 * ranked as if an animal had walked past, while `speech` (500 of the 576 audio
 * rows measured live) already ranked default. That boost was an accident of the
 * class collision, not a decision. Pinned by `key-event-scoring.spec.ts`.
 */
export function classRank(className: string): number {
  const c = className.toLowerCase()
  if (PERSON_CLASSES.has(c)) return CLASS_RANK_PERSON
  if (VEHICLE_CLASSES.has(c)) return CLASS_RANK_VEHICLE
  if (ANIMAL_CLASSES.has(c)) return CLASS_RANK_ANIMAL
  return CLASS_RANK_DEFAULT
}

interface WeightedTerm {
  readonly reason: ImportanceReason
  readonly value: number
}

/**
 * Compute a deterministic importance score for a completed track.
 *
 * `reason` is the tag of the single largest weighted term. Ties resolve to the
 * first term in a fixed, weight-descending order (confidence → class → dwell →
 * proximity → travel → zone → identity), so the output stays deterministic.
 */
export function computeImportance(input: ScoringInput): ImportanceResult {
  const terms: readonly WeightedTerm[] = [
    {
      reason: 'confidence',
      value: WEIGHT_CONFIDENCE * clamp01(input.peakConfidence),
    },
    { reason: 'class', value: WEIGHT_CLASS * classRank(input.className) },
    {
      reason: 'dwell',
      value: WEIGHT_DWELL * clamp01(input.durationMs / DWELL_FULL_MS),
    },
    {
      reason: 'proximity',
      value: WEIGHT_PROXIMITY * clamp01(input.peakBboxAreaFrac / SIZE_FULL),
    },
    {
      reason: 'travel',
      value: WEIGHT_TRAVEL * clamp01(input.totalDistance / TRAVEL_FULL),
    },
    {
      reason: 'zone',
      value: WEIGHT_ZONE * (input.zonesVisited.length > 0 ? 1 : 0),
    },
    { reason: 'identity', value: WEIGHT_IDENTITY * (input.label ? 1 : 0) },
  ]

  let sum = 0
  let best: WeightedTerm = terms[0]!
  for (const term of terms) {
    sum += term.value
    if (term.value > best.value) best = term
  }

  // Static-object gate: a track that never actually moved (both the net
  // displacement AND the whole-path span stay below their frame-diagonal
  // thresholds) is a stationary object read as a subject. Strongly demote it —
  // unless it carries a resolved IDENTITY (a recognized face/plate is always
  // worth surfacing; a tier-1 sub-class is not). Inert when geometry wasn't
  // supplied.
  // IDENTITY, not sub-class: see `ScoringInput.identityLabel`. Reading the
  // display label here is the 2026-08-20 defect — a tier-1 "Car" is not a
  // reason to surface a parked car.
  const identified = input.identityLabel !== undefined && input.identityLabel.length > 0
  const stationary =
    input.netDisplacementFrac !== undefined &&
    input.pathSpanFrac !== undefined &&
    input.netDisplacementFrac < STATIC_DISPLACEMENT_FRAC &&
    input.pathSpanFrac < STATIC_SPAN_FRAC
  if (stationary && !identified) {
    return {
      importance: clamp01(sum * STATIC_IMPORTANCE_MULTIPLIER),
      reason: best.reason,
    }
  }

  return { importance: clamp01(sum), reason: best.reason }
}
