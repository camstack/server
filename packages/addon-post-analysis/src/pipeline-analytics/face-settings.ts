import { z } from 'zod'

/**
 * Per-device face-recognition settings. Cascade: a per-device override on top
 * of the global default, resolved per field (an invalid/missing value falls
 * back to its default — parse never throws). Mirrors `audio-detection-settings`.
 */
export const FaceSettingsSchema = z.object({
  /**
   * GLOBAL master switch only — a temporary kill for the whole face-recognition
   * post-processor. On by default; the recognizer runs whenever the per-device
   * detection pipeline produces face embeddings (the pipeline steps ARE the
   * per-camera control). Not a per-device override — see
   * `resolveGlobalFaceEnabled` / `getDeviceSettingsContribution` (the field is
   * stripped from the per-device schema).
   */
  enabled: z.boolean().default(true),
  /**
   * Cosine similarity (on L2-normalized embeddings) required to match. A
   * property of ONE model's cosine space: it moves with the default model.
   *
   * ArcFace era, for the record: 0.55→0.62 on 2026-07-23, back to 0.55 on
   * 2026-08-18 once the dead `assignUniquePerFrame` margin and the poisoned
   * gallery were fixed. That value was the least-bad one for crops that were
   * mostly misaligned (2026-08-19: 20% aligned over 60 live crops); the
   * landmark-precision gate (`minLandmarkFaceSize`), the SCRFD alignment fix
   * and the gallery reset (D643, D644) have since removed those causes.
   *
   * Recalibrate from a MEASUREMENT, never by feel: run
   * `scripts/face-threshold-calibration.ts` over the live gallery (genuine and
   * impostor cosine distributions, threshold at a stated false-accept target)
   * and set the result as the operator's global value, or per camera.
   */
  // D651 (2026-09-26): 0.55 → 0.45 WITH the default model. A threshold is a
  // property of one model's cosine space, and AuraFace's is not ArcFace's: at
  // 0.55 AuraFace auto-matched 1 probe in 496 (2026-08-21). 0.45 is the
  // operating point measured on AuraFace's own gallery that day (intra min
  // 0.263, inter-identity max 0.361; the private session log), above the
  // impostor p99 0.33 of the 2026-09-26 gallery-shift measurement. fal's
  // AuraFace card publishes no threshold. Per camera it stays overridable — the
  // recognizer generates the identity event, so the policy is its own.
  similarityThreshold: z.number().min(0).max(1).default(0.45),
  /** Reject ambiguous matches: require best − secondBest ≥ margin. 0.10→0.15
   *  (2026-07-23), then →0.12 (2026-08-18) alongside the threshold retune —
   *  same story and the same recalibration plan as {@link similarityThreshold}. */
  margin: z.number().min(0).max(1).default(0.12),
  // `minFaceConfidence` lived here as a second face-confidence bar. It is gone
  // (D662): it compared the DETECTOR's score without knowing which detector
  // produced it, so once YuNet became the default (D645) its 0.5 was SCRFD's
  // bar applied to YuNet's scale. The one bar is the detector MODEL's floor,
  // applied on the runner (`ModelCatalogEntry.defaultConfidence`); a stored
  // value is purged by `planStoredMinFaceConfidencePurge`.
  /**
   * Minimum face bbox size (px, shorter side, NATIVE scale when the runner
   * measured it, else detection-frame space) for a face to be DETECTED and
   * COLLECTED into the recent-faces buffer. Below this the face is dropped
   * BEFORE ingest/enrolment (#26.1). This is the DETECTION/collection floor —
   * NOT the auto-assignment floor (see {@link recognitionMinFacePx}).
   */
  minFacePx: z.number().min(0).default(30),
  /**
   * Minimum face short side (px, NATIVE scale when the runner measured it, else
   * detection-frame space) for a collected face to be eligible for AUTO-MATCH
   * (identity assignment). Separate from — and ≥ — {@link minFacePx}: faces
   * between `minFacePx` and this floor are still detected, cropped, and stored
   * in the buffer (available for MANUAL assignment), but are NEVER auto-assigned
   * an identity. ArcFace embeddings below ~48px are unreliable and drove the
   * observed false positives (2026-07-23 face-quality batch). A face below this
   * floor keeps `recognizedIdentityId` UNSET (fail-safe).
   */
  recognitionMinFacePx: z.number().min(0).default(48),
  // `suggestionMinCosine` lived here as an independent operator knob. It is
  // gone (D222): the suggestion band's floor is DERIVED from
  // `similarityThreshold` — see {@link deriveSuggestionMinCosine} below. Two
  // knobs over one band could disagree, and did: the 2026-08-19 retune took
  // the threshold to 0.45 and left this at 0.50, so the half-open band
  // [0.50, 0.45) was EMPTY and no face could be suggested, silently.
  /**
   * Minimum enrolled-sample count an identity must have before it can be an
   * AUTO-MATCH target. A single-sample identity is an unreliable sink (one noisy
   * enrolment attracted 81% of matches); identities below this are excluded from
   * automatic matching until more samples are enrolled (#26.3).
   */
  minIdentitySamples: z.number().int().min(1).default(2),
  /** Frames an identity must be confirmed before a track is assigned. Floor of
   *  1 (0 confirmations would assign on a single noisy frame — nonsensical;
   *  such a value falls back to the default). */
  confirmFrames: z.number().int().min(1).default(3),
  // `bufferRetentionDays` lived here. D61 removed the age half of the buffer
  // prune (a buffer row carries a `trackId`, so it is track-owned and cascades
  // with its track); D62 removed the setting, because a field the sweep no
  // longer reads is a decision the operator did not actually make. The buffer
  // is bounded by `bufferMaxPerDevice` alone.
  /**
   * Upper bound on the RAW ArcFace feature magnitude a face may have and still
   * be embedded into the buffer / matched / enrolled. `0` (the default) DISABLES
   * the gate.
   *
   * This exists because a degenerate crop does not score LOW, it scores HIGH:
   * measured on this cluster 2026-08-18/19, 28.8% of all pairs of DIFFERENT
   * faces exceeded cosine 0.90 and the worst 40% of the face population had
   * collapsed onto effectively one vector (mean pairwise cosine 0.976). No
   * similarity threshold can reach that — it sits above every threshold — so the
   * only defence is to refuse the embedding before it is stored or compared.
   *
   * Direction: for this model the DEGENERATE crops carry the LARGER norm (the
   * inverse of the MagFace convention), hence a maximum. Over 140 LFW faces
   * through this exact model and preprocessing, usable crops sat at ≈4.4 (p95
   * 5.25) regardless of size, grey level or blur, while information-free crops
   * jumped to 10–16; a bound of 6.0 kept 97.6% of usable crops and rejected
   * 93.2% of degenerate ones.
   *
   * Default 0 ON PURPOSE. Those numbers are LFW's, not this cluster's, and the
   * magnitude has never been observable here — `result-assembler` discarded it
   * one line after computing it. The field and its logging ship first; set a
   * real bound once a week of live `face: embedding magnitude` lines says where
   * this cluster's populations actually sit. Enabling a gate against a number
   * nobody has measured in production is how recognition silently stops.
   */
  maxEmbeddingMagnitude: z.number().min(0).default(0),
  /** Max buffered faces kept per device. */
  bufferMaxPerDevice: z.number().int().min(0).default(50),
  /**
   * Keep the FULL frame every buffered face was detected on (D644): parked on
   * the node when the face becomes its track's best (at most once per
   * {@link FACE_SOURCE_PARK_MIN_INTERVAL_MS} per track), stored when the face is
   * buffered, moved into the sample on enrolment. ≈1.6 MB per 4K face.
   *
   * OFF by default ON PURPOSE: it adds a native JPEG encode on the runner per
   * park and ~0.5–0.75 GB/day on this hub. The controller turns it on (global
   * face settings, or one camera) after measuring `faceGallery.sourceFrameStats`.
   */
  keepSourceFrames: z.boolean().default(false),
})

