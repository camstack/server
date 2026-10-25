import { z } from 'zod'

const AudioDetectionSettingsSchema = z.object({
  classificationMinScore: z.number().min(0).max(1).default(0.6),
  /**
   * Macro classes allowed to produce an audio EVENT on this camera. Empty =
   * no policy, every class passes — so an upgrade changes nothing until an
   * operator states a policy.
   *
   * This belongs to the event generator, NOT to the classifier: the analyzer
   * keeps classifying everything it hears, `audioLabels` on the track keeps
   * carrying the full picture, and only the decision to MATERIALIZE an event
   * is narrowed. Raising a threshold inside the classifier would instead make
   * the sound invisible to every consumer at once.
   */
  audioAllowedClasses: z.array(z.string()).default([]),
  /**
   * Corroboration window on the EVENT, per class: this many occurrences of
   * the same sound must land inside `audioConfirmWindowSec` before it becomes
   * an event. `1` = no window.
   *
   * Default 2-in-10s, set by the operator on 2026-09-03 after measuring 26
   * audio tracks in 24 h: the single-frame classification is the dominant
   * false positive, and a sound that is real is heard again within ten
   * seconds. A camera that wants every occurrence sets `1`.
   *
   * The Notification Center already has this exact brake for audio RULES
   * (`confirmHits` / `confirmWindowSec`). This is the same idea one level
   * earlier, so a camera can stop MAKING the single-frame events instead of
   * only declining to notify about them.
   */
  audioConfirmHits: z.number().int().min(1).default(2),
  /** Width of the corroboration window. Ignored when `audioConfirmHits` is 1. */
  audioConfirmWindowSec: z.number().positive().default(10),
  /**
   * How far above the camera's own 10 s mean a sample must sit to be a peak.
   *
   * A DIFFERENCE between two readings on the same camera, so a uniform scale
   * offset cancels exactly and the D459 correction did not touch it. Proved,
   * not assumed — D459 enumerates this alongside `audioMarkerMinDeviationDb`,
   * `audioMarkerMinDeviations` and the EWMA/MAD pair. "Correcting" it by
   * 12 dB would be introducing the very error the epoch removed.
   *
   * @dbfs-era relative
   */
  levelDeviationDb: z.number().positive().default(10),
  levelWindowSec: z.number().positive().default(10),
  levelMaxWaitSec: z.number().positive().default(20),

  // ── Audio markers (D62) — synthetic timeline tracks for audio events ──
  //
  // Defaults are deliberately conservative AND the feature ships OFF. There
  // is no recorded audio in this repo to tune against, so the honest way to
  // ship an untuned marker source is: evaluate on every camera from the
  // start, COUNT what would have fired, log it per camera — and let the
  // operator turn it on where the number is sane. See the `wouldFire`
  // counter on the `audio anomaly gate (window)` line.
  /** Materialize synthetic audio tracks on this camera. Off = evaluate and
   *  count only, so the operator can size the rate before paying for it. */
  audioMarkerEnabled: z.boolean().default(false),
  /** EWMA time constant for the camera's "normal" loudness, in seconds. Also
   *  the warm-up: no marker until one time constant of audio has been heard. */
  audioMarkerBaselineSec: z.number().positive().default(300),
  /**
   * "High volume", absolute. A sample quieter than this is never a marker
   * however surprising it is for the camera.
   *
   * NOT shifted at the D459 epoch, for the same reason as `SILENCE_FLOOR_DBFS`
   * and with one extra argument of its own. `-25 dBFS is loud` is a statement
   * about the scale, not a measurement taken through the old decoder: nobody
   * read it off a meter, it is what "loud" means on a 16-bit full-scale range.
   *
   * The extra argument is that on the old scale this default was effectively
   * DEAD on the 19 mis-decoded cameras — a reading of -25 there required a
   * true level of -13 dBFS, which is a sound close to clipping. Bar 1 almost
   * never bound on them, so the feature has been running on two of its three
   * bars. At the epoch it starts working as designed rather than becoming too
   * permissive.
   *
   * That it also ships OFF by default (`audioMarkerEnabled`) is what makes
   * this safe to leave alone: the operator sizes the rate from the `wouldFire`
   * counter before paying for it, and that counter is now measuring the real
   * thing for the first time.
   *
   * @dbfs-era itu
   */
  audioMarkerMinDbfs: z.number().max(0).default(-25),
  /** "Out of the ordinary": how many mean-absolute-deviations of the camera's
   *  OWN jitter the sample must sit above its own mean. */
  audioMarkerMinDeviations: z.number().positive().default(4),
  /**
   * Floor in dB on the distance above the camera's own mean — what holds when
   * a dead-steady camera's deviation unit collapses toward zero.
   *
   * A distance between two readings on the same camera: scale-invariant, and
   * untouched by D459. The numerical coincidence with the PCMU correction
   * (12 dB) is exactly that — a coincidence, and the reason this note exists
   * is so nobody reads it as one of the shifted numbers.
   *
   * @dbfs-era relative
   */
  audioMarkerMinDeviationDb: z.number().positive().default(12),
  /** Audio matters most when nothing visual is happening. A marker is
   *  suppressed while a track is alive on the camera, or motion was reported,
   *  within this many seconds. */
  audioMarkerMotionQuietSec: z.number().nonnegative().default(20),
  /** Minimum gap between markers on one camera. */
  audioMarkerCooldownSec: z.number().positive().default(120),
  /** Burst ceiling: markers per camera per rolling hour. */
  audioMarkerMaxPerHour: z.number().int().positive().default(3),
  /** Flood ceiling: markers per camera per rolling 24 h. This, not the
   *  thresholds, is what bounds the worst case — a mis-tuned threshold can
   *  only ever cost the operator this many markers a day. */
  audioMarkerMaxPerDay: z.number().int().positive().default(12),

  // ── Audio episodes (hysteresis) — classified sound as one track + one event ──
  //
  // No class allowlist. A 20 s cry used to become four AudioEvents (5 s
  // heartbeat) and no timeline track; these knobs collapse that to one
  // episode. Defaults are ON for a 1–2 day live trial; tune per camera if
  // speech-all-day still produces long tracks.
  /** Materialize one event + one synthetic track per classified episode.
   *  OFF switches off the GROUPING only — classified audio still persists an
   *  event (class change, then one per 5 s heartbeat) and still reaches the
   *  Notification Center; it just opens no synthetic track. A knob that names
   *  the grouping must never silence the path (D62). */
  audioEpisodeEnabled: z.boolean().default(true),
  /** Class must be heard continuously this long before the episode opens. */
  audioEpisodeOpenHoldSec: z.number().nonnegative().default(1.5),
  /** Class must be absent this long before the episode closes. */
  audioEpisodeCloseGapSec: z.number().positive().default(12),
  /** After close, the same class cannot reopen until this elapses.
   *
   *  This is the minimum spacing between two SYNTHETIC EVENTS (the episode's
   *  event + timeline track) of the same sound on one camera — NOT a
   *  notification floor. Notification spacing is the rule's own
   *  `throttle.cooldownSec`, which already defaults to 60 s and is keyed
   *  per-device; the two are independent brakes on different objects.
   *
   *  Raised 30 → 60 s on 2026-09-03 by the operator, alongside the 2-in-10s
   *  corroboration window above. */
  audioEpisodeCooldownSec: z.number().nonnegative().default(60),
})
export type AudioDetectionSettings = z.infer<typeof AudioDetectionSettingsSchema>

export const AUDIO_DETECTION_DEFAULTS: AudioDetectionSettings = AudioDetectionSettingsSchema.parse(
  {},
)

/**
 * Resolve a per-device store blob into typed settings. Field-by-field: one
 * invalid value falls back to THAT field's default and the rest of the blob
 * still applies — a whole-object parse would throw away an operator's nine
 * good knobs because the tenth is a string.
 *
 * Driven off `.shape` rather than a hand-written key list. The list version
 * silently omitted any field added to the schema but forgotten here, which
 * reads at the call site as "the operator never set it" — an invisible way
 * for a new knob to do nothing at all.
 */
export function resolveAudioDetectionSettings(
  raw: Record<string, unknown>,
): AudioDetectionSettings {
  const sanitized: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(AudioDetectionSettingsSchema.shape)) {
    const parsed = field.safeParse(raw[key])
    // A failed field is left ABSENT so the schema's own default fills it.
    if (parsed.success) sanitized[key] = parsed.data
  }
  const resolved = AudioDetectionSettingsSchema.safeParse(sanitized)
  return resolved.success ? resolved.data : AUDIO_DETECTION_DEFAULTS
}
