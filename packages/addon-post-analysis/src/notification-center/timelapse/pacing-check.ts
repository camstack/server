/**
 * Did the DELIVERED timelapse honour the plan it was rendered from?
 *
 * Pure — no clock, no I/O, no store. The renderer hands over the exact
 * artefacts of its own decision — the dense ranges it attached, the subjects
 * they were cut for, the availability rows THE FILE WAS CUT FROM, the two
 * cadences and the output fps — plus one measurement of the finished file (its
 * duration), and gets back a verdict.
 *
 * WHICH availability rows, and why it is not the planner's. The renderer hands
 * `createExport` a WINDOW, never a list of ranges: the export engine walks that
 * window itself (`writeExportSourcePlaylist` → `collectRangeSegments(…,
 * 'absolute')`) and its playlist is what ffmpeg sampled. Since D445 that walk
 * is VERIFIED against the array, so it can find footage the planner's
 * availability read never saw — 11,986 s against 2,362 s on camera 4374. Frame
 * arithmetic over the planner's figure would then be arithmetic over footage
 * the file does not contain, and the verdict would cry `frame-surplus` at a
 * correct file. The renderer therefore re-reads availability AFTER the export,
 * once the walk has repaired the index the calendar serves from, and hands
 * THAT (`measureArchive`). Still one authority and still no second question —
 * the question is just asked of the reader that answers for the file.
 *
 * WHY THIS EXISTS. On the night of 2026-08-20→21 the scheduler logged
 * `timelapse produced … denseRanges=9 detections=13 coveragePct=91` for camera
 * 101 and delivered a file in which the 06:26 person plays at full speed.
 * Every logged number was true — of the PLAN. Two recorder defects (a retiming
 * step that let `fps=12` decimate the selected frames, and an HLS concat whose
 * timeline drifted ~495 s from the declared durations the dense map summed)
 * meant the FILE matched none of them, and nothing compared the two. This
 * module is that comparison. It reads the same plan the render used — one
 * authority, never a second query — and its output is a log line, never a
 * failed window.
 *
 * THE ARITHMETIC. A window with `coveredSec` seconds of footage, of which
 * `denseSec` fall inside dense ranges, renders
 *
 *     expected = (coveredSec − denseSec)/cadenceSec + denseSec/denseEverySec
 *
 * frames, all shown at `outputFps` — so the file's duration IS a frame count.
 * Coverage is intersected per range: a range whose footage fell in a recording
 * hole is dropped by the recorder legitimately (`export-dense-map.ts` reports
 * it), and expecting frames from footage that does not exist would cry wolf.
 */

import type { ExportDenseRange } from '@camstack/types'
import type { TimelapseTrackInterval } from './dense-ranges.js'

/** Tolerated deviation between planned and delivered frames, as a fraction of
 *  the plan. Availability `durMs` metadata wobbles against real PTS spans by a
 *  few percent per night; a quarter is comfortably above the noise and far
 *  below the failures this check exists for (−53% on the night it was born). */
const PACING_TOLERANCE_RATIO = 0.25
/** Absolute slack under which a deviation is never an anomaly — seed frames,
 *  rounding, and a last partial interval are all worth a frame or two each. */
const PACING_TOLERANCE_FRAMES = 6
/** A slowdown is "delivered" when at least this fraction of the dense EXTRA
 *  frames reached the file. Half: the failure mode is not "a few frames shy",
 *  it is a uniform video (0%) or a decimated one (negative). */
export const SLOWDOWN_DELIVERY_FLOOR = 0.5
/** Dense plans owing fewer extra frames than this are too small to measure
 *  against rounding noise — the duration check still applies, the per-window
 *  slowdown verdict does not. One second of output video at the usual 12 fps. */
export const SLOWDOWN_CHECK_FLOOR_FRAMES = 12

/** One availability row of the profile the FILE was cut from — the post-export
 *  read, not the planner's. See the module docblock for why they differ. */
export interface PacingAvailabilityRange {
  readonly startMs: number
  readonly endMs: number
}

export type PacingAnomaly = 'none' | 'no-slowdown' | 'frame-deficit' | 'frame-surplus'

/** A dense range that owed slowdown, with who it was for — the WARN's payload. */
export interface PacingDetectionWindow {
  readonly fromSec: number
  readonly toSec: number
  /** Seconds of the range actually covered by footage. */
  readonly coveredSec: number
  /** Frames the dense cadence owes this range (over its covered seconds). */
  readonly expectedDenseFrames: number
  /** How many merged subjects (tracks ∪ event groups) the range holds. */
  readonly subjects: number
  /** Their classes, first-seen order, deduplicated. */
  readonly classes: readonly string[]
  /** Epoch ms of the earliest subject in the range — "who, when". */
  readonly firstSeen: number
}

export interface PacingCheckInput {
  readonly windowStartMs: number
  readonly windowEndMs: number
  /** Base cadence, seconds — `TimelapseRule.cadenceSec`. */
  readonly cadenceSec: number
  /** The dense cadence the export carries, ms — null when no overlay was
   *  attached (no ranges, plan capped, or a non-denser derived cadence). */
  readonly denseEveryMs: number | null
  readonly outputFps: number
  /** The dense ranges the export carries, seconds from window start. */
  readonly ranges: readonly ExportDenseRange[]
  /** The merged subjects the ranges were planned from — same array, one
   *  authority (`detection-intervals.ts`). */
  readonly subjects: readonly TimelapseTrackInterval[]
  /** Availability rows of the CHOSEN profile — the same rows the profile pick
   *  measured coverage on. */
  readonly availability: readonly PacingAvailabilityRange[]
  /** The finished file's duration (from its own bytes, `mp4-duration.ts`). */
  readonly actualDurationMs: number
}

