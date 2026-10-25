/**
 * The frame rate a clip is muxed at — MEASURED on this pass, from the only
 * clock the replay carries.
 *
 * ## Why it has to be measured here
 *
 * The elementary stream this provider hands ffmpeg has no timing of its own,
 * so `-r` decides what the muxed file SAYS its frame rate is. Omitting it is
 * not "no rate": it is ffmpeg's own default (25 fps for raw H.26x), and a
 * clip muxed at a default it did not earn plays at the wrong speed with
 * nothing in the file to say so. That is the door D567 closed for Reolink and
 * D604 nailed shut; this is the same rule reached from a different wire.
 *
 * ## And why the camera's own number may not be used
 *
 * `ContentMgmt/record/tracks` on 1436 declares `framerate=2.260000 fps` for a
 * track measured at 12.55 — the feasibility note says so, and this fleet's
 * other camera agrees that the field means nothing. It is never read here.
 *
 * ## The clock
 *
 * RTP timestamps at the track's own rate (90 000 Hz on every camera measured).
 * An integer clock over an integer span, so the estimate is exact arithmetic
 * and not a float accumulated per frame.
 */

export type ReplayFpsSource = 'timestamps' | 'unmeasured'

export interface ReplayRate {
  /** The number `-r` gets, or `null` when the timestamps could not say. */
  readonly fps: number | null
  readonly source: ReplayFpsSource
  /** How many access units the estimate was taken over. */
  readonly accessUnits: number
}

/**
 * ## Why nothing is SNAPPED to a whole number
 *
 * A first version rounded an estimate that came within 4 % of an integer, on
 * the theory that a variable rate lands near one. The fixture replay measures
 * **12.5 fps exactly** — 7 200 ticks of a 90 kHz clock between every access
 * unit — and 12.5 is within 4 % of 13, so the rule turned an exact measurement
 * into a wrong one. The clock is integral and the arithmetic is exact; there
 * is nothing here a heuristic can improve, and a number the camera's own
 * timestamps produced is the one the file should carry.
 */

/**
 * The rate the timestamps say, or `null`.
 *
 * Fewer than two units, a span of zero, or a span that goes BACKWARD all
 * answer `unmeasured`. The last one is not hypothetical: a u32 RTP timestamp
 * wraps, and a wrapped span is a negative number that would otherwise mux the
 * clip at a nonsense rate rather than refusing.
 */
/**
 * How many equal spans in a row prove the clock is metronomic.
 *
 * Three spans, so four access units. Not a confidence threshold — see
 * {@link replayFpsIsExact}, where the arithmetic makes one span enough and the
 * extra two exist only so a coincidence of two equal integers cannot end the
 * probe.
 */
export const REPLAY_RATE_EXACT_SPANS = 3

/**
 * Do these timestamps ALREADY say the rate, so that waiting for more cannot
 * change the answer?
 *
 * This is arithmetic, not a heuristic. {@link estimateReplayFps} computes
 * `(n - 1) × clockRate ÷ (last − first)`. If every consecutive span equals `d`
 * then `last − first = (n − 1) × d` and the estimate is `clockRate ÷ d` for
 * EVERY n — the sixteenth unit produces the same number as the fourth. So a
 * probe that has seen {@link REPLAY_RATE_EXACT_SPANS} identical integer spans
 * is not guessing when it stops; it is declining to wait 1.0 s of a camera's
 * own realtime replay for a number it already holds.
 *
 * **Why this matters more here than anywhere else.** A Hikvision replay
 * delivers at 1× (measured 2026-09-23 on 1436: 176 access units in 14.27 s of
 * wall clock at 12.5 fps, 1.01× realtime). Every access unit the probe holds
 * back is therefore 80 ms the operator waits before the first frame, and the
 * full sixteen measured 1301 ms of a 4316 ms time-to-first-frame. The spans on
 * that camera are 7200 ticks of a 90 kHz clock, every one of them.
 *
 * Integer equality, never a tolerance: a variable-rate replay differs by at
 * least one tick and falls through to the full window, which is the behaviour
 * that shipped.
 */
export function replayFpsIsExact(timestamps: readonly number[]): boolean {
  if (timestamps.length < REPLAY_RATE_EXACT_SPANS + 1) return false
  const first = timestamps[0] ?? 0
  const second = timestamps[1] ?? 0
  const span = second - first
  if (span <= 0) return false
  for (let i = 2; i < timestamps.length; i += 1) {
    if ((timestamps[i] ?? 0) - (timestamps[i - 1] ?? 0) !== span) return false
  }
  return true
}

export function estimateReplayFps(timestamps: readonly number[], clockRate: number): ReplayRate {
  if (timestamps.length < 2 || clockRate <= 0) {
    return { fps: null, source: 'unmeasured', accessUnits: timestamps.length }
  }
  const first = timestamps[0] ?? 0
  const last = timestamps[timestamps.length - 1] ?? 0
  const span = last - first
  if (span <= 0) return { fps: null, source: 'unmeasured', accessUnits: timestamps.length }
  const fps = ((timestamps.length - 1) * clockRate) / span
  if (!Number.isFinite(fps) || fps <= 0) {
    return { fps: null, source: 'unmeasured', accessUnits: timestamps.length }
  }
  return {
    // Two decimals: enough to carry 12.5 and 12.55 apart, few enough that the
    // number on the log line and the number in the file are the same string.
    fps: Math.round(fps * 100) / 100,
    source: 'timestamps',
    accessUnits: timestamps.length,
  }
}
