/**
 * How fast a timelapse samples INSIDE a dense range — the one place that number
 * is decided.
 *
 * Pure: no clock, no I/O, no store. The renderer hands over the rule's two
 * cadence knobs, the output framerate and the planned ranges, and gets back the
 * integer `dense.everyMs` the export cap will carry.
 *
 * THE ARITHMETIC AN OPERATOR REASONS WITH. A dense range of `rangeSec` seconds,
 * sampled every `denseCadenceSec`, played at `outputFps`, occupies
 *
 *     outputSeconds = (rangeSec / denseCadenceSec) / outputFps
 *
 * seconds of finished video. The operator's case: a 7 s person pass, a 30 s
 * base cadence and 12 fps. Under the OLD derivation (base/10 = 3 s) that pass
 * was 2 frames — 0.17 s, a flicker nobody sees. Under the derivation here
 * (base/30, floored at 1 s → 1 s) it is 7 frames ≈ 0.58 s, and with
 * `minDwellSec: 1` it is densified until it is a full second. The base rate is
 * untouched, so an eight-hour night costs the same everywhere else.
 *
 * ONE CADENCE FOR EVERY RANGE — the trade-off, stated plainly.
 * `ExportDenseSchema.everyMs` is a single global number: the ranges become
 * terms of ONE ffmpeg `select` expression that switches rate by timestamp, and
 * the expression has no way to say "this range at 250 ms, that one at 1 s".
 * So when `minDwellSec` is set, the MOST DEMANDING range (the shortest one,
 * which needs the fastest rate to fill its dwell) sets the rate for all of
 * them. Longer ranges are therefore sampled denser than they strictly need.
 * A per-range cadence needs a cap-schema change and is tracked as the
 * train-bound follow-up; this variant is correct, cheap and ships today.
 *
 * NEVER A DUPLICATED FRAME. When a range is too short to fill `minDwellSec`
 * even at the {@link TIMELAPSE_DENSE_FLOOR_MS} floor — half a second of footage
 * cannot become two seconds of 12 fps video without inventing 19 frames — the
 * densification stops at the floor and {@link DenseCadenceDecision.dwellFloorCapped}
 * says so. The range gets every frame that EXISTS and not one more: a padded
 * timelapse would show the operator motion that never happened.
 */

import type { ExportDenseRange } from '@camstack/types'
import { TIMELAPSE_DENSE_FLOOR_SEC } from '@camstack/types'

/**
 * Dense cadence as a fraction of the base when the rule states none.
 *
 * Relative and not absolute so the two rates stay visibly apart at any base the
 * operator picks. Thirty (not ten): at the 30 s base this deployment actually
 * uses, a tenth produced 3 s — two frames per person pass, which is the defect
 * this constant was changed to fix.
 */
export const DENSE_CADENCE_DIVISOR = 30

/**
 * Floor on the DERIVED cadence, seconds.
 *
 * The derivation stops at one second; going below it is a deliberate act the
 * operator performs through `denseCadenceSec` or `minDwellSec`, never something
 * a base-cadence edit does to him by accident.
 */
export const DENSE_DERIVED_FLOOR_SEC = 1

/**
 * Hard floor on ANY dense cadence, ms — the recording's own frame interval.
 *
 * Asking for a frame every 50 ms from footage that has one every 100 ms does
 * not produce more frames; it produces the same frames, requested twice.
 */
export const TIMELAPSE_DENSE_FLOOR_MS = Math.round(TIMELAPSE_DENSE_FLOOR_SEC * 1000)

export interface DenseCadenceInput {
  /** The rule's base cadence, seconds — the rate outside every dense range. */
  readonly cadenceSec: number
  /** The rule's explicit dense cadence, seconds. Absent ⇒ derive it. */
  readonly denseCadenceSec?: number
  /** The rule's output-seconds guarantee per range, seconds. Absent ⇒ none. */
  readonly minDwellSec?: number
  /** Output frames per second of the assembled mp4. */
  readonly outputFps: number
  /** The planned dense ranges — only their DURATIONS are read. */
  readonly ranges: readonly ExportDenseRange[]
}

export interface DenseCadenceDecision {
  /** The integer `dense.everyMs` to put on the export. */
  readonly everyMs: number
  /** Where the pre-dwell cadence came from, for the log line. */
  readonly source: 'default' | 'explicit'
  /** `minDwellSec` pulled the cadence below what source alone would give. */
  readonly dwellApplied: boolean
  /**
   * Some range wanted a cadence below {@link TIMELAPSE_DENSE_FLOOR_MS} to meet
   * its dwell and did not get it. The range is rendered at the floor with the
   * frames that exist — the operator's guarantee is not met for THAT range, and
   * this is how the renderer knows to say so.
   */
  readonly dwellFloorCapped: boolean
}

/**
 * Decide the dense sampling rate for one render.
 *
 * @returns an integer ms cadence, always ≥ {@link TIMELAPSE_DENSE_FLOOR_MS} and
 *   — provided the caller's `denseCadenceSec` passed upsert validation —
 *   strictly below the base cadence, which `ExportTimelapseSchema` requires.
 */
export function resolveDenseCadence(input: DenseCadenceInput): DenseCadenceDecision {
  const source: 'default' | 'explicit' =
    input.denseCadenceSec !== undefined ? 'explicit' : 'default'

  // 1. The cadence before any dwell guarantee: the operator's number, or the
  //    derivation floored at a second.
  const sourceSec =
    input.denseCadenceSec ??
    Math.max(DENSE_DERIVED_FLOOR_SEC, input.cadenceSec / DENSE_CADENCE_DIVISOR)
  const sourceEveryMs = clampToFloor(Math.round(sourceSec * 1000))

  // 2. What the dwell guarantee demands. `outputSeconds >= minDwell` rearranges
  //    to `everyMs <= rangeMs / (minDwell * fps)`; the SMALLEST such bound over
  //    the ranges is the one cadence that satisfies every range it can.
  const dwell = input.minDwellSec
  if (dwell === undefined || dwell <= 0 || input.ranges.length === 0 || input.outputFps <= 0) {
    return { everyMs: sourceEveryMs, source, dwellApplied: false, dwellFloorCapped: false }
  }

  let requiredMs = Number.POSITIVE_INFINITY
  for (const range of input.ranges) {
    const rangeMs = (range.toSec - range.fromSec) * 1000
    if (rangeMs <= 0) continue
    // FLOOR, not round: a cadence rounded UP samples fewer frames than the
    // guarantee needs, which would miss the dwell by one frame.
    const needed = Math.floor(rangeMs / (dwell * input.outputFps))
    if (needed < requiredMs) requiredMs = needed
  }
  if (!Number.isFinite(requiredMs)) {
    return { everyMs: sourceEveryMs, source, dwellApplied: false, dwellFloorCapped: false }
  }

  // 3. Dwell may only DENSIFY. A range comfortably past its dwell must not pull
  //    the cadence back out — that would spend the guarantee in reverse.
  const dwellFloorCapped = requiredMs < TIMELAPSE_DENSE_FLOOR_MS
  const everyMs = clampToFloor(Math.min(sourceEveryMs, requiredMs))
  return { everyMs, source, dwellApplied: everyMs < sourceEveryMs, dwellFloorCapped }
}

/** Never below the recording's frame interval, and never zero or negative. */
function clampToFloor(everyMs: number): number {
  return Math.max(TIMELAPSE_DENSE_FLOOR_MS, everyMs)
}
