/**
 * `BestDetectionTracker` — the SINGLE canonical policy for "the best detection
 * per track" (highest detector confidence per `trackId`).
 *
 * Post-analysis derives three per-track "best" artefacts, all keyed by
 * trackId + confidence, that used to each re-implement the same ranking inline:
 *  1. the best FRAME (a boxed `thumbnail`) — `index.ts`,
 *  2. the best FACE crop + its arcface embedding — `face-recognizer.ts`,
 *  3. the best CLIP object embedding — `store/object-embedding-store.ts`.
 *
 * Consumers 1 & 2 now share THIS one implementation so a track's best frame and
 * its best face crop derive from the same confidence ranking (and, when the peak
 * frame carries a detected face, the same frame). Consumer 3 (CLIP) is a
 * DOCUMENTED SEAM: its `upsertIfBetter` is persistence-backed (its best survives
 * an addon restart, which this in-memory tracker deliberately does not), so it
 * keeps its own store-side "if better" gate rather than reading this tracker.
 *
 * The FACE seam: the best FRAME is ranked over ALL tracked detections, while the
 * best FACE can only be captured on a frame that actually produced a face
 * embedding — so the two legitimately diverge when the peak-confidence frame has
 * no detected face. Each consumer therefore keeps its OWN payload (crop /
 * embedding / boxed frame); only the ranking DECISION is unified here.
 *
 * S9: each consumer's parameterization is a NAMED, test-pinned policy in
 * `best-selection-policies.ts` (`BEST_FRAME_POLICY` / `BEST_FACE_POLICY` /
 * `BEST_OBJECT_EMBED_POLICY`). Production call sites construct this tracker
 * WITH their policy — never bare — so no path can silently imply a policy
 * again by omitting arguments.
 */

import {
  type BestFrameCandidate,
  type BestFrameComparison,
  compareBestFrame,
  isDecisiveImprovement,
  isSemantic,
  isSquareContained,
} from './edge-clear.js'
import { renameKey } from './tracker-v2/rename.js'

export interface BestDetectionTrackerOptions {
  /** A new best must beat the held peak by STRICTLY MORE than this margin.
   *  0 = any strictly-higher confidence wins (used by the face path). A small
   *  positive margin (hysteresis) stops jitter around a plateau from churning
   *  expensive per-capture work (used by the best-frame path). */
  readonly hysteresis?: number
  /** Minimum wall-clock gap (ms) between accepted bests for a track — rate-limits
   *  expensive captures. 0 = no rate limit (the face path always keeps the true
   *  peak; holding a buffer in memory is cheap). */
  readonly minGapMs?: number
  /** Whether the edge-clear tier / centering / containment `observe` inputs
   *  participate in ranking. Default true (permissive: honored when supplied).
   *  A policy declaring `false` makes the tracker IGNORE those inputs — the
   *  declaration is enforced, not just documented. */
  readonly edgeAware?: boolean
  /** Whether the subject-size `observe` input participates — and with it the
   *  DECISIVE-improvement bypass of `minGapMs`. Default true (permissive). */
  readonly sizeAware?: boolean
  /** Whether the SEMANTIC-tier `observe` input (and `markSemantic`) participates
   *  in ranking. Default true (permissive: honored when supplied). A policy
   *  declaring `false` makes the tracker IGNORE the semantic bit — the
   *  declaration is enforced, not just documented. */
  readonly semanticAware?: boolean
}

export interface BestDetection {
  readonly confidence: number
  readonly atMs: number
}