export type FaceSettings = z.infer<typeof FaceSettingsSchema>

/** A track's face frame is parked at most once per this interval (D644). */
export const FACE_SOURCE_PARK_MIN_INTERVAL_MS = 2_000

export const FACE_DEFAULTS: FaceSettings = FaceSettingsSchema.parse({})

export function resolveFaceSettings(raw: Record<string, unknown>): FaceSettings {
  const pick = <K extends keyof FaceSettings>(key: K): FaceSettings[K] => {
    const field = FaceSettingsSchema.shape[key]
    const parsed = field.safeParse(raw[key])
    return parsed.success ? (parsed.data as FaceSettings[K]) : FACE_DEFAULTS[key]
  }
  return {
    enabled: pick('enabled'),
    similarityThreshold: pick('similarityThreshold'),
    margin: pick('margin'),
    minFacePx: pick('minFacePx'),
    recognitionMinFacePx: pick('recognitionMinFacePx'),
    minIdentitySamples: pick('minIdentitySamples'),
    maxEmbeddingMagnitude: pick('maxEmbeddingMagnitude'),
    confirmFrames: pick('confirmFrames'),
    bufferMaxPerDevice: pick('bufferMaxPerDevice'),
    keepSourceFrames: pick('keepSourceFrames'),
  }
}

