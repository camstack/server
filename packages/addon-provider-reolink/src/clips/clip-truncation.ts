/**
 * When a cmd 5 download is FINISHED, and how a short one is caught.
 *
 * ## The window
 *
 * Nothing on the wire ends a cmd 5 transfer — no 201, no trailing frame, no
 * size that matches `sizeL` — so the library ends it on an idle window
 * (`DEFAULT_RECORDING_DOWNLOAD_IDLE_MS = 2 000`). This repo never passed one,
 * and so paid two seconds of silence on every clip. Measured 2026-09-20 on 592
 * and on a 639 child, same clips, byte-identical output across six repetitions
 * at 200 ms and two at 100 ms (D568):
 *
 * | | idle 2 000 | idle 200 |
 * | --- | --- | --- |
 * | 592 sub, 31–34 s | 2 361 – 2 726 ms | 1 040 – 1 062 ms |
 * | 592 main, 20–24 MB | 6 373 – 7 195 ms | 2 829 – 3 571 ms |
 * | 639 child sub, 22 s | 3 384 ms | 1 668 ms |
 *
 * {@link CLIP_IDLE_WINDOW_MS} is **300 ms**, and it is ONE number on every
 * topology. 300 is five times the largest inter-chunk gap anybody has measured
 * inside a live transfer (59 ms, on a 101 s clip), which is the margin the
 * hub-child case argues for — its bytes ride the PARENT's socket, shared with
 * every other read on that hub — while still spending an order of magnitude
 * less than the default. A second, longer constant for children was rejected:
 * 200 ms already returned byte-identical content on 639, so a per-topology
 * number would be an unmeasured guess on both sides of the branch, and the
 * thing that actually makes a short window safe is not the window, it is
 * {@link judgeClipDuration} below.
 *
 * ## The proof
 *
 * A short window can truncate a fetch, so the fetch must be able to say that
 * it did. The listed `sizeL` cannot: it has never matched the received byte
 * count on any clip measured (695 125 vs 471 288, 1 026 310 vs 814 328). The
 * DECODED duration can: it landed within a second of the catalog row's own
 * `endMs − startMs` on every clip measured (33.856 s against a 34 s row,
 * 30.537 against 31, 21.951 against 22, 32.017 against 31).
 *
 * So the gate is a SHORTFALL against the row, and the tolerance comes from
 * those numbers: the worst shortfall measured is 0.463 s, and the row's own
 * window is whole seconds (its stamps carry no sub-second field), which can
 * cost a further second on its own. 1.5 s covers both and nothing else — a
 * relative tolerance was rejected because the shortfall did not scale with
 * clip length in any measurement (0.049 s at 22 s, 0.144 s at 34 s), and a
 * percentage would have handed a long clip a blind spot of several seconds.
 */

/** The completion window for a clip download, every topology (D568). */
export const CLIP_IDLE_WINDOW_MS = 300

/**
 * The window a TRUNCATED fetch is retried on: the library's own default, the
 * one this repo shipped for its whole life. A retry exists to answer "was that
 * the window or the camera?", so it must be the conservative number and not a
 * second short one.
 */
export const CLIP_IDLE_WINDOW_RETRY_MS = 2_000

/** Worst measured shortfall (0.463 s) plus the row's whole-second stamps. */
export const CLIP_DURATION_SHORTFALL_TOLERANCE_S = 1.5

/** Why a fetch could not be judged at all. Never folded into "complete". */
export type ClipDurationUnknownReason =
  /** `stats.durationSeconds` was `null`: nothing on the wire measured one. */
  | 'duration-unmeasured'
  /** The row has no window — `endMs <= startMs`, so there is nothing to compare. */
  | 'row-window-unknown'
  /** The recording is still being written, so its `endMs` is frozen (D563). */
  | 'clip-open'

export type ClipDurationVerdict =
  | {
      readonly kind: 'complete'
      readonly expectedSeconds: number
      readonly decodedSeconds: number
    }
  | { readonly kind: 'unknown'; readonly reason: ClipDurationUnknownReason }
  | {
      readonly kind: 'short'
      readonly expectedSeconds: number
      readonly decodedSeconds: number
      readonly shortfallSeconds: number
    }

export interface JudgeClipDurationInput {
  /** The catalog row's own window, `endMs − startMs`. */
  readonly expectedMs: number
  /** `stats.durationSeconds` — `null` when the decode measured none. */
  readonly decodedSeconds: number | null
  /** The row's `inProgress`. */
  readonly inProgress?: boolean
}

/**
 * Did this pass deliver the clip the row describes?
 *
 * Only a SHORTFALL is a defect. A decode that runs longer than the row is
 * routine — the row's stamps are whole seconds and its twins differ by up to
 * four — and calling it truncated would refuse a clip that is more complete
 * than the catalog knew.
 */
export function judgeClipDuration(input: JudgeClipDurationInput): ClipDurationVerdict {
  if (input.inProgress === true) return { kind: 'unknown', reason: 'clip-open' }
  if (input.decodedSeconds === null || !Number.isFinite(input.decodedSeconds)) {
    return { kind: 'unknown', reason: 'duration-unmeasured' }
  }
  if (!Number.isFinite(input.expectedMs) || input.expectedMs <= 0) {
    return { kind: 'unknown', reason: 'row-window-unknown' }
  }
  const expectedSeconds = input.expectedMs / 1_000
  const decodedSeconds = input.decodedSeconds
  const shortfallSeconds = expectedSeconds - decodedSeconds
  if (shortfallSeconds > CLIP_DURATION_SHORTFALL_TOLERANCE_S) {
    return { kind: 'short', expectedSeconds, decodedSeconds, shortfallSeconds }
  }
  return { kind: 'complete', expectedSeconds, decodedSeconds }
}