export class BestDetectionTracker {
  private readonly hysteresis: number
  private readonly minGapMs: number
  private readonly edgeAware: boolean
  private readonly sizeAware: boolean
  private readonly semanticAware: boolean
  private readonly best = new Map<string, BestDetection>()
  /** Held peak's edge-clear tier, kept PARALLEL to `best` so `peak()`'s
   *  `{ confidence, atMs }` shape (a public contract) stays unchanged. Absent =
   *  the edge tier is not in play for the track (treated as clear → the legacy
   *  pure-confidence policy). */
  private readonly edgeClear = new Map<string, boolean>()
  /** Held peak's centeredness (0..1), PARALLEL to `best`. Absent = the caller
   *  does not supply centering (face / object-embedding paths) → the centering
   *  tie-break is disabled and the legacy confidence policy applies. */
  private readonly centerScore = new Map<string, number>()
  /** Held peak's edge-containment factor (0..1), PARALLEL to `best`. Absent =
   *  the caller does not supply containment (face / object-embedding paths) →
   *  the within-tier comparison stays on raw confidence (containment treated as
   *  1). */
  private readonly containment = new Map<string, number>()
  /** Held peak's subject-size score (0..1), PARALLEL to `best`. Absent = the
   *  caller does not supply size (face / object-embedding paths) → neutral. */
  private readonly sizeScore = new Map<string, number>()
  /** Held peak's delivered-square containment fraction (0..1), PARALLEL to
   *  `best`. Absent = the caller does not measure it → contained tier
   *  (legacy behaviour). */
  private readonly squareFraction = new Map<string, number>()
  /** Held peak's DELIVERED-CANVAS fill fraction (0..1), PARALLEL to `best`.
   *  Absent = the caller does not measure it → neutral (no fill). */
  private readonly canvasFill = new Map<string, number>()
  /** Held peak's SEMANTIC-tier bit (a recognition succeeded on that frame),
   *  PARALLEL to `best`. Absent = non-semantic (legacy behaviour). */
  private readonly semantic = new Map<string, boolean>()
  /** The last comparison run for a track (D400 promotion log). Never read by
   *  the ranking — a pure observation seam. */
  private readonly lastComparison = new Map<string, BestFrameComparison>()

  constructor(options: BestDetectionTrackerOptions = {}) {
    this.hysteresis = options.hysteresis ?? 0
    this.minGapMs = options.minGapMs ?? 0
    this.edgeAware = options.edgeAware ?? true
    this.sizeAware = options.sizeAware ?? true
    this.semanticAware = options.semanticAware ?? true
  }