/**
 * The suggestion band opens at 80% of the assignment threshold.
 *
 * ## Why derived and not a knob
 *
 * `suggestionMinCosine` used to be its own operator-overridable field. Two
 * independent numbers described ONE band, so they could contradict each other
 * — and on the live hub they did. The 2026-08-19 retune lowered
 * `similarityThreshold` to 0.45 and left the suggestion floor at its 0.50
 * default, which INVERTS the band: `[0.50, 0.45)` is empty, so from that moment
 * the recognizer could not produce a single suggestion. Nothing errored,
 * nothing logged, and the form showed two plausible numbers side by side. That
 * is the D62 shape — a second authority over a fact that already had one — and
 * the fix is the same: delete the second authority rather than police it.
 *
 * Derived, the band cannot invert for ANY threshold, which is the property
 * `face-settings.spec.ts` pins over the whole domain rather than at samples.
 *
 * ## Why 0.8
 *
 * The operator's number, and it matches what the band was for: a near-miss is
 * a probe that scored within a fifth of the bar. At the schema default (0.45,
 * D651) it gives a 0.36 floor, and it TRACKS every future retune, which is the
 * whole point: a threshold recalibrated from the live gallery moves the band
 * with it, where a fixed floor would have to be remembered and moved by hand.
 */
export const SUGGESTION_BAND_FACTOR = 0.8

/** Decimal places the derived floor is rounded to. `0.8 * 0.45` is
 *  `0.36000000000000004` in IEEE754, and an operator reading "36.000000000004%"
 *  in a report has been told the number is untrustworthy. */
const DERIVED_PRECISION = 1e4

/**
 * The cosine floor of the suggestion band for a given assignment threshold.
 *
 * INVARIANT, total over `[0, 1]`: the result is never ABOVE the threshold, and
 * is strictly below it for every threshold > 0 — so the band
 * `[floor, threshold)` can never be empty. Rounding is applied only when it
 * preserves that (for a threshold small enough that rounding would reach it,
 * the exact product is returned instead).
 */
export function deriveSuggestionMinCosine(similarityThreshold: number): number {
  const exact = similarityThreshold * SUGGESTION_BAND_FACTOR
  const rounded = Math.round(exact * DERIVED_PRECISION) / DERIVED_PRECISION
  return rounded < similarityThreshold ? rounded : exact
}

/**
 * How much larger the SUGGESTED tier of the recent-faces buffer is than the
 * ordinary one.
 *
 * ## What it buys
 *
 * `bufferMaxPerDevice` evicts oldest-first, and a row the recognizer put a
 * `suggestedIdentityId` on was exempt from nothing. Measured 2026-08-25: 15 of
 * 24 live cameras sat at EXACTLY the cap, and on camera 108 (59 faces in 25 h)
 * a suggestion survived roughly one day. A question the system asked was
 * deleted before the operator could answer it, silently.
 *
 * ## Why a bigger CAP and not immortality, and not an age ceiling
 *
 * Immortality is a leak: nothing clears `suggestedIdentityId` when the operator
 * REJECTS a suggestion — they simply do not act on it — so an unbounded
 * exemption would let a camera that suggests constantly grow without limit,
 * at 10.8 KB of JSON embedding per row.
 *
 * An age ceiling was the other candidate and it is forbidden here: a face row
 * carries a `trackId`, so it is TRACK-OWNED and clockless (D61) — a second
 * clock over it is the exact defect that aged crops out from under tracks
 * still inside their own retention window.
 *
 * So: a second CAPACITY budget, disjoint from the ordinary one, evicted
 * oldest-first within itself. When it is hit, the loss is the OLDEST unanswered
 * suggestion on that camera — the one the operator has had longest to answer
 * and has not, on a review surface that lists newest-first. That is the
 * least-bad row to lose, and losing it is logged with its `deviceId`.
 *
 * ## Why 4
 *
 * At the shipped default it turns a 50-row buffer into 200 suggested slots. On
 * the busiest measured camera (~59 faces/25 h, of which the suggestion band
 * takes a minority) that is a review window of roughly a week and a half rather
 * than a day — the operator reviews in batches (173 in one sitting on
 * 2026-08-25), so the window has to survive between BATCHES, not between days.
 *
 * The honest worst case: 250 rows/device (50 + 200) × 24 cameras × 10.8 KB ≈
 * 65 MB if every buffered face on every camera carried a suggestion. It never
 * does — the live table is 372 rows / 4.0 MB — but the bound is real and stated
 * rather than unbounded.
 *
 * DERIVED, not a second knob. Two independent numbers over one buffer could
 * contradict each other, which is exactly how the suggestion BAND broke (D222):
 * raising `bufferMaxPerDevice` raises this with it, and setting it to 0
 * disables the whole buffer rather than leaving an orphan tier behind.
 */
