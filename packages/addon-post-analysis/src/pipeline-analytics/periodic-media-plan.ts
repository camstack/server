/**
 * Pure decision for the three periodic per-track media writes of ONE frame:
 * the appended `snapshot`, the rolling `lastFrame`, and the best `thumbnail`.
 *
 * ## Why this exists (the end-of-track duplicate bug)
 *
 * The `snapshot` (append) and `lastFrame` (single rolling overwrite) used to
 * fire TOGETHER on the SAME movement-gated cadence — every appended snapshot
 * ALSO overwrote `lastFrame` with the identical boxed frame. So the rolling
 * `lastFrame` was always a byte-for-byte copy of the MOST RECENT `snapshot`,
 * and a track's filmstrip ended with the same frame shown twice (a `snapshot`
 * tile and a `lastFrame` tile of the identical pixels + timestamp).
 *
 * The fix: `lastFrame` rolls on its OWN pure-TIME cadence and ONLY on a frame
 * where NO snapshot is appended. Because a snapshot and a `lastFrame` can never
 * be written for the same frame, the rolling `lastFrame` is never identical to
 * any stored `snapshot` — the end-of-track duplicate is gone — while `lastFrame`
 * still means "the freshest view captured near track end" (it trails the
 * snapshots by up to one interval on a moving track, and captures the freshest
 * still on a stationary one). `putReplacing` keeps exactly one `lastFrame` per
 * track, so the extra stationary rolls cost one replace per interval at most.
 */

export interface PeriodicMediaPlanInput {
  /**
   * Per-camera DEBUG media (`MediaSettings.debugMediaEnabled`, default false).
   * Gates the appended filmstrip `snapshot` — and NOT the rolling `lastFrame`,
   * which the retired `saveThumbnails` used to take away with it. `lastFrame`
   * is in the keep-set (trajectory replay end, the close-time promotion
   * target, the audit's `MISSING_LASTFRAME`); a debug switch may not remove a
   * kept artefact, so the two gates were split when the switch was renamed.
   */
  readonly debugMediaEnabled: boolean
  /** The movement-gated periodic-snapshot decision for THIS frame
   *  (from {@link evaluatePeriodicSnapshot}). */
  readonly dueSnapshot: boolean
  /** The best-frame (thumbnail) decision for THIS frame — a strictly-better
   *  detection past the hysteresis margin + min-gap. */
  readonly isNewBest: boolean
  /** Whether a best `thumbnail` has ACTUALLY been persisted for this track yet.
   *  The best-thumbnail capture can silently drop when the live frame lease is
   *  recycled before the async encode runs, or the resolved frame is blank
   *  (hwaccel/cold-start) — see `event-media-dispatcher.captureForFrame`. A short
   *  / high-churn track schedules its ONLY best-thumbnail on its first frame, so
   *  one dropped capture leaves it with no subject crop and the gallery degrades
   *  to a full-scene tile (#27-A). Force a retry every frame until a thumbnail
   *  lands. Defaults to already-landed for callers that don't track it. */
  readonly thumbnailLanded?: boolean
  /** Wall-clock of this track's last ACTUALLY-written `lastFrame` (0 = never). */
  readonly lastFrameAt: number
  /** Current frame timestamp. */
  readonly now: number
  /** Rolling `lastFrame` cadence (ms) — reuses the snapshot interval. */
  readonly intervalMs: number
  /** Optional FASTER cadence for the rolling `lastFrame` alone. The snapshot
   *  interval (default 5s) exceeds most track lifetimes (3–9s), so a track
   *  often closed with NO `lastFrame` at all and nothing for the close-time
   *  promotion to absorb (2026-07-22 audit: 29/68 closed tracks). A denser
   *  roll keeps a fresh close-candidate at ~this staleness bound. Defaults to
   *  `intervalMs` (legacy behaviour) when omitted. */
  readonly lastFrameIntervalMs?: number
  /** Whether a `firstFrame` write has already landed for this track.
   *  A rolling `lastFrame` must not precede firstFrame (1b659d56). Defaults
   *  to already-landed so callers that omit the flag keep the prior behaviour. */
  readonly firstFrameLanded?: boolean
}

export interface PeriodicMediaPlan {
  /** Append a timeline `snapshot` this frame. */
  readonly appendSnapshot: boolean
  /** Overwrite the single rolling `lastFrame` this frame. */
  readonly rollingLastFrame: boolean
  /** Overwrite the single best `thumbnail` this frame. */
  readonly bestThumbnail: boolean
}

/**
 * Decide the periodic media writes for one track on one frame. Pure: no side
 * effects. The caller advances its own `lastFrameAt` clock only when the
 * returned `rollingLastFrame` is true.
 *
 * INVARIANT: `appendSnapshot` and `rollingLastFrame` are never both true — the
 * rolling `lastFrame` is never the same frame as an appended `snapshot`, so it
 * can never duplicate one.
 */
export function planPeriodicMedia(input: PeriodicMediaPlanInput): PeriodicMediaPlan {
  const appendSnapshot = input.debugMediaEnabled && input.dueSnapshot
  const lastFrameInterval = input.lastFrameIntervalMs ?? input.intervalMs
  // BUCKET-coalesced roll (2026-07-22 capture-pressure fix): tracks roll when
  // the wall-clock crosses an interval BOUNDARY, not on per-track elapsed
  // clocks. Per-track clocks spread N concurrent tracks' rolls across N
  // different frames — nearly every frame became a capture frame under
  // multi-track load, and the per-frame shared native fetch stampeded the
  // runner's retained-frame ring ("frame recycled before resolve", missing
  // thumbnails). Bucket alignment coalesces every track's roll onto the SAME
  // frame, sharing ONE native fetch per interval per device. A never-rolled
  // track (lastFrameAt 0) rolls on its first eligible frame — cheap (that
  // frame is usually fetching anyway) and it gives even sub-interval tracks a
  // genuine lastFrame.
  const lastFrameElapsed =
    Math.floor(input.now / lastFrameInterval) > Math.floor(input.lastFrameAt / lastFrameInterval)
  // Never on a snapshot frame → the rolling lastFrame is always a DISTINCT
  // frame from every stored snapshot (kills the end-of-track duplicate).
  const firstFrameLanded = input.firstFrameLanded ?? true
  const rollingLastFrame = lastFrameElapsed && !appendSnapshot && firstFrameLanded
  // Capture a best `thumbnail` on a genuine new-best frame, OR keep retrying on
  // every frame until ONE has actually landed (#27-A) — so a short track whose
  // first best-thumbnail capture was dropped (recycled/blank frame) still ends
  // up with a subject crop instead of degrading to a full-scene gallery tile.
  const thumbnailLanded = input.thumbnailLanded ?? true
  const bestThumbnail = input.isNewBest || !thumbnailLanded
  return { appendSnapshot, rollingLastFrame, bestThumbnail }
}
