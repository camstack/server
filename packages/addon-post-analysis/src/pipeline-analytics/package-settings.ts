import { z } from 'zod'

/**
 * Per-device package-drop detector settings (surface C of the
 * detection-config-exposure plan — a per-device post-analysis section).
 * Cascade: a per-device override on top of the declared default, resolved
 * per field (an invalid/missing value falls back to its default — parse
 * never throws). Mirrors `media-settings` / `tracking-settings`.
 *
 * Keys are namespaced (`packageDrop*`) because the device store is a FLAT
 * blob shared across every post-analysis section — a bare `enabled` would
 * collide with another section.
 *
 * See docs/superpowers/specs/2026-07-17-package-zones-design.md §3.3 +
 * docs/superpowers/specs/2026-07-17-detection-config-exposure-design.md
 * (surface C). Confirmation is N frames (default 3); dwell default is 0
 * (an extra bar). The 15 s dwell plus a 5 s round-gap missed a real
 * parcel on device 101 (2026-08-24 13:40).
 */
export const PackageDropSettingsSchema = z.object({
  /**
   * Explicit per-camera OFF. **On by default: the ZONE RULE is what enables
   * package detection**, not a second switch.
   *
   * As an opt-in default-false this was a parallel source of truth. Device 101
   * on 2026-07-30 had the zone (`Uscio`), an enabled `package`-stage zone rule
   * (`Pacchetti`, classFilter `['package']`), and a notification rule on
   * `delivery: 'package-event'` — three layers of operator intent, all defeated
   * silently by a boolean none of them mentions.
   *
   * Defaulting to true costs nothing on cameras nobody configured:
   * `PackageDropDetector.onAppeared` still returns early when the device has no
   * enabled `package`-stage rule, so the work is a class check plus one cached
   * lookup. Set this false to force the feature off on a camera that HAS a zone
   * rule.
   */
  packageDropEnabled: z.boolean().default(true),
  /**
   * Frames the box must be re-seen on before it is a parked package.
   * Same bar as tracker `minHits`: one frame is a flicker, two can still
   * be a passer-by's bag, three is "it stayed". A settle burst of three
   * frames in ~1 s is enough; no second governor round after the courier
   * left. Device 101 2026-08-24 13:40 expired at 1 round / 1.5 s dwell.
   */
  packageDropMinFrames: z.number().int().min(1).max(20).default(3),
  /**
   * Extra OBSERVED dwell (seconds, since first-seen) on top of N frames.
   * 0 (the default) means the frame count is enough — a courier who drops
   * and leaves in 2 s still delivers. Raise this to reject a bag briefly
   * set down and snatched back.
   */
  packageDropDwellSec: z.number().int().min(0).max(3_600).default(0),
  /** Reject tiny far-field blobs: min bbox area as a fraction of the frame. */
  packageDropMinBboxAreaFrac: z.number().min(0).max(1).default(0.004),
  /**
   * Reject near-scene-sized blobs: MAX bbox area as a fraction of the frame.
   *
   * Measured on device 101 (2026-08-21 analysis): 348/350 package false
   * positives were ONE static object — the streetlight's light wedge on the
   * granite paving — at 7.96–9.47% of the frame, scoring up to 0.877.
   * Confidence cannot separate it (the one true parcel scored 0.885); area
   * can: real parcels measured 1.14% and 1.72%. The 0.04 default sits ~4×
   * above every real parcel and ~2× below the smallest measured wedge.
   */
  packageDropMaxBboxAreaFrac: z.number().min(0).max(1).default(0.04),
  /** Emit `package-picked-up` when a delivered package's entry departs. */
  packageDropPickupEnabled: z.boolean().default(true),
  /**
   * Conclude a pick-up EARLY on positive evidence (D687): three looks of the
   * package step spanning ≥ 10 s that found the doormat empty and unoccluded,
   * with somebody in the drop-off zone around the disappearance — instead of
   * waiting out the 300 s TTL. OFF by default: the one pick-up the stored data
   * could replay (101, 2026-09-30) is no sample to judge the false-departure
   * risk by. Silence always keeps the TTL.
   */
  packageDropEarlyPickupEnabled: z.boolean().default(false),
  /**
   * A parcel needs a deliverer: a stillness candidate only ever promotes to
   * `delivered` if a non-package track (person/vehicle/animal) was active IN
   * A CONFIGURED PACKAGE DROP-OFF ZONE within this many seconds BEFORE the
   * box first appeared — and a departure only counts as `picked-up` with
   * somebody in that zone around the disappearance. Whole-camera motion (a
   * walker at the far gate) does not count. 0 disables both gates. Device
   * 101's streetlight wedge cycled delivered→picked-up ~23×/night with
   * nobody in the drop-off zone. Default 300 s: wide enough to absorb the
   * motion-settle governor's cadence (the box is often first SEEN minutes
   * after the courier left).
   */
  packageDropActivityWindowSec: z.number().int().min(0).max(3_600).default(300),
  /**
   * Stationary classes that count as a package. MODEL-AGNOSTIC: defaults to
   * the single `package` class a dedicated parcel model emits; the interim
   * COCO vector (suitcase/backpack/handbag) already maps to `package`
   * upstream, so this stays `['package']`.
   */
  packageDropClassFilter: z.array(z.string()).default(['package']),
})

export type PackageDropSettings = z.infer<typeof PackageDropSettingsSchema>

export const PACKAGE_DROP_DEFAULTS: PackageDropSettings = PackageDropSettingsSchema.parse({})

/**
 * Resolve a per-device store blob into typed package-drop settings.
 * Unknown/invalid fields fall back to the default for that field (never
 * throws on a bad blob).
 */
export function resolvePackageDropSettings(raw: Record<string, unknown>): PackageDropSettings {
  const pick = <K extends keyof PackageDropSettings>(key: K): PackageDropSettings[K] => {
    const field = PackageDropSettingsSchema.shape[key]
    const parsed = field.safeParse(raw[key])
    return parsed.success ? (parsed.data as PackageDropSettings[K]) : PACKAGE_DROP_DEFAULTS[key]
  }
  return {
    packageDropEnabled: pick('packageDropEnabled'),
    packageDropMinFrames: pick('packageDropMinFrames'),
    packageDropDwellSec: pick('packageDropDwellSec'),
    packageDropMinBboxAreaFrac: pick('packageDropMinBboxAreaFrac'),
    packageDropMaxBboxAreaFrac: pick('packageDropMaxBboxAreaFrac'),
    packageDropPickupEnabled: pick('packageDropPickupEnabled'),
    packageDropEarlyPickupEnabled: pick('packageDropEarlyPickupEnabled'),
    packageDropActivityWindowSec: pick('packageDropActivityWindowSec'),
    packageDropClassFilter: pick('packageDropClassFilter'),
  }
}
