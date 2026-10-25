/**
 * WALL-clock dense ranges → CONCATENATED-STREAM ranges.
 *
 * **The two coordinate systems are not the same, and only this side of the
 * boundary can tell them apart.** A caller (the post-analysis timelapse
 * planner) states a dense range as seconds from the export's own `fromMs`: that
 * is WALL time, because that is the only clock a track has. ffmpeg's `select`
 * predicate sees `t`, and `t` runs over the export's SOURCE PLAYLIST — the
 * concatenation of every segment file present for the range, with every
 * recording gap REMOVED, because a gap is simply a segment that does not
 * exist. The two clocks agree only on a window that recorded without a single
 * interruption.
 *
 * What it cost, live (2026-08-13, export `57d14363`, camera 101): a 10 h window
 * held 29,393 s of footage across 2,957 segments — 6,607 s of holes. Every one
 * of the five planned dense ranges was stated in wall time, so each landed late
 * by the gap accumulated before it (10 s after the first hole, nearly two hours
 * by the end of the night, i.e. past EOF). `between(t,from,to)` matched
 * nothing, the delivered video was uniform at the base cadence, and the log
 * line said `denseRanges=5`. The log was believed; the video was not probed.
 *
 * The translation lives HERE, next to the playlist, because the playlist is the
 * only artifact that knows each segment's `(startMs, durMs)` and therefore the
 * cumulative offset of every one of them. Pushing wall→stream onto the caller
 * would make every future caller responsible for a subtraction it has no data
 * for.
 *
 * The map itself is the monotone step function "how much footage precedes this
 * wall instant". Two consequences worth stating, because they remove work a
 * reader would otherwise expect to find:
 *
 *  - **A range spanning a gap never splits.** Its recorded parts are adjacent
 *    in the concatenation (a gap occupies ZERO stream time), so the clip of a
 *    wall interval is always ONE contiguous stream interval. Emitting two
 *    touching ranges would be the same filter, one term longer.
 *  - **The mapping never grows the list**, so it can never push a caller that
 *    respected `EXPORT_DENSE_MAX_RANGES` past the ceiling.
 */
import type { ExportDenseRange, ExportOptions } from '@camstack/types'

/**
 * One playlist entry's WALL placement — what ffmpeg's `t` is assembled from.
 *
 * Deliberately just the timing: the URI is the playlist's business, and a
 * mapping that could not be computed from timings alone would be a mapping that
 * needed the filesystem.
 */
export interface ExportSegmentTiming {
  readonly startMs: number
  readonly durMs: number
}

/**
 * Why a requested range produced no stream range.
 *
 * `past-end` is kept apart from `gap` because they are different operator
 * problems: a hole in the middle of the night is a recorder that stumbled,
 * while everything past the end is a window that outlived its footage (a
 * retention sweep, or a camera that stopped recording early).
 */
export type DenseRangeDropReason = 'gap' | 'past-end'

/** A requested range that mapped to nothing, in the caller's own coordinates. */
export interface DroppedDenseRange {
  readonly fromSec: number
  readonly toSec: number
  readonly reason: DenseRangeDropReason
}

/** What the render logs: how many ranges survived the translation, and why the
 *  rest did not. Never a silent drop — silence reads as "never happened". */
export interface DenseRangeMapReport {
  readonly requested: number
  readonly mapped: number
  readonly dropped: readonly DroppedDenseRange[]
}

export interface MapDenseRangesInput {
  /** Ranges in seconds from {@link MapDenseRangesInput.exportFromMs}, WALL. */
  readonly ranges: readonly ExportDenseRange[]
  /** The export record's own `fromMs` — the origin those seconds count from. */
  readonly exportFromMs: number
  /** Every segment in the source playlist. Order is irrelevant (they are
   *  sorted here); presence is not — a missing one shifts everything after it. */
  readonly segments: readonly ExportSegmentTiming[]
}

export interface MapDenseRangesResult {
  readonly ranges: readonly ExportDenseRange[]
  readonly report: DenseRangeMapReport
}

/**
 * Shortest clip worth keeping, in ms.
 *
 * Exists only to honour `ExportDenseRangeSchema`'s `toSec > fromSec`: a range
 * clipped to a sliver of footage is still honest, but a range clipped to
 * NOTHING must not be emitted as a zero-length interval the schema refuses.
 */
const MIN_MAPPED_MS = 1