export interface PacingVerdict {
  readonly anomaly: PacingAnomaly
  /** Frames the file actually holds (duration × fps). */
  readonly actualFrames: number
  /** Frames the plan owes (base over covered footage + dense over ranges). */
  readonly expectedFrames: number
  /** Frames a dense-less render of the same footage would hold. */
  readonly baselineOnlyFrames: number
  /** What the dense overlay adds over the baseline. */
  readonly expectedDenseExtraFrames: number
  /** What the file delivered over the baseline (negative ⇒ below even the
   *  uniform base cadence — frames were dropped wholesale). */
  readonly deliveredDenseExtraFrames: number
  /** Seconds of footage covering the window. */
  readonly coveredSec: number
  /** Seconds of covered footage inside dense ranges. */
  readonly denseCoveredSec: number
  /** Populated when {@link PacingVerdict.anomaly} is `no-slowdown`: every
   *  detection window that owed dense frames. Empty otherwise. */
  readonly unservedWindows: readonly PacingDetectionWindow[]
}

/** Milliseconds of [aMs, bMs) covered by the availability rows. */
function coveredMsBetween(
  availability: readonly PacingAvailabilityRange[],
  aMs: number,
  bMs: number,
): number {
  let acc = 0
  for (const row of availability) {
    const from = Math.max(aMs, row.startMs)
    const to = Math.min(bMs, row.endMs)
    if (to > from) acc += to - from
  }
  return acc
}

/** The range's subjects, summarised for the log line. */
function describeWindow(
  range: ExportDenseRange,
  input: PacingCheckInput,
  coveredSec: number,
  expectedDenseFrames: number,
): PacingDetectionWindow {
  const fromMs = input.windowStartMs + range.fromSec * 1000
  const toMs = input.windowStartMs + range.toSec * 1000
  const classes: string[] = []
  let subjects = 0
  let firstSeen = Number.POSITIVE_INFINITY
  for (const s of input.subjects) {
    const sFrom = Math.min(s.firstSeen, s.lastSeen)
    const sTo = Math.max(s.firstSeen, s.lastSeen)
    if (sTo < fromMs || sFrom > toMs) continue
    subjects += 1
    if (sFrom < firstSeen) firstSeen = sFrom
    if (s.className !== undefined && !classes.includes(s.className)) classes.push(s.className)
  }
  return {
    fromSec: range.fromSec,
    toSec: range.toSec,
    coveredSec,
    expectedDenseFrames,
    subjects,
    classes,
    firstSeen: Number.isFinite(firstSeen) ? firstSeen : fromMs,
  }
}

/**
 * Compare the delivered file against the plan it was rendered from.
 */
export function checkTimelapsePacing(input: PacingCheckInput): PacingVerdict {
  const coveredMs = coveredMsBetween(input.availability, input.windowStartMs, input.windowEndMs)
  const coveredSec = coveredMs / 1000

  const denseEverySec = input.denseEveryMs === null ? null : input.denseEveryMs / 1000
  let denseCoveredSec = 0
  const windows: PacingDetectionWindow[] = []
  if (denseEverySec !== null && denseEverySec > 0) {
    for (const range of input.ranges) {
      const rangeCoveredSec =
        coveredMsBetween(
          input.availability,
          input.windowStartMs + range.fromSec * 1000,
          input.windowStartMs + range.toSec * 1000,
        ) / 1000
      denseCoveredSec += rangeCoveredSec
      const expectedDenseFrames = Math.round(rangeCoveredSec / denseEverySec)
      if (expectedDenseFrames > 0) {
        windows.push(describeWindow(range, input, rangeCoveredSec, expectedDenseFrames))
      }
    }
  }

  const baselineOnlyFrames = Math.round(coveredSec / input.cadenceSec)
  const expectedFrames =
    denseEverySec === null || denseEverySec <= 0
      ? baselineOnlyFrames
      : Math.round(
          (coveredSec - denseCoveredSec) / input.cadenceSec + denseCoveredSec / denseEverySec,
        )
  const actualFrames = Math.round((input.actualDurationMs / 1000) * input.outputFps)
  const expectedDenseExtraFrames = expectedFrames - baselineOnlyFrames
  const deliveredDenseExtraFrames = actualFrames - baselineOnlyFrames

  const verdict = {
    actualFrames,
    expectedFrames,
    baselineOnlyFrames,
    expectedDenseExtraFrames,
    deliveredDenseExtraFrames,
    coveredSec,
    denseCoveredSec,
  }

  // 1. The check this module was commissioned for: detection windows whose
  //    slowdown never reached the file. Owns priority over the duration checks
  //    because it names the operator-visible failure ("the person at 06:26
  //    plays at full speed") — the frame numbers ride along either way.
  if (
    expectedDenseExtraFrames >= SLOWDOWN_CHECK_FLOOR_FRAMES &&
    deliveredDenseExtraFrames < SLOWDOWN_DELIVERY_FLOOR * expectedDenseExtraFrames
  ) {
    return { ...verdict, anomaly: 'no-slowdown', unservedWindows: windows }
  }

  // 2. Duration against the plan, both directions, under one tolerance.
  const slack = Math.max(PACING_TOLERANCE_FRAMES, PACING_TOLERANCE_RATIO * expectedFrames)
  if (actualFrames < expectedFrames - slack) {
    return { ...verdict, anomaly: 'frame-deficit', unservedWindows: [] }
  }
  if (actualFrames > expectedFrames + slack) {
    return { ...verdict, anomaly: 'frame-surplus', unservedWindows: [] }
  }
  return { ...verdict, anomaly: 'none', unservedWindows: [] }
}
