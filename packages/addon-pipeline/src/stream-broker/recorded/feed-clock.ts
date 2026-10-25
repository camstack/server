export function msToRtp90k(ms: number): number {
  return Math.round(ms * 90)
}

/**
 * The ORIGIN two tracks are measured from — the base and the source anchor,
 * shared, so the offset between video and audio survives a discontinuity.
 *
 * ## Why this exists
 *
 * `markDiscontinuity` re-bases on the last output. With one instance per
 * track, that last output is the TRACK'S own, and the two differ by however
 * far apart the interleave left them — so every seek replaced the real A/V
 * offset with that gap, in the same direction each time. Measured on the
 * clock alone it grows by a fixed step each time and never comes back; how
 * big that step is, is the interleave's business — 10–23 ms a seek on a
 * synthetic fixture, **900 ms over three seeks on a real clip**.
 *
 * Calling `markSeek()` on both instances "together" did not help and could
 * not: it is not the CALL that has to be shared, it is the ORIGIN. With one,
 * `out_video − out_audio` is `(vPts − aPts) / rate` — exactly the source
 * offset, which is the entire content of lip sync — and there is nothing left
 * to keep in step.
 *
 * `lastOutMs` stays per-track: monotonicity is a promise to ONE receiver
 * track, and clamping video against audio's last stamp would move video.
 */
export class FeedOrigin {
  /** Output ms the current run is measured from. */
  outBaseMs = 0
  /** Source ms the current run is measured from; `null` until the next stamp. */
  srcAnchorMs: number | null = null
  /**
   * The furthest EITHER track has been stamped. What a discontinuity clears,
   * so the gap is opened past both — and so two clocks marking the same
   * discontinuity in a row produce one gap, not two.
   */
  highWaterMs = 0
}

/**
 * Maps arbitrary, possibly-resetting source PTS (ms) onto a strictly increasing
 * output clock at `rateHz` (default 90 kHz video; pass 8000 for PCMU audio). On
 * seek the output keeps advancing while the source anchor re-bases, so
 * per-segment PTS resets never rewind the track.
 *
 * Video and audio are separate instances SHARING one {@link FeedOrigin} — see
 * there for what happens when they do not. An instance constructed without one
 * gets its own, so a lone clock behaves exactly as it always did.
 *
 * Playback rate: `setRate(r)` divides SOURCE elapsed time by `r` on the output
 * timeline (2× → half the output spacing → the receiver plays frames twice as
 * fast). A mid-stream rate change re-anchors at the last stamped point so the
 * output stays continuous and monotonic across the change (like `markSeek`,
 * but without discarding source continuity).
 */
export class MonotonicClock {
  private lastSrcMs: number | null = null
  private lastOutMs = 0
  private rate = 1
  private readonly origin: FeedOrigin

  constructor(
    private readonly rateHz: number = 90000,
    origin?: FeedOrigin,
  ) {
    this.origin = origin ?? new FeedOrigin()
  }

  stamp(srcPtsMs: number): number {
    if (this.origin.srcAnchorMs === null) this.origin.srcAnchorMs = srcPtsMs
    this.lastSrcMs = srcPtsMs
    const elapsed = Math.max(0, (srcPtsMs - this.origin.srcAnchorMs) / this.rate)
    const outMs = this.origin.outBaseMs + elapsed
    this.lastOutMs = Math.max(this.lastOutMs, outMs)
    this.origin.highWaterMs = Math.max(this.origin.highWaterMs, this.lastOutMs)
    return Math.round((this.lastOutMs * this.rateHz) / 1000)
  }

  /**
   * Call before feeding a new CONTIGUOUS segment (the per-segment PTS reset at
   * a boundary during forward playback, or a paused frame-step re-feed).
   * Advances the output ~1 frame past the last emitted ts. The nudge lives in
   * the OUTPUT domain, so it scales with the rate factor (at 2× a source frame
   * occupies ~16.5 output ms) to preserve the perceived frame cadence across
   * the boundary.
   */
  markSeek(): void {
    this.markDiscontinuity(33 / this.rate)
  }

  /**
   * Call before feeding a NON-contiguous position (a seek / scrub commit).
   * Like `markSeek` but with an explicit, caller-chosen output gap: a seek must
   * be unmistakable to the receiver — with only a ~1-frame nudge, stale
   * in-flight access units from the aborted feed and the new GOP look like one
   * contiguous stream, and a lost IDR then smears the new deltas onto pre-seek
   * references. The gap is an intentional discontinuity, so it is NOT
   * rate-scaled.
   */
  markDiscontinuity(gapMs: number): void {
    // Past the furthest EITHER track reached, not past this one's own last
    // stamp: a gap opened per track is how the two drift apart. Idempotent,
    // so the paired calls in the feeder still produce one gap.
    this.origin.outBaseMs = this.origin.highWaterMs + gapMs
    this.origin.srcAnchorMs = null
    this.lastSrcMs = null
  }

  /**
   * Change the playback-rate factor (r > 0; 0/negative/redundant are no-ops —
   * "paused" is the absence of stamping, not a clock rate). Re-anchors both the
   * source and output baselines at the last stamped point so already-emitted
   * timestamps stay fixed and the next stamp continues monotonically at the new
   * rate.
   */
  setRate(rate: number): void {
    if (!(rate > 0) || rate === this.rate) return
    if (this.origin.srcAnchorMs !== null && this.lastSrcMs !== null) {
      this.origin.outBaseMs = this.lastOutMs
      this.origin.srcAnchorMs = this.lastSrcMs
    }
    this.rate = rate
  }
}