export const SUGGESTED_BUFFER_CAP_FACTOR = 4

/**
 * The suggested tier's capacity for a given ordinary capacity.
 *
 * INVARIANT, total over every finite input: the result is a non-negative
 * integer, is never BELOW `bufferMaxPerDevice` (a suggested row is never worse
 * off than an unsuggested one), and is `0` exactly when the ordinary cap is `0`
 * (one switch turns the buffer off, not two).
 */
export function deriveSuggestedBufferCap(bufferMaxPerDevice: number): number {
  if (!Number.isFinite(bufferMaxPerDevice) || bufferMaxPerDevice <= 0) return 0
  return Math.round(bufferMaxPerDevice * SUGGESTED_BUFFER_CAP_FACTOR)
}

/**
 * The settings key that used to hold the suggestion floor. Named once, here,
 * because the ONLY code allowed to mention it now is the migration that removes
 * it from a store.
 */
export const STORED_SUGGESTION_MIN_COSINE_KEY = 'suggestionMinCosine'

/** The settings key that held the retired recognizer face-confidence bar (D662). */
export const STORED_MIN_FACE_CONFIDENCE_KEY = 'minFaceConfidence'

/** A retired setting found in a stored blob, and the patch that ends it. */
export interface StoredRetiredKeyPurge {
  /** The value the operator had set, for the announcement. */
  readonly was: unknown
  /** The patch to write: the retired key unset, nothing else touched. */
  readonly patch: Record<string, undefined>
}

/** Plan the removal of ONE retired key from a settings blob; `null` = absent. */
function planRetiredKeyPurge(
  raw: Record<string, unknown>,
  key: string,
): StoredRetiredKeyPurge | null {
  const was = raw[key]
  if (was === undefined) return null
  return { was, patch: { [key]: undefined } }
}

/**
 * Plan the removal of a persisted suggestion floor from one settings blob.
 *
 * `null` = nothing to do, which is the steady state after the first pass and
 * for every store that never had one. Absence of the key IS the migration
 * marker — no flag, no version row, and re-running is a no-op.
 *
 * The patch uses `undefined`, never `null`: the settings merge preserves an
 * explicit `null` as a STORED value, which would leave exactly the
 * accepted-but-ignored residue this exists to remove, while `undefined`
 * survives the merge as a key with no value and is dropped by the JSON
 * serialisation the blob round-trips through.
 */
export function planStoredSuggestionPurge(
  raw: Record<string, unknown>,
): StoredRetiredKeyPurge | null {
  return planRetiredKeyPurge(raw, STORED_SUGGESTION_MIN_COSINE_KEY)
}

/**
 * Plan the removal of a persisted `minFaceConfidence` (D662). Same contract as
 * {@link planStoredSuggestionPurge}: absence of the key is the marker, and the
 * patch unsets with `undefined`.
 */
export function planStoredMinFaceConfidencePurge(
  raw: Record<string, unknown>,
): StoredRetiredKeyPurge | null {
  return planRetiredKeyPurge(raw, STORED_MIN_FACE_CONFIDENCE_KEY)
}
