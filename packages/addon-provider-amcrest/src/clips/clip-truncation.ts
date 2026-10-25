/**
 * Did the replay deliver the clip the catalog row describes?
 *
 * ## Why this file exists
 *
 * `/cam/playback` hangs up early and ffmpeg exits **0** when it does, so the
 * producer's only signal — the exit code — said `complete` on a stream that
 * carried 42 % of its clip. Measured on the live hub, camera 3836, from the
 * operator's own session on 2026-09-23 19:37 (D623):
 *
 * | clip | row window | served | bytes |
 * | --- | --- | --- | --- |
 * | `1790183010-1790183055` | 45 s | `branch: "complete"` | **4 978 237** |
 * | the same clip, next attempt | 45 s | `peer-closed` (the operator gave up) | **11 841 121** |
 * | the same clip, whole (2026-09-24 00:39) | 45 s | `complete` | **39 294 962** |
 *
 * The "successful" one delivered **12.7 %** of the bytes the same camera hands
 * over when the session survives. Nothing in the log said so.
 *
 * ## What "expected" is, and why it is the ROW and not 92.5 % of it
 *
 * `clip-search.ts` records that the row's `Duration` is WALL CLOCK and that
 * the container inside the FILE runs about 7.5 % shorter (74 s row → 68.433 s
 * media, `ffprobe`). **That number does not transfer to this path**, and
 * assuming it did would have bought a blind spot of several seconds per clip.
 * The file is the whole `.dav` the camera wrote; the replay is cut by the
 * `starttime`/`endtime` the URL carries, so it tracks the row. Measured on
 * 3836 over the dial route, 2026-09-24 (video-track duration, `ffprobe`):
 *
 * | clip | row window | delivered | against the row |
 * | --- | --- | --- | --- |
 * | `1790189744-1790189787` | 43 s | 42.986 s | **−0.015 s** |
 * | `1790189367-1790189411` | 44 s | 44.835 s | +0.835 s |
 * | `1790189415-1790189537` | 122 s | 124.650 s | +2.650 s |
 * | `1790189791-1790189844` | 53 s | 56.463 s | +3.463 s |
 * | `1790189601-1790189740` | 139 s | 140.483 s | +1.483 s |
 * | `1790183010-1790183055` | 45 s | 69.569 s | **+24.569 s** |
 *
 * So the expectation is the row's own window, and — exactly as the Reolink
 * judge already says — only a SHORTFALL is a defect. A replay that runs LONGER
 * than the row is routine on this camera: five of the six ran over, and the
 * last is a row whose window under-states the recording the camera actually
 * holds for it by twenty-four seconds. A rule that judged distance in either
 * direction would have filed a defect against the most complete serve of the
 * six.
 *
 * {@link CLIP_DURATION_SHORTFALL_TOLERANCE_S} is **1.5 s**, the same number
 * and the same argument as the Reolink judge: the worst clean shortfall
 * measured here is 0.015 s, the row's stamps are whole seconds (a clip key is
 * `<startSec>-<endSec>`, so the window can be a second off on its own), and
 * ffmpeg's `out_time` is the LAST frame's presentation stamp rather than the
 * end of its interval, which under-states by one frame interval (~0.07 s at
 * this camera's rate). A relative tolerance was rejected for the reason
 * Reolink gives and this camera's numbers repeat: there is no clean shortfall
 * that scales with clip length — the only one measured at all is 0.015 s, on
 * the shortest row — so a percentage would hand a 205 s clip a twenty-second
 * blind spot to buy nothing. The truncations this gate exists to catch are not
 * marginal: the operator's "complete" serve was **4 978 237 bytes where the
 * whole clip is 39 294 962**.
 *
 * ## This is the third spelling of one idea, deliberately
 *
 * `addon-provider-reolink/src/clips/clip-truncation.ts` and
 * `addon-provider-hikvision/src/clips/clip-stream.ts` (`isShort()`) already
 * judge the same question with the same vocabulary and two different
 * tolerances. The names here are Reolink's, to the letter, so the extraction
 * is mechanical when it happens — see D623 for why it did NOT happen in this
 * change: the shared home is `@camstack/types`, which travels in the published
 * `@camstack/server` closure, so extracting would have turned a provider
 * bugfix into a framework release on every node.
 */

/**
 * The worst clean shortfall measured is 0.015 s; the row's stamps are whole
 * seconds and `out_time` under-states by one frame interval.
 */
export const CLIP_DURATION_SHORTFALL_TOLERANCE_S = 1.5

