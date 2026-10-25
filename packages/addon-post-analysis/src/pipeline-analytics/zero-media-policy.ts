/**
 * Zero-media track policy — the pure close-time decision for a track that
 * reaches its end with NO persisted media (operator design, 2026-07-21 night;
 * spec `docs/superpowers/specs/2026-07-21-native-media-persistence-design.md`
 * §"Zero-media track policy").
 *
 * A track holding a BEST shot (a `thumbnail`, or the native `keyFrame` one is
 * derived from) follows the normal path untouched.
 *
 * A track holding OTHER media but no best shot is the 2026-07-31 case: it is
 * never suppressed — a first/last frame proves the subject was real — but it is
 * given the retained raster crop, because a gallery row whose tile is empty is
 * the symptom an operator reports as "no best shot". Measured cause: the native
 * lease misses and the capture is queued for RETRY, and a 3-second track dies
 * before the retry lands (333 misses / 24 h on this cluster).
 *
 * A zero-media track is classified:
 *  - **Ultra-short (< {@link ZERO_MEDIA_SUPPRESS_MAX_DURATION_MS}) AND never
 *    confirmed** → `suppress`: false-birth noise (a phantom the tracker emitted
 *    then dropped within a second). It is removed entirely — no list row, no
 *    media, no lifecycle event, no dangling events/history.
 *  - **Longer (≥ threshold) OR confirmed** → keep the track. When a
 *    detection-raster crop was retained during its life, persist it as a
 *    last-resort preview (`raster-fallback`); otherwise keep the (media-less)
 *    row (`persist`) — we never suppress a real track just because a crop was
 *    unavailable.
 *
 * "Confirmed" is the tracker's hit-confirmation signal (`trackAge >= minHits`)
 * carried from the SORT tracker output — a track observed across ≥ minHits
 * frames is a stable, real subject, not a one-frame phantom.
 *
 * This module holds NO I/O so it is fully unit-testable; the caller
 * (`sweepExpiredTracks`) supplies `hasMedia` (a MediaStore owner query), the
 * retained `confirmed` flag, and whether a raster fallback crop was captured.
 */

/**
 * Max track duration (ms) at or above which a zero-media track is NEVER treated
 * as false-birth noise. Below this, a never-confirmed zero-media track is
 * suppressed. ~1s per the operator contract.
 */
export const ZERO_MEDIA_SUPPRESS_MAX_DURATION_MS = 1_000

/**
 * Max duration (ms) below which a zero-media track WITHOUT even a raster
 * fallback is suppressed REGARDLESS of confirmation. Rationale (operator triage
 * 2026-07-22): `confirmed` is `trackAge >= minHits`, and a low `minHits` camera
 * confirms a phantom within a few hundred ms — so sub-1.5s "confirmed" rows
 * with literally NOTHING to render (no media, no raster) survived as empty
 * gallery tiles. A row that would render nothing and lasted under this bound
 * is noise, confirmed or not; anything longer, or anything with a raster crop,
 * is kept as before.
 */
export const ZERO_MEDIA_NOTHING_TO_SHOW_MAX_DURATION_MS = 1_500

export type ZeroMediaPolicyOutcome = 'persist' | 'suppress' | 'raster-fallback'

export interface ZeroMediaPolicyInput {
  /** Track lifetime (`lastSeen - firstSeen`) in ms. */
  readonly durationMs: number
  /** Whether the track already owns ANY persisted media (any kind/owner:'track'). */
  readonly hasMedia: boolean
  /**
   * Whether the track owns a BEST shot — a `thumbnail` or the native `keyFrame`
   * a thumbnail is derived from. See the module header: media alone is not the
   * same as something to show, and this is the field that separates them.
   */
  readonly hasBestMedia: boolean
  /** Whether the track reached the tracker's hit-confirmation during its life. */
  readonly confirmed: boolean
  /** Whether a detection-raster subject crop was retained for the last-resort
   *  fallback (captured live, committed only here at close). */
  readonly hasRasterFallback: boolean
}

export interface ZeroMediaPolicyConfig {
  readonly suppressMaxDurationMs: number
  /** See {@link ZERO_MEDIA_NOTHING_TO_SHOW_MAX_DURATION_MS}. */
  readonly nothingToShowMaxDurationMs: number
}

export const DEFAULT_ZERO_MEDIA_POLICY_CONFIG: ZeroMediaPolicyConfig = {
  suppressMaxDurationMs: ZERO_MEDIA_SUPPRESS_MAX_DURATION_MS,
  nothingToShowMaxDurationMs: ZERO_MEDIA_NOTHING_TO_SHOW_MAX_DURATION_MS,
}

/**
 * Classify a closing track's persistence outcome. Pure — see the module header
 * for the full contract.
 */
export function decideZeroMediaPolicy(
  input: ZeroMediaPolicyInput,
  config: ZeroMediaPolicyConfig = DEFAULT_ZERO_MEDIA_POLICY_CONFIG,
): ZeroMediaPolicyOutcome {
  // A track that already has a BEST shot follows the normal path untouched.
  if (input.hasBestMedia) return 'persist'
  // Media but no best shot: the 2026-07-31 case. Never suppress — the track is
  // real and its first/last frames prove it — but spend the retained raster on
  // the hole, because "no best shot" is the symptom the operator actually sees.
  if (input.hasMedia) return input.hasRasterFallback ? 'raster-fallback' : 'persist'
  // Zero-media, ultra-short AND never confirmed → false-birth noise: suppress.
  const ultraShort = input.durationMs < config.suppressMaxDurationMs
  if (ultraShort && !input.confirmed) return 'suppress'
  // Zero-media, NOTHING to render (no raster either) and short-lived → an empty
  // gallery row, confirmed or not (a low-minHits camera "confirms" phantoms in
  // a few hundred ms): suppress. Longer media-less tracks are still kept — we
  // never silently drop a genuinely long-observed subject.
  if (!input.hasRasterFallback && input.durationMs < config.nothingToShowMaxDurationMs) {
    return 'suppress'
  }
  // Zero-media but LONGER or confirmed → keep the track; use the retained
  // raster crop as a last-resort preview when one was captured, else keep the
  // (unavoidably media-less) row.
  return input.hasRasterFallback ? 'raster-fallback' : 'persist'
}