  /**
   * Record a detection's `confidence` (at wall-clock `timestamp`) for `trackId`.
   * Returns true when it becomes the track's new best.
   *
   * When `edgeClear` is supplied, an EDGE-AWARE policy applies: an edge-clear
   * frame (whole subject in view) ALWAYS outranks an edge-touching one (a
   * clipped, partial subject); the tier upgrade bypasses hysteresis + `minGapMs`
   * so the first clear frame is always taken. WITHIN the same tier — and when
   * `edgeClear` is omitted (legacy callers: the face + object-embedding paths) —
   * the classic policy holds: a confidence past the `hysteresis` margin that also
   * respects `minGapMs` wins. On acceptance the held peak advances.
   */
  observe(
    trackId: string,
    confidence: number,
    timestamp: number,
    edgeClearIn?: boolean,
    centerScoreIn?: number,
    containmentIn?: number,
    sizeScoreIn?: number,
    squareFractionIn?: number,
    semanticIn?: boolean,
    canvasFillIn?: number,
  ): boolean {
    // Enforce the declared policy: a non-edge-aware / non-size-aware policy
    // IGNORES those inputs (they are treated as never supplied), so the policy
    // table is load-bearing rather than documentation.
    const edgeClear = this.edgeAware ? edgeClearIn : undefined
    const centerScore = this.edgeAware ? centerScoreIn : undefined
    const containment = this.edgeAware ? containmentIn : undefined
    const sizeScore = this.sizeAware ? sizeScoreIn : undefined
    const squareFraction = this.edgeAware ? squareFractionIn : undefined
    const canvasFill = this.edgeAware ? canvasFillIn : undefined
    const semanticBit = this.semanticAware ? semanticIn : undefined
    const cur = this.best.get(trackId)
    if (cur === undefined) {
      this.best.set(trackId, { confidence, atMs: timestamp })
      if (edgeClear !== undefined) this.edgeClear.set(trackId, edgeClear)
      if (centerScore !== undefined) this.centerScore.set(trackId, centerScore)
      if (containment !== undefined) this.containment.set(trackId, containment)
      if (sizeScore !== undefined) this.sizeScore.set(trackId, sizeScore)
      if (squareFraction !== undefined) this.squareFraction.set(trackId, squareFraction)
      if (canvasFill !== undefined) this.canvasFill.set(trackId, canvasFill)
      if (semanticBit !== undefined) this.semantic.set(trackId, semanticBit)
      return true
    }
    // Absent tier = clear (legacy pure-confidence policy for un-tiered callers).
    const curClear = this.edgeClear.get(trackId) ?? true
    const candClear = edgeClear ?? true
    const curCenter = this.centerScore.get(trackId)
    const curContainment = this.containment.get(trackId)
    const curSize = this.sizeScore.get(trackId)
    const curSquareFraction = this.squareFraction.get(trackId)
    const curCanvasFill = this.canvasFill.get(trackId)
    const curSemantic = this.semantic.get(trackId) ?? false
    const candSemantic = semanticBit ?? false
    const held = {
      confidence: cur.confidence,
      edgeClear: curClear,
      ...(curCenter !== undefined ? { centerScore: curCenter } : {}),
      ...(curContainment !== undefined ? { containment: curContainment } : {}),
      ...(curSize !== undefined ? { sizeScore: curSize } : {}),
      ...(curSquareFraction !== undefined ? { squareFraction: curSquareFraction } : {}),
      ...(curCanvasFill !== undefined ? { canvasFill: curCanvasFill } : {}),
      semantic: curSemantic,
    }
    const cand = {
      confidence,
      edgeClear: candClear,
      ...(centerScore !== undefined ? { centerScore } : {}),
      ...(containment !== undefined ? { containment } : {}),
      ...(sizeScore !== undefined ? { sizeScore } : {}),
      ...(squareFraction !== undefined ? { squareFraction } : {}),
      ...(canvasFill !== undefined ? { canvasFill } : {}),
      semantic: candSemantic,
    }
    // A tier upgrade bypasses hysteresis + minGap. Square containment is the
    // outer tier (a delivered subject beats a delivered background, 2026-08-21);
    // the SEMANTIC tier (a recognition succeeded on the frame) sits under it;
    // the edge tier orders frames only WITHIN the same square + semantic tiers.
    const squareTierUpgrade = isSquareContained(cand) && !isSquareContained(held)
    const sameSquareTier = isSquareContained(cand) === isSquareContained(held)
    const semanticTierUpgrade = sameSquareTier && isSemantic(cand) && !isSemantic(held)
    const sameSemanticTier = isSemantic(cand) === isSemantic(held)
    const tierUpgrade =
      squareTierUpgrade ||
      semanticTierUpgrade ||
      (sameSquareTier && sameSemanticTier && candClear && !curClear)
    // Rate limit (`minGapMs`) yields to a tier upgrade AND — on the size-aware
    // best-frame path ONLY (caller supplies `sizeScore`) — to a DECISIVE
    // effective-score improvement: a drive-through subject's best framing lands
    // 1–3s after birth, inside the rate window, and must not be lost. Legacy
    // un-sized callers (face / object-embedding) keep the strict gap.
    const gapOk =
      timestamp - cur.atMs >= this.minGapMs ||
      (sizeScore !== undefined && isDecisiveImprovement(held, cand))
    const comparison = compareBestFrame(held, cand, this.hysteresis)
    this.lastComparison.set(trackId, comparison)
    const isNewBest = tierUpgrade
      ? true // clear beats touching ALWAYS — bypass hysteresis + minGap
      : comparison.accepted && gapOk
    if (isNewBest) {
      this.best.set(trackId, { confidence, atMs: timestamp })
      if (edgeClear !== undefined) this.edgeClear.set(trackId, edgeClear)
      if (centerScore !== undefined) this.centerScore.set(trackId, centerScore)
      if (containment !== undefined) this.containment.set(trackId, containment)
      if (sizeScore !== undefined) this.sizeScore.set(trackId, sizeScore)
      if (squareFraction !== undefined) this.squareFraction.set(trackId, squareFraction)
      if (canvasFill !== undefined) this.canvasFill.set(trackId, canvasFill)
      this.semantic.set(trackId, candSemantic)
    }
    return isNewBest
  }

  /**
   * The FULL candidate shape of the track's held peak — everything the ranking
   * saw, not just `{confidence, atMs}`. Read BEFORE `observe` so a promotion
   * attempt can be logged against the peak it actually competed with (D400).
   * Undefined when the track holds no peak (the first sighting).
   */
  heldCandidate(trackId: string): BestFrameCandidate | undefined {
    const cur = this.best.get(trackId)
    if (cur === undefined) return undefined
    const centerScore = this.centerScore.get(trackId)
    const containment = this.containment.get(trackId)
    const sizeScore = this.sizeScore.get(trackId)
    const squareFraction = this.squareFraction.get(trackId)
    const canvasFill = this.canvasFill.get(trackId)
    return {
      confidence: cur.confidence,
      edgeClear: this.edgeClear.get(trackId) ?? true,
      ...(centerScore !== undefined ? { centerScore } : {}),
      ...(containment !== undefined ? { containment } : {}),
      ...(sizeScore !== undefined ? { sizeScore } : {}),
      ...(squareFraction !== undefined ? { squareFraction } : {}),
      ...(canvasFill !== undefined ? { canvasFill } : {}),
      semantic: this.semantic.get(trackId) ?? false,
    }
  }

