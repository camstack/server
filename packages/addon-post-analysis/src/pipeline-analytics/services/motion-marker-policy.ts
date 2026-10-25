/**
 * Should this motion off→on edge produce a STILL?
 *
 * ## Why the question is not "did motion start"
 *
 * Measured on the live hub 2026-08-30: `motion-event-snapshot.ts` writes one
 * ~95 KiB JPEG on every `transitionedOn`, and that edge fires once every
 * **1.010 s** — median 1010 ms, p25 1007, p75 1014 — on every camera, busy or
 * dead quiet, at 03:00 and at 09:00. A 7 ms band that does not move with the
 * scene is not a scene statistic, it is a clock. Camera 3829 produced 22 827
 * stills against **5** detected tracks in one day.
 *
 * The clock belongs to the PROVIDER. Reolink emits
 * `MotionOnMotionChanged { detected: true }` on every firmware push and never
 * emits `false` (`reolink-camera.ts:9744`); Hikvision documents the same shape
 * — *"Emit the motion heartbeat on EVERY VMD tick, not just the rising edge …
 * mirroring Reolink's per-push emit"* (`hikvision-camera.ts:3434`). That is a
 * LEVEL KEEPALIVE at ~1 Hz. The analyzer meanwhile emits `MotionAnalysis` on
 * every pass at `motionFps` (default 4) carrying a raw
 * `regions.length > 0` sample with no hysteresis. Both handlers used to write
 * ONE shared `lastMotionInsertByDevice` map, so every analyzer frame that
 * happened to see no pixel change stamped `detected: false` and the next
 * provider keepalive read it as a rising edge. `onboardMotionDrivesAnalyzer`
 * defaults to **true** — an onboard push is precisely what starts the
 * analyzer — so the two sources are never exclusive, which is why D475
 * replaced the shared map with `MotionEpisodeTracker`, keyed per
 * `(deviceId, source)`: the two paths now keep independent transition state
 * and can no longer manufacture a rising edge for each other. The keepalive
 * shape this module exists to filter is unchanged — a firmware source still
 * repeats `detected:true` at ~1 Hz for the whole burst, so a still-per-edge
 * rule would still be a clock, not a scene statistic.
 *
 * ## What the operator actually asked for
 *
 * *"Dovremmo avere delle tracce sintetiche di motion semplice, se non avviene
 * alcuna detection per molto tempo, ma così tante sono veramente tante."* [We should have synthetic tracks of simple motion, if no detection happens for a long time, but so many of them are really many.]
 *
 * The fallback has a purpose: when a camera sees motion but the detector finds
 * nothing for a long stretch, one marker keeps the timeline from being blank.
 * The condition is a DETECTION DROUGHT, not an edge. So the gate here is a
 * function of two clocks and never of the edge itself:
 *
 *  - `lastDetectionAtMs` — the {@link isMotionActive} half that answers "was a
 *    tracked object alive". A drought is `now - lastDetectionAtMs >= quietMs`.
 *  - `lastMarkerAtMs` — one marker per drought WINDOW, so a 12-hour drought
 *    (camera 3829's median is 3.4 h) still produces evidence every `quietMs`
 *    instead of one still and then eleven blank hours.
 *
 * Both are in-RAM mirrors refreshed off the event path (D49): a stale mirror
 * SUPPRESSES a marker, it never invents one, and a read that fails changes
 * nothing because there is no read.
 *
 * ## Why `quietMs` defaults to 15 minutes
 *
 * From the observed distribution, not from a round number. Over 24 h across the
 * ten busiest cameras there were 1 445 detection-free stretches: median 42 s,
 * p75 201 s, **p90 770 s**. "Molto tempo" [a long time] is the tail, so the threshold sits
 * just past p90 — 900 s. Nine stretches in ten are shorter than one window and
 * produce NO marker at all, which is correct: they are not droughts. Sizing at
 * that N: **688 markers/day fleet-wide ≈ 64 MB/day**, against today's 92 400
 * stills/day ≈ 9.0 GB/day. Same fallback, 134× less of it.
 */

/** Why {@link decideMotionStill} answered as it did. */
export type MotionStillReason =
  /** Per-camera debug media is on: every edge is captured, as before. */
  | 'debug'
  /** A detection drought, and no marker yet in this window — capture. */
  | 'quiet-marker'
  /** A tracked object was alive within `quietMs`: the detector is covering
   *  this camera, so a motion still adds nothing. */
  | 'detection-recent'
  /** Already marked this drought window. */
  | 'marker-recent'

export interface MotionStillDecisionInput {
  /** `MediaSettings.debugMediaEnabled` for this camera. */
  readonly debugMediaEnabled: boolean
  /** Wall clock of the off→on edge being judged. */
  readonly now: number
  /** Last ms a spatial track was alive on this camera; `undefined` = never
   *  seen one (a camera that has not attached yet, or has never detected). */
  readonly lastDetectionAtMs: number | undefined
  /** Last ms this camera produced a motion marker still; `undefined` = never. */
  readonly lastMarkerAtMs: number | undefined
  /** The drought window N. */
  readonly quietMs: number
}

export interface MotionStillDecision {
  readonly capture: boolean
  readonly reason: MotionStillReason
}

/**
 * Pure. No clock of its own, no store read, no await — it is called on the
 * motion event path at up to the provider's keepalive rate.
 *
 * A non-positive `quietMs` would make every edge a marker (`now - x >= 0` is
 * true for any mirror), which is the flood this module removes; it is clamped
 * by the schema (`motionMarkerQuietMs.min`), and the ordering below puts the
 * detection check first so the reason names the most useful fact.
 */
export function decideMotionStill(input: MotionStillDecisionInput): MotionStillDecision {
  if (input.debugMediaEnabled) return { capture: true, reason: 'debug' }
  const { now, quietMs } = input
  if (input.lastDetectionAtMs !== undefined && now - input.lastDetectionAtMs < quietMs) {
    return { capture: false, reason: 'detection-recent' }
  }
  if (input.lastMarkerAtMs !== undefined && now - input.lastMarkerAtMs < quietMs) {
    return { capture: false, reason: 'marker-recent' }
  }
  return { capture: true, reason: 'quiet-marker' }
}