/** Milliseconds of footage that precede `wallMs` in the concatenation. */
function recordedMsBefore(segments: readonly ExportSegmentTiming[], wallMs: number): number {
  let acc = 0
  for (const s of segments) {
    // No early exit: two segments may OVERLAP in wall time after a writer
    // restart, and ffmpeg plays both, so the concatenation is longer than the
    // wall span. Summing every overlap is what matches what ffmpeg sees.
    if (wallMs >= s.startMs + s.durMs) acc += s.durMs
    else if (wallMs > s.startMs) acc += wallMs - s.startMs
  }
  return acc
}

/** Whole milliseconds → seconds, with no float tail for the filter string. */
function msToSec(ms: number): number {
  return Math.round(ms) / 1000
}

/**
 * Translate wall-clock dense ranges into the export's stream timeline.
 *
 * @returns the surviving ranges (in stream seconds, ordered as given) plus the
 *   report the render logs.
 */
export function mapDenseRangesToStreamTime(input: MapDenseRangesInput): MapDenseRangesResult {
  const segments = [...input.segments].sort((a, b) => a.startMs - b.startMs)
  // With no footage at all every range is past the (non-existent) end — the
  // engine refuses such an export before it reaches here, but a mapping that
  // divided by an empty list would be a crash instead of an answer.
  const footageEndMs = segments.reduce(
    (end, s) => Math.max(end, s.startMs + s.durMs),
    input.exportFromMs,
  )

  const mapped: ExportDenseRange[] = []
  const dropped: DroppedDenseRange[] = []
  for (const range of input.ranges) {
    const fromWallMs = input.exportFromMs + range.fromSec * 1000
    const toWallMs = input.exportFromMs + range.toSec * 1000
    const fromMs = Math.round(recordedMsBefore(segments, fromWallMs))
    const toMs = Math.round(recordedMsBefore(segments, toWallMs))
    if (toMs - fromMs < MIN_MAPPED_MS) {
      dropped.push({
        fromSec: range.fromSec,
        toSec: range.toSec,
        reason: fromWallMs >= footageEndMs ? 'past-end' : 'gap',
      })
      continue
    }
    mapped.push({ fromSec: msToSec(fromMs), toSec: msToSec(toMs) })
  }

  return {
    ranges: mapped,
    report: { requested: input.ranges.length, mapped: mapped.length, dropped },
  }
}

/** The timelapse block of {@link ExportOptions}, present. */
type ExportTimelapseOptions = NonNullable<ExportOptions['timelapse']>

export interface StreamTimeExportOptionsInput {
  readonly options: ExportOptions
  /** The export record's `fromMs`. */
  readonly fromMs: number
  readonly segments: readonly ExportSegmentTiming[]
}

export interface StreamTimeExportOptions {
  /** The SAME object when there was nothing to translate — never a copy that
   *  invites a caller to believe something changed. */
  readonly options: ExportOptions
  /** Null when the export carries no dense overlay: nothing to report. */
  readonly report: DenseRangeMapReport | null
}

/**
 * One export's options with its dense ranges expressed in stream time.
 *
 * An overlay that maps to NOTHING is removed entirely rather than left with an
 * empty range list: `ExportDenseSchema` refuses `ranges: []` and
 * `selectPredicate` would emit `if(,…)`, a filter ffmpeg rejects — so a night
 * whose busy moments all fell in holes would fail the render instead of
 * delivering the uniform video it legitimately is.
 */
export function withStreamTimeDenseRanges(
  input: StreamTimeExportOptionsInput,
): StreamTimeExportOptions {
  const timelapse = input.options.timelapse
  const dense = timelapse?.dense
  if (timelapse === undefined || dense === undefined) {
    return { options: input.options, report: null }
  }
  const { ranges, report } = mapDenseRangesToStreamTime({
    ranges: dense.ranges,
    exportFromMs: input.fromMs,
    segments: input.segments,
  })
  const base: ExportTimelapseOptions = {
    everyMs: timelapse.everyMs,
    ...(timelapse.outputFps !== undefined ? { outputFps: timelapse.outputFps } : {}),
  }
  // `[...ranges]`: the cap's inferred shape carries a MUTABLE array, so a
  // readonly one cannot be handed straight over.
  const remapped: ExportTimelapseOptions =
    ranges.length > 0 ? { ...base, dense: { everyMs: dense.everyMs, ranges: [...ranges] } } : base
  return { options: { ...input.options, timelapse: remapped }, report }
}