/** Why a stream could not be judged at all. Never folded into "complete". */
export type ClipDurationUnknownReason =
  /** Nothing measured a span — ffmpeg's progress named no `out_time`. */
  | 'duration-unmeasured'
  /** The row has no window (`endMs <= startMs`), so there is nothing to compare. */
  | 'row-window-unknown'

export type ClipDurationVerdict =
  | {
      readonly kind: 'complete'
      readonly expectedSeconds: number
      readonly deliveredSeconds: number
    }
  | {
      readonly kind: 'short'
      readonly expectedSeconds: number
      readonly deliveredSeconds: number
      readonly shortfallSeconds: number
    }
  /**
   * The peer got a container and no media in it.
   *
   * NOT a short serve, and this is the one place the vocabulary widens past
   * Reolink's: measured on 3836, the camera grants a `/cam/playback` session,
   * answers `PLAY 200` and delivers zero RTP. ffmpeg still writes an `ftyp`
   * and an empty `moov`, so the peer is BEGUN and the producer's "did any byte
   * arrive" gate says yes. A stream of zero frames is not 100 % short — it is
   * nothing, it is diagnosed at the camera rather than at the session, and the
   * two must never share a branch name (D391).
   */
  | { readonly kind: 'empty'; readonly expectedSeconds: number }
  | { readonly kind: 'unknown'; readonly reason: ClipDurationUnknownReason }

export interface JudgeClipDurationInput {
  /** The catalog row's own window, `endMs − startMs`. */
  readonly expectedMs: number
  /** MEASURED off the mux's progress — `null` when nothing measured one. */
  readonly deliveredSeconds: number | null
  /** Video frames the mux reported writing. `null` when it reported none. */
  readonly frames: number | null
}

/**
 * Did this pass deliver the clip the row describes?
 *
 * Only a SHORTFALL is a defect — see the docblock. `unknown` is never folded
 * into either answer: a stream nothing measured is a stream nobody checked
 * (D393).
 */
export function judgeClipDuration(input: JudgeClipDurationInput): ClipDurationVerdict {
  if (!Number.isFinite(input.expectedMs) || input.expectedMs <= 0) {
    return { kind: 'unknown', reason: 'row-window-unknown' }
  }
  const expectedSeconds = input.expectedMs / 1_000
  // Zero frames is the camera's own silence, and it is asked BEFORE the
  // duration: a mux that wrote no frame has no span to be short of.
  if (input.frames === 0) return { kind: 'empty', expectedSeconds }
  if (input.deliveredSeconds === null || !Number.isFinite(input.deliveredSeconds)) {
    return { kind: 'unknown', reason: 'duration-unmeasured' }
  }
  const deliveredSeconds = input.deliveredSeconds
  const shortfallSeconds = expectedSeconds - deliveredSeconds
  if (shortfallSeconds > CLIP_DURATION_SHORTFALL_TOLERANCE_S) {
    return { kind: 'short', expectedSeconds, deliveredSeconds, shortfallSeconds }
  }
  return { kind: 'complete', expectedSeconds, deliveredSeconds }
}

/** The code a consumer branches on, without parsing prose. `null` for a
 *  stream there is nothing to report about. */
export function truncationReasonCode(verdict: ClipDurationVerdict): string | null {
  switch (verdict.kind) {
    case 'short':
      return 'stream-short'
    case 'empty':
      return 'stream-empty'
    case 'unknown':
      return 'completeness-unverified'
    case 'complete':
      return null
  }
}

/**
 * The sentence the operator reads, in the surface that already shows a stream
 * error. It names what was delivered AND what was asked for, because "the clip
 * is short" and "the session dropped" look identical on a timeline.
 */
export function describeTruncation(verdict: ClipDurationVerdict): string | null {
  switch (verdict.kind) {
    case 'short':
      return (
        `the camera ended this replay early: ${verdict.deliveredSeconds.toFixed(1)} s of ` +
        `${verdict.expectedSeconds.toFixed(1)} s arrived, ${verdict.shortfallSeconds.toFixed(1)} s ` +
        'short. The rest of the clip is still on the camera — ask for it again.'
      )
    case 'empty':
      return (
        'the camera accepted this replay and sent no video at all, so there is nothing to ' +
        `play of the ${verdict.expectedSeconds.toFixed(1)} s this clip covers. Its replay ` +
        'session is the one to look at, not the recording.'
      )
    case 'unknown':
      return `this clip could not be checked for truncation: ${verdict.reason}`
    case 'complete':
      return null
  }
}
