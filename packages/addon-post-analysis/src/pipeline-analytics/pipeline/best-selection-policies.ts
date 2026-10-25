/**
 * Best-selection policy table — the ONE place where every "best detection per
 * track" selection policy is DECLARED (S9 of the 2026-07-22 maintainability
 * refactor).
 *
 * Post-analysis runs three in-memory best-per-track selections, all through the
 * same parameterized {@link ../best-detection-tracker.js BestDetectionTracker}
 * primitive. Historically only the best-frame path spelled its parameters out;
 * the face and object-embedding paths constructed the tracker bare and thereby
 * IMPLIED a confidence-only policy — an undeclared divergence that comments
 * elsewhere claimed was "the shared policy". This table makes each policy an
 * explicit, named, test-pinned value: change a number here and the policy-table
 * spec fails, forcing the drift to be a DECISION instead of an accident.
 *
 * The two PERSISTENT "if better" gates are documented seams, deliberately NOT
 * in this table (they are durable, cross-restart, store-side — not live-track
 * selection): `ObjectEmbeddingStore.upsertIfBetter` (the CLIP embedding row's
 * cross-restart gate) and `eventStore.peakForTrack` (importance recompute).
 */

/** A declared "best detection per track" selection policy. Structurally
 *  assignable to `BestDetectionTrackerOptions` — construct the tracker WITH the
 *  policy (`new BestDetectionTracker(BEST_FACE_POLICY)`), never bare. */
export interface BestSelectionPolicy {
  /** A new best must beat the held peak by STRICTLY MORE than this margin. */
  readonly hysteresis: number
  /** Minimum wall-clock gap (ms) between accepted bests for a track. */
  readonly minGapMs: number
  /** Whether the edge-clear tier / centering / containment inputs participate
   *  in ranking. When false the tracker ignores those `observe` inputs and
   *  ranks on raw confidence. */
  readonly edgeAware: boolean
  /** Whether the subject-size input participates (and, with it, the DECISIVE
   *  improvement bypass of `minGapMs`). When false the tracker ignores the
   *  `sizeScore` input and the rate limit is strict. */
  readonly sizeAware: boolean
  /** Whether the SEMANTIC tier participates (a frame from which a recognition
   *  succeeded — face auto-match / attributed plate read / accepted fine
   *  classification — outranks any frame that proved nothing, below the
   *  square-containment tier). When false the tracker ignores the semantic
   *  observe input and `markSemantic`. */
  readonly semanticAware: boolean
}

/**
 * Best FRAME (§5 boxed `thumbnail` + native keyFrame re-shot signal) — the
 * expensive-capture path. Full edge-aware ranking: an edge-clear frame always
 * outranks a clipped one, centering / containment / subject-size break ties,
 * hysteresis (0.05) stops confidence jitter around a plateau from churning
 * per-capture work, and the 2 s rate limit caps capture pressure — except that
 * `sizeAware` enables the DECISIVE-improvement bypass, so a drive-through
 * subject's best framing (landing 1–3 s after birth, inside the rate window)
 * is never lost.
 */
export const BEST_FRAME_POLICY: BestSelectionPolicy = {
  hysteresis: 0.05,
  minGapMs: 2_000,
  edgeAware: true,
  sizeAware: true,
  // Semantic promotion (2026-08-21): the boxed `thumbnail` / native keyFrame
  // should be the frame that PROVED something about the subject.
  semanticAware: true,
}

/**
 * Best FACE (face-recognizer hold buffer) — SIZE-AWARE, no hysteresis, no rate
 * limit.
 *
 * No hysteresis / no gap, unchanged: accepting a new best only swaps an
 * already-decoded crop buffer in memory (cheap; no capture is triggered), and a
 * track may live well under the best-frame rate-limit window, so a gap would
 * silently discard the real peak for nothing.
 *
 * `sizeAware` since 2026-08-19. It used to be confidence-ONLY, and that was the
 * wrong ranking: SCRFD saturates its confidence on surveillance footage, so a
 * 12 px face and a 40 px face both answer ~0.9 and the track simply kept
 * whichever arrived first. The size that matters is the face's DETECTION-FRAME
 * short side, because that bounds the landmark precision the alignment warp
 * consumes — `face-size-score.ts` carries the measurement that set the
 * reference. Because `minGapMs` is 0 here, enabling this does NOT switch on the
 * decisive-improvement rate-limit bypass (there is no rate limit to bypass); it
 * only adds the size factor to the ranking.
 */
export const BEST_FACE_POLICY: BestSelectionPolicy = {
  hysteresis: 0,
  minGapMs: 0,
  edgeAware: false,
  sizeAware: true,
  // The face path ranks FACES (landmark precision), not shots — the semantic
  // tier is a best-SHOT concept and would circularly rank "the matched face"
  // above "the sharpest face".
  semanticAware: false,
}

/**
 * Best OBJECT (CLIP) embedding + its tight crop — the in-memory
 * DECISION (which live frame the embedding row + crop derive from). The
 * durable, cross-restart "if better" gate stays DOWNSTREAM in
 * `ObjectEmbeddingStore.upsertIfBetter` (the documented seam: this selector
 * resets on addon restart, the store row does not). A SEPARATE named policy
 * from the face path: the two may drift apart deliberately without one
 * masquerading as the other.
 */
export const BEST_OBJECT_EMBED_POLICY: BestSelectionPolicy = {
  hysteresis: 0,
  minGapMs: 0,
  // EDGE + SIZE aware since 2026-09-03. Confidence alone let a frame with the
  // subject half out of shot win — the detector is sure about the half it can
  // see — and that half became the vector. The post-close REBUILD already
  // embeds from the edge-aware `keyFrame`, so one subject could hold two
  // vectors derived from materially different views. This removes that
  // divergence in the direction the durable path already took.
  edgeAware: true,
  sizeAware: true,
  // NOT semantic: a frame that proved an identity is not thereby the best frame
  // to EMBED, and ranking it so would make the vector agree with the recogniser
  // by construction.
  semanticAware: false,
}

/**
 * Detail-dispatch CANDIDATE-IMPROVED signal (detail-dispatcher `candidateBest`)
 * — confidence-only, per-device re-dispatch trigger when a track's parent
 * detection improves enough to justify a fresh enrichment pass. Cheap decision
 * (no capture), so no hysteresis/gap. Declared here so the policy table is
 * EXHAUSTIVE: every BestDetectionTracker construction names its policy.
 */
export const CANDIDATE_IMPROVE_POLICY: BestSelectionPolicy = {
  hysteresis: 0,
  minGapMs: 0,
  edgeAware: false,
  sizeAware: false,
  semanticAware: false,
}