  /**
   * The comparison the LAST {@link observe} ran for this track — which term
   * decided, and both effective scores. Undefined on a first sighting (nothing
   * was compared) and after {@link delete}. Feeds the promotion log line; it is
   * never a ranking input.
   */
  lastComparisonFor(trackId: string): BestFrameComparison | undefined {
    return this.lastComparison.get(trackId)
  }

  /**
   * Stamp the HELD peak as semantic — the attribution-time re-score for a
   * recognition that arrived AFTER the frame was ranked (detail results are
   * async). Use when the recognition's source frame IS the held peak: the
   * stamp locks the tier so a later non-semantic frame cannot displace the
   * frame that proved something. Returns false (no-op) when the track holds no
   * peak or the policy declares `semanticAware: false`.
   */
  markSemantic(trackId: string): boolean {
    if (!this.semanticAware) return false
    if (!this.best.has(trackId)) return false
    this.semantic.set(trackId, true)
    return true
  }

  /** The held peak for a track (undefined if never observed). */
  peak(trackId: string): BestDetection | undefined {
    return this.best.get(trackId)
  }

  /**
   * D683: two pieces of one subject keep the better held peak — the SAME
   * `compareBestFrame` verdict {@link observe} reaches, minus the capture-rate
   * gating (`minGapMs`), which has no meaning for two already-held peaks being
   * folded into one. Returns whose peak survived, so callers that hold their
   * OWN parallel payload (face crop, parked-frame mirror) know which side to
   * keep.
   */
  adopt(survivorId: string, absorbedId: string): 'survivor' | 'absorbed' {
    const mine = this.heldCandidate(survivorId)
    const theirs = this.heldCandidate(absorbedId)
    const absorbedWins =
      theirs !== undefined && (mine === undefined || this.challengerWins(theirs, mine))
    // Every per-track map this class declares (mirrors `delete`/`clear` above)
    // — listed explicitly, not looped over as a heterogeneous array, so each
    // call stays typed to its own value type.
    // When the absorbed peak wins it replaces the survivor's WHOLE record: a
    // map where only the survivor had an entry must not keep it, or the
    // survivor's tier fields would ride on the absorbed peak (review L2).
    const move = <V>(map: Map<string, V>): void => {
      if (absorbedWins) {
        map.delete(survivorId)
        renameKey(map, absorbedId, survivorId)
      } else map.delete(absorbedId)
    }
    move(this.best)
    move(this.edgeClear)
    move(this.centerScore)
    move(this.containment)
    move(this.sizeScore)
    move(this.squareFraction)
    move(this.canvasFill)
    move(this.semantic)
    move(this.lastComparison)
    return absorbedWins ? 'absorbed' : 'survivor'
  }

  /** Does `challenger` beat `incumbent` — `compareBestFrame`'s verdict, the
   *  one {@link observe} reaches too. `observe`'s own `tierUpgrade` term only
   *  lets a tier upgrade skip `minGapMs`; it never changes the verdict, since
   *  `compareBestFrame` already accepts every tier upgrade (review L3). */
  private challengerWins(challenger: BestFrameCandidate, incumbent: BestFrameCandidate): boolean {
    return compareBestFrame(incumbent, challenger, this.hysteresis).accepted
  }

  /** Drop a track's peak (call at track end). */
  delete(trackId: string): void {
    this.best.delete(trackId)
    this.edgeClear.delete(trackId)
    this.centerScore.delete(trackId)
    this.containment.delete(trackId)
    this.sizeScore.delete(trackId)
    this.squareFraction.delete(trackId)
    this.canvasFill.delete(trackId)
    this.semantic.delete(trackId)
    this.lastComparison.delete(trackId)
  }

  clear(): void {
    this.best.clear()
    this.edgeClear.clear()
    this.centerScore.clear()
    this.containment.clear()
    this.sizeScore.clear()
    this.squareFraction.clear()
    this.canvasFill.clear()
    this.semantic.clear()
    this.lastComparison.clear()
  }
}
